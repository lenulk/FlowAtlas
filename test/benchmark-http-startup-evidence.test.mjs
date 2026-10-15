import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QA_STARTUP_PREFIX } from '../scripts/cli-startup-phases.mjs';
import { observeBenchmarkStartup } from '../scripts/benchmark-startup-evidence.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('owned benchmark child early exit produces bounded startup evidence without raw output', { timeout: 7000 }, async (t) => {
  const storageRoot = join(projectRoot, 'reports', 'storage');
  mkdirSync(storageRoot, { recursive: true });
  const workspace = mkdtempSync(join(storageRoot, 'benchmark-startup-evidence-'));
  const canonicalStorage = realpathSync(storageRoot);
  const canonicalWorkspace = realpathSync(workspace);
  const workspaceRelative = relative(canonicalStorage, canonicalWorkspace);
  assert.ok(workspaceRelative && !workspaceRelative.startsWith('..') && !isAbsolute(workspaceRelative));
  const lockPath = join(workspace, 'data', 'actions', '.writer.lock');
  mkdirSync(dirname(lockPath), { recursive: true });
  let cleanupVerified = false;
  t.after(() => {
    if (!cleanupVerified) return;
    assert.equal(lstatSync(workspace).isSymbolicLink(), false);
    const actualWorkspace = realpathSync(workspace);
    assert.equal(actualWorkspace, canonicalWorkspace);
    const withinStorage = relative(canonicalStorage, actualWorkspace);
    assert.ok(withinStorage && !withinStorage.startsWith('..') && !isAbsolute(withinStorage));
    assert.equal(realpathSync(dirname(actualWorkspace)), canonicalStorage);
    assert.equal(existsSync(lockPath), false);
    rmSync(actualWorkspace, { recursive: true, force: true });
  });

  const canary = 'private-benchmark-child-canary';
  const privatePath = 'C:\\private\\benchmark\\fixture';
  const phase = {
    role: 'inspector', phase: 'target-readiness-failed', elapsedMs: 19,
    ownerConnected: false, childSpawned: false,
    error: canary, path: privatePath,
  };
  const frame = `${QA_STARTUP_PREFIX}${JSON.stringify(phase)}\n`;
  const script = [
    `const frame = Buffer.from(${JSON.stringify(frame)}); process.stdout.write(frame.subarray(0, 13)); process.stdout.write(frame.subarray(13));`,
    `const utf8 = Buffer.from(${JSON.stringify(`π private stdout ${canary} ${privatePath}\n`)}); process.stdout.write(utf8.subarray(0, 1)); process.stdout.write(utf8.subarray(1));`,
    `process.stderr.write(${JSON.stringify(`private stderr ${canary} ${privatePath}\n`)});`,
    'process.exitCode = 23;',
  ].join('\n');
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
    windowsHide: true,
  });
  const observer = observeBenchmarkStartup(child, () => existsSync(lockPath));
  let timer;
  try {
    const closed = once(child, 'close');
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Owned benchmark child did not close within five seconds'));
      }, 5000);
    });
    await Promise.race([closed, timeout]);

    const snapshot = observer.snapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), ['owner', 'phases']);
    assert.deepEqual(Object.keys(snapshot.owner).sort(), [
      'spawned', 'exited', 'closed', 'collectorReported', 'targetReported', 'stdoutBytes', 'stderrBytes',
      'errorCode', 'exitCode', 'signal', 'elapsedMs', 'writerLockExists',
    ].sort());
    assert.deepEqual(Object.keys(snapshot.phases).sort(), ['invalidFrames', 'overflowFrames', 'records']);
    assert.equal(snapshot.phases.records.length, 1);
    assert.equal(snapshot.phases.invalidFrames, 0);
    assert.equal(snapshot.phases.overflowFrames, 0);
    assert.deepEqual(snapshot.phases.records[0], {
      role: 'inspector', phase: 'target-readiness-failed', elapsedMs: 19,
      ownerConnected: false, childSpawned: false,
    });
    assert.equal(snapshot.owner.spawned, true);
    assert.equal(snapshot.owner.exited, true);
    assert.equal(snapshot.owner.closed, true);
    assert.equal(snapshot.owner.exitCode, 23);
    assert.equal(snapshot.owner.signal, null);
    assert.equal(snapshot.owner.errorCode, null);
    assert.equal(snapshot.owner.writerLockExists, false);
    assert.equal(Number.isSafeInteger(snapshot.owner.elapsedMs), true);
    assert.ok(snapshot.owner.elapsedMs >= 0);
    for (const byteCount of [snapshot.owner.stdoutBytes, snapshot.owner.stderrBytes]) {
      assert.equal(Number.isSafeInteger(byteCount), true);
      assert.ok(byteCount >= 0);
    }
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(canary), false);
    assert.equal(serialized.includes(privatePath), false);
  } finally {
    clearTimeout(timer);
    observer.dispose();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const event of ['spawn', 'error', 'exit', 'close']) assert.equal(child.listenerCount(event), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
  cleanupVerified = true;
});

test('unknown owned-child signals are reduced to the fixed OTHER label', () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const observer = observeBenchmarkStartup(child, () => false);
  child.emit('exit', null, 'SIGUSR2');
  const snapshot = observer.snapshot();
  assert.equal(snapshot.owner.exitCode, null);
  assert.equal(snapshot.owner.signal, 'OTHER');
  assert.deepEqual(snapshot.phases, { records: [], invalidFrames: 0, overflowFrames: 0 });
  observer.dispose();
  for (const event of ['spawn', 'error', 'exit', 'close']) assert.equal(child.listenerCount(event), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
});
