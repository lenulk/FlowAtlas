import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { replaceStateFile } from '../src/action-store.mjs';

test('transient Windows replacement refusal retries the same staged bytes before replacing old state', (t) => {
  const root = realpathSync(process.cwd());
  const parent = join(root, 'reports', 'storage'); mkdirSync(parent, { recursive: true });
  const canonicalParent = realpathSync(parent), rel = relative(root, canonicalParent);
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
  const directory = realpathSync(mkdtempSync(join(canonicalParent, 'replacement-')));
  assert.equal(dirname(directory), canonicalParent);
  t.after(() => {
    assert.equal(realpathSync(directory), directory); assert.equal(dirname(directory), canonicalParent);
    rmSync(directory, { recursive: true, force: true });
  });
  const source = join(directory, 'staged.tmp'), destination = join(directory, 'state.json');
  writeFileSync(source, 'new durable state'); writeFileSync(destination, 'old durable state');
  let attempts = 0; const pauses = [];
  replaceStateFile(source, destination, { platform: 'win32', pause: (ms) => pauses.push(ms),
    rename: (from, to) => {
      assert.equal(from, source); assert.equal(to, destination);
      assert.equal(readFileSync(source, 'utf8'), 'new durable state');
      assert.equal(readFileSync(destination, 'utf8'), 'old durable state');
      if (++attempts <= 2) throw Object.assign(new Error('controlled refusal'), { code: 'EPERM' });
      renameSync(from, to);
    } });
  assert.equal(attempts, 3); assert.deepEqual(pauses, [5, 10]);
  assert.equal(readFileSync(destination, 'utf8'), 'new durable state'); assert.equal(existsSync(source), false);
});

test('persistent Windows refusal stops within the retry budget and other failures are not retried', () => {
  for (const [platform, code, expectedAttempts] of [['win32', 'EPERM', 5], ['win32', 'EBUSY', 5],
    ['win32', 'EACCES', 5], ['win32', 'ENOSPC', 1], ['linux', 'EPERM', 1]]) {
    let attempts = 0; const pauses = [];
    const failure = Object.assign(new Error('controlled persistent failure'), { code });
    assert.throws(() => replaceStateFile('staged.tmp', 'state.json', { platform,
      pause: (ms) => pauses.push(ms), rename: () => { attempts++; throw failure; } }), (error) => error === failure);
    assert.equal(attempts, expectedAttempts);
    assert.equal(pauses.reduce((total, ms) => total + ms, 0), expectedAttempts === 5 ? 75 : 0);
  }
});
