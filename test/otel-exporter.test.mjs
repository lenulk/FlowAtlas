import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { LocalHttpSpanExporter, normalizeSdkHttpSpan } from '../src/otel-exporter.mjs';

function sdkSpan(index = 1) {
  return { kind: 1, spanContext: () => ({ traceId: 'a'.repeat(32), spanId: index.toString(16).padStart(16, '0') }),
    startTime: [1790812800, 0], endTime: [1790812800, 100000000], duration: [0, 100000000], status: { code: 0 },
    name: 'canary-name', events: [{ exception: 'canary-exception' }], resource: { secret: 'canary-resource' },
    attributes: { 'http.request.method': 'GET', 'http.response.status_code': 200, 'url.full': 'http://canary-user:canary-pass@canary-host/?token=canary-query' } };
}
async function serve(t, handle) {
  const server = createServer(handle); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const config = (url, extra = {}) => ({ collectorUrl: url, projectId: 'target', codeDigest: 'b'.repeat(64), sessionToken: randomBytes(32).toString('base64url'), ...extra });

test('SDK metadata normalization strips sensitive fields and ignores non-HTTP spans', () => {
  assert.equal(JSON.stringify(normalizeSdkHttpSpan(sdkSpan())).includes('canary-'), false);
  assert.equal(normalizeSdkHttpSpan({ ...sdkSpan(), kind: 0 }), null);
  assert.equal(normalizeSdkHttpSpan({ ...sdkSpan(), attributes: {} }), null);
  assert.equal(normalizeSdkHttpSpan({ ...sdkSpan(), attributes: { 'http.method': 'canary-method' } }).span.method, 'OTHER');
});

test('bounded exporter promptly acknowledges spans, reports drops and stops with a stalled collector', async (t) => {
  let received = 0; const health = [];
  const url = await serve(t, async (req, _res) => { received++; for await (const _part of req) { /* drain but never reply */ } });
  const exporter = new LocalHttpSpanExporter(config(url, { capacity: 4, timeoutMs: 1000, onDrop: (report) => { health.push(report); throw new Error('diagnostic failure'); } }));
  let acknowledged = false;
  exporter.export(Array.from({ length: 20 }, (_v, index) => sdkSpan(index + 1)), ({ code }) => { assert.equal(code, 0); acknowledged = true; });
  assert.equal(acknowledged, true); assert.ok(exporter.queue.length + exporter.inFlight <= 4); assert.equal(exporter.dropped, 16);
  const started = Date.now(); await exporter.shutdown();
  assert.ok(Date.now() - started < 1500, 'Shutdown must abort delivery within the documented budget');
  assert.equal(exporter.queue.length, 0); assert.equal(exporter.inFlight, 0); assert.equal(exporter.dropped, 20);
  assert.deepEqual(exporter.summary(), { httpSpans: 20, invalidSpans: 0, delivered: 0, dropped: 20, queued: 0, inFlight: 0 });
  assert.equal(received, 1); assert.ok(health.length > 0); assert.equal(JSON.stringify(health).includes('canary-'), false);
});

test('rejected span deliveries are attempted once and never follow a credential redirect', async (t) => {
  let foreignCalls = 0, calls = 0;
  const foreign = await serve(t, (_req, res) => { foreignCalls++; res.end('{}'); });
  const url = await serve(t, (req, res) => { calls++; req.resume(); res.writeHead(302, { location: foreign }); res.end(); });
  const exporter = new LocalHttpSpanExporter(config(url));
  exporter.export([sdkSpan()], () => {}); await exporter.forceFlush();
  assert.equal(calls, 1); assert.equal(foreignCalls, 0); assert.equal(exporter.dropped, 1);
  await exporter.shutdown();
});

test('exporter summary counts acknowledged HTTP spans separately from invalid and ignored spans', async (t) => {
  const received = [];
  const url = await serve(t, async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    received.push(JSON.parse(body)); res.end('{}');
  });
  const exporter = new LocalHttpSpanExporter(config(url));
  exporter.export([sdkSpan(1), sdkSpan(2), { ...sdkSpan(), kind: 0 },
    { ...sdkSpan(), spanContext: () => ({ traceId: 'invalid' }) }], () => {});
  await exporter.shutdown();
  assert.equal(received.flatMap((batch) => batch.spans).length, 2);
  assert.deepEqual(exporter.summary(), { httpSpans: 2, invalidSpans: 1, delivered: 2, dropped: 1, queued: 0, inFlight: 0 });
  assert.equal(Object.isFrozen(exporter.summary()), true);
  assert.equal(JSON.stringify(exporter.summary()).includes('canary-'), false);
  let code; exporter.export([sdkSpan(3)], (result) => { code = result.code; });
  assert.equal(code, 1); assert.equal(exporter.summary().httpSpans, 2);
});
