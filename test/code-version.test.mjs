import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCodeVersion } from '../src/flowatlas.mjs';

test('code version distinguishes a commit from changed working-tree files', () => {
  const storage = join(dirname(dirname(fileURLToPath(import.meta.url))), 'reports', 'storage');
  mkdirSync(storage, { recursive: true });
  const root = mkdtempSync(join(storage, 'flowatlas-version-'));
  const safeRoot = resolve(root);
  const safeTemp = resolve(storage);
  if (!safeRoot.startsWith(`${safeTemp}${sep}`)) throw new Error('Temporary test path escaped the project storage directory');
  try {
    for (const folder of ['src', 'public', 'examples']) mkdirSync(join(root, folder));
    writeFileSync(join(root, 'src', 'app.mjs'), 'export const value = 1;\n');
    writeFileSync(join(root, 'public', 'index.html'), '<!doctype html>\n');
    writeFileSync(join(root, 'examples', 'demo.mjs'), 'export const demo = true;\n');
    const installed = getCodeVersion(root);
    assert.equal(installed.commit, null, 'A packaged tool must not inherit its parent repository commit');
    assert.equal(installed.dirty, null);
    assert.match(installed.digest, /^[a-f0-9]{64}$/);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Codex', '-c', 'user.email=codex@localhost', 'commit', '-qm', 'fixture'], { cwd: root });

    const clean = getCodeVersion(root);
    assert.equal(clean.dirty, false);
    assert.match(clean.commit, /^[a-f0-9]{40,64}$/);
    writeFileSync(join(root, 'src', 'app.mjs'), 'export const value = 2;\n');
    const changed = getCodeVersion(root);
    assert.equal(changed.dirty, true);
    assert.equal(changed.commit, clean.commit);
    assert.notEqual(changed.digest, clean.digest);
  } finally {
    rmSync(safeRoot, { recursive: true, force: true });
  }
});
