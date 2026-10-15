import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { Agent, request } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { release } from 'node:os';
import { ProjectSources } from '../src/project-sources.mjs';
import { appSource } from './http-benchmark-fixture.mjs';
import { percentile } from './benchmark-statistics.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const projectId = 'sdk-durable-qa';
const expectedSpans = 1051;
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, path) => {
  const rel = relative(parent, path);
  return Boolean(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);
};
const app = appSource + `\nprocess.on('message',message=>{if(message==='qa:stop')server.close(()=>process.disconnect());});\n`;
const safeCount = value => Number.isSafeInteger(value) && value >= 0;

function childProcess(args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const state = { child, messages: [], stdout: '', stderr: '', closed: false, outcome: null, spawnError: false };
  child.on('message', value => state.messages.push(value));
  child.stdout.on('data', chunk => { state.stdout = (state.stdout + chunk).slice(-32768); });
  child.stderr.on('data', chunk => { state.stderr = (state.stderr + chunk).slice(-32768); });
  child.once('error', () => { state.spawnError = true; });
  child.once('close', (code, signal) => { state.closed = true; state.outcome = { code, signal }; });
  return state;
}

async function waitFor(predicate, state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    if (state.spawnError || state.closed || state.messages.some(message => message?.kind === 'error'))
      throw new Error('child_failed');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('child_deadline');
}

async function waitClosed(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!state.closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  return state.closed;
}

async function stopOwned(state, command) {
  if (!state || state.closed) return;
  if (state.child.connected) {
    try { state.child.send(command, () => {}); } catch {}
  }
  await waitClosed(state, 1500);
  if (!state.closed) state.child.kill('SIGKILL');
  await waitClosed(state, 1500);
}

function get(origin, path, agent) {
  return new Promise(resolve => {
    const started = performance.now(); let finished = false;
    const finish = value => { if (!finished) { finished = true; clearTimeout(timer); resolve({ ...value, ms: performance.now() - started }); } };
    const req = request(new URL(path, origin), { agent }, res => {
      let body = '', bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes <= 2048) body += chunk; });
      res.on('end', () => finish({ status: res.statusCode, body }));
      res.on('error', () => finish({ status: 0, body: '' }));
    });
    const timer = setTimeout(() => req.destroy(), 10000);
    req.on('error', () => finish({ status: 0, body: '' })); req.end();
  });
}

async function workload(origin, prefix, count, agent) {
  let cursor = 0; const samples = []; const started = performance.now();
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < count) {
      const index = cursor++, id = prefix + '-' + String(index).padStart(4, '0');
      const result = await get(origin, '/bench/' + id, agent);
      assert.equal(result.status, 200, 'fixture response status');
      assert.equal(result.body, 'flowatlas-benchmark:' + id + ':ok', 'fixture response bytes');
      samples[index] = result.ms;
    }
  }));
  return { count: samples.length, durationMs: performance.now() - started,
    p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), p99Ms: percentile(samples, 0.99) };
}

function traceRecord(output, prefix, fields) {
  const matches = output.split(/\r?\n/).filter(line => line.startsWith(prefix));
  if (matches.length !== 1) return null;
  const raw = matches[0].slice(prefix.length);
  if (!raw) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!fields.every(field => safeCount(value?.[field]))) return null;
  return Object.fromEntries(fields.map(field => [field, value[field]]));
}

function safeService(value, mode) {
  if (value?.kind !== 'stopped' || value.closed !== true) return null;
  const fields = mode === 'sink' ? ['received', 'unique', 'invalid', 'requests', 'responses202']
    : ['acceptedUnique', 'responses202', 'retainedActions'];
  if (!fields.every(field => safeCount(value[field]))) return null;
  const result = Object.fromEntries(fields.map(field => [field, value[field]]));
  result.closed = true;
  if (mode === 'durable') {
    if (typeof value.observerFailure !== 'boolean' || typeof value.reloadVerified !== 'boolean'
      || !/^[a-f0-9]{64}$/.test(value.savedDigest ?? '') || !/^[a-f0-9]{64}$/.test(value.reloadedDigest ?? '')
      || !value.storageTiming || !safeCount(value.storageTiming.saves)
      || !safeCount(value.storageTiming.failures) || !Number.isFinite(value.storageTiming.syncMs)
      || value.storageTiming.syncMs < 0) return null;
    result.observerFailure = value.observerFailure; result.reloadVerified = value.reloadVerified;
    result.savedDigest = value.savedDigest; result.reloadedDigest = value.reloadedDigest;
    result.storageTiming = { saves: value.storageTiming.saves, failures: value.storageTiming.failures,
      syncMs: value.storageTiming.syncMs };
  }
  return result;
}

async function condition(mode, round) {
  const storageRoot = join(root, 'reports/storage'); mkdirSync(storageRoot, { recursive: true });
  const parent = realpathSync(storageRoot);
  assert.ok(inside(realpathSync(root), parent) && !lstatSync(storageRoot).isSymbolicLink());
  const workspace = realpathSync(mkdtempSync(join(parent, 'sdk-durable-pair-')));
  assert.ok(inside(parent, workspace) && !lstatSync(workspace).isSymbolicLink());
  const row = { mode, round, complete: false, failure: null, measurement: null, appMetrics: null,
    delivery: null, health: null, transport: null, service: null, targetClosed: false, serviceClosed: false,
    targetOutcome: null, serviceOutcome: null, workspaceRemoved: false, retainedWorkspace: null };
  const token = randomBytes(32).toString('base64url');
  const agent = new Agent({ keepAlive: true, maxSockets: 8 });
  let service, target, phase = 'setup';
  try {
    mkdirSync(join(workspace, 'app'));
    writeFileSync(join(workspace, 'app/server.mjs'), app, { flag: 'wx' });
    const codeDigest = new ProjectSources(workspace,
      [{ id: projectId, root: 'app', files: ['server.mjs'] }]).version(projectId).digest;
    const childEnv = { ...process.env };
    delete childEnv.NODE_OPTIONS; delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.FLOWATLAS_CLI_OWNER; delete childEnv.FLOWATLAS_TRACE_TIMING;
    delete childEnv.FLOWATLAS_TRACED_TOOL_ROOT; delete childEnv.FLOWATLAS_BENCHMARK_TARGET_PROFILE;
    for (const key of Object.keys(childEnv)) if (key.startsWith('OTEL_')) delete childEnv[key];
    service = childProcess([join(root, mode === 'sink' ? 'scripts/sdk-durable-pair-sink-child.mjs'
      : 'scripts/sdk-durable-pair-collector-child.mjs')], childEnv);
    service.child.send({ kind: 'start', sessionToken: token, projectId, codeDigest,
      ...(mode === 'durable' ? { workspace } : {}) }, () => {});
    const ready = await waitFor(() => service.messages.find(message => message?.kind === 'ready'), service, 12000);
    assert.ok(Number.isSafeInteger(ready.port) && ready.port > 0 && ready.port <= 65535);
    if (mode === 'durable') assert.equal(ready.codeDigest, codeDigest);
    const targetEnv = { ...childEnv, PORT: '0', FLOWATLAS_URL: `http://127.0.0.1:${ready.port}`,
      FLOWATLAS_PROJECT_ID: projectId, FLOWATLAS_TRACE_DIGEST: codeDigest, FLOWATLAS_SESSION_TOKEN: token,
      OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none', OTEL_LOG_LEVEL: 'none' };
    const hook = pathToFileURL(createRequire(import.meta.url).resolve('@opentelemetry/instrumentation/hook.mjs')).href;
    target = childProcess(['--experimental-loader', hook, '--import',
      pathToFileURL(join(root, 'src/otel-preload.mjs')).href, join(workspace, 'app/server.mjs')], targetEnv);
    const origin = await waitFor(() => target.stdout.match(/Registered app: (http:\/\/127\.0\.0\.1:\d+)/)?.[1], target, 12000);
    phase = 'responses';
    await workload(origin, 'warmup', 50, agent);
    row.measurement = await workload(origin, 'measured', 1000, agent);
    const metrics = await get(origin, '/__flowatlas_benchmark_metrics', agent);
    assert.equal(metrics.status, 200);
    const raw = JSON.parse(metrics.body);
    const fields = ['requests', 'uniqueRequests', 'metricsRequests', 'invalid', 'cpuUserMicros', 'cpuSystemMicros', 'maxRssBytes'];
    assert.ok(fields.every(field => safeCount(raw[field])));
    row.appMetrics = Object.fromEntries(fields.map(field => [field, raw[field]]));
    assert.deepEqual([raw.requests, raw.uniqueRequests, raw.metricsRequests, raw.invalid], [1050, 1050, 1, 0]);
    agent.destroy();
    phase = 'capture';
    target.child.send('flowatlas:shutdown', () => {});
    const flushed = await waitFor(() => target.messages.find(message => message === 'flowatlas:flushed'
      || message === 'flowatlas:flush-failed'), target, 5000);
    assert.equal(flushed, 'flowatlas:flushed');
    row.delivery = traceRecord(target.stderr, 'FlowAtlas trace summary: ',
      ['httpSpans', 'invalidSpans', 'delivered', 'dropped', 'queued', 'inFlight']);
    row.health = traceRecord(target.stderr, 'FlowAtlas trace delivery health: ',
      ['overflow', 'invalid', 'rejected', 'timeout', 'transport', 'shutdown']);
    row.transport = traceRecord(target.stderr, 'FlowAtlas trace transport health: ',
      ['batches', 'submittedSpans', 'smallBatches', 'peakRequests']);
    assert.deepEqual(row.delivery, { httpSpans: expectedSpans, invalidSpans: 0, delivered: expectedSpans,
      dropped: 0, queued: 0, inFlight: 0 });
    assert.deepEqual(row.health, { overflow: 0, invalid: 0, rejected: 0, timeout: 0, transport: 0, shutdown: 0 });
    assert.ok(row.transport && row.transport.batches > 0 && row.transport.submittedSpans === expectedSpans
      && row.transport.peakRequests >= 1 && row.transport.peakRequests <= 2);
    target.child.send('qa:stop', () => {});
    await waitFor(() => target.closed, target, 5000);
    assert.deepEqual(target.outcome, { code: 0, signal: null });
    phase = 'service';
    service.child.send({ kind: 'stop' }, () => {});
    const stopped = await waitFor(() => service.messages.find(message => message?.kind === 'stopped'), service, 5000);
    row.service = safeService(stopped, mode);
    assert.ok(row.service);
    await waitFor(() => service.closed, service, 5000);
    assert.deepEqual(service.outcome, { code: 0, signal: null });
    if (mode === 'sink') {
      assert.deepEqual([row.service.received, row.service.unique, row.service.invalid], [expectedSpans, expectedSpans, 0]);
      assert.equal(row.service.responses202, row.service.requests);
      assert.equal(row.service.responses202, row.transport.batches);
    } else {
      assert.equal(row.service.observerFailure, false);
      assert.equal(row.service.reloadVerified, true);
      assert.equal(row.service.savedDigest, row.service.reloadedDigest);
      assert.equal(row.service.acceptedUnique, expectedSpans);
      assert.equal(row.service.retainedActions, 100);
      assert.equal(row.service.responses202, row.transport.batches);
      assert.ok(row.service.storageTiming.saves > 0);
      assert.equal(row.service.storageTiming.failures, 0);
      assert.equal(existsSync(join(workspace, 'data/actions/.writer.lock')), false);
    }
    row.complete = true;
  } catch {
    row.failure = phase + '_failed';
  } finally {
    agent.destroy();
    await stopOwned(target, 'qa:stop');
    await stopOwned(service, { kind: 'stop' });
    if (service && !row.service) row.service = safeService(service.messages.find(message => message?.kind === 'stopped'), mode);
    row.targetClosed = Boolean(target?.closed); row.serviceClosed = Boolean(service?.closed);
    row.targetOutcome = target?.outcome ?? null; row.serviceOutcome = service?.outcome ?? null;
    const safe = realpathSync(workspace);
    if (row.complete && row.targetClosed && row.serviceClosed && safe === workspace && inside(parent, safe)
      && !lstatSync(safe).isSymbolicLink() && !existsSync(join(workspace, 'data/actions/.writer.lock'))) {
      try { rmSync(safe, { recursive: true, force: true }); row.workspaceRemoved = true; }
      catch { row.failure = 'workspace_cleanup_failed'; row.complete = false; }
    }
    if (!row.workspaceRemoved) row.retainedWorkspace = relative(root, workspace).replaceAll('\\', '/');
  }
  return row;
}

test('actual SDK target cost versus controlled sink and real durable collector stays diagnostic', { timeout: 180000 }, async () => {
  const output = join(root, 'reports/benchmarks'); mkdirSync(output, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const files = ['src/otel-preload.mjs', 'src/otel-exporter.mjs', 'src/server.mjs', 'src/action-store.mjs',
    'scripts/http-benchmark-fixture.mjs', 'scripts/sdk-durable-pair-sink-child.mjs',
    'scripts/sdk-durable-pair-collector-child.mjs', 'scripts/benchmark-statistics.mjs', 'package.json', 'npm-shrinkwrap.json'];
  const report = { id, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'package.json', 'npm-shrinkwrap.json'],
      { cwd: root }).toString().trim()),
    scriptDigest: hash(readFileSync(fileURLToPath(import.meta.url))),
    runtimeDigests: Object.fromEntries(files.map(file => [file, hash(readFileSync(join(root, file)))])),
    fixtureDigest: hash(appSource), generatedFixtureDigest: hash(app),
    runtime: { node: process.version, platform: process.platform, osRelease: release() },
    workload: { rounds: 3, warmup: 50, measured: 1000, concurrency: 8, expectedSdkSpans: expectedSpans,
      exporterCapacity: 2048, slots: 2, batchLimit: 32, uploadTimeoutMs: 1000, shutdownDeadlineMs: 900 },
    evidenceKind: 'actual NodeSDK on shared synthetic HTTP fixture; separate target, sink/collector and driver processes',
    protocolDifference: { sink: 'controlled 202 acknowledgement; no normalization, graph validation or storage',
      durable: 'production HTTP ingestion, graph validation and JsonActionStore fsync/rename/reload' },
    measurementScope: 'request p95 includes driver scheduling and shared-host contention but excludes startup and shutdown; target CPU starts after SDK preload and includes warmup/metrics request, RSS samples during requests; durable post-save observer scans up to history 100, while sink validates batches; saved-state digest versus reload is consistency, not independent request-order proof',
    performanceAcceptance: { assessable: false, met: null, reason: 'sdk_durable_pair_diagnostic' },
    comparisons: 'within this paired synthetic workload only; no subtraction of unrelated medians or real-app claim',
    pairs: [] };
  try {
    for (let round = 1; round <= 3; round++) {
      const order = round % 2 ? ['sink', 'durable'] : ['durable', 'sink'];
      const rows = {};
      for (const mode of order) rows[mode] = await condition(mode, round);
      report.pairs.push({ round, order, sink: rows.sink, durable: rows.durable });
    }
  } finally {
    const path = join(output, `sdk-durable-pair-${id}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log('SDK durable pair report: ' + relative(root, path).replaceAll('\\', '/'));
  }
  assert.equal(report.pairs.length, 3);
  assert.ok(report.pairs.every(pair => pair.sink.complete && pair.durable.complete
    && pair.sink.workspaceRemoved && pair.durable.workspaceRemoved), 'SDK durable pair failed; retain report and fixtures');
});
