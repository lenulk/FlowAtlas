import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, realpathSync, lstatSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { release } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const storageRoot = join(root, 'reports', 'storage');
const outputRoot = join(root, 'reports', 'benchmarks');
const roundsCount = 3;
const warmupCount = 50;
const measuredCount = 1000;
const concurrency = 8;
const expectedRequests = warmupCount + measuredCount;
const expectedTraceSpans = expectedRequests + 1;
const appSource = `import { createServer } from 'node:http';
import { cpuUsage, memoryUsage } from 'node:process';
const started = cpuUsage();
const seen = new Set();
let requests = 0;
let metricsRequests = 0;
let invalid = 0;
let maxRssBytes = memoryUsage().rss;
const server = createServer((req, res) => {
  maxRssBytes = Math.max(maxRssBytes, memoryUsage().rss);
  if (req.method === 'GET' && req.url === '/__flowatlas_benchmark_metrics') {
    metricsRequests++;
    const cpu = cpuUsage(started);
    const body = Buffer.from(JSON.stringify({ requests, uniqueRequests: seen.size, metricsRequests, invalid,
      cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system, maxRssBytes: Math.max(maxRssBytes, memoryUsage().rss) }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body);
    return;
  }
  requests++;
  const match = /^\\/bench\\/(warmup-\\d{4}|measured-\\d{4})$/.exec(req.url ?? '');
  if (req.method !== 'GET' || !match || seen.has(match[1])) {
    invalid++;
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('invalid');
  } else {
    seen.add(match[1]);
    const body = Buffer.from('flowatlas-benchmark:' + match[1] + ':ok');
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length });
    res.end(body);
  }
});
server.listen(Number(process.env.PORT), '127.0.0.1', () =>
  console.log('Registered app: http://127.0.0.1:' + server.address().port));
`;

function fixtureSource(profileScope) {
  if (profileScope !== 'target') return appSource;
  // Diagnostic fixture only; no profiler, inspector port or file writer is injected into owner apps.
  const profiler = `import { Session } from 'node:inspector';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
const profileSession = new Session(); profileSession.connect();
const profilePost = promisify(profileSession.post.bind(profileSession));
await profilePost('Profiler.enable'); await profilePost('Profiler.start');
async function stopProfile() {
  const { profile } = await profilePost('Profiler.stop'); profileSession.disconnect();
  writeFileSync(process.env.FLOWATLAS_BENCHMARK_TARGET_PROFILE, JSON.stringify(profile), { flag: 'wx' });
}
`;
  return profiler + appSource.replace('const server = createServer((req, res) => {', 'const server = createServer(async (req, res) => {')
    .replace('    metricsRequests++;', '    metricsRequests++;\n    await stopProfile();');
}

function isInside(parent, target) {
  const path = relative(parent, target);
  return Boolean(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(path);
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

function digestSources() {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  for (const directory of ['src', 'scripts']) visit(directory);
  for (const file of ['package.json', 'npm-shrinkwrap.json']) if (existsSync(join(root, file))) files.push(file);
  const inventory = Object.fromEntries(files.sort().map((file) => [file, hash(readFileSync(join(root, file)))]));
  return hash(JSON.stringify(inventory));
}

function percentile(samples, fraction) {
  if (!samples.length) return null;
  const ordered = [...samples].sort((a, b) => a - b);
  return Number(ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)].toFixed(3));
}

function metrics(samples, durationMs) {
  return { count: samples.length, p50Ms: percentile(samples, 0.50), p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99), durationMs: Number(durationMs.toFixed(3)),
    throughputRequestsPerSecond: durationMs > 0 ? Number((samples.length * 1000 / durationMs).toFixed(3)) : null,
    latencySamplesMs: samples };
}

function comparePerformance(baselineP95Ms, tracedP95Ms) {
  const deltaMs = baselineP95Ms === null || tracedP95Ms === null ? null : Number((tracedP95Ms - baselineP95Ms).toFixed(3));
  const relativePercent = baselineP95Ms > 0 && tracedP95Ms !== null
    ? Number(((tracedP95Ms / baselineP95Ms - 1) * 100).toFixed(3)) : null;
  const criterion = baselineP95Ms !== null && baselineP95Ms < 1 ? 'absolute_overhead_ms' : 'relative_increase_percent';
  const met = criterion === 'absolute_overhead_ms' ? deltaMs !== null && deltaMs <= 5
    : relativePercent !== null && relativePercent <= 10;
  return { deltaMs, relativePercent, acceptance: { criterion, met,
    threshold: criterion === 'absolute_overhead_ms' ? { deltaMs: 5 } : { relativePercent: 10 } } };
}

function workloadManifest() {
  const ids = Array.from({ length: measuredCount }, (_, index) => `measured-${String(index).padStart(4, '0')}`);
  const serialized = ids.map((id) => `GET\0/bench/${id}\0flowatlas-benchmark:${id}:ok`).join('\n');
  return { requestIdDigest: hash(ids.join('\n')), workloadDigest: hash(serialized) };
}

function requestOnce(origin, id, agent, signal) {
  const started = performance.now();
  return new Promise((resolveRequest) => {
    let settled = false;
    let deadline;
    let req;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abortRequest);
      resolveRequest({ ...result, latencyMs: Number((performance.now() - started).toFixed(3)) });
    };
    const path = id === '__flowatlas_benchmark_metrics' ? `/${id}` : `/bench/${id}`;
    const url = new URL(path, origin);
    req = request(url, { method: 'GET', agent }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (chunk) => { size += chunk.length; if (size <= 256) chunks.push(chunk); });
      res.on('end', () => finish({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => finish({ status: 0, body: '', error: true }));
    });
    const abortRequest = () => req.destroy(new Error('aborted'));
    signal?.addEventListener('abort', abortRequest, { once: true });
    if (signal?.aborted) abortRequest();
    deadline = setTimeout(() => req.destroy(new Error('request_deadline')), 10000);
    req.on('error', () => finish({ status: 0, body: '', error: true }));
    req.end();
  });
}

async function sendRequests(origin, ids, agent, signal) {
  let cursor = 0;
  const start = performance.now();
  const output = [];
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= ids.length || signal?.aborted) return;
      const id = ids[index];
      const result = await requestOnce(origin, id, agent, signal);
      const expectedBody = `flowatlas-benchmark:${id}:ok`;
      output[index] = { ...result, correct: !result.error && result.status === 200 && result.body === expectedBody };
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const durationMs = performance.now() - start;
  return { results: output, measurements: metrics(output.filter(Boolean).map((item) => item.latencyMs), durationMs),
    correctResponses: output.filter((item) => item.correct).length, failedResponses: output.filter((item) => !item.correct).length };
}

function summaryLine(output, prefix) {
  const line = output.split(/\r?\n/).find((item) => item.startsWith(prefix));
  if (!line) return null;
  try { return JSON.parse(line.slice(prefix.length)); } catch { return null; }
}

async function waitForReady(child, outputRef, signal) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('condition_deadline');
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('inspector_exited_before_ready');
    const collector = outputRef.value.match(/^FlowAtlas: (http:\/\/127\.0\.0\.1:\d+)$/m)?.[1];
    const app = outputRef.value.match(/^App: (http:\/\/127\.0\.0\.1:\d+)$/m)?.[1];
    if (collector && app) return { collector, app };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('inspector_readiness_timeout');
}

function parseTraceSummary(output) {
  const value = summaryLine(output, 'FlowAtlas trace summary: ');
  if (!value) return null;
  const fields = ['httpSpans', 'invalidSpans', 'delivered', 'dropped', 'queued', 'inFlight'];
  if (fields.some((field) => !Number.isInteger(value[field]) || value[field] < 0)) return null;
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function parseDropReasons(output) {
  const value = summaryLine(output, 'FlowAtlas trace delivery health: ');
  const fields = ['overflow', 'invalid', 'rejected', 'timeout', 'transport', 'shutdown'];
  if (!value || fields.some((field) => !Number.isSafeInteger(value[field]) || value[field] < 0)) return null;
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function parseRejections(output) {
  const value = summaryLine(output, 'FlowAtlas trace rejection health: ');
  const fields = ['400', '401', '403', '409', '413', '503', 'other'];
  if (!value || fields.some((field) => !Number.isSafeInteger(value[field]) || value[field] < 0)) return null;
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function parseTransport(output) {
  const value = summaryLine(output, 'FlowAtlas trace transport health: ');
  const fields = ['batches', 'submittedSpans', 'smallBatches', 'peakRequests'];
  if (!value || fields.some((field) => !Number.isSafeInteger(value[field]) || value[field] < 0)
    || value.peakRequests > 2 || value.smallBatches > value.batches
    || value.submittedSpans < value.batches || value.submittedSpans > 32 * value.batches) return null;
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function storageDiagnostics(output) {
  const operations = new Set(['initialize', 'load', 'save']);
  const stages = new Set(['directory', 'lock', 'stat', 'read', 'parse', 'validate', 'retention', 'open', 'write', 'sync', 'close', 'rename']);
  const codes = new Set(['EACCES', 'EPERM', 'EIO', 'EROFS', 'EBADF', 'EINVAL', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EISDIR',
    'EEXIST', 'ENOENT', 'ENOSPC', 'EBUSY', 'ENOTEMPTY', 'EFBIG', 'EDQUOT', 'ENOMEM', 'EXDEV', 'ENAMETOOLONG', 'ELOOP']);
  return [...output.matchAll(/^FlowAtlas storage: (\{[^\n]+\})/gm)].slice(0, 10).flatMap((match) => {
    try { const value = JSON.parse(match[1]);
      if (value.code !== 'FLOWATLAS_STORAGE_ERROR') return [];
      return [{ code: value.code, operation: operations.has(value.operation) ? value.operation : 'unknown',
        stage: stages.has(value.stage) ? value.stage : 'unknown', causeCode: codes.has(value.causeCode) ? value.causeCode : 'UNKNOWN' }];
    } catch { return []; }
  });
}

function parseAppMetrics(value) {
  if (!value || typeof value !== 'object') return null;
  const fields = ['requests', 'uniqueRequests', 'invalid', 'cpuUserMicros', 'cpuSystemMicros', 'maxRssBytes'];
  if (fields.some((field) => !Number.isSafeInteger(value[field]) || value[field] < 0) || value.metricsRequests !== 1) return null;
  return Object.fromEntries([...fields, 'metricsRequests'].map((field) => [field, value[field]]));
}

async function runCondition(condition, runIndex, manifest, profileDirectory = null, profileScope = null) {
  mkdirSync(storageRoot, { recursive: true });
  const canonicalStorage = realpathSync(storageRoot);
  if (!isInside(realpathSync(root), canonicalStorage)) throw new Error('unsafe_storage_parent');
  const workspace = mkdtempSync(join(canonicalStorage, 'benchmark-http-'));
  const canonicalWorkspace = realpathSync(workspace);
  if (!isInside(canonicalStorage, canonicalWorkspace) || lstatSync(canonicalWorkspace).isSymbolicLink()) {
    throw new Error('unsafe_workspace_path');
  }
  try {
    mkdirSync(join(workspace, 'app'));
    writeFileSync(join(workspace, 'app', 'server.mjs'), fixtureSource(profileScope), { flag: 'wx' });
    writeFileSync(join(workspace, 'flowatlas.config.json'), JSON.stringify({ projects: [
      { id: 'benchmark-http', root: 'app', files: ['server.mjs'] },
    ] }, null, 2) + '\n', { flag: 'wx' });
  } catch {
    const actual = realpathSync(workspace);
    if (actual === canonicalWorkspace && isInside(canonicalStorage, actual) && !existsSync(join(actual, 'data', 'actions', '.writer.lock')))
      rmSync(actual, { recursive: true, force: true });
    throw new Error('fixture_setup_failed');
  }

  const sessionToken = randomBytes(32).toString('base64url');
  const childEnv = { ...process.env, FLOWATLAS_SESSION_TOKEN: sessionToken,
    FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0', FLOWATLAS_APP_PORT: '0', FLOWATLAS_EXTERNAL_PORT: '0' };
  delete childEnv.FLOWATLAS_TRACED_TOOL_ROOT;
  delete childEnv.NODE_OPTIONS;
  delete childEnv.FLOWATLAS_BENCHMARK_TARGET_PROFILE;
  if (profileScope === 'target') childEnv.FLOWATLAS_BENCHMARK_TARGET_PROFILE = join(profileDirectory, `round-${runIndex}-${condition}.cpuprofile`);
  for (const key of Object.keys(childEnv)) if (key.startsWith('OTEL_')) delete childEnv[key];
  const options = ['--project', 'benchmark-http', '--entry', 'server.mjs'];
  const args = profileScope === 'collector' ? [join(root, 'scripts', 'inspect.mjs'), ...options]
    : [join(root, 'scripts', 'cli.mjs'), '--workspace', workspace, 'inspect', ...options];
  if (profileScope === 'collector') childEnv.FLOWATLAS_WORKSPACE_ROOT = workspace;
  if (condition === 'traced') args.push('--trace', 'http');
  if (profileScope === 'collector') args.unshift('--cpu-prof', `--cpu-prof-dir=${profileDirectory}`,
    `--cpu-prof-name=round-${runIndex}-${condition}.cpuprofile`);
  const child = spawn(process.execPath, args, { cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const closePromise = new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
  const conditionController = new AbortController();
  const conditionTimer = setTimeout(() => conditionController.abort(), 30000);
  const outputRef = { value: '' };
  const appendOutput = (chunk) => { outputRef.value = (outputRef.value + chunk.toString()).slice(-131072); };
  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);

  const result = { condition, runIndex, workloadDigest: manifest.workloadDigest, requestIdDigest: manifest.requestIdDigest,
    warmupRequests: warmupCount, measuredRequests: measuredCount, concurrency,
    expectedHttpSpans: condition === 'traced' ? expectedTraceSpans : 0,
    warmup: null, measurement: null, app: null, trace: null, dropReasons: null, rejectionStatuses: null, transport: null, storageDiagnostics: [], metricsEndpoint: null,
    gracefulShutdown: false, processCleanupConfirmed: false, workspaceRemoved: false, retainedWorkspace: null,
    valid: false, failure: null };
  let stopSent = false;
  try {
    const ready = await waitForReady(child, outputRef, conditionController.signal);
    const warmupIds = Array.from({ length: warmupCount }, (_, index) => `warmup-${String(index).padStart(4, '0')}`);
    const measuredIds = Array.from({ length: measuredCount }, (_, index) => `measured-${String(index).padStart(4, '0')}`);
    const workloadAgent = new Agent({ keepAlive: true, maxSockets: concurrency });
    let warmup; let measurement;
    try {
      warmup = await sendRequests(ready.app, warmupIds, workloadAgent, conditionController.signal);
      measurement = await sendRequests(ready.app, measuredIds, workloadAgent, conditionController.signal);
    } finally { workloadAgent.destroy(); }
    if (conditionController.signal.aborted) result.failure = 'condition_deadline';
    const metricsAgent = new Agent({ keepAlive: false });
    let appMetricsResponse;
    try { appMetricsResponse = await requestOnce(ready.app, '__flowatlas_benchmark_metrics', metricsAgent, conditionController.signal); }
    finally { metricsAgent.destroy(); }
    let rawMetrics;
    try { rawMetrics = JSON.parse(appMetricsResponse.body); } catch { rawMetrics = null; }
    result.metricsEndpoint = { status: appMetricsResponse.status, correctResponse: appMetricsResponse.status === 200
      && Boolean(rawMetrics && rawMetrics.requests === expectedRequests && rawMetrics.metricsRequests === 1
        && rawMetrics.uniqueRequests === expectedRequests && rawMetrics.invalid === 0) };
    result.app = parseAppMetrics(rawMetrics);
    result.warmup = { requests: warmupIds.length, correctResponses: warmup.correctResponses, failedResponses: warmup.failedResponses };
    result.measurement = { ...measurement.measurements, correctResponses: measurement.correctResponses,
      failedResponses: measurement.failedResponses };
    if (warmup.correctResponses !== warmupCount || warmup.failedResponses !== 0
      || measurement.correctResponses !== measuredCount || measurement.failedResponses !== 0
      || !result.metricsEndpoint.correctResponse || !result.app) result.failure = 'response_validation_failed';
  } catch (error) {
    result.failure = ['inspector_readiness_timeout', 'inspector_exited_before_ready', 'condition_deadline'].includes(error.message)
      ? error.message : 'workload_or_inspector_error';
  } finally {
    clearTimeout(conditionTimer);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.stdin.write('stop\n'); stopSent = true; } catch { /* Retain the workspace if shutdown cannot be confirmed. */ }
      let timer;
      const outcome = await Promise.race([closePromise, new Promise((resolveClose) => { timer = setTimeout(() => resolveClose(null), 12000); })]);
      clearTimeout(timer);
      if (!outcome && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      let killTimer;
      const finalOutcome = outcome ?? await Promise.race([closePromise,
        new Promise((resolveClose) => { killTimer = setTimeout(() => resolveClose(null), 3000); })]);
      clearTimeout(killTimer);
      result.gracefulShutdown = stopSent && Boolean(finalOutcome && finalOutcome.code === 0);
    } else {
      const finalOutcome = await closePromise;
      result.gracefulShutdown = stopSent && finalOutcome.code === 0;
    }
    result.processCleanupConfirmed = result.gracefulShutdown;
    result.storageDiagnostics = storageDiagnostics(outputRef.value);
    if (condition === 'traced') {
      result.trace = parseTraceSummary(outputRef.value); result.dropReasons = parseDropReasons(outputRef.value);
      result.rejectionStatuses = parseRejections(outputRef.value);
      result.transport = parseTransport(outputRef.value);
    }
    const lockExists = existsSync(join(workspace, 'data', 'actions', '.writer.lock'));
    const storageSafe = result.gracefulShutdown && !lockExists && (condition !== 'traced'
      || Boolean(result.trace && result.trace.queued === 0 && result.trace.inFlight === 0
        && result.trace.dropped === 0 && result.trace.invalidSpans === 0
        && result.trace.delivered === expectedTraceSpans));
    result.valid = !result.failure && result.gracefulShutdown && !lockExists
      && Boolean(result.warmup && result.measurement && result.app && result.metricsEndpoint?.correctResponse)
      && result.app.requests === expectedRequests && result.app.uniqueRequests === expectedRequests
      && result.app.metricsRequests === 1 && result.app.invalid === 0
      && (condition !== 'traced' || Boolean(result.trace && result.trace.httpSpans === expectedTraceSpans
        && result.trace.invalidSpans === 0 && result.trace.delivered + result.trace.dropped === expectedTraceSpans
        && result.dropReasons && Object.values(result.dropReasons).reduce((sum, count) => sum + count, 0) === result.trace.dropped
        && result.rejectionStatuses && Object.values(result.rejectionStatuses).reduce((sum, count) => sum + count, 0) === result.dropReasons.rejected
        && result.transport && result.transport.submittedSpans <= result.trace.httpSpans
        && result.transport.submittedSpans >= result.trace.delivered));
    if (!result.failure && !result.valid) result.failure = 'counts_or_capture_validation_failed';
    const actualWorkspace = realpathSync(workspace);
    const cleanupAllowed = isInside(canonicalStorage, actualWorkspace) && actualWorkspace === canonicalWorkspace
      && !lstatSync(actualWorkspace).isSymbolicLink() && storageSafe;
    if (cleanupAllowed) {
      try { rmSync(actualWorkspace, { recursive: true, force: true }); result.workspaceRemoved = true; }
      catch { result.failure ??= 'workspace_cleanup_failed'; result.valid = false;
        result.retainedWorkspace = relative(root, actualWorkspace).replaceAll('\\', '/'); }
    } else {
      result.retainedWorkspace = relative(root, actualWorkspace).replaceAll('\\', '/');
    }
  }
  return result;
}

function sourceCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}
function sourceDirty() {
  try { return Boolean(execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'package.json', 'npm-shrinkwrap.json'],
    { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); }
  catch { return null; }
}

test('explicit local HTTP trace overhead benchmark (not in default suite)', { timeout: 300000 }, async () => {
  mkdirSync(outputRoot, { recursive: true });
  const canonicalOutput = realpathSync(outputRoot);
  if (!isInside(realpathSync(root), canonicalOutput) || lstatSync(outputRoot).isSymbolicLink()) {
    throw new Error('Unsafe benchmark report directory.');
  }
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const outputFile = join(outputRoot, `${id}.json`);
  const profileScope = ['collector', 'target'].includes(process.env.FLOWATLAS_BENCHMARK_PROFILE) ? process.env.FLOWATLAS_BENCHMARK_PROFILE : null;
  const profileDirectory = profileScope ? join(canonicalOutput, `profile-${id}`) : null;
  if (profileDirectory) mkdirSync(profileDirectory);
  const manifest = workloadManifest();
  const report = { id, startedAt: new Date().toISOString(), finishedAt: null, sourceCommit: sourceCommit(),
    sourceDirty: sourceDirty(), sourceDigest: digestSources(), runtime: { node: process.version, platform: process.platform, arch: process.arch, osRelease: release() },
    profiling: profileDirectory ? { scope: profileScope === 'collector' ? 'collector inspect process only; direct entry omits CLI wrapper'
      : 'fixture target workload only; public CLI; diagnostic fixture includes local inspector Session', fixtureDigest: hash(fixtureSource(profileScope)), directory: relative(root, profileDirectory).replaceAll('\\', '/'),
      comparableWithUnprofiledResults: false } : null,
    workload: { kind: 'deterministic plain native HTTP ESM fixture', warmupRequests: warmupCount, measuredRequests: measuredCount,
      concurrency, rounds: roundsCount, additionalUnmeasuredMetricsRequest: 1, ...manifest },
    thresholds: { tinyBaselineP95CutoffMs: 1, absoluteOverheadBudgetMs: 5, relativeP95TargetPercent: 10 }, rounds: [], acceptance: null,
    artifact: relative(root, outputFile).replaceAll('\\', '/'), failure: null };
  let testFailure = null;
  try {
    for (let round = 0; round < roundsCount; round++) {
      const order = round % 2 === 0 ? ['baseline', 'traced'] : ['traced', 'baseline'];
      const outcomes = {};
      for (const condition of order) {
        const outcome = await runCondition(condition, round + 1, manifest, profileDirectory, profileScope);
        outcomes[condition] = outcome;
      }
      const baselineP95 = outcomes.baseline.measurement?.p95Ms ?? null;
      const tracedP95 = outcomes.traced.measurement?.p95Ms ?? null;
      const comparison = comparePerformance(baselineP95, tracedP95);
      report.rounds.push({ round: round + 1, order, baseline: outcomes.baseline, traced: outcomes.traced,
        deltaP95Ms: comparison.deltaMs, relativeP95OverheadPercent: comparison.relativePercent,
        performanceAcceptance: comparison.acceptance });
    }
  } catch {
    report.failure = 'benchmark_execution_error';
    testFailure = new Error('Benchmark execution failed; sanitized report saved.');
  } finally {
    const baselineP95s = report.rounds.map((round) => round.baseline.measurement?.p95Ms).filter(Number.isFinite);
    const tracedP95s = report.rounds.map((round) => round.traced.measurement?.p95Ms).filter(Number.isFinite);
    const deltaP95s = report.rounds.map((round) => round.deltaP95Ms).filter(Number.isFinite);
    const pairedOverheads = report.rounds.map((round) => round.relativeP95OverheadPercent).filter(Number.isFinite);
    const captureComplete = report.rounds.length === roundsCount && report.rounds.every(({ traced }) => traced.valid
      && traced.trace?.httpSpans === expectedTraceSpans && traced.trace.delivered + traced.trace.dropped === expectedTraceSpans
      && traced.trace.dropped === 0 && traced.trace.queued === 0 && traced.trace.inFlight === 0);
    const workloadCorrect = report.rounds.length === roundsCount && report.rounds.every(({ baseline, traced }) => baseline.valid && traced.valid
      && baseline.workloadDigest === traced.workloadDigest && baseline.requestIdDigest === traced.requestIdDigest);
    const baselineP95Median = percentile(baselineP95s, 0.5);
    const tracedP95Median = percentile(tracedP95s, 0.5);
    const deltaP95Median = percentile(deltaP95s, 0.5);
    const relativeP95Median = percentile(pairedOverheads, 0.5);
    const aggregatePerformance = comparePerformance(baselineP95Median, tracedP95Median);
    report.acceptance = { allResponsesCorrectAndCountsReconciled: workloadCorrect,
      captureCompleteWithoutDrops: captureComplete,
      performanceAcceptance: { ...aggregatePerformance.acceptance, aggregateMethod: 'ratio_or_difference_of_condition_medians',
        aggregateDeltaP95Ms: aggregatePerformance.deltaMs, aggregateRelativeP95OverheadPercent: aggregatePerformance.relativePercent,
        medianBaselineP95Ms: baselineP95Median,
        medianTracedP95Ms: tracedP95Median, medianDeltaP95Ms: deltaP95Median,
        medianPairedRelativeP95OverheadPercent: relativeP95Median },
      performanceTargetMissDoesNotFailMeasurement: true,
      note: 'Fixture-local measurements only; performance thresholds are reported, not enforced as a test failure.' };
    if (!workloadCorrect || !captureComplete) testFailure ??= new Error('Benchmark workload/capture acceptance failed; all completed rounds are in the report.');
    report.finishedAt = new Date().toISOString();
    writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`HTTP benchmark report: ${relative(root, outputFile).replaceAll('\\', '/')}`);
    console.log(`HTTP benchmark acceptance: ${JSON.stringify(report.acceptance)}`);
    if (report.rounds.some((round) => round.baseline.retainedWorkspace || round.traced.retainedWorkspace)) {
      console.log('HTTP benchmark retained workspace: see sanitized report for its relative path.');
    }
  }
  if (testFailure) throw testFailure;
});
