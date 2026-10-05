import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServers } from '../src/server.mjs';
import { JsonActionStore, StorageError, storageErrorDiagnostic } from '../src/action-store.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const storageTests = join(root, 'reports', 'storage');
function temporaryStorage(t) {
  mkdirSync(storageTests, { recursive: true });
  const directory = mkdtempSync(join(storageTests, 'case-'));
  t.after(() => {
    const path = relative(storageTests, directory);
    assert.ok(path && !path.startsWith('..') && !isAbsolute(path));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
const post = (base, path, body) => fetch(`${base}${path}`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('opt-in storage timing records bounded numeric stages and preserves failed-save state', async (t) => {
  const dataDir = temporaryStorage(t);
  const servers = await startServers({ port: 0, inventoryPort: 0, dataDir, traceTiming: true });
  try {
    const id = randomUUID();
    assert.equal((await post(`http://127.0.0.1:${servers.port}`, '/flowatlas/action-start', { id, name: 'view-product' })).status, 201);
    const before = readFileSync(servers.atlas.store.file, 'utf8');
    assert.throws(() => servers.atlas.store.save([{}]), /Unable to persist/);
    assert.equal(readFileSync(servers.atlas.store.file, 'utf8'), before);
    const timing = servers.atlas.store.timingHealth();
    assert.equal(timing.saves, 2); assert.equal(timing.failures, 1);
    assert.ok(timing.validateMs > 0 && timing.syncMs > 0 && timing.serializeMs > 0);
    assert.ok(timing.totalMs >= timing.maxMs);
    assert.equal(Object.isFrozen(timing), true);
    assert.ok(Object.values(timing).every(value => Number.isFinite(value) && value >= 0));
    assert.equal(JSON.stringify(timing).includes('canary'), false);
  } finally { await servers.close(); }
  const disabled = new JsonActionStore(dataDir);
  try { assert.equal(disabled.timingHealth(), null); } finally { disabled.close(); }
});
async function expectStartupFailure(options, pattern) {
  let opened;
  try { await assert.rejects(async () => { opened = await startServers(options); }, pattern); }
  finally { if (opened) await opened.close(); }
}

test('completed and partial graphs survive a server restart without changing evidence', async (t) => {
  const dataDir = temporaryStorage(t);
  let servers = await startServers({ port: 0, inventoryPort: 0, dataDir });
  const snapshots = [];
  const partialId = randomUUID();
  try {
    const base = `http://127.0.0.1:${servers.port}`;
    for (const [name, path, method] of [['view-product', '/api/product', 'GET'],
      ['check-stock', '/api/check-stock', 'POST'], ['place-order', '/api/place-order', 'POST']]) {
      const id = randomUUID();
      assert.equal((await post(base, '/flowatlas/action-start', { id, name })).status, 201);
      assert.equal((await fetch(`${base}${path}`, { method, headers: { 'x-flowatlas-action-id': id } })).status, 200);
      snapshots.push(await (await fetch(`${base}/flowatlas/actions/${id}`)).json());
    }
    await post(base, '/flowatlas/ingest', { kind: 'action-start', actionId: partialId, name: 'partial' });
    await post(base, '/flowatlas/ingest', { kind: 'handler-entry', actionId: partialId, name: 'partial',
      service: 'app', method: 'GET', path: '/partial', symbol: 'handler', file: 'src/server.mjs' });
    snapshots.push(await (await fetch(`${base}/flowatlas/actions/${partialId}`)).json());
    await servers.close();
    servers = await startServers({ port: 0, inventoryPort: 0, dataDir });
    const restarted = `http://127.0.0.1:${servers.port}`;
    assert.equal((await (await fetch(`${restarted}/flowatlas/actions`)).json()).length, 4);
    for (const before of snapshots) {
      const response = await fetch(`${restarted}/flowatlas/actions/${before.id}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), before);
    }
    assert.equal(servers.atlas.get(partialId).outcome, 'running');
    assert.equal(servers.atlas.get(partialId).edges.length, 2);
  } finally { await servers.close(); }
});

test('a storage directory accepts only one collector at a time', async (t) => {
  const dataDir = temporaryStorage(t);
  const diagnostics = [];
  const first = await startServers({ port: 0, inventoryPort: 0, dataDir });
  try {
    await expectStartupFailure({ port: 0, inventoryPort: 0, dataDir,
      onStorageError: (diagnostic) => diagnostics.push(diagnostic) }, /locked/i);
    assert.deepEqual(diagnostics, [{ code: 'FLOWATLAS_STORAGE_ERROR', operation: 'initialize',
      stage: 'lock', causeCode: 'EEXIST' }]);
  } finally { await first.close(); }
  const reopened = await startServers({ port: 0, inventoryPort: 0, dataDir });
  await reopened.close();
});

test('corrupted saved data prevents startup and is preserved for recovery', async (t) => {
  const dataDir = temporaryStorage(t);
  const diagnostics = [];
  const file = join(dataDir, 'state.json');
  writeFileSync(file, '{broken');
  await expectStartupFailure({ port: 0, inventoryPort: 0, dataDir,
    onStorageError: (diagnostic) => diagnostics.push(diagnostic) }, /saved action/i);
  assert.deepEqual(diagnostics, [{ code: 'FLOWATLAS_STORAGE_ERROR', operation: 'load',
    stage: 'parse', causeCode: 'UNKNOWN' }]);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
  // Failed initialization must release its lock and leave no inventory listener behind.
  rmSync(file);
  const reopened = await startServers({ port: 0, inventoryPort: 0, dataDir });
  await reopened.close();
});

test('storage diagnostics omit secrets even in unexpected cause fields and nested errors', () => {
  const secret = 'CANARY_PRIVATE_TOKEN';
  for (const code of ['EPERM', secret]) {
    const cause = Object.assign(new Error(`${secret}: private path`), { code, path: secret,
      dest: secret, syscall: secret, stack: secret });
    const nested = new StorageError(secret, cause);
    const error = new StorageError(secret, nested, { operation: secret, stage: secret });
    const diagnostic = storageErrorDiagnostic(error);
    assert.deepEqual(diagnostic, { code: 'FLOWATLAS_STORAGE_ERROR', operation: 'unknown',
      stage: 'unknown', causeCode: code === 'EPERM' ? 'EPERM' : 'UNKNOWN' });
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
    assert.equal(Object.isFrozen(diagnostic), true);
  }
});

test('a throwing diagnostic sink cannot change storage rejection, cleanup or recovery', async (t) => {
  const dataDir = temporaryStorage(t);
  let called = 0;
  const servers = await startServers({ port: 0, inventoryPort: 0, dataDir,
    onStorageError: () => { called++; throw new Error('CANARY_SINK_FAILURE'); } });
  const base = `http://127.0.0.1:${servers.port}`;
  const state = join(dataDir, 'state.json');
  const id = randomUUID();
  try {
    mkdirSync(state);
    const response = await post(base, '/flowatlas/action-start', { id, name: 'view-product' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Unable to persist action; previous saved state has been preserved' });
    assert.equal(called, 1);
    assert.equal(servers.atlas.get(id), null);
    assert.equal(readdirSync(dataDir).some((file) => file.endsWith('.tmp')), false);
    rmdirSync(state);
    assert.equal((await post(base, '/flowatlas/action-start', { id, name: 'view-product' })).status, 201);
    assert.equal(called, 1);
  } finally { await servers.close(); }
});

test('persistent retention removes only expired graphs and remains bounded after restart', async (t) => {
  const dataDir = temporaryStorage(t);
  let servers = await startServers({ port: 0, inventoryPort: 0, dataDir, actionLimit: 2 });
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  try {
    const base = `http://127.0.0.1:${servers.port}`;
    for (const id of ids) await post(base, '/flowatlas/action-start', { id, name: 'view-product' });
    assert.equal(servers.atlas.get(ids[0]), null);
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).actions.length, 2);
    await servers.close();
    servers = await startServers({ port: 0, inventoryPort: 0, dataDir, actionLimit: 2 });
    assert.equal(servers.atlas.get(ids[0]), null);
    assert.deepEqual(new Set(servers.atlas.list().map((action) => action.id)), new Set(ids.slice(1)));
  } finally { await servers.close(); }
});

test('a filesystem write failure returns 503 without committing the rejected event or action', async (t) => {
  const dataDir = temporaryStorage(t);
  const diagnostics = [];
  const servers = await startServers({ port: 0, inventoryPort: 0, dataDir,
    onStorageError: (diagnostic) => diagnostics.push(diagnostic) });
  const base = `http://127.0.0.1:${servers.port}`;
  const id = randomUUID();
  const state = join(dataDir, 'state.json');
  const backup = join(dataDir, 'before-write.json');
  let blocked = false;
  try {
    assert.equal((await post(base, '/flowatlas/ingest', { kind: 'action-start', actionId: id, name: 'test' })).status, 202);
    const before = structuredClone(servers.atlas.get(id));
    const saved = readFileSync(state, 'utf8');
    // Create an actual rename obstruction in a disposable directory, preserving the last state.
    renameSync(state, backup);
    mkdirSync(state);
    blocked = true;
    const event = { kind: 'handler-entry', actionId: id, name: 'test', service: 'app',
      method: 'GET', path: '/test', symbol: 'handler', file: 'src/server.mjs' };
    const failed = await post(base, '/flowatlas/ingest', event);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'Unable to persist action; previous saved state has been preserved' });
    assert.deepEqual(servers.atlas.get(id), before);
    const rejectedId = randomUUID();
    assert.equal((await post(base, '/flowatlas/action-start', { id: rejectedId, name: 'view-product' })).status, 503);
    assert.equal(diagnostics.length, 2, 'Both rejected writes must have local diagnostics');
    for (const diagnostic of diagnostics) {
      assert.equal(diagnostic.operation, 'save');
      assert.equal(diagnostic.stage, 'rename');
      assert.notEqual(diagnostic.causeCode, 'UNKNOWN');
      t.diagnostic(`storage obstruction: ${JSON.stringify(diagnostic)}`);
    }
    assert.equal(servers.atlas.get(rejectedId), null);
    assert.equal(readFileSync(backup, 'utf8'), saved);
    assert.equal(readdirSync(dataDir).some((file) => file.endsWith('.tmp')), false);
    rmdirSync(state);
    renameSync(backup, state);
    blocked = false;
    const recovered = await post(base, '/flowatlas/ingest', event);
    assert.equal(recovered.status, 202, `Recovery failed: ${JSON.stringify(diagnostics)}`);
    assert.equal(diagnostics.length, 2);
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).actions[0].edges.length, 2);
  } finally {
    if (blocked) { rmdirSync(state); renameSync(backup, state); }
    await servers.close();
  }
});

test('saved source paths and snapshot digests are validated before serving old graphs', async (t) => {
  const dataDir = temporaryStorage(t);
  const servers = await startServers({ port: 0, inventoryPort: 0, dataDir });
  try { await post(`http://127.0.0.1:${servers.port}`, '/flowatlas/action-start', { id: randomUUID(), name: 'view-product' }); }
  finally { await servers.close(); }
  const file = join(dataDir, 'state.json');
  const original = JSON.parse(readFileSync(file, 'utf8'));
  for (const alter of [
    (state) => { state.actions[0].codeVersion.digest = '0'.repeat(64); },
    (state) => {
      const version = state.actions[0].codeVersion;
      version.files['../outside.txt'] = 'a'.repeat(64);
      version.digest = createHash('sha256').update(Object.keys(version.files).sort()
        .map((name) => `${name}\0${version.files[name]}`).join('\n')).digest('hex');
    },
    (state) => { state.actions.push(structuredClone(state.actions[0])); },
  ]) {
    const changed = structuredClone(original);
    alter(changed);
    const bytes = JSON.stringify(changed);
    writeFileSync(file, bytes);
    await expectStartupFailure({ port: 0, inventoryPort: 0, dataDir }, /saved actions/i);
    assert.equal(readFileSync(file, 'utf8'), bytes);
  }
});

test('storage cannot be placed outside the project or in code and Git directories', async () => {
  for (const dataDir of ['../outside', 'src/state', 'public/state', 'examples/state', '.git/state']) {
    await expectStartupFailure({ port: 0, inventoryPort: 0, dataDir }, /Data directory/);
  }
});

test('twenty concurrent persistent actions reload with the same isolated evidence', async (t) => {
  const dataDir = temporaryStorage(t);
  let servers = await startServers({ port: 0, inventoryPort: 0, dataDir });
  try {
    const base = `http://127.0.0.1:${servers.port}`;
    const captured = await Promise.all(Array.from({ length: 20 }, async () => {
      const id = randomUUID();
      assert.equal((await post(base, '/flowatlas/action-start', { id, name: 'check-stock' })).status, 201);
      assert.equal((await fetch(`${base}/api/check-stock`, { method: 'POST', headers: { 'x-flowatlas-action-id': id } })).status, 200);
      const graph = await (await fetch(`${base}/flowatlas/actions/${id}`)).json();
      assert.equal(graph.outcome, 'success');
      assert.ok(graph.edges.every((edge) => !edge.evidence.correlationId || edge.evidence.correlationId === id));
      return graph;
    }));
    await servers.close();
    servers = await startServers({ port: 0, inventoryPort: 0, dataDir });
    assert.equal(servers.atlas.actions.size, 20);
    for (const graph of captured) assert.deepEqual(servers.atlas.get(graph.id), graph);
  } finally { await servers.close(); }
});

test('a failed listener startup releases storage so the directory can be reopened', async (t) => {
  const dataDir = temporaryStorage(t);
  const occupied = await startServers({ port: 0, inventoryPort: 0 });
  try {
    for (const options of [{ port: occupied.port, inventoryPort: 0 }, { port: 0, inventoryPort: occupied.inventoryPort }]) {
      await expectStartupFailure({ ...options, dataDir }, /EADDRINUSE/);
      const recovered = await startServers({ port: 0, inventoryPort: 0, dataDir });
      await recovered.close();
    }
  } finally { await occupied.close(); }
});
