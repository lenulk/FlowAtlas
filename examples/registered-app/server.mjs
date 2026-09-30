import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createFlowAtlasClient, captureProjectVersion } from './node-adapter.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const files = ['server.mjs', 'index.html', 'node-adapter.mjs', 'project-sources.mjs'];
const projectId = process.env.FLOWATLAS_PROJECT_ID ?? 'message-app';
const version = captureProjectVersion(root, files, projectId);
const client = createFlowAtlasClient({ projectId, codeDigest: version.digest,
  collectorUrl: process.env.FLOWATLAS_URL ?? 'http://127.0.0.1:4173' });
const captures = new Map();
const routes = new Map([
  ['GET /api/message', { name: 'view-message', handler: viewMessage }],
  ['POST /api/send', { name: 'send-message', handler: sendMessage }],
  ['POST /api/fail', { name: 'fail-message', handler: failMessage }],
]);
const send = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
});
const message = createServer((request, response) => {
  response.setHeader('x-received-traceparent', request.headers.traceparent ?? '');
  send(response, request.url === '/fail' ? 503 : 200, { message: request.url === '/fail' ? 'Message service unavailable' : 'MSG-1' });
});
const externalPort = await listen(message, Number(process.env.EXTERNAL_PORT ?? 4191));
async function callMessage(capture, symbol, method, path) {
  return capture.fetch(`http://127.0.0.1:${externalPort}${path}`, {
    method, symbol, destination: 'message service', signal: AbortSignal.timeout(5000) });
}
async function viewMessage(capture) {
  await capture.handler({ method: 'GET', path: '/api/message', symbol: 'viewMessage', file: 'server.mjs' });
  return callMessage(capture, 'viewMessage', 'GET', '/message');
}
async function sendMessage(capture) {
  await capture.handler({ method: 'POST', path: '/api/send', symbol: 'sendMessage', file: 'server.mjs' });
  return callMessage(capture, 'sendMessage', 'POST', '/send');
}
async function failMessage(capture) {
  await capture.handler({ method: 'POST', path: '/api/fail', symbol: 'failMessage', file: 'server.mjs' });
  return callMessage(capture, 'failMessage', 'POST', '/fail');
}
const app = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(readFileSync(join(root, 'index.html'))); return;
    }
    if (request.method === 'POST' && request.url === '/action-start') {
      let content = ''; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) { send(response, 400, { error: 'Body too large' }); return; } content += chunk; }
      const body = JSON.parse(content);
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string'
        || !/^[A-Za-z0-9_-]{8,80}$/.test(body.id) || ![...routes.values()].some((route) => route.name === body.name)
        || (body.clientTime != null && (typeof body.clientTime !== 'string' || body.clientTime.length > 64 || Number.isNaN(Date.parse(body.clientTime))))) {
        send(response, 400, { error: 'Invalid action' }); return;
      }
      if (captures.has(body.id)) { send(response, 409, { error: 'Action already started' }); return; }
      const capture = await client.start({ id: body.id, name: body.name, clientTime: body.clientTime ?? null });
      captures.set(body.id, { capture, used: false });
      if (captures.size > 100) captures.delete(captures.keys().next().value);
      send(response, 201, { id: capture.id, viewerUrl: capture.viewerUrl, complete: capture.complete }); return;
    }
    const route = routes.get(`${request.method} ${request.url}`);
    const entry = captures.get(request.headers['x-flowatlas-action-id']);
    if (!route) { send(response, 404, { error: 'Not found' }); return; }
    if (!entry || entry.capture.name !== route.name) { send(response, 400, { error: 'Start the matching action first' }); return; }
    if (entry.used) { send(response, 409, { error: 'Action already used' }); return; }
    entry.used = true;
    const { capture } = entry;
    try {
      const result = await route.handler(capture);
      const body = await result.json();
      await capture.finish(result.ok ? 'success' : 'error');
      response.setHeader('x-flowatlas-telemetry', capture.complete ? 'complete' : 'incomplete');
      send(response, result.status, { ...body, viewerUrl: capture.viewerUrl, complete: capture.complete });
    } catch {
      await capture.finish('error');
      response.setHeader('x-flowatlas-telemetry', capture.complete ? 'complete' : 'incomplete');
      send(response, 502, { error: 'Message request failed', viewerUrl: capture.viewerUrl, complete: capture.complete });
    }
  } catch (error) { send(response, error instanceof SyntaxError ? 400 : 500, { error: 'Request failed' }); }
});
let port;
try { port = await listen(app, Number(process.env.PORT ?? 4190)); }
catch (error) { await new Promise((resolve) => message.close(resolve)); throw error; }
console.log(`Registered app: http://127.0.0.1:${port}; project: ${projectId}; snapshot: ${version.digest}`);
const input = createInterface({ input: process.stdin });
let closing;
const close = () => closing ??= (async () => {
  input.close(); process.stdin.destroy();
  await Promise.all([app, message].map((server) => new Promise((resolve) => server.close(resolve))));
})();
input.on('line', (line) => { if (line.trim() === 'stop') close(); });
process.once('SIGINT', close);
process.once('SIGTERM', close);
