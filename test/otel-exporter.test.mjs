import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { LocalHttpSpanExporter, normalizeSdkHttpSpan } from '../src/otel-exporter.mjs';
import { cleanHttpSpan, validSpanId } from '../src/http-span-contract.mjs';

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

test('opt-in timing distinguishes stalled shutdown from successful acknowledgement without sensitive data', async (t) => {
  const url = await serve(t, (req, _res) => req.resume());
  const exporter = new LocalHttpSpanExporter(config(url, { timing: true }));
  exporter.export(Array.from({ length: 96 }, (_v, index) => sdkSpan(index + 1)), () => {});
  await exporter.shutdown();
  const timing = exporter.timingHealth();
  assert.equal(timing.shutdownQueued, 32); assert.equal(timing.shutdownInFlight, 64);
  assert.equal(timing.shutdownDelivered, 0); assert.equal(timing.deadlineFired, 1);
  assert.ok(timing.shutdownMs >= 800 && timing.shutdownMs < 1500);
  assert.equal(timing.batches, 2); assert.equal(timing.acknowledgedBatches, 0);
  assert.ok(timing.batchMaxMs > 0); assert.ok(timing.deadlineLateMs >= 0);
  assert.equal(Object.isFrozen(timing), true);
  assert.ok(Object.values(timing).every(value => Number.isFinite(value) && value >= 0));
  assert.equal(JSON.stringify(timing).includes('canary'), false);
  assert.equal(new LocalHttpSpanExporter(config(url)).timingHealth(), null);
});

test('successful timing counts uploads and shutdown progress without changing delivery', async (t) => {
  const url = await serve(t, (req, res) => { req.resume(); res.end('{}'); });
  const exporter = new LocalHttpSpanExporter(config(url, { timing: true }));
  exporter.export(Array.from({ length: 96 }, (_v, index) => sdkSpan(index + 1)), () => {});
  await exporter.shutdown();
  const timing = exporter.timingHealth();
  assert.equal(exporter.summary().delivered, 96); assert.equal(timing.shutdownDelivered, 96);
  assert.equal(timing.batches, 3); assert.equal(timing.acknowledgedBatches, 3);
  assert.equal(timing.deadlineFired, 0); assert.ok(timing.batchTotalMs >= timing.batchMaxMs);
});

test('SDK metadata normalization strips sensitive fields and ignores non-HTTP spans', () => {
  assert.equal(JSON.stringify(normalizeSdkHttpSpan(sdkSpan())).includes('canary-'), false);
  assert.equal(normalizeSdkHttpSpan({ ...sdkSpan(), kind: 0 }), null);
  assert.equal(normalizeSdkHttpSpan({ ...sdkSpan(), attributes: {} }), null);
  assert.equal(normalizeSdkHttpSpan({ ...sdkSpan(), attributes: { 'http.method': 'canary-method' } }).span.method, 'OTHER');
});

test('normalized HTTP contract preserves identity time status and duration boundaries', () => {
  const valid = normalizeSdkHttpSpan(sdkSpan()).span;
  for (const size of [16, 32]) {
    assert.equal(validSpanId('f'.repeat(size), size), true);
    for (const id of ['0'.repeat(size), 'F'.repeat(size), 'f'.repeat(size - 1), 'f'.repeat(size + 1), null]) {
      assert.equal(validSpanId(id, size), false);
    }
  }
  for (const patch of [{ spanId: '0'.repeat(16) }, { parentSpanId: '0'.repeat(16) },
    { startedAt: '2026-10-01T00:00:00Z' }, { endedAt: 'not-a-time' },
    { endedAt: '2026-09-30T00:00:00.000Z' }, { durationMs: NaN }, { durationMs: Infinity },
    { durationMs: -1 }, { durationMs: 86400001 }, { httpStatus: 99 }, { httpStatus: 600 }, { httpStatus: NaN }]) {
    assert.throws(() => cleanHttpSpan({ ...valid, ...patch }), /Invalid normalized HTTP span/);
  }
  for (const durationMs of [0, 86400000]) for (const httpStatus of [null, 100, 599]) {
    assert.equal(cleanHttpSpan({ ...valid, durationMs, httpStatus, secret: 'canary' }).durationMs, durationMs);
  }
  assert.deepEqual(cleanHttpSpan(valid), valid);
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
  assert.deepEqual(exporter.deliveryHealth(), { overflow: 16, invalid: 0, rejected: 0, timeout: 0, transport: 0, shutdown: 4 });
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
  assert.equal(received.flatMap((batch) => batch.items).length, 2);
  assert.deepEqual(exporter.summary(), { httpSpans: 2, invalidSpans: 1, delivered: 2, dropped: 1, queued: 0, inFlight: 0 });
  assert.equal(Object.isFrozen(exporter.summary()), true);
  assert.equal(JSON.stringify(exporter.summary()).includes('canary-'), false);
  let code; exporter.export([sdkSpan(3)], (result) => { code = result.code; });
  assert.equal(code, 1); assert.equal(exporter.summary().httpSpans, 2);
});

test('delivery health distinguishes a rejected batch from a timed out collector', async (t) => {
  const rejectedUrl = await serve(t, (req, res) => { req.resume(); res.writeHead(503); res.end(); });
  const rejected = new LocalHttpSpanExporter(config(rejectedUrl));
  rejected.export([sdkSpan()], () => {}); await rejected.shutdown();
  assert.equal(rejected.deliveryHealth().rejected, 1); assert.equal(rejected.deliveryHealth().timeout, 0);
  assert.equal(rejected.rejectionHealth()['503'], 1); assert.equal(rejected.rejectionHealth()['400'], 0);
  const stalledUrl = await serve(t, (req, _res) => req.resume());
  const stalled = new LocalHttpSpanExporter(config(stalledUrl, { timeoutMs: 30 }));
  stalled.export([sdkSpan()], () => {}); await stalled.shutdown();
  assert.equal(stalled.deliveryHealth().timeout, 1); assert.equal(stalled.deliveryHealth().shutdown, 0);
  assert.equal(Object.values(stalled.rejectionHealth()).reduce((sum, count) => sum + count, 0), 0);
  assert.equal(Object.values(stalled.deliveryHealth()).reduce((sum, count) => sum + count, 0), stalled.dropped);
});

test('collector uploads use at most two slots and preserve cross-trace batch accounting', async (t) => {
  let active = 0, peak = 0; const received = [];
  const url = await serve(t, async (req, res) => {
    active++; peak = Math.max(peak, active);
    let body = ''; for await (const part of req) body += part;
    received.push(JSON.parse(body));
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--; res.end('{}');
  });
  const exporter = new LocalHttpSpanExporter(config(url));
  exporter.export(Array.from({ length: 128 }, (_v, index) => ({ ...sdkSpan(index + 1),
    spanContext: () => ({ traceId: (index + 1).toString(16).padStart(32, '0'),
      spanId: (index + 1).toString(16).padStart(16, '0') }) })), () => {});
  assert.ok(exporter.queue.length + exporter.inFlight <= 256);
  await exporter.forceFlush();
  assert.equal(peak, 2); assert.equal(active, 0);
  assert.equal(received.length, 4); assert.ok(received.every((batch) => batch.items.length === 32));
  assert.equal(new Set(received.flatMap((batch) => batch.items.map((item) => item.traceId))).size, 128);
  assert.deepEqual(exporter.transportHealth(), { batches: 4, submittedSpans: 128, smallBatches: 0, peakRequests: 2 });
  assert.equal(Object.isFrozen(exporter.transportHealth()), true);
  assert.deepEqual(exporter.summary(), { httpSpans: 128, invalidSpans: 0, delivered: 128,
    dropped: 0, queued: 0, inFlight: 0 });
  await exporter.shutdown();
});

test('shutdown aborts both active upload slots and accounts for queued spans once', async (t) => {
  let received = 0;
  const url = await serve(t, (req, _res) => { received++; req.resume(); });
  const exporter = new LocalHttpSpanExporter(config(url, { timeoutMs: 1000 }));
  exporter.export(Array.from({ length: 96 }, (_v, index) => sdkSpan(index + 1)), () => {});
  const started = Date.now(); await exporter.shutdown();
  assert.ok(Date.now() - started < 1500);
  assert.equal(received, 2);
  assert.deepEqual(exporter.summary(), { httpSpans: 96, invalidSpans: 0, delivered: 0,
    dropped: 96, queued: 0, inFlight: 0 });
  assert.equal(exporter.deliveryHealth().shutdown, 96);
});

test('small exports coalesce without holding callbacks and sparse traffic drains on its own', async (t) => {
  const received = []; let firstReceived;
  const arrived = new Promise((resolve) => { firstReceived = resolve; });
  const url = await serve(t, async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    received.push(JSON.parse(body)); res.end('{}'); firstReceived();
  });
  const exporter = new LocalHttpSpanExporter(config(url));
  let callbacks = 0;
  for (let index = 1; index <= 24; index++) exporter.export([sdkSpan(index)], () => { callbacks++; });
  assert.equal(callbacks, 24);
  assert.equal(exporter.transportHealth().batches, 0, 'Partial batch waits independently of SDK callbacks');
  let deadline;
  try { await Promise.race([arrived, new Promise((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error('Sparse batch did not drain')), 2000);
  })]); } finally { clearTimeout(deadline); }
  await exporter.forceFlush();
  assert.equal(received.length, 1); assert.equal(received[0].items.length, 24);
  assert.equal(exporter.summary().delivered, 24); await exporter.shutdown();
});

test('full batches dispatch immediately and forceFlush bypasses the partial-batch wait', async (t) => {
  const url = await serve(t, (req, res) => { req.resume(); res.end('{}'); });
  const exporter = new LocalHttpSpanExporter(config(url));
  exporter.export(Array.from({ length: 32 }, (_v, index) => sdkSpan(index + 1)), () => {});
  assert.equal(exporter.transportHealth().batches, 1);
  await exporter.forceFlush();
  exporter.export([sdkSpan(33)], () => {});
  assert.equal(exporter.transportHealth().batches, 1);
  const flushed = exporter.forceFlush();
  assert.equal(exporter.transportHealth().batches, 2, 'Flush starts the pending batch synchronously');
  await flushed; assert.equal(exporter.summary().delivered, 33); await exporter.shutdown();
});

test('default exporter buffers a measured burst within 2048 spans and still stops a stalled collector', async (t) => {
  let received = 0;
  const url = await serve(t, (req, _res) => { received++; req.resume(); });
  const exporter = new LocalHttpSpanExporter(config(url));
  let callback = false;
  exporter.export(Array.from({ length: 3000 }, (_v, index) => sdkSpan(index + 1)), () => { callback = true; });
  assert.equal(callback, true); assert.equal(exporter.capacity, 2048); assert.equal(exporter.timeoutMs, 1000);
  assert.equal(exporter.queue.length + exporter.inFlight, 2048);
  assert.equal(exporter.deliveryHealth().overflow, 952);
  await exporter.shutdown();
  assert.equal(received, 2);
  assert.deepEqual(exporter.summary(), { httpSpans: 3000, invalidSpans: 0, delivered: 0,
    dropped: 3000, queued: 0, inFlight: 0 });
  assert.equal(exporter.deliveryHealth().shutdown, 2048);
  assert.throws(() => new LocalHttpSpanExporter(config(url, { capacity: 2049 })), /Invalid local trace exporter/);
  assert.throws(() => new LocalHttpSpanExporter(config(url, { timeoutMs: 1001 })), /Invalid local trace exporter/);
});
