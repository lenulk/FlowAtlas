import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCodeVersion } from '../src/flowatlas.mjs';
import { createQaStartupPhaseParser } from './cli-startup-phases.mjs';
import { finalizeCliOwnerFixture } from './qa-fixture-cleanup.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
test('controlled delayed target preserves original10s readiness failure and bounded phase evidence', { timeout: 26000 }, async () => {
  const parentPath = join(root, 'reports/storage'); mkdirSync(parentPath, { recursive: true });
  const parent = realpathSync(parentPath), workspace = realpathSync(mkdtempSync(join(parent, 'cli-phase-delay-')));
  const scope = relative(parent, workspace); assert.ok(scope && !scope.startsWith('..') && !isAbsolute(scope));
  assert.equal(lstatSync(workspace).isSymbolicLink(), false);
  mkdirSync(join(workspace, 'app'));
  writeFileSync(join(workspace, 'app/server.mjs'), `import {createServer} from 'node:http';
const server=createServer((req,res)=>res.end('owned reference'));
setTimeout(()=>server.listen(0,'127.0.0.1',()=>console.log('Registered app: http://127.0.0.1:'+server.address().port)),20000);
process.stdin.resume();
`);
  writeFileSync(join(workspace, 'flowatlas.config.json'), JSON.stringify({ projects: [{ id: 'phase-qa', root: 'app', files: ['server.mjs'] }] }));
  const parser = createQaStartupPhaseParser(), version = getCodeVersion(root);
  const child = spawn(process.execPath, ['scripts/cli.mjs', '--workspace', workspace, 'inspect'], { cwd: root,
    env: { ...process.env, FLOWATLAS_QA_STARTUP: '1', FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0',
      FLOWATLAS_SESSION_TOKEN: randomBytes(32).toString('base64url') }, stdio: ['pipe','pipe','pipe'], windowsHide: true });
  let stdoutBytes = 0, stderrBytes = 0, errorTail = '', failureObserved = false, childClosed = false;
  child.stdout.on('data', part => { stdoutBytes += part.length; parser.write(part); });
  child.stderr.on('data', part => {
    stderrBytes += part.length; const text = errorTail + part.toString();
    failureObserved ||= text.includes('App did not become ready within 10 seconds'); errorTail = text.slice(-128);
  });
  const closed = new Promise((resolve, reject) => { child.once('close', code => { childClosed = true; resolve(code); }); child.once('error', reject); });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 24000); let exitCode;
  try { exitCode = await closed; } finally { clearTimeout(watchdog); errorTail = ''; }
  const snapshot = parser.snapshot(), lockAbsent = !existsSync(join(workspace, 'data/actions/.writer.lock'));
  const cleanup = finalizeCliOwnerFixture({ parent, workspace, canonical: workspace,
    lock: join(workspace, 'data/actions/.writer.lock'), wrapperClosed: childClosed,
    wrapperPid: child.pid, ownedPids: [], isAlive: () => { throw new Error('Unknown PID must not be probed'); } });
  const directory = join(root, 'reports/diagnostics/cli-startup'); mkdirSync(directory, { recursive: true });
  const path = join(directory, `controlled-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  writeFileSync(path, JSON.stringify({ sourceCommit: version.commit, sourceDigest: version.digest, sourceDirty: version.dirty,
    evidenceKind: 'controlled owned target20s listen delay; does not establish historical SDK stall cause',
    targetDelayMs: 20000, originalTargetDeadlineMs: 10000, exitCode, originalFailureObserved: failureObserved,
    childClosed, writerLockAbsent: lockAbsent, stdoutBytes, stderrBytes, phases: snapshot,
    workspaceRetained: !cleanup.removed, cleanupConfirmation: cleanup }, null, 2)+'\n');
  assert.equal(exitCode, 1); assert.equal(failureObserved, true); assert.equal(childClosed, true); assert.equal(lockAbsent, true);
  assert.deepEqual(cleanup, { wrapperClosed: true, writerLockExists: false,
    identitiesKnown: false, ownedStopped: false, removed: false });
  assert.equal(existsSync(workspace), true);
  assert.equal(snapshot.invalidFrames + snapshot.overflowFrames, 0);
  const inspector = snapshot.records.filter(record => record.role === 'inspector');
  assert.deepEqual(inspector.map(record => record.phase), ['collector-start-requested','collector-started','owner-confirm-requested',
    'owner-confirmed','target-spawn-requested','target-spawned','target-readiness-failed']);
  const spawned = inspector.find(record => record.phase === 'target-spawned'), failed = inspector.at(-1);
  assert.equal(failed.childSpawned, true); assert.ok(failed.elapsedMs - spawned.elapsedMs >= 9500);
  assert.doesNotMatch(JSON.stringify(snapshot), /Bearer|127\.0\.0\.1|sessionToken|"pid"|workspace/);
  console.log(`Controlled startup phase evidence retained: ${relative(root,path)}`);
});
