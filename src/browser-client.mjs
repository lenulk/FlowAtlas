// Opt-in browser action scope. No global fetch patch, cookies or persistent state.
function localUrl(input, origin) {
  const url = new URL(input instanceof Request ? input.url : input, origin);
  if (url.origin !== origin || url.username || url.password || url.hash) {
    throw new TypeError('FlowAtlas action requests must use the app origin without URL credentials or fragments');
  }
  return url;
}

async function boundedJson(response) {
  if (!response.body) throw new Error('Missing action response');
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16384) throw new Error('Action response exceeds limit');
      chunks.push(part.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const value = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(value));
}

function viewerLink(value, id) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.hash
      || url.searchParams.get('actionId') !== id || [...url.searchParams].length !== 1) return null;
    return url.href;
  } catch { return null; }
}

export function createBrowserActions({ origin = globalThis.location?.origin, startUrl = '/action-start', timeoutMs = 1000 } = {}) {
  const app = new URL(origin);
  if (!['http:', 'https:'].includes(app.protocol) || app.href !== app.origin + '/'
    || (globalThis.location && globalThis.location.origin !== app.origin)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
    throw new TypeError('Invalid browser action configuration');
  }
  const base = app.origin;
  const endpoint = localUrl(startUrl, base);
  if (endpoint.search) throw new TypeError('Action start endpoint must not contain query parameters');
  return Object.freeze({ async start(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new TypeError('Invalid action name');
    const id = globalThis.crypto.randomUUID();
    let acknowledged = false; let link = null; let state = 'ready'; let used = false; let closed = false;
    // A failed metadata request must not prevent the caller from attempting its business request.
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name, clientTime: new Date().toISOString() }),
        signal: AbortSignal.timeout(timeoutMs), credentials: 'same-origin', redirect: 'error' });
      if (response.ok) {
        const body = await boundedJson(response);
        acknowledged = body?.id === id && (body.complete === true || body.telemetry?.complete === true);
        if (acknowledged) link = viewerLink(body.viewerUrl, id);
      } else await response.body?.cancel();
    } catch { /* Capture unavailable; do not retry or expose response bodies/errors. */ }
    return Object.freeze({ id, name,
      get state() { return state; },
      get complete() { return state === 'complete'; },
      get viewerUrl() { return state === 'complete' ? link : null; },
      close() { closed = true; },
      async fetch(input, options = {}) {
        if (closed || used) throw new Error('Action scope is closed or already used');
        const url = localUrl(input, base);
        const request = new Request(input instanceof Request ? input : url, options);
        if (request.mode === 'no-cors') throw new TypeError('Action requests require a readable same-origin response');
        const headers = new Headers(request.headers); headers.set('x-flowatlas-action-id', id);
        used = true; state = 'running';
        try {
          // Following a redirect could forward the custom correlation header to another origin.
          const response = await fetch(new Request(request, { headers, redirect: 'error' }));
          state = acknowledged && response.headers.get('x-flowatlas-telemetry') === 'complete' ? 'complete' : 'incomplete';
          return response; // Caller owns the business body; never read, clone, log or retry it.
        } catch (error) { state = 'incomplete'; throw error; }
      },
    });
  } });
}
