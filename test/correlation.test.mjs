import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startServers } from '../src/server.mjs';

test('same HTTP path in different destinations creates distinct request nodes', async () => {
  const servers = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${servers.port}`;
  const actionId = randomUUID();
  const send = (event) => fetch(`${base}/flowatlas/ingest`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId, ...event }) });
  try {
    await send({ kind: 'action-start', name: 'fanout' });
    await send({ kind: 'handler-entry', name: 'fanout', service: 'app', method: 'GET',
      path: '/fanout', symbol: 'handler', file: 'src/server.mjs' });
    for (const destination of ['service-a', 'service-b']) {
      assert.equal((await send({ kind: 'outbound-result', service: 'app', symbol: 'handler',
        destination, method: 'GET', path: '/health', outcome: 'completed', status: 200, durationMs: 1 })).status, 202);
    }
    const graph = await (await fetch(`${base}/flowatlas/actions/${actionId}`)).json();
    const requests = graph.nodes.filter((node) => node.type === 'external-request');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((node) => node.destination), ['service-a', 'service-b']);
    const edges = graph.edges.filter((edge) => edge.evidence.type === 'http-outbound');
    assert.equal(new Set(edges.map((edge) => edge.to)).size, 2);
    assert.deepEqual(edges.map((edge) => edge.evidence.destination), ['service-a', 'service-b']);
  } finally { await servers.close(); }
});

test('outbound events from a different trace are rejected without changing the graph', async () => {
  const servers = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${servers.port}`;
  const actionId = randomUUID();
  const send = (event) => fetch(`${base}/flowatlas/ingest`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId, ...event }) });
  const get = async () => (await fetch(`${base}/flowatlas/actions/${actionId}`)).json();
  try {
    await send({ kind: 'action-start', name: 'example' });
    await send({ kind: 'handler-entry', name: 'example', service: 'app', method: 'GET',
      path: '/example', symbol: 'handler', file: 'src/server.mjs',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01' });
    const before = await get();
    const outgoing = { kind: 'outbound-result', service: 'app', symbol: 'handler',
      method: 'GET', path: '/health', outcome: 'completed', status: 200, durationMs: 1,
      traceparent: '00-33333333333333333333333333333333-4444444444444444-01' };
    assert.equal((await send(outgoing)).status, 400);
    assert.deepEqual(await get(), before);
    // A new span in the same trace is valid; trace IDs, not parent span IDs, must match.
    assert.equal((await send({ ...outgoing,
      traceparent: '00-11111111111111111111111111111111-4444444444444444-01' })).status, 202);
  } finally { await servers.close(); }
});

test('twenty concurrent actions keep their evidence and outcomes isolated', async () => {
  const servers = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${servers.port}`;
  try {
    await Promise.all(Array.from({ length: 20 }, async () => {
      const id = randomUUID();
      const start = await fetch(`${base}/flowatlas/action-start`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, name: 'check-stock' }) });
      assert.equal(start.status, 201);
      assert.equal((await fetch(`${base}/api/check-stock`, { method: 'POST', headers: { 'x-flowatlas-action-id': id } })).status, 200);
      const graph = await (await fetch(`${base}/flowatlas/actions/${id}`)).json();
      assert.equal(graph.id, id);
      assert.equal(graph.outcome, 'success');
      assert.equal(graph.edges.length, 5);
      assert.ok(graph.edges.every((edge) => !edge.evidence.correlationId || edge.evidence.correlationId === id));
    }));
    assert.equal((await (await fetch(`${base}/flowatlas/actions`)).json()).length, 20);
  } finally { await servers.close(); }
});
