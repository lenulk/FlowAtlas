import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { performance } from 'node:perf_hooks';
import { cleanHttpSpan, httpMethods, validSpanId } from './http-span-contract.mjs';

const millis = ([seconds, nanos]) => seconds * 1000 + nanos / 1e6;
export function normalizeSdkHttpSpan(span) {
  if (![1, 2].includes(span.kind)) return null;
  const attributes = span.attributes;
  const method = attributes['http.request.method'] ?? attributes['http.method'];
  if (method === undefined) return null;
  const identity = span.spanContext();
  if (!validSpanId(identity.traceId, 32)) throw new Error('Invalid SDK trace identity');
  const status = attributes['http.response.status_code'] ?? attributes['http.status_code'] ?? null;
  return { traceId: identity.traceId, span: cleanHttpSpan({ spanId: identity.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null, kind: span.kind === 1 ? 'SERVER' : 'CLIENT',
    method: httpMethods.has(method) ? method : 'OTHER', startedAt: new Date(millis(span.startTime)).toISOString(),
    endedAt: new Date(millis(span.endTime)).toISOString(), durationMs: Math.round(millis(span.duration) * 1000) / 1000,
    httpStatus: status, error: span.status.code === 2 }) };
}

export class LocalHttpSpanExporter {
  constructor({ collectorUrl, projectId, codeDigest, sessionToken, capacity = 2048, timeoutMs = 1000, onDrop = () => {}, timing = false }) {
    const url = new URL(collectorUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.href !== url.origin + '/' || !/^[a-z][a-z0-9_-]{0,63}$/.test(projectId ?? '')
      || !/^[a-f0-9]{64}$/.test(codeDigest ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken ?? '')
      || !Number.isInteger(capacity) || capacity < 1 || capacity > 2048
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000) throw new Error('Invalid local trace exporter configuration');
    this.url = url.origin + '/flowatlas/ingest'; this.projectId = projectId; this.codeDigest = codeDigest;
    this.agent = null; this.transport = null;
    this.sessionToken = sessionToken; this.capacity = capacity; this.timeoutMs = timeoutMs; this.onDrop = onDrop;
    this.queue = []; this.inFlight = 0; this.dropped = 0; this.closed = false;
    this.active = new Set(); this.controllers = new Set();
    this.batchTimer = null; this.flushing = 0;
    this.httpSpans = 0; this.invalidSpans = 0; this.delivered = 0;
    this.batches = 0; this.submittedSpans = 0; this.smallBatches = 0; this.peakRequests = 0;
    this.dropReasons = { overflow: 0, invalid: 0, rejected: 0, timeout: 0, transport: 0, shutdown: 0 };
    this.rejectedStatuses = { '400': 0, '401': 0, '403': 0, '409': 0, '413': 0, '503': 0, other: 0 };
    this.timing = timing === true ? { batches: 0, acknowledgedBatches: 0, batchTotalMs: 0, batchMaxMs: 0,
      firstBatchMs: 0, shutdownQueued: 0, shutdownInFlight: 0, shutdownDelivered: 0, shutdownMs: 0,
      deadlineFired: 0, deadlineLateMs: 0 } : null;
  }
  timingHealth() { return this.timing ? Object.freeze({ ...this.timing }) : null; }
  summary() {
    return Object.freeze({ httpSpans: this.httpSpans, invalidSpans: this.invalidSpans, delivered: this.delivered,
      dropped: this.dropped, queued: this.queue.length, inFlight: this.inFlight });
  }
  deliveryHealth() { return Object.freeze({ ...this.dropReasons }); }
  rejectionHealth() { return Object.freeze({ ...this.rejectedStatuses }); }
  transportHealth() {
    return Object.freeze({ batches: this.batches, submittedSpans: this.submittedSpans,
      smallBatches: this.smallBatches, peakRequests: this.peakRequests });
  }
  drop(count, reason = 'transport') {
    this.dropped += count;
    this.dropReasons[Object.hasOwn(this.dropReasons, reason) ? reason : 'transport'] += count;
    try { this.onDrop(Object.freeze({ dropped: this.dropped, queued: this.queue.length, inFlight: this.inFlight })); } catch { /* Diagnostic cannot affect business code. */ }
  }
  export(spans, callback) {
    if (this.closed) { callback({ code: 1 }); return; }
    for (const span of spans) {
      try {
        const item = normalizeSdkHttpSpan(span);
        if (!item) continue;
        this.httpSpans++;
        if (this.queue.length + this.inFlight >= this.capacity) this.drop(1, 'overflow'); else this.queue.push(item);
      } catch { this.invalidSpans++; this.drop(1, 'invalid'); }
    }
    callback({ code: 0 });
    this.schedule(); // SDK/application never awaits collector delivery.
  }
  schedule() {
    if (!this.queue.length || this.closed || this.flushing) return;
    if (this.queue.length >= 32) {
      clearTimeout(this.batchTimer); this.batchTimer = null;
      void this.pump(false);
    }
    if (this.queue.length && this.queue.length < 32 && this.active.size < 2 && !this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        void this.pump(true);
      }, 20);
    }
  }
  pump(includePartial = true) {
    while (this.queue.length && this.active.size < 2 && (includePartial || this.queue.length >= 32)) {
      const work = this.sendBatch().finally(() => {
        this.active.delete(work);
        this.schedule();
      });
      this.active.add(work);
    }
    return Promise.all([...this.active]);
  }
  async sendBatch() {
    const started = this.timing ? performance.now() : null;
    const first = this.batches === 0;
    const batch = this.queue.splice(0, 32);
    this.inFlight += batch.length;
    const controller = new AbortController(); this.controllers.add(controller);
    this.batches++; this.submittedSpans += batch.length; if (batch.length < 32) this.smallBatches++;
    this.peakRequests = Math.max(this.peakRequests, this.controllers.size);
    const timer = setTimeout(() => controller.abort('timeout'), this.timeoutMs);
    try {
      // Loading HTTP before SDK startup interferes with its CJS/ESM hooks.
      // Delay the built-in import until the target has already created a span.
      this.transport ??= import('node:http').then(({ Agent, request }) => {
        this.agent = new Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2 });
        return request;
      });
      const request = await this.transport;
      const body = JSON.stringify({ kind: 'otel-span-batch', projectId: this.projectId, codeDigest: this.codeDigest, items: batch });
      const status = await context.with(suppressTracing(context.active()), () => new Promise((resolve, reject) => {
        const req = request(this.url, { method: 'POST', agent: this.agent, signal: controller.signal,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
            authorization: `Bearer ${this.sessionToken}` } }, (res) => {
          const status = res.statusCode ?? 0;
          res.once('error', reject);
          // Native HTTP never follows redirects. Refusals need no response body.
          if (status < 200 || status >= 300) { res.destroy(); resolve(status); return; }
          // Do not acknowledge a truncated or stalled successful response.
          res.once('aborted', () => reject(new Error('Incomplete collector response')));
          res.once('end', () => resolve(status));
          res.resume(); // Drain without retaining or interpreting collector response data.
        });
        req.once('error', reject); req.end(body);
      }));
      if (status < 200 || status >= 300) {
        this.rejectedStatuses[Object.hasOwn(this.rejectedStatuses, status) ? status : 'other'] += batch.length;
        this.drop(batch.length, 'rejected');
      }
      else { this.delivered += batch.length; if (this.timing) this.timing.acknowledgedBatches++; }
    } catch { this.drop(batch.length, ['timeout', 'shutdown'].includes(controller.signal.reason) ? controller.signal.reason : 'transport'); }
    finally {
      clearTimeout(timer); this.inFlight -= batch.length; this.controllers.delete(controller);
      if (this.timing) {
        const elapsed = performance.now() - started;
        this.timing.batches++; this.timing.batchTotalMs += elapsed;
        this.timing.batchMaxMs = Math.max(this.timing.batchMaxMs, elapsed);
        if (first) this.timing.firstBatchMs = elapsed;
      }
    }
  }
  async forceFlush() {
    this.flushing++;
    clearTimeout(this.batchTimer); this.batchTimer = null;
    try { do { await this.pump(); } while (this.queue.length || this.active.size); }
    finally { this.flushing--; this.schedule(); }
  }
  async shutdown() {
    const started = this.timing ? performance.now() : null, delivered = this.delivered;
    if (this.timing) { this.timing.shutdownQueued = this.queue.length; this.timing.shutdownInFlight = this.inFlight; }
    this.closed = true;
    const timer = setTimeout(() => {
      if (this.timing) { this.timing.deadlineFired++; this.timing.deadlineLateMs = Math.max(0, performance.now() - started - 900); }
      const queued = this.queue.length; this.queue = []; if (queued) this.drop(queued, 'shutdown');
      for (const controller of this.controllers) controller.abort('shutdown');
    }, 900);
    try { await this.forceFlush(); } finally {
      clearTimeout(timer);
      this.agent?.destroy();
      if (this.timing) { this.timing.shutdownMs = performance.now() - started; this.timing.shutdownDelivered = this.delivered - delivered; }
    }
  }
}
