import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, Agent, request } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { release } from 'node:os';
import { appSource } from './http-benchmark-fixture.mjs';
import { percentile } from './benchmark-statistics.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, path) => { const v = relative(parent, path); return v && !v.startsWith('..') && !isAbsolute(v); };
const modes = ['baseline', 'sdk-count-only', 'sdk-production-exporter-sink'];
const controlledFault = process.env.FLOWATLAS_SDK_HTTP_FAULT === 'sink-reject';
const app = appSource + `\nprocess.on('message',message=>{if(message==='qa:stop')server.close(()=>process.disconnect());});\n`;
const number = value => Number.isSafeInteger(value) && value >= 0;
async function waitFor(predicate, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 10)); }
  throw Error('sdk_diagnostic_deadline');
}
function get(origin, path, agent) {
  return new Promise(resolve => {
    const started = performance.now(); let finished = false;
    const finish = value => { if (!finished) { finished = true; clearTimeout(timer); resolve({ ...value, ms: performance.now() - started }); } };
    const req = request(new URL(path, origin), { agent }, res => {
      let body = '', size = 0;
      res.on('data', chunk => { size += chunk.length; if (size <= 2048) body += chunk; });
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
    p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), p99Ms: percentile(samples, 0.99), samplesMs: samples };
}
async function condition(mode, round) {
  const parentPath = join(root, 'reports/storage'); mkdirSync(parentPath, { recursive: true });
  const parent = realpathSync(parentPath);
  assert.ok(inside(realpathSync(root), parent) && !lstatSync(parentPath).isSymbolicLink());
  const workspace = realpathSync(mkdtempSync(join(parent, 'sdk-http-')));
  assert.ok(inside(parent, workspace));
  const row = { mode, round, complete: false, failure: null, workspaceRemoved: false,
    retainedWorkspace: null, measurement: null, metrics: null, sdkCounts: null, delivery: null, sinkReceived: 0 };
  const token = randomBytes(32).toString('base64url'), traces = new Set();
  let child, closed = false, sink, sinkClosed = false, invalidSink = 0, stdout = '', stderr = '', sdkCounts, flushed = false;
  const agent = new Agent({ keepAlive: true, maxSockets: 8 });
  try {
    writeFileSync(join(workspace, 'app.mjs'), app, { flag: 'wx' });
    sink = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST' || req.url !== '/flowatlas/ingest' || req.headers.authorization !== `Bearer ${token}`) throw Error();
        if (controlledFault && mode === 'sdk-production-exporter-sink' && round === 1) { req.resume(); res.writeHead(503); res.end(); return; }
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 262144) throw Error(); chunks.push(chunk); }
        const payload = JSON.parse(Buffer.concat(chunks));
        if (payload.kind !== 'otel-span-batch' || payload.projectId !== 'sdk-http-qa' || payload.codeDigest !== hash(app)
          || !Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 32) throw Error();
        for (const item of payload.items) {
          if (!/^[a-f0-9]{32}$/.test(item.traceId) || /^0+$/.test(item.traceId) || traces.has(item.traceId)
            || item.span.kind !== 'SERVER' || item.span.method !== 'GET' || item.span.httpStatus !== 200) throw Error();
          traces.add(item.traceId); row.sinkReceived++;
        }
        res.writeHead(202); res.end();
      } catch { invalidSink++; req.resume(); res.writeHead(400); res.end(); }
    });
    sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
    const env = { ...process.env, PORT: '0', FLOWATLAS_URL: 'http://127.0.0.1:' + sink.address().port,
      FLOWATLAS_PROJECT_ID: 'sdk-http-qa', FLOWATLAS_TRACE_DIGEST: hash(app), FLOWATLAS_SESSION_TOKEN: token };
    for (const key of Object.keys(env)) if (key.startsWith('OTEL_') || key.startsWith('NODE_') || key === 'FLOWATLAS_CLI_OWNER'
      || key === 'FLOWATLAS_TRACE_TIMING' || key === 'FLOWATLAS_TRACED_TOOL_ROOT') delete env[key];
    Object.assign(env, { OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none', OTEL_LOG_LEVEL: 'none' });
    const args = mode === 'baseline' ? [] : ['--experimental-loader',
      pathToFileURL(createRequire(import.meta.url).resolve('@opentelemetry/instrumentation/hook.mjs')).href,
      '--import', pathToFileURL(join(root, mode === 'sdk-count-only' ? 'scripts/sdk-http-count-preload.mjs' : 'src/otel-preload.mjs')).href];
    child = spawn(process.execPath, [...args, join(workspace, 'app.mjs')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    child.on('close', () => { closed = true; }); child.on('error', () => { row.failure = 'child_spawn_failed'; });
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16384); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
    child.on('message', message => {
      if (message === 'flowatlas:flushed') flushed = true;
      if (message?.qaSdkCounts && ['counted', 'invalid', 'uniqueTraces'].every(k => number(message.qaSdkCounts[k])))
        sdkCounts = Object.fromEntries(['counted', 'invalid', 'uniqueTraces'].map(k => [k, message.qaSdkCounts[k]]));
    });
    const origin = await waitFor(() => {
      if (row.failure || closed) throw Error('child_exited_before_ready');
      return stdout.match(/Registered app: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    });
    await workload(origin, 'warmup', 50, agent);
    row.measurement = await workload(origin, 'measured', 1000, agent);
    const metrics = await get(origin, '/__flowatlas_benchmark_metrics', agent); assert.equal(metrics.status, 200);
    const raw = JSON.parse(metrics.body), fields = ['requests', 'uniqueRequests', 'metricsRequests', 'invalid', 'cpuUserMicros', 'cpuSystemMicros', 'maxRssBytes'];
    assert.ok(fields.every(k => number(raw[k]))); row.metrics = Object.fromEntries(fields.map(k => [k, raw[k]]));
    assert.equal(raw.requests, 1050); assert.equal(raw.uniqueRequests, 1050); assert.equal(raw.metricsRequests, 1); assert.equal(raw.invalid, 0);
    agent.destroy();
    if (mode !== 'baseline') {
      child.send('flowatlas:shutdown'); await waitFor(() => flushed || sdkCounts, 5000);
      if (sdkCounts) { row.sdkCounts = sdkCounts; assert.deepEqual(sdkCounts, { counted: 1051, invalid: 0, uniqueTraces: 1051 }); }
      else {
        const rawSummary = JSON.parse(stderr.match(/^FlowAtlas trace summary: (\{[^\n]+\})$/m)?.[1] ?? 'null');
        const fields = ['httpSpans', 'invalidSpans', 'delivered', 'dropped', 'queued', 'inFlight'];
        assert.ok(rawSummary && fields.every(k => number(rawSummary[k])));
        row.delivery = Object.fromEntries(fields.map(k => [k, rawSummary[k]]));
        assert.deepEqual(row.delivery, { httpSpans: 1051, invalidSpans: 0, delivered: 1051, dropped: 0, queued: 0, inFlight: 0 });
        assert.equal(row.sinkReceived, 1051); assert.equal(traces.size, 1051);
      }
    }
    assert.equal(invalidSink, 0); assert.equal(row.sinkReceived, mode === 'sdk-production-exporter-sink' ? 1051 : 0);
    child.send('qa:stop'); await waitFor(() => closed, 5000); assert.equal(child.exitCode, 0);
    row.complete = true;
  } catch { row.failure ??= 'sdk_condition_validation_failed'; }
  finally {
    agent.destroy();
    if (child && !closed) {
      if (child.connected) child.send('qa:stop', () => {});
      try { await waitFor(() => closed, 1500); } catch { child.kill('SIGKILL'); try { await waitFor(() => closed, 1500); } catch {} }
    }
    if (sink) { sink.closeAllConnections(); await new Promise(resolve => sink.close(resolve)); sinkClosed = true; }
    if (row.complete && closed && sinkClosed && realpathSync(workspace) === workspace && inside(parent, workspace)
      && !lstatSync(workspace).isSymbolicLink()) {
      try { rmSync(workspace, { recursive: true, force: true }); row.workspaceRemoved = true; } catch { row.failure = 'workspace_cleanup_failed'; row.complete = false; }
    }
    if (!row.workspaceRemoved) row.retainedWorkspace = relative(root, workspace).replaceAll('\\', '/');
  }
  return row;
}
test('actual SDK HTTP count-only and production exporter sink costs remain diagnostic', { timeout: 180000 }, async () => {
  const output = join(root, 'reports/benchmarks'); mkdirSync(output, { recursive: true });
  const report = { id: new Date().toISOString().replace(/[:.]/g, '-'), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
    runtime: { node: process.version, platform: process.platform, osRelease: release() },
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'package.json', 'npm-shrinkwrap.json']).toString().trim()),
    runtimeDigests: Object.fromEntries(['src/otel-preload.mjs', 'src/otel-exporter.mjs', 'src/http-span-contract.mjs', 'src/evidence-time.mjs', 'scripts/http-benchmark-fixture.mjs',
      'scripts/sdk-http-count-preload.mjs', 'scripts/benchmark-statistics.mjs', 'package.json', 'npm-shrinkwrap.json']
      .map(file => [file, hash(readFileSync(join(root, file)))])),
    scriptDigest: hash(readFileSync(fileURLToPath(import.meta.url))), preloadDigest: hash(readFileSync(join(root, 'scripts/sdk-http-count-preload.mjs'))),
    fixtureDigest: hash(appSource), generatedFixtureDigest: hash(app),
    controlledFault: controlledFault ? 'sink-reject' : null,
    evidenceKind: 'actual SDK HTTP instrumentation on synthetic shared fixture; no business app or durable collector',
    performanceAcceptance: { assessable: false, met: null, reason: 'sdk_component_diagnostic' },
    workload: { rounds: 3, warmup: 50, measured: 1000, concurrency: 8, expectedSdkSpans: 1051 },
    scope: { countOnly: 'SDK span creation/context/instrumentation plus count-only exporter; no normalization, transport or persistence',
      sink: 'production preload/exporter with controlled HTTP acknowledgement sink; no graph validation or storage',
      timing: 'request p95 excludes startup and shutdown; CPU/RSS app metrics include warmup and metric request; no subtraction of unrelated workloads' }, conditions: [] };
  try {
    for (let round = 1; round <= 3; round++) for (let i = 0; i < 3; i++) report.conditions.push(await condition(modes[(round - 1 + i) % 3], round));
  } finally {
    const path = join(output, 'sdk-http-' + report.id + '.json'); writeFileSync(path, JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log('SDK HTTP diagnostic report: ' + relative(root, path).replaceAll('\\', '/'));
    console.log(JSON.stringify(report.conditions.map(r => ({ mode: r.mode, round: r.round, complete: r.complete,
      p95Ms: r.measurement?.p95Ms, counted: r.sdkCounts?.counted, ack: r.delivery?.delivered, failure: r.failure }))));
  }
  assert.equal(report.conditions.length, 9); assert.ok(report.conditions.every(r => r.complete && r.workspaceRemoved), 'SDK diagnostic conditions failed; preserve report and fixture');
});
