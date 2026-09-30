import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FlowAtlas } from '../src/flowatlas.mjs';
import { startServers } from '../src/server.mjs';

test('retention evicts only the oldest action and preserves the remaining graphs', () => {
  const atlas = new FlowAtlas({ digest: 'a'.repeat(64), files: {} }, 2);
  atlas.start('action-001', 'one');
  const second = atlas.start('action-002', 'two');
  atlas.finish(second.id, 'success');
  atlas.start('action-003', 'three');
  assert.equal(atlas.get('action-001'), null);
  assert.equal(atlas.get(second.id), second);
  assert.deepEqual(atlas.list().map((action) => action.id), ['action-003', 'action-002']);
  assert.equal(second.outcome, 'success');
});

test('node capacity includes the action node and accepts existing declarations at the limit', () => {
  const atlas = new FlowAtlas({ digest: 'a'.repeat(64), files: {} });
  const action = atlas.start('action-001', 'bounded');
  for (let i = 0; i < 99; i++) atlas.node(action, { id: `node-${i}`, type: 'unknown', label: 'Gap' });
  assert.equal(action.nodes.length, 100);
  assert.doesNotThrow(() => atlas.node(action, { id: 'node-0', type: 'unknown', label: 'Gap' }));
  assert.throws(() => atlas.node(action, { id: 'overflow', type: 'unknown', label: 'Gap' }), /capacity/);
  assert.equal(action.nodes.length, 100);
});

test('UTF-8 request size is limited by bytes and rejected without storing private fields', async () => {
  const servers = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${servers.port}`;
  const id = randomUUID();
  try {
    const response = await fetch(`${base}/flowatlas/action-start`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'view-product', ignored: 'ก'.repeat(5500) }) });
    assert.equal(response.status, 400);
    assert.equal(servers.atlas.get(id), null);
  } finally { await servers.close(); }
});

test('ingestion caps each graph and rejects overflow atomically', async () => {
  const servers = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${servers.port}`;
  const actionId = randomUUID();
  const send = (event) => fetch(`${base}/flowatlas/ingest`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId, ...event }) });
  try {
    await send({ kind: 'action-start', name: 'bounded' });
    const entry = { kind: 'handler-entry', name: 'bounded', service: 'app', method: 'GET',
      path: '/bounded', symbol: 'handler', file: 'src/server.mjs' };
    for (let i = 0; i < 100; i++) assert.equal((await send(entry)).status, 202);
    const before = structuredClone(servers.atlas.get(actionId));
    assert.equal(before.edges.length, 200);
    assert.equal((await send(entry)).status, 413);
    assert.deepEqual(servers.atlas.get(actionId), before);
    const graph = await fetch(`${base}/flowatlas/actions/${actionId}`);
    assert.equal(graph.status, 200);
  } finally { await servers.close(); }
});
