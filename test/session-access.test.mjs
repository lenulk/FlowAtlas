import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { startServers } from '../src/server.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startIndependentApp } from '../examples/independent-app/server.mjs';

test('session protects history, source, ingestion and demo routes before mutation', async () => {
  const token = randomBytes(32).toString('base64url');
  const servers = await startServers({ port: 0, inventoryPort: 0, sessionToken: token });
  const base = `http://127.0.0.1:${servers.port}`;
  try {
    for (const route of ['/flowatlas/actions', '/flowatlas/status', '/flowatlas/projects/private',
      '/flowatlas/source?file=src/server.mjs', '/api/product']) {
      const response = await fetch(base + route);
      assert.equal(response.status, 401, route);
      assert.deepEqual(await response.json(), { error: 'Session authorization required' });
    }
    for (const route of ['/flowatlas/ingest', '/flowatlas/action-start']) {
      const response = await fetch(base + route, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer invalid' },
        body: '{invalid' });
      assert.equal(response.status, 401, route);
    }
    assert.equal(servers.atlas.actions.size, 0);
    assert.deepEqual(await (await fetch(base + '/flowatlas/session')).json(), { authorizationRequired: true });
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(`${base}/flowatlas/actions?token=${token}`)).status, 401);
    const authorized = await fetch(base + '/flowatlas/actions', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), []);
  } finally { await servers.close(); }
});

test('foreign origins and rebinding Host are rejected even with a valid credential', async () => {
  const token = randomBytes(32).toString('base64url');
  const servers = await startServers({ port: 0, inventoryPort: 0, sessionToken: token });
  const base = `http://127.0.0.1:${servers.port}`;
  try {
    for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:1']) {
      assert.equal((await fetch(base + '/flowatlas/actions', {
        headers: { authorization: `Bearer ${token}`, origin },
      })).status, 403);
    }
    const rebound = await new Promise((done, reject) => {
      const call = request(base + '/flowatlas/actions', { headers: { host: `evil.example:${servers.port}`,
        authorization: `Bearer ${token}` } }, (response) => {
        response.resume(); response.on('end', () => done(response.statusCode));
      });
      call.on('error', reject); call.end();
    });
    assert.equal(rebound, 421);
    assert.equal((await fetch(base + '/flowatlas/actions', {
      headers: { authorization: `Bearer ${token}`, origin: base },
    })).status, 200);
  } finally { await servers.close(); }
});

test('session credential stays out of graphs and invalid credentials cannot read or append', async () => {
  const token = randomBytes(32).toString('base64url');
  const servers = await startServers({ port: 0, inventoryPort: 0, sessionToken: token });
  const base = `http://127.0.0.1:${servers.port}`;
  const id = randomUUID();
  try {
    assert.equal((await fetch(base + '/flowatlas/action-start', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'view-product' }),
    })).status, 201);
    const response = await fetch(base + `/flowatlas/actions/${id}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes(token), false);
    assert.equal((await fetch(base + `/flowatlas/actions/${id}`, {
      headers: { authorization: `Bearer ${randomBytes(32).toString('base64url')}` },
    })).status, 401);
  } finally { await servers.close(); }
});

test('standalone server enables authorization and hides credentials in piped output', { timeout: 15000 }, async () => {
  const token = randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, ['src/server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FLOWATLAS_SESSION_TOKEN: token, FLOWATLAS_MEMORY_ONLY: '1', PORT: '0', INVENTORY_PORT: '0' } });
  let output = ''; child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const base = await new Promise((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('Standalone readiness timed out')), 8000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/FlowAtlas MVP: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); ready(match[1]); }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Standalone exited before readiness')); });
    });
    assert.equal(output.includes(token), false);
    assert.equal((await fetch(base + '/flowatlas/actions')).status, 401);
    assert.equal((await fetch(base + '/flowatlas/actions', { headers: { authorization: `Bearer ${token}` } })).status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  }
});

test('independent fixture sends session credentials only to the collector and preserves its response', async () => {
  const token = randomBytes(32).toString('base64url');
  const servers = await startServers({ port: 0, inventoryPort: 0, sessionToken: token });
  const base = `http://127.0.0.1:${servers.port}`;
  let app;
  try {
    app = await startIndependentApp({ port: 0, externalPort: 0, collectorUrl: base, sessionToken: token });
    const target = `http://127.0.0.1:${app.port}`;
    const id = randomUUID();
    const started = await fetch(target + '/action-start', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'view-message' }) });
    const start = await started.json();
    assert.equal(start.telemetry.complete, true);
    assert.equal(JSON.stringify(start).includes(token), false);
    const response = await fetch(target + '/api/message', { headers: { 'x-flowatlas-action-id': id } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-flowatlas-telemetry'), 'complete');
    assert.equal((await response.text()).includes(token), false);
    const graph = await (await fetch(base + `/flowatlas/actions/${id}`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(graph.outcome, 'success');
    assert.equal(JSON.stringify(graph).includes(token), false);
  } finally { await app?.close(); await servers.close(); }
});
