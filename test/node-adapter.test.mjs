import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createFlowAtlasClient } from '../src/node-adapter.mjs';

async function serve(t, handle) {
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('adapter propagates context and reports only allowlisted metadata while returning the actual response', async (t) => {
  const events = [];
  const token = randomBytes(32).toString('base64url');
  const collector = await serve(t, async (request, response) => {
    assert.equal(request.headers.authorization === `Bearer ${token}`, true);
    let body = ''; for await (const chunk of request) body += chunk;
    events.push(JSON.parse(body)); response.writeHead(202); response.end('{}');
  });
  const downstream = await serve(t, (request, response) => {
    assert.equal(request.headers.authorization, 'secret-auth');
    response.writeHead(503, { 'x-received-traceparent': request.headers.traceparent });
    response.end('business body');
  });
  const client = createFlowAtlasClient({ collectorUrl: collector.url, projectId: 'target', codeDigest: 'a'.repeat(64), sessionToken: token });
  const capture = await client.start({ name: 'send' });
  await capture.handler({ method: 'POST', path: '/api/send', symbol: 'send', file: 'server.mjs' });
  const response = await capture.fetch(`${downstream.url}/send?token=secret-query`, {
    symbol: 'send', destination: 'message service', method: 'POST',
    headers: { authorization: 'secret-auth', cookie: 'secret-cookie' }, body: 'secret-payload',
  });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'business body');
  await capture.finish('error');
  assert.equal(capture.complete, true);
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((e) => e.kind), ['action-start', 'handler-entry', 'outbound-result', 'finish']);
  assert.equal(events[2].path, '/send');
  assert.equal(events[2].status, 503);
  assert.equal(events[2].receivedTraceparent, capture.traceparent);
  assert.ok(events.every((event) => event.actionId === capture.id && event.projectId === 'target'));
  assert.doesNotMatch(JSON.stringify(events), /secret-|business body/);
  assert.equal(JSON.stringify(events).includes(token), false);
  await assert.rejects(capture.handler({}), /finished/);
  await assert.rejects(capture.finish('success'), /finished/);
});

test('collector outage and timeout mark capture incomplete without blocking business requests', async (t) => {
  const downstream = await serve(t, (_request, response) => response.end('ok'));
  const stopped = await serve(t, (_request, response) => response.end('{}'));
  await new Promise((resolve) => stopped.server.close(resolve));
  const stalled = await serve(t, (_request, _response) => {});
  t.after(() => stalled.server.closeAllConnections());
  for (const collectorUrl of [stopped.url, stalled.url]) {
    const capture = await createFlowAtlasClient({ collectorUrl, projectId: 'target', codeDigest: 'a'.repeat(64), timeoutMs: 50 }).start({ name: 'view' });
    assert.equal(capture.complete, false);
    assert.equal(capture.viewerUrl, null);
    await capture.handler({ method: 'GET', path: '/api', file: 'server.mjs', symbol: 'view' });
    const result = await capture.fetch(downstream.url, { symbol: 'view', destination: 'service' });
    assert.equal(await result.text(), 'ok');
    await capture.finish('success');
  }
});

test('adapter transport failures keep the original error and produce bounded failure metadata', async (t) => {
  const events = [];
  const collector = await serve(t, async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    events.push(JSON.parse(body)); response.writeHead(202); response.end('{}');
  });
  const stopped = await serve(t, (_request, response) => response.end());
  await new Promise((resolve) => stopped.server.close(resolve));
  const capture = await createFlowAtlasClient({ collectorUrl: collector.url, projectId: 'target', codeDigest: 'a'.repeat(64) }).start({ name: 'fail' });
  await capture.handler({ method: 'GET', path: '/api', symbol: 'fail', file: 'server.mjs' });
  await assert.rejects(capture.fetch(stopped.url, { symbol: 'fail', destination: 'service' }), TypeError);
  await capture.finish('error');
  assert.equal(events[2].outcome, 'failed');
  assert.equal(events[2].error, 'Request transport failed');
  assert.equal(capture.complete, true);
});

test('adapter rejects invalid configuration and programmer inputs before sending requests', async () => {
  for (const extra of [{ collectorUrl: 'https://example.com' }, { collectorUrl: 'http://127.0.0.1/private' },
    { projectId: '../bad' }, { projectId: true, service: 'target' }, { codeDigest: ['a'.repeat(64)] }, { codeDigest: 'bad' }, { timeoutMs: 0 },
    { sessionToken: '' }, { sessionToken: 43 }, { sessionToken: 'x'.repeat(44) }]) {
    assert.throws(() => createFlowAtlasClient({ projectId: 'target', codeDigest: 'a'.repeat(64), ...extra }));
  }
  const client = createFlowAtlasClient({ projectId: 'target', codeDigest: 'a'.repeat(64) });
  await assert.rejects(client.start({ name: '' }), /Invalid/);
  await assert.rejects(client.start({ name: 'view', id: 'bad' }), /Invalid/);
});
