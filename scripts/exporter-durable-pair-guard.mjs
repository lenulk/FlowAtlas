import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const reportDirectory = join(root, 'reports/benchmarks');
const storageDirectory = join(root, 'reports/storage');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function inside(parent, candidate) {
  const rel = relative(parent, candidate);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

function ownedWorkspace(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^reports\/storage\/collector-cost-[\w-]+$/);
  const candidate = resolve(root, value);
  const parent = realpathSync(storageDirectory);
  assert.ok(inside(parent, candidate));
  assert.ok(existsSync(candidate));
  assert.equal(lstatSync(candidate).isSymbolicLink(), false);
  assert.equal(realpathSync(candidate), candidate);
  assert.equal(existsSync(join(candidate, 'data/actions/.writer.lock')), false);
  return value;
}

function validateCondition(row, pairRound, mode) {
  assert.equal(row.mode, mode);
  assert.equal(row.round, pairRound);
  const worker = row.worker;
  assert.ok(worker);
  const summary = worker.summary;
  const health = worker.health;
  assert.equal(summary.httpSpans, 1051);
  assert.equal(summary.delivered + summary.dropped, 1051);
  assert.equal(summary.queued + summary.inFlight, 0);
  assert.ok(Number.isSafeInteger(worker.transport.submittedSpans)
    && worker.transport.submittedSpans >= summary.delivered
    && worker.transport.submittedSpans <= 1051);
  assert.ok(Number.isSafeInteger(worker.transport.peakRequests)
    && worker.transport.peakRequests >= 0 && worker.transport.peakRequests <= 2);
  assert.ok(Number.isSafeInteger(worker.timing.deadlineFired)
    && worker.timing.deadlineFired >= 0 && worker.timing.deadlineFired <= 1);
  for (const field of ['overflow', 'invalid', 'rejected', 'timeout', 'transport']) assert.equal(health[field], 0);
  assert.equal(summary.dropped, health.shutdown);
  assert.equal(row.acceptedUnique, row.acceptedCount);
  assert.ok(Number.isSafeInteger(row.acceptedCount) && row.acceptedCount >= 0);
  assert.ok(row.acceptedCount <= 1051);
  assert.ok(row.acceptedCount >= summary.delivered);
  assert.ok(Number.isSafeInteger(row.acceptedUnique) && row.acceptedUnique >= 0);
  assert.equal(row.retainedActions, Math.min(100, row.acceptedCount));
  assert.equal(row.expectedRetainedOrderDigest, row.actualRetainedOrderDigest);
  assert.match(row.expectedRetainedOrderDigest, /^[a-f0-9]{64}$/);
  assert.equal(row.reloadVerified, true);
  assert.equal(typeof row.complete, 'boolean');
  assert.equal(row.storageTiming.failures, 0);
  assert.ok(Number.isSafeInteger(row.storageTiming.saves) && row.storageTiming.saves > 0);
  assert.ok(Number.isFinite(row.storageTiming.syncMs) && row.storageTiming.syncMs >= 120 * row.storageTiming.saves);
  assert.ok(row.workerOutcome);
  assert.equal(row.workerOutcome.exitCode, 0);
  assert.equal(row.workerOutcome.signal, null);
  assert.equal(row.childClosed, true);
  assert.equal(row.serverClosed, true);
  assert.equal(row.storeClosed, true);

  if (row.complete) {
    assert.equal(row.failure, null);
    assert.equal(row.workspaceRemoved, true);
    assert.equal(summary.delivered, 1051);
    assert.equal(summary.dropped, 0);
  } else {
    assert.ok(health.shutdown > 0);
    assert.ok(worker.timing.deadlineFired >= 1);
    assert.equal(typeof row.failure, 'string');
    assert.match(row.failure, /^[a-z0-9_-]{1,80}$/);
    assert.ok(summary.dropped > 0);
    assert.equal(row.workspaceRemoved, false);
    ownedWorkspace(row.retainedWorkspace);
  }
}

test('controlled slow fsync retains the durable-pair shutdown failures and verifies reload', { timeout: 180000 }, () => {
  mkdirSync(reportDirectory, { recursive: true });
  mkdirSync(storageDirectory, { recursive: true });
  const before = new Set(readdirSync(reportDirectory));
  const env = { ...process.env, FLOWATLAS_SLOW_FSYNC_QA: '1' };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env.FLOWATLAS_COLLECTOR_COST_FAULT;
  const result = spawnSync(process.execPath,
    ['--import', './scripts/slow-fsync-preload.mjs', '--test', 'scripts/benchmark-exporter-durable-pair.mjs'],
    { cwd: root, env, encoding: 'utf8', timeout: 150000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const tap = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const tapPath = join(reportDirectory, `exporter-durable-pair-slow-${id}.tap`);
  writeFileSync(tapPath, tap, { flag: 'wx' });

  const reportFiles = readdirSync(reportDirectory).filter(name => !before.has(name)
    && /^exporter-durable-pair-slow-[\wT-]+\.json$/.test(name));
  assert.equal(result.status, 1, 'controlled inner capture must preserve its expected failure');
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
  assert.equal(reportFiles.length, 1, 'expected exactly one new inner JSON report');
  const reportName = reportFiles[0];
  const reportPath = join(reportDirectory, reportName);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.controlledSync?.requestedDelayMs, 120);
  assert.equal(report.performanceAcceptance.assessable, false);
  assert.equal(report.performanceAcceptance.met, null);
  assert.equal(report.performanceAcceptance.reason, 'component_diagnostic');
  assert.deepEqual(report.workload, {
    spans: 1051, rounds: 3, exporterCapacity: 2048, uploadTimeoutMs: 1000,
    shutdownDeadlineMs: 900, slots: 2, batchLimit: 32, burst: true,
  });
  assert.equal(report.pairs.length, 3);

  let previousFirst = null;
  let failures = 0;
  let saves = 0;
  const orderRows = [];
  for (let index = 0; index < report.pairs.length; index++) {
    const pair = report.pairs[index];
    const round = index + 1;
    assert.equal(pair.round, round);
    assert.deepEqual(pair.order.slice().sort(), ['production', 'qa']);
    assert.notEqual(pair.order[0], pair.order[1]);
    if (previousFirst !== null) assert.notEqual(pair.order[0], previousFirst);
    previousFirst = pair.order[0];
    assert.deepEqual(Object.keys(pair).sort(), ['order', 'production', 'qa', 'round']);
    for (const mode of ['production', 'qa']) {
      const row = pair[mode];
      validateCondition(row, round, mode);
      saves += row.storageTiming.saves;
      if (!row.complete) failures++;
      orderRows.push({ round, mode, complete: row.complete, delivered: row.worker.summary.delivered,
        dropped: row.worker.summary.dropped, shutdown: row.worker.health.shutdown,
        reloadVerified: row.reloadVerified, workspaceRemoved: row.workspaceRemoved,
        retainedOrderDigest: row.actualRetainedOrderDigest });
    }
  }
  assert.ok(failures > 0, 'controlled delay must reproduce at least one retained shutdown loss');
  for (const pair of report.pairs) {
    assert.equal(pair.order.length, 2);
    assert.ok(pair.order.every(mode => pair[mode].mode === mode));
  }

  const injected = [...tap.matchAll(/^FLOWATLAS_SLOW_SYNC (\{[^\r\n]+\})$/gm)].map(match => JSON.parse(match[1]));
  assert.equal(injected.length, 1);
  assert.deepEqual(injected[0], { delayMs: 120, calls: saves, openDescriptors: 0 });
  assert.equal(typeof report.controlledSync.scope, 'string');
  assert.ok(report.controlledSync.scope.length > 0 && report.controlledSync.scope.length <= 120);

  const evidence = {
    id,
    evidenceKind: 'controlled synthetic 120ms pre-fsync delay; not actual disk speed or performance acceptance',
    orderDigestScope: 'post-save persisted-state versus reload consistency; not independent request-order proof',
    performanceAcceptance: { assessable: false, met: null, reason: 'controlled_fault' },
    innerReport: reportName,
    innerReportDigest: sha256(reportPath),
    guardDigest: sha256(fileURLToPath(import.meta.url)),
    preloadDigest: sha256(join(root, 'scripts/slow-fsync-preload.mjs')),
    injected: injected[0],
    conditions: orderRows,
  };
  const evidencePath = join(reportDirectory, `exporter-durable-pair-guard-${id}.json`);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(evidence));
});
