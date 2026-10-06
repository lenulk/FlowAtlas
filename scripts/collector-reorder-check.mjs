import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { reorderCollectorPair } from './collector-reorder-fixture.mjs';
const traceId = batch => ((batch - 1) * 32 + 1).toString(16).padStart(32, '0');
for (const reverseArrival of [false, true]) {
  test(`owned reorder fixture commits batch32 before31 with ${reverseArrival ? 'reversed' : 'sender'} arrival`, async t => {
    const committed = [];
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body); committed.push(payload.items[0].traceId); res.end('{}');
    });
    const probe = reorderCollectorPair(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    function send(batch) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify({ items: [{ traceId: traceId(batch) }] });
        const req = request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/flowatlas/ingest',
          headers: { 'content-length': Buffer.byteLength(body) } }, res => {
          res.resume(); res.once('end', () => { assert.equal(res.statusCode, 200); resolve(); });
        });
        req.once('error', reject); req.end(body);
      });
    }
    for (let batch = 1; batch <= 30; batch++) await send(batch);
    const first = send(reverseArrival ? 32 : 31);
    // Wait for the first network request, not an arbitrary timing sleep.
    const deadline = Date.now() + 2000;
    while (probe().requests < 31 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(probe().requests, 31);
    await Promise.all([first, send(reverseArrival ? 31 : 32)]); await send(33);
    assert.equal(committed.indexOf(traceId(32)) < committed.indexOf(traceId(31)), true);
    assert.deepEqual(probe(), { requests: 33, releases: 1, aborted: 0, held: false });
  });
}
