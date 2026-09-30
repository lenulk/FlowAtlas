import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMessageService } from './external.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const routeSource = 'examples/independent-app/external.mjs';
const handlerSource = 'examples/independent-app/server.mjs';
const actions = new Map([
  ['GET /api/message', { name: 'view-message', symbol: 'viewMessage', method: 'GET', apiPath: '/api/message', path: '/external/message' }],
  ['POST /api/send', { name: 'send-message', symbol: 'sendMessage', method: 'POST', apiPath: '/api/send', path: '/external/send' }],
  ['POST /api/fail', { name: 'fail-message', symbol: 'failMessage', method: 'POST', apiPath: '/api/fail', path: '/external/fail' }],
]);

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let value = '';
  for await (const chunk of request) {
    value += chunk;
    if (value.length > 4096) throw new Error('Request body is too large');
  }
  return value ? JSON.parse(value) : {};
}

function listen(server, port) {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePort(server.address().port);
    });
  });
}

function newTraceparent() {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}

async function sendEvent(collectorUrl, event) {
  const response = await fetch(`${collectorUrl}/flowatlas/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(`FlowAtlas collector rejected ${event.kind}: ${failure.error ?? response.status}`);
  }
  return response.json();
}

async function runAction(route, actionId, collectorUrl, messageUrl) {
  const service = 'independent-app';
  const context = newTraceparent();
  await sendEvent(collectorUrl, {
    kind: 'handler-entry', actionId, name: route.name, service,
    method: route.method, path: route.apiPath,
    symbol: route.symbol, file: handlerSource, traceparent: context,
  });
  const started = performance.now();
  let downstream;
  try {
    downstream = await fetch(`${messageUrl}${route.path}`, {
      method: route.method,
      headers: { traceparent: context, 'x-flowatlas-action-id': actionId },
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    await sendEvent(collectorUrl, {
      kind: 'outbound-result', actionId, service, symbol: route.symbol,
      method: route.method, path: route.path, destination: 'message service',
      outcome: 'failed', error: error.message,
      durationMs: Math.round(performance.now() - started), traceparent: context,
    });
    await sendEvent(collectorUrl, { kind: 'finish', actionId, outcome: 'error' });
    throw error;
  }
  const body = await downstream.json();
  await sendEvent(collectorUrl, {
    kind: 'outbound-result', actionId, service, symbol: route.symbol,
    method: route.method, path: route.path, destination: 'message service',
    outcome: 'completed', status: downstream.status,
    durationMs: Math.round(performance.now() - started), traceparent: context,
    receivedTraceparent: downstream.headers.get('x-received-traceparent'),
    routeFile: routeSource, routeSymbol: 'createMessageService',
  });
  await sendEvent(collectorUrl, { kind: 'finish', actionId, outcome: downstream.ok ? 'success' : 'error' });
  return { status: downstream.status, body };
}

async function viewMessage(actionId, collectorUrl, messageUrl) {
  return runAction(actions.get('GET /api/message'), actionId, collectorUrl, messageUrl);
}

async function sendMessage(actionId, collectorUrl, messageUrl) {
  return runAction(actions.get('POST /api/send'), actionId, collectorUrl, messageUrl);
}

async function failMessage(actionId, collectorUrl, messageUrl) {
  return runAction(actions.get('POST /api/fail'), actionId, collectorUrl, messageUrl);
}

export async function startIndependentApp({ port = 4180, externalPort = 4181, collectorUrl = 'http://127.0.0.1:4173' } = {}) {
  const external = createMessageService();
  const actualExternalPort = await listen(external, externalPort);
  const messageUrl = `http://127.0.0.1:${actualExternalPort}`;
  const app = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/app.js')) {
        const file = url.pathname === '/' ? 'index.html' : 'app.js';
        response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
        response.end(readFileSync(join(directory, 'public', file)));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/action-start') {
        const body = await readJson(request);
        if (typeof body.id !== 'string' || ![...actions.values()].some((item) => item.name === body.name)) {
          sendJson(response, 400, { error: 'Invalid action' });
          return;
        }
        await sendEvent(collectorUrl, {
          kind: 'action-start', actionId: body.id, name: body.name,
          clientTime: body.clientTime ?? null,
        });
        sendJson(response, 201, { id: body.id, viewerUrl: `${collectorUrl}/?actionId=${encodeURIComponent(body.id)}` });
        return;
      }
      const route = actions.get(`${request.method} ${url.pathname}`);
      if (!route) {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      const actionId = request.headers['x-flowatlas-action-id'];
      if (typeof actionId !== 'string') {
        sendJson(response, 400, { error: 'Missing action ID' });
        return;
      }
      const handler = route.name === 'view-message' ? viewMessage
        : route.name === 'send-message' ? sendMessage : failMessage;
      const result = await handler(actionId, collectorUrl, messageUrl);
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, 502, { error: error.message });
    }
  });
  try {
    const actualPort = await listen(app, port);
    return {
      app, external, port: actualPort, externalPort: actualExternalPort,
      async close() {
        await Promise.all([app, external].map((server) => new Promise((done) => server.close(done))));
      },
    };
  } catch (error) {
    await new Promise((done) => external.close(done));
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const instance = await startIndependentApp({
    port: Number(process.env.PORT ?? 4180),
    externalPort: Number(process.env.EXTERNAL_PORT ?? 4181),
    collectorUrl: process.env.FLOWATLAS_URL ?? 'http://127.0.0.1:4173',
  });
  console.log(`Independent app: http://127.0.0.1:${instance.port}`);
}
