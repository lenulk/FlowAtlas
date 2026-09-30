import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServers } from '../src/server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function launchIndependentApp(collectorUrl) {
  const child = spawn(process.execPath, ['examples/independent-app/server.mjs'], {
    cwd: root, env: { ...process.env, PORT: '0', EXTERNAL_PORT: '0', FLOWATLAS_URL: collectorUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Independent app did not start: ${output}`)), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Independent app: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Independent app exited ${code}: ${output}`)); });
  });
  return { child, ready };
}

test('a separate web app sends three action traces to FlowAtlas across HTTP', async () => {
  const collector = await startServers({ port: 0, inventoryPort: 0 });
  const collectorUrl = `http://127.0.0.1:${collector.port}`;
  const fixture = launchIndependentApp(collectorUrl);
  try {
    const targetUrl = await fixture.ready;
    const page = await fetch(targetUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Message App/);

    const cases = [
      { name: 'view-message', method: 'GET', path: '/api/message', status: 200, outcome: 'success' },
      { name: 'send-message', method: 'POST', path: '/api/send', status: 200, outcome: 'success' },
      { name: 'fail-message', method: 'POST', path: '/api/fail', status: 503, outcome: 'error' },
    ];
    for (const item of cases) {
      const id = randomUUID();
      const started = await fetch(`${targetUrl}/action-start`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name: item.name, clientTime: new Date().toISOString() }),
      });
      assert.equal(started.status, 201);
      const startResult = await started.json();
      assert.equal(startResult.viewerUrl, `${collectorUrl}/?actionId=${id}`);
      const api = await fetch(`${targetUrl}${item.path}`, {
        method: item.method, headers: { 'x-flowatlas-action-id': id },
      });
      assert.equal(api.status, item.status);
      const graphResponse = await fetch(`${collectorUrl}/flowatlas/actions/${id}`);
      assert.equal(graphResponse.status, 200);
      const graph = await graphResponse.json();
      assert.equal(graph.name, item.name);
      assert.equal(graph.outcome, item.outcome);
      assert.deepEqual(graph.edges.map((edge) => edge.status),
        ['observed', 'observed', 'observed', 'inferred', 'unknown']);
      assert.equal(graph.edges[1].evidence.traceparent, graph.edges[2].evidence.traceparent);
      assert.equal(graph.edges[2].evidence.receivedTraceparent, graph.edges[2].evidence.traceparent);
      assert.match(graph.nodes.find((node) => node.type === 'code').source.file, /^examples\/independent-app\//);
      const routeSource = graph.nodes.find((node) => node.id.startsWith('external-route:')).source;
      const sourceResponse = await fetch(`${collectorUrl}/flowatlas/source?file=${encodeURIComponent(routeSource.file)}&sha256=${routeSource.sha256}`);
      assert.equal(sourceResponse.status, 200);
      assert.match(await sourceResponse.text(), /createMessageService/);
    }

    const missingId = await fetch(`${targetUrl}/api/message`);
    assert.equal(missingId.status, 400);
  } finally {
    fixture.child.kill();
    await Promise.race([once(fixture.child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    await collector.close();
  }
});

test('collector rejects mismatched action names, invalid trace context, and unknown source files', async () => {
  const collector = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${collector.port}`;
  const actionId = randomUUID();
  const send = (event) => fetch(`${base}/flowatlas/ingest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event),
  });
  try {
    assert.equal((await send({ kind: 'action-start', actionId, name: 'view-message' })).status, 202);
    const entry = {
      kind: 'handler-entry', actionId, name: 'view-message', service: 'independent-app',
      method: 'GET', path: '/api/message', symbol: 'viewMessage',
      file: 'examples/independent-app/server.mjs',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    };
    assert.equal((await send({ ...entry, name: 'send-message' })).status, 400);
    assert.equal((await send({ ...entry, traceparent: 'bad' })).status, 400);
    assert.equal((await send({ ...entry, file: '../secret.txt' })).status, 400);
    assert.equal((await send(entry)).status, 202);
    const badOutbound = {
      kind: 'outbound-result', actionId, service: 'independent-app', symbol: 'viewMessage',
      method: 'GET', path: '/external/message', destination: 'message service',
      outcome: 'completed', status: 200, durationMs: 1,
      traceparent: entry.traceparent, routeFile: '../secret.txt', routeSymbol: 'handler',
    };
    assert.equal((await send(badOutbound)).status, 400);
    const graph = await (await fetch(`${base}/flowatlas/actions/${actionId}`)).json();
    assert.equal(graph.edges.length, 2);
  } finally {
    await collector.close();
  }
});
