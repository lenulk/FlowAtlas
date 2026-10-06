// QA preload for an owned reference process only; production does not import it.
import { LocalHttpSpanExporter } from '../src/otel-exporter.mjs';
let instance, peakBuffered = 0, peakInFlight = 0, peakRequests = 0;
const observe = exporter => {
  instance = exporter;
  peakBuffered = Math.max(peakBuffered, exporter.queue.length + exporter.inFlight);
  peakInFlight = Math.max(peakInFlight, exporter.inFlight);
  peakRequests = Math.max(peakRequests, exporter.active.size);
};
for (const method of ['export', 'pump']) {
  const original = LocalHttpSpanExporter.prototype[method];
  LocalHttpSpanExporter.prototype[method] = function (...args) {
    observe(this); const result = original.apply(this, args); observe(this); return result;
  };
}
const emit = () => {
  if (!instance || !process.connected) return;
  const value = { ...instance.summary(), peakBuffered, peakInFlight,
    peakRequests: Math.max(peakRequests, instance.transportHealth().peakRequests),
    maxRssBytes: process.resourceUsage().maxRSS * 1024 };
  process.send({ qaSustainedExporter: value }, () => {});
};
const timer = setInterval(emit, 1000); timer.unref();
process.on('message', message => { if (message === 'qa:probe') emit(); });
