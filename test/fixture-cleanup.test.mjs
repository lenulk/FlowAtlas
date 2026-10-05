import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, isAbsolute } from 'node:path';
import { cleanupOwnedFixture } from '../scripts/qa-fixture-cleanup.mjs';

const parent = fileURLToPath(new URL('../reports/storage/', import.meta.url));
function fixture(code = "process.stdin.on('data',()=>process.exit(0));") {
  mkdirSync(parent, { recursive: true });
  const workspace = mkdtempSync(join(parent, 'cleanup-boundary-'));
  const canonical = realpathSync(workspace);
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.on('error', () => {});
  const closed = new Promise((resolve) => child.once('close', resolve));
  return { child, closed, parent, workspace, canonical, origins: [] };
}
async function dispose(owned) {
  // The boundary helper intentionally unrefs an unconfirmed child. This test
  // owns the subsequent forced disposal and must keep its close wait alive.
  owned.child.ref();
  for (const stream of [owned.child.stdin, owned.child.stdout, owned.child.stderr]) stream?.ref?.();
  if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill('SIGKILL');
  await owned.closed;
  // This exact canonical workspace was generated above, and the owned child is closed.
  if (existsSync(owned.canonical)) {
    const inside = relative(realpathSync(parent), owned.canonical);
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside) && realpathSync(owned.workspace) === owned.canonical);
    rmSync(owned.canonical, { recursive: true, force: true });
  }
}

test('QA cleanup requests stop and confirms close before removing workspace', async () => {
  const owned = fixture();
  try {
    assert.deepEqual(await cleanupOwnedFixture(owned), { closed: true, lockRemoved: true, portsClosed: [], removed: true });
    assert.equal(existsSync(owned.workspace), false);
  } finally { await dispose(owned); }
});

test('QA cleanup retains a lock even when its known wrapper already closed', async () => {
  const owned = fixture('process.exit(0)');
  const lock = join(owned.workspace, 'data/actions/.writer.lock');
  mkdirSync(join(owned.workspace, 'data/actions'), { recursive: true }); writeFileSync(lock, 'retained QA evidence');
  try {
    await owned.closed;
    const result = await cleanupOwnedFixture({ ...owned, timeoutMs: 100 });
    assert.equal(result.closed, true); assert.equal(result.lockRemoved, false); assert.equal(result.removed, false);
    assert.equal(existsSync(lock), true);
  } finally { await dispose(owned); }
});

test('QA cleanup retains workspace if a known port is still listening', async () => {
  const owned = fixture(); const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await cleanupOwnedFixture({ ...owned, origins: [`http://127.0.0.1:${server.address().port}`], timeoutMs: 300 });
    assert.deepEqual(result.portsClosed, [false]); assert.equal(result.removed, false);
    assert.equal(existsSync(owned.workspace), true);
  } finally { await new Promise((resolve) => server.close(resolve)); await dispose(owned); }
});

test('QA cleanup bounds an unresponsive owned child without force-killing it', async () => {
  const owned = fixture("process.stdin.resume(); setInterval(()=>{},1000);");
  try {
    const started = Date.now();
    const result = await cleanupOwnedFixture({ ...owned, timeoutMs: 100 });
    assert.equal(result.closed, false); assert.equal(result.removed, false);
    assert.equal(owned.child.exitCode, null); assert.equal(owned.child.signalCode, null);
    assert.ok(Date.now() - started < 2000);
    assert.equal(existsSync(owned.workspace), true);
  } finally { await dispose(owned); }
});

test('QA cleanup rejects a changed canonical workspace before sending stop', async () => {
  const owned = fixture();
  try {
    await assert.rejects(cleanupOwnedFixture({ ...owned, canonical: realpathSync(parent) }), /canonical parent/);
    assert.equal(owned.child.stdin.writableEnded, false);
    assert.equal(existsSync(owned.workspace), true);
  } finally { await dispose(owned); }
});
