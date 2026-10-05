import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { getCodeVersion } from '../src/flowatlas.mjs';
import { captureProjectVersion } from '../src/project-sources.mjs';
import { JsonActionStore } from '../src/action-store.mjs';

function workspace(t) {
  const parent = join(process.cwd(), 'reports/storage'); mkdirSync(parent, { recursive: true });
  const directory = realpathSync(mkdtempSync(join(parent, 'snapshot-digest-')));
  t.after(() => {
    const inside = relative(realpathSync(parent), directory);
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside) && realpathSync(directory) === directory);
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function digest(files) {
  return crypto.createHash('sha256').update(Object.keys(files).sort().map((file) => `${file}\0${files[file]}`).join('\n')).digest('hex');
}
function graph(files) {
  return { schemaVersion: '0.1', id: 'snapshot-1234', name: 'snapshot', startedAt: new Date().toISOString(),
    finishedAt: null, outcome: 'running', codeVersion: { projectId: 'snapshot', files, digest: digest(files) },
    nodes: [{ id: 'action', type: 'user-action', label: 'snapshot', origin: 'client-reported' }], edges: [] };
}

test('captured tool and project file hashes cannot be edited in place', (t) => {
  const root = workspace(t);
  for (const name of ['src', 'public', 'examples']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'src/app.mjs'), 'export const value=1;');
  const tool = getCodeVersion(root), project = captureProjectVersion(join(root, 'src'), ['app.mjs'], 'snapshot');
  for (const version of [tool, project]) {
    const file = Object.keys(version.files)[0], hash = version.files[file];
    assert.equal(Object.isFrozen(version.files), true);
    assert.throws(() => { version.files[file] = 'b'.repeat(64); }, TypeError);
    assert.equal(version.files[file], hash);
  }
  writeFileSync(join(root, 'src/app.mjs'), 'export const value=2;');
  assert.notEqual(captureProjectVersion(join(root, 'src'), ['app.mjs'], 'snapshot').digest, project.digest);
});

test('repeated saves hash an immutable snapshot once while checking every asserted digest', (t) => {
  const root = workspace(t), store = new JsonActionStore(root);
  const action = graph(Object.freeze({ 'app.mjs': 'a'.repeat(64) }));
  const original = crypto.createHash; let hashes = 0;
  const mocked = t.mock.method(crypto, 'createHash', (...args) => { hashes++; return Reflect.apply(original, crypto, args); });
  syncBuiltinESMExports();
  try {
    store.save([action]); store.save([action]); store.save([action]);
    assert.equal(hashes, 1, 'Unchanged immutable source files must not be rehashed for each save');
    const before = readFileSync(store.file, 'utf8');
    action.codeVersion.digest = 'b'.repeat(64);
    assert.throws(() => store.save([action]), /Unable to persist/);
    assert.equal(readFileSync(store.file, 'utf8'), before);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); store.close(); }
});

test('mutable and accessor snapshots are rechecked and graph validation never uses the digest cache', (t) => {
  const root = workspace(t), store = new JsonActionStore(root);
  try {
    for (const accessor of [false, true]) {
      let value = 'a'.repeat(64);
      const files = accessor ? Object.freeze(Object.defineProperty({}, 'app.mjs', { enumerable: true, get: () => value })) : { 'app.mjs': value };
      const action = graph(files); store.save([action]);
      const before = readFileSync(store.file, 'utf8');
      if (accessor) value = 'b'.repeat(64); else files['app.mjs'] = 'b'.repeat(64);
      assert.throws(() => store.save([action]), /Unable to persist/);
      assert.equal(readFileSync(store.file, 'utf8'), before);
    }
    const action = graph(Object.freeze({ 'app.mjs': 'a'.repeat(64) })); store.save([action]);
    const before = readFileSync(store.file, 'utf8');
    action.nodes[0].label = '';
    assert.throws(() => store.save([action]), /Unable to persist/);
    assert.equal(readFileSync(store.file, 'utf8'), before);
    action.nodes[0].label = 'snapshot'; action.codeVersion.files = Object.freeze({ '../escape.mjs': 'a'.repeat(64) });
    action.codeVersion.digest = digest(action.codeVersion.files);
    assert.throws(() => store.save([action]), /Unable to persist/);
    assert.equal(readFileSync(store.file, 'utf8'), before);
  } finally { store.close(); }
});
