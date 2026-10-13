import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, lstatSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { FlowAtlas, getCodeVersion } from '../src/flowatlas.mjs';
import { ingestHttpSpanBatch } from '../src/http-spans.mjs';
import { validateGraph } from '../src/evidence-contract.mjs';
import { JsonActionStore } from '../src/action-store.mjs';
import { planPairs, runPlannedSaves } from './durable-group-commit-plan.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sha = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, path) => {
  const part = relative(parent, path);
  return Boolean(part) && !part.startsWith('..') && !isAbsolute(part);
};

function fixture(fileCount) {
  const files = Object.freeze(Object.fromEntries(Array.from({ length: fileCount }, (_, i) =>
    [`modules/unit-${i}.mjs`, 'b'.repeat(64)]).sort(([a], [b]) => a.localeCompare(b))));
  const version = { projectId: 'component', commit: null, dirty: null, files,
    digest: sha(Object.keys(files).sort().map(file => `${file}\0${files[file]}`).join('\n')) };
  const snapshots = [];
  const atlas = new FlowAtlas(version, 100, { load: () => [], save: actions => {
    // Copy each state when committed: subsequent updates must not rewrite the fixture history.
    const captured = JSON.parse(JSON.stringify(actions));
    for (const action of captured) action.codeVersion.files = files;
    snapshots.push(captured);
  } }, { version: () => version });
  const span = (spanId, parentSpanId = null) => ({ spanId, parentSpanId,
    kind: parentSpanId ? 'CLIENT' : 'SERVER', method: 'GET',
    startedAt: '2026-10-01T00:00:00.000Z', endedAt: '2026-10-01T00:00:00.100Z',
    durationMs: 100, httpStatus: 200, error: false });
  const send = items => ingestHttpSpanBatch(atlas, { kind: 'otel-span-batch', projectId: 'component',
    codeDigest: version.digest, items });
  for (let i = 0; i < 1051; i += 32) send(Array.from({ length: Math.min(32, 1051 - i) }, (_, n) =>
    ({ traceId: (i + n + 1).toString(16).padStart(32, '0'), span: span('1'.padStart(16, '0')) })));
  for (let i = 0; i < 64; i += 32) send(Array.from({ length: 32 }, (_, n) =>
    ({ traceId: (1051 - i - n).toString(16).padStart(32, '0'),
      span: span('2'.padStart(16, '0'), '1'.padStart(16, '0')) })));
  assert.equal(snapshots.length, 35);
  assert.equal(snapshots.at(-1).length, 100);
  assert.equal(snapshots[32].filter(action => action.trace.spans.length === 2).length, 0);
  assert.equal(snapshots[33].filter(action => action.trace.spans.length === 2).length, 32);
  assert.equal(snapshots[34].filter(action => action.trace.spans.length === 2).length, 64);
  for (const actions of snapshots) for (const action of actions) {
    assert.deepEqual(validateGraph(action), []);
    assert.equal(action.codeVersion.files, files);
  }
  const encoded = snapshots.map(actions => JSON.stringify({ storageVersion: 1, actions }));
  return { fileCount, snapshots, encoded, digest: sha(encoded.join('\n')) };
}

function ownedWorkspace(parent) {
  const workspace = realpathSync(mkdtempSync(join(parent, 'durable-group-')));
  assert.ok(inside(parent, workspace) && !lstatSync(workspace).isSymbolicLink());
  return workspace;
}

function removeConfirmed(parent, workspace, directory) {
  if (!inside(parent, workspace) || realpathSync(workspace) !== workspace
    || lstatSync(workspace).isSymbolicLink() || existsSync(join(directory, '.writer.lock'))) return false;
  rmSync(workspace, { recursive: true });
  return true;
}

function condition(data, mode, round, parent) {
  const workspace = ownedWorkspace(parent);
  const directory = join(workspace, 'actions'); mkdirSync(directory);
  const groups = mode === 'pairs' ? planPairs(data.snapshots) : data.snapshots.map((state, index) =>
    ({ indices: [index], state }));
  const row = { fileCount: data.fileCount, mode, round, fixtureDigest: data.digest,
    groups: groups.length, expectedSyncCalls: groups.length, publishedStates: 0,
    syncCalls: 0, expectedEncodedBytes: 0, elapsedMs: null, storeTiming: null,
    finalBytesVerified: false, reloadVerified: false, complete: false,
    failure: null, workspaceRemoved: false, retainedWorkspace: null };
  let store;
  try {
    store = new JsonActionStore(directory, { timing: true });
    const started = performance.now();
    const published = runPlannedSaves(groups, state => store.save(state));
    row.elapsedMs = performance.now() - started;
    row.publishedStates = published.publishedIndices.length;
    row.syncCalls = store.timingHealth().saves;
    row.storeTiming = store.timingHealth();
    row.expectedEncodedBytes = groups.reduce((total, group) => total + Buffer.byteLength(data.encoded[group.indices.at(-1)]), 0);
    assert.equal(published.failedGroupIndex, null);
    assert.deepEqual(published.publishedIndices, Array.from({ length: 35 }, (_, index) => index));
    assert.equal(row.syncCalls, groups.length);
    assert.equal(row.storeTiming.failures, 0);
    store.close(); store = null;
    row.finalBytesVerified = readFileSync(join(directory, 'state.json'), 'utf8') === data.encoded.at(-1);
    const reopened = new JsonActionStore(directory);
    try { row.reloadVerified = JSON.stringify(reopened.load(100)) === JSON.stringify(data.snapshots.at(-1)); }
    finally { reopened.close(); }
    row.complete = row.finalBytesVerified && row.reloadVerified && row.publishedStates === 35;
    if (!row.complete) row.failure = 'accounting_or_reload_failed';
  } catch { row.failure = 'write_or_reload_failed'; }
  finally {
    try { store?.close(); } catch { row.failure ??= 'cleanup_failed'; }
    if (row.complete && !row.failure) {
      try { row.workspaceRemoved = removeConfirmed(parent, workspace, directory); }
      catch { row.failure = 'cleanup_failed'; }
    }
    if (!row.workspaceRemoved) row.retainedWorkspace = relative(root, workspace).replaceAll('\\', '/');
  }
  return row;
}

function failedGroupControl(data, parent) {
  const workspace = ownedWorkspace(parent);
  const directory = join(workspace, 'actions'); mkdirSync(directory);
  const row = { fileCount: data.fileCount, failureAtGroup: 1, publishedIndices: [],
    previousReloadVerified: false, futureUnattempted: false, saveFailures: 0,
    complete: false, failure: null, workspaceRemoved: false, retainedWorkspace: null };
  let store;
  try {
    // Invalid second pair exercises the production store's rejection/old-state path.
    // It does not claim to simulate a torn write or an fsync failure.
    const invalid = structuredClone(data.snapshots[3]); invalid[0].id = '!';
    const states = [data.snapshots[0], data.snapshots[1], data.snapshots[2], invalid,
      data.snapshots[4], data.snapshots[5]];
    const groups = planPairs(states);
    store = new JsonActionStore(directory, { timing: true });
    const result = runPlannedSaves(groups, state => store.save(state));
    row.publishedIndices = result.publishedIndices;
    row.saveFailures = store.timingHealth().failures;
    row.futureUnattempted = store.timingHealth().saves === 2;
    assert.equal(result.failedGroupIndex, 1);
    assert.deepEqual(result.publishedIndices, [0, 1]);
    assert.equal(row.saveFailures, 1);
    assert.equal(row.futureUnattempted, true);
    store.close(); store = null;
    const reopened = new JsonActionStore(directory);
    try { row.previousReloadVerified = JSON.stringify(reopened.load(100)) === JSON.stringify(data.snapshots[1]); }
    finally { reopened.close(); }
    row.complete = row.previousReloadVerified;
    if (!row.complete) row.failure = 'previous_state_changed';
  } catch { row.failure = 'fault_control_failed'; }
  finally {
    try { store?.close(); } catch { row.failure ??= 'cleanup_failed'; }
    if (row.complete && !row.failure) {
      try { row.workspaceRemoved = removeConfirmed(parent, workspace, directory); }
      catch { row.failure = 'cleanup_failed'; }
    }
    if (!row.workspaceRemoved) row.retainedWorkspace = relative(root, workspace).replaceAll('\\', '/');
  }
  return row;
}

test('paired durable saves keep exact final state and publish only after successful save', { timeout: 180000 }, () => {
  const storagePath = join(root, 'reports/storage'), reportPath = join(root, 'reports/benchmarks');
  mkdirSync(storagePath, { recursive: true }); mkdirSync(reportPath, { recursive: true });
  const parent = realpathSync(storagePath);
  assert.ok(inside(realpathSync(root), parent) && !lstatSync(storagePath).isSymbolicLink());
  assert.ok(inside(realpathSync(root), realpathSync(reportPath)) && !lstatSync(reportPath).isSymbolicLink());
  const datasets = [1, 64].map(fixture), version = getCodeVersion(root);
  const report = { sourceCommit: version.commit, sourceDigest: version.digest, sourceDirty: version.dirty,
    scriptDigest: sha(readFileSync(fileURLToPath(import.meta.url))),
    helperDigest: sha(readFileSync(join(root, 'scripts/durable-group-commit-plan.mjs'))),
    evidenceKind: 'QA-only grouped durable snapshot feasibility; synthetic graph states, no HTTP, exporter, SDK or app',
    runtime: { node: process.version, platform: process.platform, osRelease: release() },
    performanceAcceptance: { assessable: false, met: null, reason: 'isolated_storage_feasibility' },
    scope: { baseline: '35 existing store.save calls', pairs: '18 existing store.save calls, at most two adjacent states per save',
      publication: 'synthetic indices appended only after save returns; not HTTP acknowledgements or production admission',
      timing: 'fixture generation and reopening excluded; store.save includes validation, encoding, real fsync and rename',
      accounting: 'expectedEncodedBytes are derived from fixture states; successful syncCalls inferred from storeTiming.saves with zero failures, not direct syscall tracing',
      failure: 'invalid grouped state rejected by production validation; not an injected I/O or crash failure' },
    workload: { uniqueTraces: 1051, updatedTraces: 64, states: 35, historyLimit: 100,
      fileCases: [1, 64], rounds: 3, maximumGroupSize: 2 },
    fixtures: datasets.map(data => ({ fileCount: data.fileCount, digest: data.digest })),
    conditions: [], failureControls: [] };
  for (let round = 0; round < 3; round++) for (const data of datasets) {
    const modes = round % 2 ? ['pairs', 'baseline'] : ['baseline', 'pairs'];
    for (const mode of modes) report.conditions.push(condition(data, mode, round + 1, parent));
  }
  for (const data of datasets) report.failureControls.push(failedGroupControl(data, parent));
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(reportPath, `durable-group-${id}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ conditions: report.conditions.map(row => ({ fileCount: row.fileCount, mode: row.mode,
    round: row.round, complete: row.complete, syncCalls: row.syncCalls, elapsedMs: row.elapsedMs,
    storageSyncMs: row.storeTiming?.syncMs, failure: row.failure })),
  failureControls: report.failureControls.map(row => ({ fileCount: row.fileCount, complete: row.complete, failure: row.failure })) }));
  assert.ok(report.conditions.every(row => row.complete && !row.failure && row.workspaceRemoved)
    && report.failureControls.every(row => row.complete && !row.failure && row.workspaceRemoved),
  'Grouped durable snapshot feasibility failed; sanitized report and failed workspace retained.');
});
