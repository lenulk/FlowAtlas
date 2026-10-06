import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createBrowserActions } from '../src/browser-client.mjs';

async function serve(t, handle) {
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

function replyBusiness(req, res, body, requests) {
  requests.push({ id: req.headers['x-flowatlas-action-id'], method: req.method, body, auth: req.headers.authorization });
  res.writeHead(req.url.split('?')[0] === '/slow' ? 503 : 200, { 'x-flowatlas-telemetry': 'complete' });
  res.end(body || 'actual business response');
}

test('concurrent browser scopes keep distinct IDs, bodies and business outcomes', async (t) => {
  const starts = new Map(); const requests = []; const metadata = [];
  const origin = await serve(t, async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    if (req.url === '/action-start') {
      const action = JSON.parse(body); metadata.push(action); starts.set(action.id, action.name);
      if (action.name === 'slow') await new Promise((resolve) => setTimeout(resolve, 30));
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: action.id, complete: true, viewerUrl: `http://127.0.0.1:4173/?actionId=${action.id}` }));
    } else {
      replyBusiness(req, res, body, requests);
    }
  });
  const actions = createBrowserActions({ origin });
  const [slow, fast] = await Promise.all([actions.start('slow'), actions.start('fast')]);
  assert.notEqual(slow.id, fast.id); assert.equal(slow.viewerUrl, null);
  const sourceHeaders = new Headers({ authorization: 'canary-auth', 'x-flowatlas-action-id': 'stale-id' });
  const [a, b] = await Promise.all([
    slow.fetch('/slow?token=canary-query', { method: 'POST', headers: sourceHeaders, body: 'canary-payload' }),
    fast.fetch(new Request(origin + '/fast', { headers: { 'x-owner': 'yes' } })),
  ]);
  assert.equal(a.status, 503); assert.equal(await a.text(), 'canary-payload');
  assert.equal(b.status, 200); assert.equal(await b.text(), 'actual business response');
  assert.equal(slow.complete, true); assert.equal(fast.complete, true);
  assert.ok(slow.viewerUrl.endsWith(slow.id));
  assert.deepEqual(requests.map((item) => starts.get(item.id)).sort(), ['fast', 'slow']);
  assert.equal(requests.find((item) => item.id === slow.id).auth, 'canary-auth');
  assert.equal(sourceHeaders.get('x-flowatlas-action-id'), 'stale-id');
  assert.equal(JSON.stringify(metadata).includes('canary-'), false);
  await assert.rejects(slow.fetch('/again'), /already used/);
});

test('fixture business outcomes stay independent when action-start metadata is unavailable', async (t) => {
  const requests = []; let startCalls = 0;
  const origin = await serve(t, async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    if (req.url === '/action-start') { startCalls++; res.writeHead(503); res.end('metadata unavailable'); }
    else replyBusiness(req, res, body, requests);
  });
  const actions = createBrowserActions({ origin });
  const [slow, fast] = await Promise.all([actions.start('slow'), actions.start('fast')]);
  const [a, b] = await Promise.all([slow.fetch('/slow', { method: 'POST', body: 'business payload' }), fast.fetch('/fast')]);
  assert.equal(a.status, 503); assert.equal(await a.text(), 'business payload');
  assert.equal(b.status, 200); assert.equal(await b.text(), 'actual business response');
  assert.equal(startCalls, 2); assert.equal(requests.length, 2);
  assert.deepEqual(new Set(requests.map(({ id }) => id)), new Set([slow.id, fast.id]));
  for (const scope of [slow, fast]) { assert.equal(scope.complete, false); assert.equal(scope.viewerUrl, null); }
});

test('foreign origins and redirects never receive browser correlation', async (t) => {
  let foreignCalls = 0; let businessCalls = 0;
  const foreign = await serve(t, (_req, res) => { foreignCalls++; res.end('foreign'); });
  const origin = await serve(t, async (req, res) => {
    if (req.url === '/action-start') {
      let body = ''; for await (const part of req) body += part;
      res.end(JSON.stringify({ ...JSON.parse(body), complete: true, viewerUrl: foreign + '/?actionId=wrong&token=canary' }));
    } else { businessCalls++; res.writeHead(302, { location: foreign }); res.end(); }
  });
  const client = createBrowserActions({ origin }); const scope = await client.start('redirect');
  await assert.rejects(scope.fetch(foreign), /app origin/);
  assert.equal(businessCalls, 0); assert.equal(foreignCalls, 0);
  await assert.rejects(scope.fetch('/redirect', { redirect: 'follow' }), TypeError);
  assert.equal(businessCalls, 1); assert.equal(foreignCalls, 0); assert.equal(scope.complete, false);
});

test('controlled metadata failures including no dispatch never retry real business requests', async (t) => {
  let serverStartCalls = 0; let businessCalls = 0;
  const attempts = new Map();
  const origin = await serve(t, async (req, res) => {
    if (req.url.startsWith('/start')) {
      serverStartCalls++; req.resume(); res.writeHead(500); res.end();
    } else { businessCalls++; res.writeHead(409, { 'x-flowatlas-telemetry': 'complete' }); res.end('business rejected once'); }
  });
  // Model metadata faults deterministically. The original 50ms test incorrectly
  // required every attempt to arrive at the server even when abort ran first.
  // Business requests still use the actual HTTP server and the original fetch.
  const realFetch = globalThis.fetch;
  const paths = ['/start-rejected', '/start-json', '/start-oversized', '/start-timeout', '/start-no-dispatch'];
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!paths.includes(url.pathname)) return realFetch(input, options);
    attempts.set(url.pathname, (attempts.get(url.pathname) ?? 0) + 1);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    if (url.pathname === '/start-no-dispatch') return Promise.reject(new TypeError('Controlled failure before dispatch'));
    if (url.pathname === '/start-timeout') return new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Controlled metadata abort', 'AbortError'));
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
    });
    return Promise.resolve(new Response(url.pathname === '/start-oversized' ? 'x'.repeat(20000) : 'not-json-canary',
      { status: url.pathname === '/start-rejected' ? 503 : 200 }));
  });
  for (const path of paths) {
    const scope = await createBrowserActions({ origin, startUrl: path, timeoutMs: 50 }).start('view');
    const result = await scope.fetch('/business');
    assert.equal(result.status, 409); assert.equal(await result.text(), 'business rejected once');
    assert.equal(scope.state, 'incomplete'); assert.equal(scope.viewerUrl, null);
  }
  assert.deepEqual([...attempts], paths.map(path => [path, 1]));
  assert.equal(serverStartCalls, 0, 'Controlled metadata faults never need a network dispatch');
  assert.equal(businessCalls, 5);
});

test('browser config, action and request boundaries fail before dispatch', async (t) => {
  let calls = 0; const origin = await serve(t, (_req, res) => { calls++; res.end('{}'); });
  for (const options of [{ origin: origin + '/path' }, { origin: 'file:///' }, { origin, startUrl: '//example.com/start' },
    { origin, startUrl: '/start?token=x' }, { origin, timeoutMs: 0 }, { origin, timeoutMs: 5001 }]) {
    assert.throws(() => createBrowserActions(options));
  }
  const client = createBrowserActions({ origin });
  await assert.rejects(client.start(true)); await assert.rejects(client.start(' '.repeat(2))); assert.equal(calls, 0);
  const scope = await client.start('valid'); assert.equal(calls, 1);
  await assert.rejects(scope.fetch('/business', { mode: 'no-cors' }));
  await assert.rejects(scope.fetch(origin.replace('http://', 'http://user:password@') + '/business'));
  scope.close(); await assert.rejects(scope.fetch('/business'), /closed/); assert.equal(calls, 1);
});
