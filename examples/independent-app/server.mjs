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
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 4096) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const value = text ? JSON.parse(text) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON object');
  return value;
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

async function sendEvent(collectorUrl, event, timeoutMs, sessionToken) {
  const response = await fetch(`${collectorUrl}/flowatlas/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sessionToken === null ? {} : { authorization: `Bearer ${sessionToken}` }) },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(`FlowAtlas collector rejected ${event.kind}: ${failure.error ?? response.status}`);
  }
  return response.json();
}

async function reportEvent(collectorUrl, event, capture, timeoutMs) {
  if (!capture.complete) return;
  try {
    await sendEvent(collectorUrl, event, timeoutMs, capture.sessionToken);
  } catch {
    // Stop this capture after the first loss: later events cannot repair an incomplete run.
    capture.complete = false;
  }
}

async function runAction(route, actionId, collectorUrl, messageUrl, capture, timeoutMs) {
  const report = (event) => reportEvent(collectorUrl, event, capture, timeoutMs);
  const service = 'independent-app';
  const context = newTraceparent();
  await report({
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
    await report({
      kind: 'outbound-result', actionId, service, symbol: route.symbol,
      method: route.method, path: route.path, destination: 'message service',
      outcome: 'failed', error: error.message,
      durationMs: Math.round(performance.now() - started), traceparent: context,
    });
    await report({ kind: 'finish', actionId, outcome: 'error' });
    throw error;
  }
  const body = await downstream.json();
  await report({
    kind: 'outbound-result', actionId, service, symbol: route.symbol,
    method: route.method, path: route.path, destination: 'message service',
    outcome: 'completed', status: downstream.status,
    durationMs: Math.round(performance.now() - started), traceparent: context,
    receivedTraceparent: downstream.headers.get('x-received-traceparent'),
    routeFile: routeSource, routeSymbol: 'createMessageService',
  });
  await report({ kind: 'finish', actionId, outcome: downstream.ok ? 'success' : 'error' });
  return { status: downstream.status, body };
}

async function viewMessage(actionId, collectorUrl, messageUrl, capture, timeoutMs) {
  return runAction(actions.get('GET /api/message'), actionId, collectorUrl, messageUrl, capture, timeoutMs);
}

async function sendMessage(actionId, collectorUrl, messageUrl, capture, timeoutMs) {
  return runAction(actions.get('POST /api/send'), actionId, collectorUrl, messageUrl, capture, timeoutMs);
}

async function failMessage(actionId, collectorUrl, messageUrl, capture, timeoutMs) {
  return runAction(actions.get('POST /api/fail'), actionId, collectorUrl, messageUrl, capture, timeoutMs);
}

export async function startIndependentApp({ port = 4180, externalPort = 4181, collectorUrl = 'http://127.0.0.1:4173', telemetryTimeoutMs = 500,
  sessionToken = process.env.FLOWATLAS_SESSION_TOKEN ?? null } = {}) {
  if (!Number.isInteger(telemetryTimeoutMs) || telemetryTimeoutMs <= 0) throw new Error('Invalid telemetry timeout');
  const collector = new URL(collectorUrl);
  if (collector.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(collector.hostname)
    || collector.username || collector.password || collector.pathname !== '/' || collector.search || collector.hash
    || (sessionToken !== null && (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)))) {
    throw new Error('Invalid local collector config');
  }
  const captures = new Map();
  const external = createMessageService();
  const actualExternalPort = await listen(external, externalPort);
  const messageUrl = `http://127.0.0.1:${actualExternalPort}`;
  const app = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let currentCapture = null;
    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/app.js')) {
        const file = url.pathname === '/' ? 'index.html' : 'app.js';
        response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
        response.end(readFileSync(join(directory, 'public', file)));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/action-start') {
        const body = await readJson(request);
        if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(body.id)
          || ![...actions.values()].some((item) => item.name === body.name)
          || (body.clientTime != null && (typeof body.clientTime !== 'string' || body.clientTime.length > 64
            || Number.isNaN(Date.parse(body.clientTime))))) {
          sendJson(response, 400, { error: 'Invalid action' });
          return;
        }
        if (captures.has(body.id)) { sendJson(response, 409, { error: 'Action ID already exists' }); return; }
        const capture = { name: body.name, complete: true, used: false, sessionToken };
        captures.set(body.id, capture);
        if (captures.size > 100) captures.delete(captures.keys().next().value);
        await reportEvent(collectorUrl, {
          kind: 'action-start', actionId: body.id, name: body.name,
          clientTime: body.clientTime ?? null,
        }, capture, telemetryTimeoutMs);
        sendJson(response, 201, { id: body.id, viewerUrl: `${collectorUrl}/?actionId=${encodeURIComponent(body.id)}`,
          telemetry: { complete: capture.complete } });
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
      const capture = captures.get(actionId);
      if (!capture || capture.name !== route.name) { sendJson(response, 400, { error: 'Unknown or mismatched action' }); return; }
      if (capture.used) { sendJson(response, 409, { error: 'Action has already run' }); return; }
      capture.used = true;
      currentCapture = capture;
      const handler = route.name === 'view-message' ? viewMessage
        : route.name === 'send-message' ? sendMessage : failMessage;
      const result = await handler(actionId, collectorUrl, messageUrl, capture, telemetryTimeoutMs);
      response.setHeader('x-flowatlas-telemetry', capture.complete ? 'complete' : 'incomplete');
      sendJson(response, result.status, result.body);
    } catch (error) {
      if (currentCapture) response.setHeader('x-flowatlas-telemetry', currentCapture.complete ? 'complete' : 'incomplete');
      const clientError = ['Invalid JSON object', 'Request body is too large'].includes(error.message) || error instanceof SyntaxError;
      sendJson(response, clientError ? 400 : 502, { error: error.message });
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
