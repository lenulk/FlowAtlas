import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { startServers } from '../src/server.mjs';
import { startIndependentApp } from '../examples/independent-app/server.mjs';

const post = (base, body) => fetch(`${base}/action-start`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('collector outage at action start preserves business success and error responses', async () => {
  const unavailable = createServer();
  await new Promise((resolve) => unavailable.listen(0, '127.0.0.1', resolve));
  const collectorUrl = `http://127.0.0.1:${unavailable.address().port}`;
  await new Promise((resolve) => unavailable.close(resolve));
  const fixture = await startIndependentApp({ port: 0, externalPort: 0, collectorUrl });
  const base = `http://127.0.0.1:${fixture.port}`;
  try {
    for (const [name, path, status] of [['send-message', '/api/send', 200], ['fail-message', '/api/fail', 503]]) {
      const id = randomUUID();
      const started = await post(base, { id, name });
      assert.equal(started.status, 201);
      assert.equal((await started.json()).telemetry.complete, false);
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'x-flowatlas-action-id': id } });
      assert.equal(response.status, status);
      assert.equal(response.headers.get('x-flowatlas-telemetry'), 'incomplete');
      const body = await response.json();
      if (status === 200) assert.equal(body.messageId, 'MSG-1');
      else assert.match(body.error, /temporarily unavailable/);
    }
  } finally { await fixture.close(); }
});

test('collector outage after action start preserves the API result and flags incomplete capture', async () => {
  const collector = await startServers({ port: 0, inventoryPort: 0 });
  const fixture = await startIndependentApp({ port: 0, externalPort: 0, collectorUrl: `http://127.0.0.1:${collector.port}` });
  const base = `http://127.0.0.1:${fixture.port}`;
  const id = randomUUID();
  try {
    const started = await post(base, { id, name: 'view-message' });
    assert.equal(started.status, 201);
    assert.equal((await started.json()).telemetry.complete, true);
    await collector.close();
    const response = await fetch(`${base}/api/message`, { headers: { 'x-flowatlas-action-id': id } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-flowatlas-telemetry'), 'incomplete');
    assert.match((await response.json()).message, /Hello/);
  } finally { await fixture.close(); await collector.close(); }
});

test('fixture validates local action input even when the collector is unavailable', async () => {
  const fixture = await startIndependentApp({ port: 0, externalPort: 0, collectorUrl: 'http://127.0.0.1:1' });
  const base = `http://127.0.0.1:${fixture.port}`;
  try {
    for (const body of [null, [], { id: '../bad', name: 'view-message' },
      { id: randomUUID(), name: 'view-message', clientTime: {} }]) {
      assert.equal((await post(base, body)).status, 400);
    }
  } finally { await fixture.close(); }
});

test('a downstream transport failure is distinct from a collector outage', async () => {
  const collector = await startServers({ port: 0, inventoryPort: 0 });
  const collectorUrl = `http://127.0.0.1:${collector.port}`;
  const fixture = await startIndependentApp({ port: 0, externalPort: 0, collectorUrl });
  const base = `http://127.0.0.1:${fixture.port}`;
  const id = randomUUID();
  try {
    await post(base, { id, name: 'view-message' });
    await new Promise((resolve) => fixture.external.close(resolve));
    const response = await fetch(`${base}/api/message`, { headers: { 'x-flowatlas-action-id': id } });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('x-flowatlas-telemetry'), 'complete');
    const graph = await (await fetch(`${collectorUrl}/flowatlas/actions/${id}`)).json();
    assert.equal(graph.outcome, 'error');
    assert.equal(graph.edges[2].evidence.outcome, 'failed');
    assert.equal(graph.edges.some((edge) => edge.status === 'inferred'), false);
  } finally { await fixture.close(); await collector.close(); }
});

test('a stalled collector times out and the action can still run', async () => {
  const stalled = createServer(() => {});
  await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve));
  const fixture = await startIndependentApp({ port: 0, externalPort: 0,
    collectorUrl: `http://127.0.0.1:${stalled.address().port}`, telemetryTimeoutMs: 50 });
  const base = `http://127.0.0.1:${fixture.port}`;
  const id = randomUUID();
  try {
    const startedAt = performance.now();
    const started = await post(base, { id, name: 'send-message' });
    assert.equal(started.status, 201);
    assert.equal((await started.json()).telemetry.complete, false);
    assert.ok(performance.now() - startedAt < 2000, 'collector wait must be bounded');
    const response = await fetch(`${base}/api/send`, { method: 'POST', headers: { 'x-flowatlas-action-id': id } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).messageId, 'MSG-1');
    assert.equal((await post(base, { id, name: 'send-message' })).status, 409);
    assert.equal((await fetch(`${base}/api/send`, { method: 'POST', headers: { 'x-flowatlas-action-id': id } })).status, 409);
  } finally {
    await fixture.close();
    stalled.closeAllConnections();
    await new Promise((resolve) => stalled.close(resolve));
  }
});
