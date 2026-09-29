import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startServers } from '../src/server.mjs';

test('one browser action links to API, code, and external service with honest evidence statuses', async () => {
  const servers = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${servers.port}`;
  try {
    const id = randomUUID();
    const start = await fetch(`${base}/flowatlas/action-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'check-stock', clientTime: new Date().toISOString() }),
    });
    assert.equal(start.status, 201);
    const api = await fetch(`${base}/api/check-stock`, {
      method: 'POST', headers: { 'x-flowatlas-action-id': id },
    });
    assert.equal(api.status, 200);
    assert.equal(api.headers.get('x-flowatlas-action-id'), id);
    assert.deepEqual(await api.json(), { productId: 'atlas-notebook', stock: 2 });

    const graphResponse = await fetch(`${base}/flowatlas/actions/${id}`);
    assert.equal(graphResponse.status, 200);
    const graph = await graphResponse.json();
    assert.equal(graph.id, id);
    assert.equal(graph.outcome, 'success');
    assert.match(graph.codeVersion.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(graph.edges.map((edge) => edge.status),
      ['observed', 'observed', 'observed', 'inferred', 'unknown']);
    assert.equal(graph.edges[2].evidence.status, 200);
    assert.equal(graph.edges[3].evidence.type, 'source-route-match');
    assert.equal(graph.edges[4].evidence.type, 'coverage-gap');
    assert.ok(graph.edges.every((edge) => edge.evidence.id && edge.evidence.recordedAt));

    const code = graph.nodes.find((node) => node.id === 'code:checkStock');
    assert.equal(code.source.status, 'inferred');
    const source = await fetch(`${base}/flowatlas/source?file=${encodeURIComponent(code.source.file)}&sha256=${code.source.sha256}`);
    assert.equal(source.status, 200);
    assert.match(await source.text(), /startServers/);
    const stale = await fetch(`${base}/flowatlas/source?file=${encodeURIComponent(code.source.file)}&sha256=wrong`);
    assert.equal(stale.status, 404);
  } finally {
    await servers.close();
  }
});

test('all three actions work and depleted stock is an error in the trace', async () => {
  const servers = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${servers.port}`;
  try {
    const product = await fetch(`${base}/api/product`);
    assert.equal(product.status, 200);
    const productId = product.headers.get('x-flowatlas-action-id');
    const productGraph = await (await fetch(`${base}/flowatlas/actions/${productId}`)).json();
    assert.equal(productGraph.name, 'view-product');
    assert.equal(productGraph.nodes[0].origin, 'unverified');
    assert.deepEqual(productGraph.edges.map((edge) => edge.status), ['unknown', 'observed']);

    for (const expectedStatus of [200, 200, 409]) {
      const order = await fetch(`${base}/api/place-order`, { method: 'POST' });
      assert.equal(order.status, expectedStatus);
      const id = order.headers.get('x-flowatlas-action-id');
      const graph = await (await fetch(`${base}/flowatlas/actions/${id}`)).json();
      assert.equal(graph.outcome, expectedStatus === 409 ? 'error' : 'success');
      assert.equal(graph.edges.find((edge) => edge.evidence.type === 'http-outbound').evidence.status, expectedStatus);
    }
    const list = await (await fetch(`${base}/flowatlas/actions`)).json();
    assert.equal(list.length, 4);
  } finally {
    await servers.close();
  }
});

test('invalid and duplicate action IDs are rejected', async () => {
  const servers = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${servers.port}`;
  try {
    const post = (id) => fetch(`${base}/flowatlas/action-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'view-product' }),
    });
    assert.equal((await post('../bad')).status, 400);
    const id = randomUUID();
    assert.equal((await post(id)).status, 201);
    assert.equal((await post(id)).status, 409);
    const malformed = await fetch(`${base}/flowatlas/action-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    });
    assert.equal(malformed.status, 400);
  } finally {
    await servers.close();
  }
});

test('an unavailable service leaves evidence of the attempted outbound request', async () => {
  const servers = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${servers.port}`;
  try {
    await new Promise((resolve) => servers.inventory.close(resolve));
    const response = await fetch(`${base}/api/check-stock`, { method: 'POST' });
    assert.equal(response.status, 500);
    const id = response.headers.get('x-flowatlas-action-id');
    const graph = await (await fetch(`${base}/flowatlas/actions/${id}`)).json();
    assert.equal(graph.outcome, 'error');
    const outbound = graph.edges.find((edge) => edge.evidence.type === 'http-outbound');
    assert.equal(outbound.status, 'observed');
    assert.equal(outbound.evidence.outcome, 'failed');
    assert.equal(graph.edges.some((edge) => edge.status === 'inferred'), false);
  } finally {
    await servers.close();
  }
});
