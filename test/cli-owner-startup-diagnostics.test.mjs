import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { observeOwnedStartup, awaitOwnedReadiness } from '../scripts/cli-owner-startup-diagnostics.mjs';

function fixture() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  return child;
}
test('startup diagnostic keeps split markers and fixed lifecycle fields without raw output', () => {
  const child = fixture(); let time = 100;
  const observer = observeOwnedStartup(child, () => true, () => time);
  child.emit('spawn');
  child.stdout.emit('data', Buffer.from('private-token\nFlowAt'));
  child.stdout.emit('data', Buffer.from('las: http://127.0.0.1:1234\nApp: http://127.0.0.1:5678\n'));
  child.stderr.emit('data', Buffer.from('secret path /private/customer-data'));
  child.emit('error', { code: 'private-error', message: 'private-token' });
  child.emit('exit', 7, null); child.emit('close'); time = 125;
  const result = observer.snapshot();
  assert.deepEqual(Object.keys(result).sort(), ['spawned', 'exited', 'closed', 'collectorReported', 'targetReported',
    'stdoutBytes', 'stderrBytes', 'errorCode', 'exitCode', 'signal', 'elapsedMs', 'writerLockExists'].sort());
  assert.equal(result.collectorReported, true); assert.equal(result.targetReported, true);
  assert.equal(result.spawned && result.exited && result.closed, true);
  assert.equal(result.errorCode, 'OTHER'); assert.equal(result.exitCode, 7);
  assert.equal(result.elapsedMs, 25); assert.equal(result.writerLockExists, true);
  assert.equal(result.stderrBytes, Buffer.byteLength('secret path /private/customer-data'));
  assert.doesNotMatch(JSON.stringify(result), /private|secret|1234|5678/);
  observer.dispose(); observer.dispose();
  for (const event of ['spawn', 'error', 'exit', 'close']) assert.equal(child.listenerCount(event), 0);
  assert.equal(child.stdout.listenerCount('data'), 0); assert.equal(child.stderr.listenerCount('data'), 0);
});
test('startup diagnostic lock read failure and stderr spoof cannot claim readiness', () => {
  const child = fixture(); const observer = observeOwnedStartup(child, () => { throw Error('secret lock path'); });
  child.stdout.emit('data', Buffer.from('x'.repeat(100000)));
  child.stderr.emit('data', Buffer.from('FlowAtlas: http://127.0.0.1:9999\nApp: http://127.0.0.1:8888'));
  child.emit('error', { code: 'ENOENT' }); child.emit('exit', null, 'SIGKILL');
  const result = observer.snapshot();
  assert.equal(result.stdoutBytes, 100000); assert.equal(result.writerLockExists, null);
  assert.equal(result.collectorReported || result.targetReported, false);
  assert.equal(result.errorCode, 'ENOENT'); assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.closed, false); observer.dispose();
});
test('startup diagnostic reports actual owned child early exit without publishing stderr', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['-e', "process.stderr.write('private-fixture-token');process.exit(23)"],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
  const observer = observeOwnedStartup(child, () => false);
  const original = new Error('Controlled owned child exited before readiness'); let diagnostic;
  try {
    await assert.rejects(awaitOwnedReadiness(async () => {
      await once(child, 'close'); throw original;
    }, observer, (message) => { diagnostic = message; }), (error) => error === original);
    const result = observer.snapshot();
    assert.equal(result.spawned && result.exited && result.closed, true);
    assert.equal(result.exitCode, 23); assert.equal(result.writerLockExists, false);
    assert.equal(result.collectorReported || result.targetReported, false);
    assert.equal(result.stderrBytes, Buffer.byteLength('private-fixture-token'));
    assert.doesNotMatch(JSON.stringify(result), /private-fixture-token/);
    assert.match(diagnostic, /^Owner startup state: /);
    assert.equal(JSON.parse(diagnostic.slice('Owner startup state: '.length)).exitCode, 23);
    assert.doesNotMatch(diagnostic, /private-fixture-token/);
  } finally {
    observer.dispose();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
test('startup evidence preserves the original failure even if diagnostic reporting fails', async () => {
  const child = fixture(); const observer = observeOwnedStartup(child, () => false);
  const original = new Error('original readiness failure');
  await assert.rejects(awaitOwnedReadiness(async () => { throw original; }, observer,
    () => { throw Error('diagnostic sink failed'); }), (error) => error === original);
  assert.equal(child.listenerCount('spawn'), 0);
  const successObserver = observeOwnedStartup(child, () => false);
  assert.equal(await awaitOwnedReadiness(async () => 'ready', successObserver, () => assert.fail()), 'ready');
  assert.equal(child.stdout.listenerCount('data'), 0);
});
