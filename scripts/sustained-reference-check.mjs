import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, lstatSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { release } from 'node:os';
import { startServers } from '../src/server.mjs';
import { JsonActionStore } from '../src/action-store.mjs';
import { getCodeVersion } from '../src/flowatlas.mjs';
import { parseTiming, exporterTimingFields, storageTimingFields } from './trace-timing-report.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const durationMs = Number(process.env.FLOWATLAS_SUSTAINED_DURATION_MS ?? 1800000);
if (!Number.isSafeInteger(durationMs) || durationMs < 4000 || durationMs > 1800000) throw Error('invalid_qa_duration');
const limits = Object.freeze({ workers: 20, durationMs: 1800000, targetMaxRssBytes: 512 * 1024 * 1024,
  driverCollectorMaxRssBytes: 512 * 1024 * 1024, stateFileMaxBytes: 64 * 1024 * 1024,
  bufferedSpans: 2048, inFlightSpans: 64, uploadSlots: 2, retainedGraphs: 100 });
const app = `import { createServer } from 'node:http';
const next = Array(20).fill(0); let requests = 0, completed = 0, invalid = 0, active = 0, peak = 0;
const server = createServer((req,res)=>{
 const match=/^\\/reference\\/(\\d+)\\/(\\d+)$/.exec(req.url??'');
 const worker=Number(match?.[1]),sequence=Number(match?.[2]);
 if(req.method!=='GET'||!match||worker>=20||sequence!==next[worker]){invalid++;res.writeHead(409);res.end('invalid');return;}
 next[worker]++;requests++;active++;peak=Math.max(peak,active);
 const fault=process.env.FLOWATLAS_SUSTAINED_FAULT==='business-status'&&requests===1;
 setTimeout(()=>{active--;completed++;
  res.writeHead(fault?409:200);
  res.end('reference:'+worker+':'+sequence+':ok');},100);
});
const emit=()=>process.connected&&process.send({qaSustainedApp:{requests,completed,invalid,active,peak,maxRssBytes:process.resourceUsage().maxRSS*1024}},()=>{});
const timer=setInterval(emit,1000);timer.unref();
process.on('message',message=>{if(message==='qa:metrics')emit();if(message==='qa:stop'){clearInterval(timer);server.close(()=>process.disconnect());}});
server.listen(0,'127.0.0.1',()=>process.send({qaReadyPort:server.address().port},()=>{}));
`;
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, path) => { const v = relative(parent, path); return Boolean(v) && !v.startsWith('..') && !isAbsolute(v); };
const number = value => Number.isSafeInteger(value) && value >= 0;
function fields(value, names) {
  return value && names.every(k => number(value[k])) ? Object.fromEntries(names.map(k => [k, value[k]])) : null;
}
async function waitFor(check, ms = 12000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error('reference_deadline');
}
function get(port, path, agent) {
  return new Promise(resolve => {
    let done = false, body = '', bytes = 0;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const req = request({ hostname: '127.0.0.1', port, path, agent }, res => {
      res.on('data', chunk => { bytes += chunk.length; if (bytes <= 256) body += chunk; });
      res.on('end', () => finish({ status: res.statusCode, body, bytes }));
      res.on('error', () => finish({ status: 0, body: '', bytes: 0 }));
    });
    const timer = setTimeout(() => req.destroy(), 10000);
    req.on('error', () => finish({ status: 0, body: '', bytes: 0 })); req.end();
  });
}

test('bounded sustained reference HTTP workload uses actual SDK and durable reload, never pilot acceptance',
  { timeout: durationMs + 60000 }, async () => {
    const parentPath = join(root, 'reports/storage'); mkdirSync(parentPath, { recursive: true });
    const parent = realpathSync(parentPath);
    assert.ok(inside(realpathSync(root), parent) && !lstatSync(parentPath).isSymbolicLink());
    const workspace = realpathSync(mkdtempSync(join(parent, 'sustained-reference-')));
    assert.ok(inside(parent, workspace) && !lstatSync(workspace).isSymbolicLink());
    const id = new Date().toISOString().replace(/[:.]/g, '-'), version = getCodeVersion(root);
    const report = { id, sourceCommit: version.commit, sourceDigest: version.digest, sourceDirty: version.dirty,
      scriptDigest: hash(readFileSync(fileURLToPath(import.meta.url))), fixtureDigest: hash(app),
      probeDigest: hash(readFileSync(join(root, 'scripts/sustained-exporter-probe.mjs'))),
      runtime: { node: process.version, platform: process.platform, osRelease: release() },
      evidenceKind: 'owned synthetic HTTP reference; actual SDK/exporter/JSON disk; not business app or user pilot',
      limits, requestedDurationMs: durationMs, fault: ['business-status','collector-reject'].includes(process.env.FLOWATLAS_SUSTAINED_FAULT) ? process.env.FLOWATLAS_SUSTAINED_FAULT : null,
      performanceAcceptance: { assessable: false, met: null, reason: 'unpaired_sustained_reference' },
      sustainedAcceptance: { assessable: durationMs === limits.durationMs, met: null },
      complete: false, failure: null, phase: 'setup', errorCode: null, responses: 0, acceptedSpans: 0, invalidGraphs: 0,
      driverCollectorMaxRssBytes: 0, peakStateFileBytes: 0, maxRetained: 0, samples: 0,
      observedDurationMs: 0, app: null, exporter: null, summary: null, reloadVerified: false,
      dropReasons: null, rejectionStatuses: null, exporterTiming: null, storageTiming: null,
      storageErrors: [], storageErrorsOmitted: 0, collectorRejects: 0,
      childClosed: false, collectorClosed: false, workspaceRemoved: false, retainedWorkspace: null,
      limitations: ['No baseline latency comparison', 'No browser action or business handler mapping',
        'Identity uniqueness checked within bounded retained window; no unbounded all-trace history',
        'State-file peak measured after commits; total filesystem/temporary-file footprint is not assessed'] };
    const token = randomBytes(32).toString('base64url'), tail = new Map();
    let servers, child, readyPort, closed = false, flushed = false, stdout = '', stderr = '', probe, metrics, interval;
    const agent = new Agent({ keepAlive: true, maxSockets: limits.workers });
    const fail = reason => { report.failure ??= reason; };
    const observeResources = () => {
      report.driverCollectorMaxRssBytes = Math.max(report.driverCollectorMaxRssBytes, process.resourceUsage().maxRSS * 1024);
      if (report.driverCollectorMaxRssBytes > limits.driverCollectorMaxRssBytes) fail('driver_memory_limit');
      if (probe && (probe.maxRssBytes > limits.targetMaxRssBytes || probe.peakBuffered > limits.bufferedSpans
        || probe.peakInFlight > limits.inFlightSpans || probe.peakRequests > limits.uploadSlots || probe.dropped)) fail('exporter_resource_or_drop');
    };
    try {
      mkdirSync(join(workspace, 'app'));
      writeFileSync(join(workspace, 'app/app.mjs'), app, { flag: 'wx' });
      servers = await startServers({ port: 0, inventoryPort: 0, workspace, dataDir: 'data/actions', sessionToken: token, traceTiming: true,
        onStorageError: value => {
          // startServers supplies fixed-vocabulary storageErrorDiagnostic fields.
          const names = ['code','operation','stage','causeCode'];
          if (!names.every(k => typeof value[k] === 'string' && /^[A-Za-z_]{1,32}$/.test(value[k]))) { report.storageErrorsOmitted++; return; }
          const found = report.storageErrors.find(item => names.every(k => item[k] === value[k]));
          if (found) found.count++;
          else if (report.storageErrors.length < 16) report.storageErrors.push({ ...Object.fromEntries(names.map(k => [k,value[k]])), count: 1 });
          else report.storageErrorsOmitted++;
        },
        projects: [{ id: 'sustained-reference', root: 'app', files: ['app.mjs'] }] });
      if (report.fault === 'collector-reject') {
        const handlers = servers.app.listeners('request'); assert.equal(handlers.length, 1);
        const original = handlers[0]; servers.app.off('request', original);
        servers.app.on('request', (req, res) => {
          if (req.method === 'POST' && req.url === '/flowatlas/ingest' && report.collectorRejects === 0) {
            report.collectorRejects++; req.resume(); res.writeHead(503); res.end(); return;
          }
          original.call(servers.app, req, res);
        });
      }
      const digest = servers.atlas.projectSources.version('sustained-reference').digest;
      const commit = servers.atlas.putTraceGraphs;
      servers.atlas.putTraceGraphs = function (graphs) {
        const result = commit.call(this, graphs);
        for (const graph of graphs) {
          report.acceptedSpans += graph.trace.spans.length;
          if (graph.trace.spans.length !== 1 || graph.trace.spans[0].kind !== 'SERVER'
            || graph.trace.spans[0].httpStatus !== 200 || graph.outcome !== 'success') report.invalidGraphs++;
          tail.set(graph.id, graph.trace.traceId); if (tail.size > limits.retainedGraphs) tail.delete(tail.keys().next().value);
        }
        report.maxRetained = Math.max(report.maxRetained, this.actions.size);
        report.peakStateFileBytes = Math.max(report.peakStateFileBytes, statSync(join(workspace, 'data/actions/state.json')).size);
        if (report.maxRetained > limits.retainedGraphs || report.peakStateFileBytes > limits.stateFileMaxBytes) fail('storage_resource_limit');
        return result;
      };
      const env = { ...process.env, FLOWATLAS_URL: `http://127.0.0.1:${servers.port}`, FLOWATLAS_PROJECT_ID: 'sustained-reference',
        FLOWATLAS_TRACE_DIGEST: digest, FLOWATLAS_SESSION_TOKEN: token, FLOWATLAS_TRACE_TIMING: '1' };
      delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
      for (const key of Object.keys(env)) if (key.startsWith('OTEL_')) delete env[key];
      child = spawn(process.execPath, ['--experimental-loader',
        pathToFileURL(createRequire(import.meta.url).resolve('@opentelemetry/instrumentation/hook.mjs')).href,
        '--import', pathToFileURL(join(root, 'scripts/sustained-exporter-probe.mjs')).href,
        '--import', pathToFileURL(join(root, 'src/otel-preload.mjs')).href, join(workspace, 'app/app.mjs')],
        { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.once('close', () => { closed = true; }); child.once('error', () => fail('child_spawn_failed'));
      child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16384); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
      child.on('message', message => {
        if (number(message?.qaReadyPort) && message.qaReadyPort > 0 && message.qaReadyPort < 65536) readyPort = message.qaReadyPort;
        if (message === 'flowatlas:flushed') flushed = true;
        if (message?.qaSustainedExporter) {
          probe = fields(message.qaSustainedExporter, ['httpSpans','invalidSpans','delivered','dropped','queued','inFlight',
            'peakBuffered','peakInFlight','peakRequests','maxRssBytes']); report.samples++; observeResources();
        }
        if (message?.qaSustainedApp) metrics = fields(message.qaSustainedApp, ['requests','completed','invalid','active','peak','maxRssBytes']);
      });
      report.phase = 'ready';
      await waitFor(() => { if (closed || report.failure) throw Error('reference_startup_failed'); return readyPort; });
      report.phase = 'workload';
      const started = performance.now(), until = started + durationMs;
      interval = setInterval(() => {
        observeResources();
        console.log(JSON.stringify({ referenceElapsedSeconds: Math.round((performance.now()-started)/1000),
          responses: report.responses, acceptedSpans: report.acceptedSpans, driverMaxRssBytes: report.driverCollectorMaxRssBytes,
          targetMaxRssBytes: probe?.maxRssBytes ?? null, peakBuffered: probe?.peakBuffered ?? null, failure: report.failure }));
      }, 30000);
      await Promise.all(Array.from({ length: limits.workers }, async (_, worker) => {
        let sequence = 0;
        while (performance.now() < until && !report.failure) {
          const body = `reference:${worker}:${sequence}:ok`, result = await get(readyPort, `/reference/${worker}/${sequence}`, agent);
          if (result.status !== 200 || result.body !== body || result.bytes !== Buffer.byteLength(body)) fail('business_response_mismatch');
          else report.responses++;
          sequence++;
        }
      }));
      report.observedDurationMs = performance.now() - started;
      clearInterval(interval); interval = null; agent.destroy();
      report.phase = 'flush';
      child.send('qa:metrics'); child.send('flowatlas:shutdown');
      await waitFor(() => flushed || closed, 5000); assert.ok(flushed);
      const raw = JSON.parse(stderr.match(/^FlowAtlas trace summary: (\{[^\n]+\})$/m)?.[1] ?? 'null');
      report.summary = fields(raw, ['httpSpans','invalidSpans','delivered','dropped','queued','inFlight']);
      const fromOutput = (label, names) => {
        const line = stderr.split('\n').find(line => line.startsWith(label));
        try { return fields(JSON.parse(line?.slice(label.length)), names); } catch { return null; }
      };
      report.dropReasons = fromOutput('FlowAtlas trace delivery health: ', ['overflow','invalid','rejected','timeout','transport','shutdown']);
      report.rejectionStatuses = fromOutput('FlowAtlas trace rejection health: ', ['400','401','403','409','413','503','other']);
      report.exporterTiming = parseTiming(stderr, 'FlowAtlas trace timing: ', exporterTimingFields);
      assert.ok(report.dropReasons && report.rejectionStatuses && report.exporterTiming);
      const oldSamples = report.samples; child.send('qa:probe'); child.send('qa:metrics');
      await waitFor(() => report.samples > oldSamples && metrics?.active === 0, 3000);
      report.app = metrics; report.exporter = probe; observeResources();
      assert.ok(probe && report.samples > 0); assert.ok(metrics.maxRssBytes <= limits.targetMaxRssBytes);
      child.send('qa:stop'); await waitFor(() => closed, 5000); assert.equal(child.exitCode, 0);
      report.phase = 'validation';
      assert.equal(report.failure, null); assert.ok(report.responses >= 100);
      assert.deepEqual(report.summary, { httpSpans: report.responses, invalidSpans: 0, delivered: report.responses, dropped: 0, queued: 0, inFlight: 0 });
      assert.equal(metrics.requests, report.responses); assert.equal(metrics.completed, report.responses);
      assert.equal(metrics.invalid, 0); assert.equal(metrics.peak, limits.workers);
      assert.equal(report.acceptedSpans, report.responses); assert.equal(report.invalidGraphs, 0);
      const graphs = [...servers.atlas.actions.values()];
      assert.equal(graphs.length, limits.retainedGraphs);
      assert.deepEqual(graphs.map(g => g.trace.traceId), [...tail.values()]);
      assert.equal(new Set(graphs.map(g => g.trace.traceId)).size, graphs.length);
      report.phase = 'reload';
      report.storageTiming = parseTiming(JSON.stringify(servers.atlas.store.timingHealth()), '', storageTimingFields);
      const before = JSON.stringify(graphs); await servers.close(); servers = null; report.collectorClosed = true;
      const store = new JsonActionStore(join(workspace, 'data/actions'));
      try { report.reloadVerified = JSON.stringify(store.load(limits.retainedGraphs)) === before; } finally { store.close(); }
      assert.equal(report.reloadVerified, true);
      report.complete = true; report.phase = 'done';
    } catch (error) {
      if (['ERR_ASSERTION','ENOENT','EACCES','EPERM','EIO'].includes(error.code)) report.errorCode = error.code;
      fail('reference_capture_or_execution_failed');
    }
    finally {
      clearInterval(interval); agent.destroy();
      if (child && !closed) {
        if (child.connected) child.send('qa:stop', () => {});
        try { await waitFor(() => closed, 1500); } catch { child.kill('SIGKILL'); try { await waitFor(() => closed, 1500); } catch {} }
      }
      report.childClosed = closed;
      if (servers) {
        try {
          const before = JSON.stringify([...servers.atlas.actions.values()]);
          report.storageTiming = parseTiming(JSON.stringify(servers.atlas.store.timingHealth()), '', storageTimingFields);
          await servers.close(); report.collectorClosed = true;
          const store = new JsonActionStore(join(workspace, 'data/actions'));
          try { report.reloadVerified = JSON.stringify(store.load(limits.retainedGraphs)) === before; } finally { store.close(); }
          if (!report.reloadVerified) fail('reference_reload_failed');
        } catch { fail('reference_cleanup_or_reload_failed'); }
      }
      if (report.failure) report.complete = false;
      if (report.complete && closed && report.collectorClosed && !report.failure && realpathSync(workspace) === workspace
        && inside(parent, workspace) && !lstatSync(workspace).isSymbolicLink() && !existsSync(join(workspace, 'data/actions/.writer.lock'))) {
        try { rmSync(workspace, { recursive: true, force: true }); report.workspaceRemoved = true; } catch { fail('reference_cleanup_failed'); }
      }
      if (!report.workspaceRemoved) report.retainedWorkspace = relative(root, workspace).replaceAll('\\', '/');
      if (report.sustainedAcceptance.assessable) report.sustainedAcceptance.met = report.complete && !report.failure
        && report.workspaceRemoved && report.observedDurationMs >= limits.durationMs;
      const directory = join(root, 'reports/benchmarks'); mkdirSync(directory, { recursive: true });
      assert.ok(inside(realpathSync(root), realpathSync(directory)) && !lstatSync(directory).isSymbolicLink());
      writeFileSync(join(directory, `sustained-reference-${id}.json`), JSON.stringify(report, null, 2)+'\n', { flag: 'wx' });
      console.log(JSON.stringify({ id, complete: report.complete, failure: report.failure, responses: report.responses,
        observedDurationMs: report.observedDurationMs, sustainedAcceptance: report.sustainedAcceptance,
        driverCollectorMaxRssBytes: report.driverCollectorMaxRssBytes, exporter: report.exporter, reloadVerified: report.reloadVerified }));
    }
    assert.ok(report.complete && !report.failure && report.workspaceRemoved, 'Sustained reference failed; sanitized evidence and workspace retained');
  });
