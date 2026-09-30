import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startServers } from '../src/server.mjs';
import { validateGraph } from '../src/evidence-contract.mjs';

function post(base, path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('invalid action payloads return 400 and never create an action', async () => {
  const servers = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${servers.port}`;
  try {
    for (const body of [null, [], 'text', 42,
      { id: randomUUID(), name: 'view-product', clientTime: { private: 'must not be stored' } },
      { id: randomUUID(), name: 'view-product', clientTime: 'not-a-time' }]) {
      const response = await post(base, '/flowatlas/action-start', body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    for (const clientTime of [{ private: 'must not be stored' }, 'not-a-time']) {
      assert.equal((await post(base, '/flowatlas/ingest', {
        kind: 'action-start', actionId: randomUUID(), name: 'example', clientTime,
      })).status, 400);
    }
    assert.deepEqual(await (await fetch(`${base}/flowatlas/actions`)).json(), []);
  } finally { await servers.close(); }
});

test('rejected handler events leave the existing graph unchanged', async () => {
  const servers = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${servers.port}`;
  const actionId = randomUUID();
  const send = (event) => post(base, '/flowatlas/ingest', { actionId, ...event });
  const get = async () => {
    const response = await fetch(`${base}/flowatlas/actions/${actionId}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const entry = { kind: 'handler-entry', name: 'example', service: 'app', method: 'GET',
    path: '/one', symbol: 'handler', file: 'src/server.mjs' };
  try {
    await send({ kind: 'action-start', name: 'example' });
    const empty = await get();
    assert.equal((await send({ ...entry, file: '__proto__' })).status, 400);
    assert.deepEqual(await get(), empty);
    assert.equal((await send(entry)).status, 202);
    const before = await get();
    assert.equal((await send({ ...entry, path: '/two', file: 'src/catalog.mjs' })).status, 400);
    assert.deepEqual(await get(), before);
  } finally { await servers.close(); }
});

test('graph validation reports malformed nodes and edges without throwing', () => {
  const graph = { schemaVersion: '0.1', id: 'action-123', name: 'test',
    startedAt: new Date().toISOString(), finishedAt: null, outcome: 'running',
    codeVersion: { digest: 'a'.repeat(64), files: {} }, nodes: [null], edges: [null] };
  assert.doesNotThrow(() => validateGraph(graph));
  assert.ok(validateGraph(graph).length > 0);
});
