// Owned QA server only. Select synthetic sender batches by their known first
// trace ID, never network arrival ordinal. Read/replay the exact bounded body
// on the original request so headers, socket and production parser stay intact.
export function reorderCollectorPair(server) {
  const handlers = server.listeners('request');
  if (handlers.length !== 1) throw new Error('unexpected_qa_request_handlers');
  const original = handlers[0]; let requests = 0, held = null, releases = 0, aborted = 0, triggerFinished = false;
  const marker = batch => ((batch - 1) * 32 + 1).toString(16).padStart(32, '0');
  const release = () => {
    if (!held || !triggerFinished) return;
    const pending = held; held = null; releases++; original.call(server, pending.req, pending.res);
  };
  server.off('request', original);
  server.on('request', async (req, res) => {
    if (req.method === 'POST' && req.url === '/flowatlas/ingest') {
      requests++;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw Error('qa_body_bound'); chunks.push(chunk); }
        const body = Buffer.concat(chunks), firstTrace = JSON.parse(body).items?.[0]?.traceId;
        req[Symbol.asyncIterator] = async function* () { yield body; };
        if (firstTrace === marker(31)) {
          if (held || releases) throw Error('qa_duplicate_held_batch');
          held = { req, res }; release(); return;
        }
        if (firstTrace === marker(32)) res.once('finish', () => { triggerFinished = true; release(); });
      } catch {
        aborted++; res.writeHead(400); res.end(); return;
      }
    }
    original.call(server, req, res);
  });
  return () => ({ requests, releases, aborted, held: held !== null });
}
