// Activated only by inspect --trace http, before the target's imports.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor, AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { LocalHttpSpanExporter } from './otel-exporter.mjs';

const collector = new URL(process.env.FLOWATLAS_URL);
let warned = false;
const exporter = new LocalHttpSpanExporter({ collectorUrl: collector.origin, projectId: process.env.FLOWATLAS_PROJECT_ID,
  codeDigest: process.env.FLOWATLAS_TRACE_DIGEST, sessionToken: process.env.FLOWATLAS_SESSION_TOKEN,
  onDrop: (health) => { if (!warned) { warned = true; console.error(`FlowAtlas trace capture incomplete: ${JSON.stringify(health)}`); } } });
const loopback = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
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
let shutdown;
const close = () => shutdown ??= sdk.shutdown().finally(async () => {
  if (exporter.dropped) console.error(`FlowAtlas trace dropped spans: ${exporter.dropped}`);
  await new Promise((resolve, reject) => process.stderr.write(`FlowAtlas trace summary: ${JSON.stringify(exporter.summary())}\n`,
    (error) => error ? reject(error) : resolve()));
});
process.once('beforeExit', close);
if (process.send) {
  process.on('message', (message) => {
    if (message === 'flowatlas:shutdown') close().then(() => process.send?.('flowatlas:flushed'),
      () => process.send?.('flowatlas:flush-failed'));
  });
  // IPC must not keep an otherwise finished application alive.
  process.channel?.unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  // Inspector also has a 5s kill deadline; this bounds preload cleanup independently.
  const deadline = setTimeout(() => process.exit(1), 1500);
  close().then(() => { clearTimeout(deadline); process.exit(0); }, () => { clearTimeout(deadline); process.exit(1); });
});
