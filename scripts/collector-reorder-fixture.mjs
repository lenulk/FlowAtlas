// Owned QA server only. Hold request31 until request32 has finished its commit.
export function reorderCollectorPair(server) {
  const handlers = server.listeners('request');
  if (handlers.length !== 1) throw new Error('unexpected_qa_request_handlers');
  const original = handlers[0]; let requests = 0, held = null, releases = 0, aborted = 0;
  server.off('request', original);
  server.on('request', (req, res) => {
    if (req.method === 'POST' && req.url === '/flowatlas/ingest') {
      requests++;
      if (requests === 31) {
        held = { req, res };
        req.once('error', () => { aborted++; });
        return;
      }
      if (requests === 32) res.once('finish', () => {
        const pending = held; held = null;
        if (pending) { releases++; original.call(server, pending.req, pending.res); }
      });
    }
    original.call(server, req, res);
  });
  return () => ({ requests, releases, aborted, held: held !== null });
}
