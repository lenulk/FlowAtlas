import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, lstatSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { release } from 'node:os';
import { startServers } from '../src/server.mjs';
import { JsonActionStore } from '../src/action-store.mjs';
import { getCodeVersion } from '../src/flowatlas.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const count = 1051;
const controlledFault = process.env.FLOWATLAS_COLLECTOR_COST_FAULT === 'transport-reject';
const workerSource = `import { LocalHttpSpanExporter } from ${JSON.stringify(pathToFileURL(join(root, 'src/otel-exporter.mjs')).href)};
import { performance } from 'node:perf_hooks';
process.once('message', async (config) => {
  const exporter = new LocalHttpSpanExporter({ ...config, timing: true, capacity: 2048, timeoutMs: 1000 });
  const spans = Array.from({ length: ${count} }, (_, index) => ({ kind: 1,
    spanContext: () => ({ traceId: (index + 1).toString(16).padStart(32, '0'), spanId: '1'.padStart(16, '0') }),
    startTime: [1790812800, 0], endTime: [1790812800, 100000000], duration: [0, 100000000],
    status: { code: 0 }, attributes: { 'http.request.method': 'GET', 'http.response.status_code': 200 } }));
  const started = performance.now(), cpu = process.cpuUsage();
  exporter.export(spans, () => {});
  await exporter.shutdown();
  const used = process.cpuUsage(cpu);
  process.send({ summary: exporter.summary(), health: exporter.deliveryHealth(), timing: exporter.timingHealth(), transport: exporter.transportHealth(),
    elapsedMs: performance.now() - started, cpuUserMicros: used.user, cpuSystemMicros: used.system }, () => process.disconnect());
});
process.send('ready');
`;
const inside = (parent, path) => {
  const value = relative(parent, path);
  return Boolean(value) && !value.startsWith('..') && !isAbsolute(value);
};
const numeric = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function sanitizeWorker(value) {
  const groups = { summary: ['httpSpans', 'invalidSpans', 'delivered', 'dropped', 'queued', 'inFlight'],
    health: ['overflow', 'invalid', 'rejected', 'timeout', 'transport', 'shutdown'],
    transport: ['batches', 'submittedSpans', 'smallBatches', 'peakRequests'],
    timing: ['batches', 'acknowledgedBatches', 'batchTotalMs', 'batchMaxMs', 'firstBatchMs', 'shutdownQueued',
      'shutdownInFlight', 'shutdownDelivered', 'shutdownMs', 'deadlineFired', 'deadlineLateMs'] };
  const result = {};
  if (!value || !['elapsedMs', 'cpuUserMicros', 'cpuSystemMicros'].every(key => numeric(value[key]))) return null;
  for (const [group, fields] of Object.entries(groups)) {
    if (!value[group] || !fields.every(key => numeric(value[group][key]))) return null;
    result[group] = Object.fromEntries(fields.map(key => [key, value[group][key]]));
  }
  for (const key of ['elapsedMs', 'cpuUserMicros', 'cpuSystemMicros']) result[key] = value[key];
  return result;
}

async function condition(mode, round) {
  const storageRoot = join(root, 'reports/storage'); mkdirSync(storageRoot, { recursive: true });
  const parent = realpathSync(storageRoot);
  if (!inside(realpathSync(root), parent) || lstatSync(storageRoot).isSymbolicLink()) throw new Error('unsafe_diagnostic_parent');
  const workspace = realpathSync(mkdtempSync(join(parent, 'collector-cost-')));
  if (!inside(parent, workspace) || lstatSync(workspace).isSymbolicLink()) throw new Error('unsafe_diagnostic_workspace');
  const result = { mode, round, evidenceKind: 'simulated span replay; no application or SDK span creation',
    durable: mode === 'disk', complete: false, worker: null, storageTiming: null, received: null,
    retainedActions: null, reloadVerified: false, failure: null, workerOutcome: null, workspaceRemoved: false, retainedWorkspace: null };
  const sessionToken = randomBytes(32).toString('base64url');
  let servers, sink, child, childClosed = false, cleanClosed = false, received = 0;
  try {
    mkdirSync(join(workspace, 'app'));
    writeFileSync(join(workspace, 'app/worker.mjs'), workerSource, { flag: 'wx' });
    let port, digest;
    if (mode === 'transport') {
      digest = createHash('sha256').update('component diagnostic only').digest('hex');
      sink = createServer(async (req, res) => {
        if (controlledFault && round === 1) { req.resume(); res.writeHead(503); res.end(); return; }
        if (req.method !== 'POST' || req.url !== '/flowatlas/ingest' || req.headers.authorization !== `Bearer ${sessionToken}`) { res.writeHead(403); res.end(); return; }
        try {
          let body = ''; for await (const part of req) { body += part; if (body.length > 16384) throw new Error('oversize'); }
          const batch = JSON.parse(body);
          if (batch.kind !== 'otel-span-batch' || batch.projectId !== 'component' || batch.codeDigest !== digest
            || !Array.isArray(batch.items) || batch.items.length < 1 || batch.items.length > 32) throw new Error('invalid');
          received += batch.items.length; res.writeHead(201); res.end('{}');
        } catch { res.writeHead(400); res.end(); }
      });
      await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve)); port = sink.address().port;
    } else {
      servers = await startServers({ port: 0, inventoryPort: 0, dataDir: mode === 'disk' ? 'data/actions' : null,
        workspace, sessionToken, traceTiming: true, projects: [{ id: 'component', root: 'app', files: ['worker.mjs'] }] });
      port = servers.port; digest = servers.atlas.projectSources.version('component').digest;
    }
    const workerEnv = { ...process.env };
    delete workerEnv.NODE_OPTIONS; delete workerEnv.NODE_TEST_CONTEXT;
    for (const key of Object.keys(workerEnv)) if (key.startsWith('OTEL_')) delete workerEnv[key];
    child = spawn(process.execPath, [join(workspace, 'app/worker.mjs')], { cwd: root, env: workerEnv,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    let report;
    const ended = new Promise(resolve => { child.once('close', (code, signal) => { childClosed = true; resolve({ code, signal }); }); child.once('error', () => resolve({ code: null, signal: 'spawn_error' })); });
    child.on('message', message => {
      if (message === 'ready') {
        try { child.send({ collectorUrl: `http://127.0.0.1:${port}`, projectId: 'component', codeDigest: digest, sessionToken }, () => {}); }
        catch { child.kill('SIGKILL'); }
      }
      else report = sanitizeWorker(message);
    });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
    let outcome; try { outcome = await ended; } finally { clearTimeout(deadline); }
    result.workerOutcome = { exitCode: Number.isInteger(outcome.code) ? outcome.code : null,
      signal: ['SIGKILL', 'SIGTERM', 'SIGINT', 'spawn_error'].includes(outcome.signal) ? outcome.signal : outcome.signal ? 'other' : null };
    if (outcome.code !== 0 || outcome.signal || !report) throw new Error('worker_diagnostic_failed');
    result.worker = report;
    const summary = report.summary;
    result.complete = summary.httpSpans === count && summary.delivered === count && summary.dropped === 0
      && summary.invalidSpans === 0 && summary.queued === 0 && summary.inFlight === 0
      && report.transport.submittedSpans === count && report.transport.peakRequests <= 2
      && report.transport.batches >= Math.ceil(count / 32);
    if (mode === 'transport') {
      result.received = received; result.complete &&= received === count;
    } else {
      const graphs = [...servers.atlas.actions.values()]; result.retainedActions = graphs.length;
      const expected = Array.from({ length: 100 }, (_, index) => (count - 99 + index).toString(16).padStart(32, '0'));
      result.complete &&= graphs.length === 100 && graphs.every((graph, index) => graph.trace.traceId === expected[index]
        && graph.trace.spans.length === 1 && graph.trace.spans[0].httpStatus === 200 && graph.outcome === 'success');
      result.storageTiming = servers.atlas.store?.timingHealth() ?? null;
      if (mode === 'disk') {
        const before = JSON.stringify(graphs); await servers.close(); servers = null;
        const reopened = new JsonActionStore(join(workspace, 'data/actions'));
        try { result.reloadVerified = JSON.stringify(reopened.load(100)) === before; } finally { reopened.close(); }
        result.complete &&= result.reloadVerified;
      }
    }
    if (!result.complete) result.failure = 'component_capture_or_reload_failed';
  } catch (error) {
    result.failure = ['worker_diagnostic_failed', 'component_capture_or_reload_failed'].includes(error.message) ? error.message : 'component_setup_or_execution_failed';
  } finally {
    try {
      if (servers) await servers.close();
      if (sink) { sink.closeAllConnections(); await new Promise(resolve => sink.close(resolve)); }
      cleanClosed = true;
    } catch { result.failure ??= 'collector_cleanup_failed'; }
    const canonical = realpathSync(workspace);
    if (result.complete && !result.failure && childClosed && cleanClosed && canonical === workspace && inside(parent, canonical)
      && !lstatSync(canonical).isSymbolicLink() && !existsSync(join(canonical, 'data/actions/.writer.lock'))) {
      try { rmSync(canonical, { recursive: true, force: true }); result.workspaceRemoved = true; }
      catch { result.failure = 'workspace_cleanup_failed'; }
    }
    if (!result.workspaceRemoved) result.retainedWorkspace = relative(root, workspace).replaceAll('\\', '/');
  }
  return result;
}

test('component collector cost diagnostic uses simulated replay, never performance or SDK acceptance', { timeout: 150000 }, async () => {
  const directory = join(root, 'reports/benchmarks'); mkdirSync(directory, { recursive: true });
  if (!inside(realpathSync(root), realpathSync(directory)) || lstatSync(directory).isSymbolicLink()) throw new Error('unsafe_diagnostic_report_directory');
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const version = getCodeVersion(root);
  const report = { id, sourceCommit: version.commit, sourceDigest: version.digest, sourceDirty: version.dirty,
    sourceScope: 'core tool snapshot; diagnostic script and generated fixture identified separately',
    diagnosticScriptDigest: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    fixtureDigest: createHash('sha256').update(workerSource).digest('hex'),
    runtime: { node: process.version, platform: process.platform, osRelease: release() },
    evidenceKind: 'component diagnostic with simulated normalized HTTP spans; not application/SDK workload or pilot',
    workload: { spans: count, rounds: 3, burst: true, exporterCapacity: 2048, uploadTimeoutMs: 1000, shutdownDeadlineMs: 900, slots: 2, batchLimit: 32 },
    controlledFault: controlledFault ? 'transport-reject' : null,
    performanceAcceptance: { assessable: false, met: null, reason: 'component_diagnostic' }, conditions: [] };
  for (let round = 0; round < 3; round++) {
    const modes = ['transport', 'memory', 'disk']; const order = modes.slice(round).concat(modes.slice(0, round));
    for (const mode of order) report.conditions.push(await condition(mode, round + 1));
  }
  writeFileSync(join(directory, `collector-cost-${controlledFault ? 'fault-' : ''}${id}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report.conditions.map(value => ({ mode: value.mode, round: value.round, complete: value.complete,
    elapsedMs: value.worker?.elapsedMs, delivered: value.worker?.summary.delivered, dropped: value.worker?.summary.dropped,
    storageTiming: value.storageTiming, reloadVerified: value.reloadVerified, failure: value.failure }))));
  assert.ok(report.conditions.every(value => value.complete && !value.failure && value.workspaceRemoved), 'Component capture/reload failed; sanitized diagnostic report retained.');
});
