// QA only: actual SDK and HTTP instrumentation, count-only exporter, no delivery.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor, AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const collector = new URL(process.env.FLOWATLAS_URL);
const loopback = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
let counted = 0, invalid = 0; const traces = new Set();
const exporter = {
  export(spans, callback) {
    for (const span of spans) {
      counted++;
      const identity = span.spanContext();
      const method = span.attributes['http.request.method'] ?? span.attributes['http.method'];
      const status = span.attributes['http.response.status_code'] ?? span.attributes['http.status_code'];
      if (span.kind !== 1 || method !== 'GET' || status !== 200 || !/^[a-f0-9]{32}$/.test(identity.traceId)
        || /^0+$/.test(identity.traceId) || traces.has(identity.traceId)) invalid++;
      traces.add(identity.traceId);
    }
    callback({ code: 0 });
  },
  async shutdown() {}, async forceFlush() {},
};
const sdk = new NodeSDK({ autoDetectResources: false, resourceDetectors: [],
  resource: resourceFromAttributes({ 'service.name': process.env.FLOWATLAS_PROJECT_ID }),
  logRecordProcessors: [], metricReaders: [], sampler: new AlwaysOnSampler(), textMapPropagator: new W3CTraceContextPropagator(),
  spanProcessors: [new SimpleSpanProcessor(exporter)],
  instrumentations: [new HttpInstrumentation({
    ignoreOutgoingRequestHook: (options) => !loopback(options.hostname ?? options.host?.split(':')[0])
      || (String(options.port ?? '80') === (collector.port || '80') && (options.hostname ?? options.host) === collector.hostname),
    headersToSpanAttributes: {},
  }), new UndiciInstrumentation({ ignoreRequestHook: (request) => {
    try { const url = new URL(request.origin); return !loopback(url.hostname) || url.origin === collector.origin; } catch { return true; }
  }, headersToSpanAttributes: {} })],
});
sdk.start();
process.on('message', (message) => {
  if (message === 'flowatlas:shutdown') sdk.shutdown().then(() =>
    process.send({ qaSdkCounts: { counted, invalid, uniqueTraces: traces.size } }));
});
process.channel?.unref();
