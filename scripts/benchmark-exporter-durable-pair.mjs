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
import { ProjectSources } from '../src/project-sources.mjs';
import { createDurableHttpAdmission } from './durable-http-admission-prototype.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const count = 1051;
const slow = process.env.FLOWATLAS_SLOW_FSYNC_QA === '1';
const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, path) => {
  const part = relative(parent, path);
  return Boolean(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../') && !isAbsolute(part);
};

// The exact same generated sender is used for both collectors. No real SDK or
// business application creates these simulated SDK-shaped spans.
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

const numeric = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function sanitizeWorker(value) {
  const groups = { summary: ['httpSpans', 'invalidSpans', 'delivered', 'dropped', 'queued', 'inFlight'],
    health: ['overflow', 'invalid', 'rejected', 'timeout', 'transport', 'shutdown'],
    transport: ['batches', 'submittedSpans', 'smallBatches', 'peakRequests'],
    timing: ['batches', 'acknowledgedBatches', 'batchTotalMs', 'batchMaxMs', 'firstBatchMs',
      'shutdownQueued', 'shutdownInFlight', 'shutdownDelivered', 'shutdownMs', 'deadlineFired', 'deadlineLateMs'] };
  if (!value || !['elapsedMs', 'cpuUserMicros', 'cpuSystemMicros'].every(key => numeric(value[key]))) return null;
  const result = {};
  for (const [group, fields] of Object.entries(groups)) {
    if (!value[group] || !fields.every(key => numeric(value[group][key]))) return null;
    result[group] = Object.fromEntries(fields.map(key => [key, value[group][key]]));
  }
  for (const key of ['elapsedMs', 'cpuUserMicros', 'cpuSystemMicros']) result[key] = value[key];
  return result;
}

function observeSaves(store) {
  const save = store.save.bind(store);
  const seen = new Set();
  let acceptedCount = 0, lastSaved = [], observerFailure = false;
  store.save = function (actions) {
    const value = save(actions);
    try {
      const current = new Set();
      for (const graph of actions) {
        const id = graph?.trace?.traceId;
        if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)
          || BigInt(`0x${id}`) < 1n || BigInt(`0x${id}`) > BigInt(count) || current.has(id)) {
          observerFailure = true; continue;
        }
        current.add(id);
        if (!seen.has(id)) { seen.add(id); acceptedCount++; }
      }
      // Every trace is new in this fixed fixture, so later saves do not mutate
      // these graph objects. Retain the last committed array without adding a
      // second full-history clone to each measured collector write.
      lastSaved = actions;
    } catch { observerFailure = true; }
    return value;
  };
  return () => ({ acceptedCount, acceptedUnique: seen.size, lastSaved, observerFailure });
}

async function boundedClose(start, force, milliseconds = 3000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(start).then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => { try { force(); } catch {} resolve(false); }, milliseconds); })]);
  } finally { clearTimeout(timer); }
}

async function condition(mode, round) {
  const storageRoot = join(root, 'reports/storage'); mkdirSync(storageRoot, { recursive: true });
  const parent = realpathSync(storageRoot);
  if (!inside(realpathSync(root), parent) || lstatSync(storageRoot).isSymbolicLink()) throw new Error('unsafe_diagnostic_parent');
  const workspace = realpathSync(mkdtempSync(join(parent, 'collector-cost-')));
  if (!inside(parent, workspace) || lstatSync(workspace).isSymbolicLink()) throw new Error('unsafe_diagnostic_workspace');
  const directory = join(workspace, 'data/actions');
  const row = { mode, round, complete: false, failure: null, worker: null, workerOutcome: null,
    childClosed: false, serverClosed: false, storeClosed: false,
    storageTiming: null, acceptedCount: 0, acceptedUnique: 0, observerFailure: false,
    retainedActions: null, expectedRetainedOrderDigest: null, actualRetainedOrderDigest: null,
    reloadVerified: false, responseFinished: { accepted202: 0, unavailable503: 0, other: 0 },
    qaSnapshot: null, workspaceRemoved: false, retainedWorkspace: null };
  const sessionToken = randomBytes(32).toString('base64url');
  let servers, qaServer, qa, store, child, childClosed = false, serverClosed = false, storeClosed = false;
  let observed = () => ({ acceptedCount: 0, acceptedUnique: 0, lastSaved: [], observerFailure: false });
  try {
    mkdirSync(join(workspace, 'app'));
    writeFileSync(join(workspace, 'app/worker.mjs'), workerSource, { flag: 'wx' });
    let port, codeDigest;
    if (mode === 'production') {
      servers = await startServers({ port: 0, inventoryPort: 0, dataDir: 'data/actions', workspace,
        sessionToken, traceTiming: true, projects: [{ id: 'component', root: 'app', files: ['worker.mjs'] }],
        onStorageError: () => {} });
      store = servers.atlas.store;
      port = servers.port;
      codeDigest = servers.atlas.projectSources.version('component').digest;
      servers.app.on('request', (_request, response) => response.once('finish', () => {
        if (response.statusCode === 202) row.responseFinished.accepted202++;
        else if (response.statusCode === 503) row.responseFinished.unavailable503++;
        else row.responseFinished.other++;
      }));
    } else {
      mkdirSync(directory, { recursive: true });
      store = new JsonActionStore(directory, { timing: true });
      const sources = new ProjectSources(workspace, [{ id: 'component', root: 'app', files: ['worker.mjs'] }]);
      codeDigest = sources.version('component').digest;
      qa = createDurableHttpAdmission({ store, version: getCodeVersion(root), projectSources: sources });
      qaServer = createServer((request, response) => {
        response.once('finish', () => {
          if (response.statusCode === 202) row.responseFinished.accepted202++;
          else if (response.statusCode === 503) row.responseFinished.unavailable503++;
          else row.responseFinished.other++;
        });
        if (request.method !== 'POST' || request.url !== '/flowatlas/ingest'
          || request.headers.authorization !== `Bearer ${sessionToken}`) {
          request.resume(); response.writeHead(403); response.end(); return;
        }
        // Exporter route/auth stays unchanged; the QA adapter alone selects the prototype route.
        request.url = '/qa/ingest';
        void qa.handle(request, response);
      });
      await new Promise((resolve, reject) => {
        qaServer.once('error', reject); qaServer.listen(0, '127.0.0.1', resolve);
      });
      port = qaServer.address().port;
    }
    observed = observeSaves(store);
    const workerEnv = { ...process.env };
    delete workerEnv.NODE_OPTIONS; delete workerEnv.NODE_TEST_CONTEXT;
    for (const key of Object.keys(workerEnv)) if (key.startsWith('OTEL_')) delete workerEnv[key];
    child = spawn(process.execPath, [join(workspace, 'app/worker.mjs')], { cwd: root, env: workerEnv,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    let report;
    const ended = new Promise(resolve => {
      child.once('close', (code, signal) => { childClosed = true; resolve({ code, signal }); });
      child.once('error', () => resolve({ code: null, signal: 'spawn_error' }));
    });
    child.on('message', message => {
      if (message === 'ready') {
        try { child.send({ collectorUrl: `http://127.0.0.1:${port}`, projectId: 'component', codeDigest, sessionToken }, () => {}); }
        catch { child.kill('SIGKILL'); }
      } else report = sanitizeWorker(message);
    });
    const workerTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
    let outcome;
    try { outcome = await ended; } finally { clearTimeout(workerTimer); }
    row.workerOutcome = { exitCode: Number.isInteger(outcome.code) ? outcome.code : null,
      signal: ['SIGKILL', 'SIGTERM', 'SIGINT', 'spawn_error'].includes(outcome.signal) ? outcome.signal : outcome.signal ? 'other' : null };
    if (outcome.code !== 0 || outcome.signal || !report) throw new Error('worker_diagnostic_failed');
    row.worker = report;
  } catch (error) {
    row.failure = error.message === 'worker_diagnostic_failed' ? error.message : 'component_setup_or_execution_failed';
  } finally {
    if (child && !childClosed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try {
      if (servers) serverClosed = await boundedClose(() => servers.close(),
        () => { servers.app.closeAllConnections(); servers.inventory.closeAllConnections(); });
      if (qaServer) {
        serverClosed = await boundedClose(() => new Promise(resolve => qaServer.close(resolve)),
          () => qaServer.closeAllConnections());
        qa.close();
        row.qaSnapshot = qa.snapshot();
        if (serverClosed) { store.close(); storeClosed = true; }
      }
      if (mode === 'qa' && store && !qaServer) { qa?.close(); store.close(); storeClosed = true; }
      if (servers && serverClosed) storeClosed = true;
    } catch { row.failure ??= 'collector_cleanup_failed'; }
    if (!serverClosed) row.failure ??= 'collector_cleanup_failed';
    row.childClosed = childClosed;
    row.serverClosed = serverClosed;
    row.storeClosed = storeClosed;
    row.storageTiming = store?.timingHealth() ?? null;
    const state = observed();
    row.acceptedCount = state.acceptedCount; row.acceptedUnique = state.acceptedUnique;
    row.observerFailure = state.observerFailure;
    row.expectedRetainedOrderDigest = digest(JSON.stringify(state.lastSaved.map(graph => graph?.trace?.traceId ?? null)));
    if (serverClosed && storeClosed && !existsSync(join(directory, '.writer.lock'))) {
      try {
        const reopened = new JsonActionStore(directory);
        let graphs;
        try { graphs = reopened.load(100); } finally { reopened.close(); }
        row.retainedActions = graphs.length;
        row.actualRetainedOrderDigest = digest(JSON.stringify(graphs.map(graph => graph?.trace?.traceId ?? null)));
        row.reloadVerified = JSON.stringify(graphs) === JSON.stringify(state.lastSaved)
          && row.expectedRetainedOrderDigest === row.actualRetainedOrderDigest
          && graphs.every(graph => graph?.trace?.spans?.length === 1
            && graph.trace.spans[0].httpStatus === 200 && graph.outcome === 'success');
      } catch { row.failure ??= 'collector_reload_failed'; }
    }
    const w = row.worker;
    const accounted = Boolean(w && w.summary.httpSpans === count && w.summary.invalidSpans === 0
      && w.summary.delivered + w.summary.dropped === count && w.summary.queued === 0 && w.summary.inFlight === 0
      && w.transport.submittedSpans <= count && w.transport.peakRequests <= 2
      && Object.values(w.health).reduce((sum, value) => sum + value, 0) === w.summary.dropped);
    row.complete = !row.failure && accounted && w.summary.delivered === count && w.summary.dropped === 0
      && row.acceptedCount === count && row.acceptedUnique === count && !row.observerFailure
      && row.retainedActions === 100 && row.reloadVerified && row.storageTiming?.failures === 0
      && serverClosed && childClosed;
    if (!row.complete) row.failure ??= 'component_capture_or_reload_failed';
    const canonical = realpathSync(workspace);
    if (row.complete && canonical === workspace && inside(parent, canonical)
      && !lstatSync(canonical).isSymbolicLink() && !existsSync(join(directory, '.writer.lock'))) {
      try { rmSync(canonical, { recursive: true, force: true }); row.workspaceRemoved = true; }
      catch { row.failure = 'workspace_cleanup_failed'; row.complete = false; }
    }
    if (row.complete && !row.workspaceRemoved) {
      row.complete = false; row.failure = 'workspace_cleanup_unconfirmed';
    }
    if (!row.workspaceRemoved) row.retainedWorkspace = relative(root, workspace).replaceAll('\\', '/');
  }
  return row;
}

test('QA comparison replays the same exporter into production and durable-pair prototype collectors',
  { timeout: 150000 }, async () => {
    const directory = join(root, 'reports/benchmarks'); mkdirSync(directory, { recursive: true });
    if (!inside(realpathSync(root), realpathSync(directory)) || lstatSync(directory).isSymbolicLink())
      throw new Error('unsafe_diagnostic_report_directory');
    const id = new Date().toISOString().replace(/[:.]/g, '-');
    const source = getCodeVersion(root);
    const report = {
      id, sourceCommit: source.commit, sourceDigest: source.digest, sourceDirty: source.dirty,
      diagnosticScriptDigest: digest(readFileSync(fileURLToPath(import.meta.url))),
      prototypeDigest: digest(readFileSync(join(root, 'scripts/durable-http-admission-prototype.mjs'))),
      fixtureDigest: digest(workerSource), runtime: { node: process.version, platform: process.platform, osRelease: release() },
      evidenceKind: 'same simulated exporter worker; two distinct collector protocols; no application, SDK creation or pilot',
      protocolDifference: { production: { route: '/flowatlas/ingest', auth: 'session bearer', status: 202, body: 'action results' },
        qa: { exporterRouteAdapter: '/flowatlas/ingest to /qa/ingest', auth: 'QA exact bearer check', status: 202, body: 'fixed accepted true', staging: 'deep-cloned committed actions' },
        comparedAs: 'aggregate collector prototype, not grouping-only isolation' },
      workload: { spans: count, rounds: 3, burst: true, exporterCapacity: 2048,
        uploadTimeoutMs: 1000, shutdownDeadlineMs: 900, slots: 2, batchLimit: 32 },
      controlledSync: slow ? { requestedDelayMs: 120, scope: 'explicit existing QA preload on canonical collector-cost state temp files; outer guard verifies actual calls' } : null,
      storageCounters: 'JsonActionStore timing on successful saves; only controlled preload separately counts fsync injection',
      retainedOrderEvidence: 'post-save full-state monitor versus reloaded store, not independent sender order',
      performanceAcceptance: { assessable: false, met: null, reason: 'component_diagnostic' }, pairs: [],
    };
    for (let round = 1; round <= 3; round++) {
      const order = round % 2 ? ['production', 'qa'] : ['qa', 'production'];
      const pair = { round, order };
      for (const mode of order) pair[mode] = await condition(mode, round);
      report.pairs.push(pair);
    }
    const name = `exporter-durable-pair-${slow ? 'slow-' : ''}${id}.json`;
    writeFileSync(join(directory, name), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`Exporter durable pair report: reports/benchmarks/${name}`);
    assert.ok(report.pairs.every(pair => ['production', 'qa'].every(mode =>
      pair[mode].complete && !pair[mode].failure && pair[mode].workspaceRemoved)),
    'Exporter durable pair capture/reload failed; sanitized report retained.');
  });
