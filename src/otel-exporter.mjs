import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
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
  constructor({ collectorUrl, projectId, codeDigest, sessionToken, capacity = 256, timeoutMs = 300, onDrop = () => {} }) {
    const url = new URL(collectorUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.href !== url.origin + '/' || !/^[a-z][a-z0-9_-]{0,63}$/.test(projectId ?? '')
      || !/^[a-f0-9]{64}$/.test(codeDigest ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken ?? '')
      || !Number.isInteger(capacity) || capacity < 1 || capacity > 256
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000) throw new Error('Invalid local trace exporter configuration');
    this.url = url.origin + '/flowatlas/ingest'; this.projectId = projectId; this.codeDigest = codeDigest;
    this.sessionToken = sessionToken; this.capacity = capacity; this.timeoutMs = timeoutMs; this.onDrop = onDrop;
    this.queue = []; this.inFlight = 0; this.dropped = 0; this.closed = false; this.pending = null; this.abort = null;
    this.httpSpans = 0; this.invalidSpans = 0; this.delivered = 0;
    this.dropReasons = { overflow: 0, invalid: 0, rejected: 0, timeout: 0, transport: 0, shutdown: 0 };
    this.rejectedStatuses = { '400': 0, '401': 0, '403': 0, '409': 0, '413': 0, '503': 0, other: 0 };
  }
  summary() {
    return Object.freeze({ httpSpans: this.httpSpans, invalidSpans: this.invalidSpans, delivered: this.delivered,
      dropped: this.dropped, queued: this.queue.length, inFlight: this.inFlight });
  }
  deliveryHealth() { return Object.freeze({ ...this.dropReasons }); }
  rejectionHealth() { return Object.freeze({ ...this.rejectedStatuses }); }
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
    void this.pump(); // SDK/application never awaits collector delivery.
  }
  pump() {
    if (this.pending) return this.pending;
    this.pending = this.drain().finally(() => {
      this.pending = null;
      if (this.queue.length && !this.closed) void this.pump();
    });
    return this.pending;
  }
  async drain() {
    while (this.queue.length) {
      const batch = this.queue.splice(0, 32);
      this.inFlight = batch.length;
      const controller = new AbortController(); this.abort = controller;
      const timer = setTimeout(() => controller.abort('timeout'), this.timeoutMs);
      try {
        const response = await context.with(suppressTracing(context.active()), () => fetch(this.url, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.sessionToken}` },
          body: JSON.stringify({ kind: 'otel-span-batch', projectId: this.projectId, codeDigest: this.codeDigest, items: batch }),
          signal: controller.signal, redirect: 'error' }));
        await response.body?.cancel();
        if (!response.ok) {
          this.rejectedStatuses[Object.hasOwn(this.rejectedStatuses, response.status) ? response.status : 'other'] += batch.length;
          this.drop(batch.length, 'rejected');
        }
        else this.delivered += batch.length;
      } catch { this.drop(batch.length, ['timeout', 'shutdown'].includes(controller.signal.reason) ? controller.signal.reason : 'transport'); }
      finally { clearTimeout(timer); this.inFlight = 0; this.abort = null; }
    }
  }
  async forceFlush() { do { await this.pump(); } while (this.queue.length || this.pending); }
  async shutdown() {
    this.closed = true;
    const timer = setTimeout(() => {
      const queued = this.queue.length; this.queue = []; if (queued) this.drop(queued, 'shutdown');
      this.abort?.abort('shutdown');
    }, 900);
    try { await this.forceFlush(); } finally { clearTimeout(timer); }
  }
}
