import { randomUUID, randomBytes } from 'node:crypto';
export { captureProjectVersion } from './project-sources.mjs';

// Explicit instrumentation for Node apps. Does not patch global fetch or capture bodies.
export function createFlowAtlasClient({ collectorUrl = 'http://127.0.0.1:4173', projectId, codeDigest,
  service = projectId, timeoutMs = 500, sessionToken = process.env.FLOWATLAS_SESSION_TOKEN ?? null } = {}) {
  const collector = new URL(collectorUrl);
  if (collector.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(collector.hostname)
    || collector.username || collector.password || collector.pathname !== '/' || collector.search || collector.hash) {
    throw new Error('Collector must be a local HTTP origin');
  }
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(projectId)
    || typeof codeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(codeDigest)
    || typeof service !== 'string' || !service.trim() || service.length > 200
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000
    || (sessionToken !== null && (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)))) throw new Error('Invalid FlowAtlas adapter config');
  const base = collector.origin;

  return { async start({ id = randomUUID(), name, clientTime = null } = {}) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(id)
      || typeof name !== 'string' || !name.trim() || name.length > 200
      || (clientTime !== null && (typeof clientTime !== 'string' || clientTime.length > 64 || Number.isNaN(Date.parse(clientTime))))) {
      throw new Error('Invalid FlowAtlas action');
    }
    const context = `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
    let complete = true;
    let finished = false;
    let queue = Promise.resolve();
    const report = (event) => {
      queue = queue.then(async () => {
        if (!complete) return;
        try {
          const response = await fetch(`${base}/flowatlas/ingest`, { method: 'POST',
            headers: { 'content-type': 'application/json', ...(sessionToken === null ? {} : { authorization: `Bearer ${sessionToken}` }) },
            body: JSON.stringify({ ...event, projectId, actionId: id }),
            signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
          await response.arrayBuffer();
          if (!response.ok) complete = false;
        } catch { complete = false; }
      });
      return queue;
    };
    await report({ kind: 'action-start', name, clientTime, codeDigest });

    return {
      id, name, traceparent: context,
      get complete() { return complete; },
      get viewerUrl() { return complete ? `${base}/?actionId=${encodeURIComponent(id)}` : null; },
      async handler({ method, path, symbol, file }) {
        if (finished) throw new Error('Action is already finished');
        await report({ kind: 'handler-entry', name, service, method, path, symbol, file, traceparent: context });
      },
      async fetch(input, { symbol, destination, ...options } = {}) {
        if (finished) throw new Error('Action is already finished');
        const url = new URL(input);
        const headers = new Headers(options.headers);
        headers.set('x-flowatlas-action-id', id);
        headers.set('traceparent', context);
        const method = (options.method ?? 'GET').toUpperCase();
        const started = performance.now();
        let response;
        try { response = await fetch(url, { ...options, method, headers, redirect: 'error' }); }
        catch (error) {
          await report({ kind: 'outbound-result', service, symbol, method, path: url.pathname, destination,
            outcome: 'failed', error: error.name === 'TimeoutError' ? 'Request timed out' : 'Request transport failed',
            durationMs: Math.round(performance.now() - started), traceparent: context });
          throw error;
        }
        await report({ kind: 'outbound-result', service, symbol, method, path: url.pathname, destination,
          outcome: 'completed', status: response.status, durationMs: Math.round(performance.now() - started),
          traceparent: context, receivedTraceparent: response.headers.get('x-received-traceparent') });
        return response;
      },
      async finish(outcome) {
        if (finished) throw new Error('Action is already finished');
        if (!['success', 'error'].includes(outcome)) throw new Error('Invalid action outcome');
        finished = true;
        await report({ kind: 'finish', outcome });
      },
    };
  } };
}
