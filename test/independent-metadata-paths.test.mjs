import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { startServers } from '../src/server.mjs';
import { startIndependentApp } from '../examples/independent-app/server.mjs';

const phases = ['action-start', 'handler-entry', 'outbound-result', 'finish'];
async function exercise(collectorUrl, onMetadataDiagnostic, timeoutMs = 500) {
  const app = await startIndependentApp({ port: 0, externalPort: 0, collectorUrl,
    telemetryTimeoutMs: timeoutMs, onMetadataDiagnostic });
  const base = `http://127.0.0.1:${app.port}`, id = randomUUID();
  try {
    const started = await fetch(`${base}/action-start`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'send-message' }) });
    assert.equal(started.status, 201);
    const start = await started.json();
    const response = await fetch(`${base}/api/send`, { method: 'POST', headers: { 'x-flowatlas-action-id': id } });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { messageId: 'MSG-1' });
    return { startComplete: start.telemetry.complete, header: response.headers.get('x-flowatlas-telemetry') };
  } finally { await app.close(); }
}
for (const failingPhase of ['action-start', 'outbound-result']) {
  for (const fault of ['http-status', 'body', 'timeout']) {
    test(`metadata ${failingPhase} ${fault} identifies first loss without changing business response`, async t => {
      const attempted = [], rows = [];
      const collector = createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        const event = JSON.parse(body); attempted.push(event.kind);
        if (event.kind === failingPhase) {
          if (fault === 'timeout') return;
          if (fault === 'http-status') { res.writeHead(503); res.end('{"error":"canary-private-message"}'); return; }
          res.writeHead(202); res.end('invalid canary-private-body'); return;
        }
        res.writeHead(202); res.end('{}');
      });
      await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
      t.after(() => { collector.closeAllConnections(); return new Promise(resolve => collector.close(resolve)); });
      const result = await exercise(`http://127.0.0.1:${collector.address().port}`, row => rows.push(row), fault === 'timeout' ? 50 : 500);
      assert.equal(result.startComplete, failingPhase !== 'action-start'); assert.equal(result.header, 'incomplete');
      const expectedAttempts = phases.slice(0, phases.indexOf(failingPhase) + 1);
      assert.deepEqual(attempted, expectedAttempts, 'No retry and later metadata phases stay suppressed');
      assert.ok(rows.length > 0, 'Opt-in diagnostics must survive an incomplete capture');
      const latest = rows.at(-1), stage = latest.phases[failingPhase];
      assert.equal(stage.attempted, 1); assert.equal(stage.settled, 1); assert.equal(stage.failure, fault);
      assert.equal(stage.status, fault === 'timeout' ? null : fault === 'body' ? 202 : 503);
      for (const phase of phases.slice(phases.indexOf(failingPhase) + 1)) assert.equal(latest.phases[phase].skipped, 1);
      assert.doesNotMatch(JSON.stringify(rows), /canary-private|MSG-1|Bearer|http:\/\/|actionId/);
    });
  }
}
test('healthy opt-in phases acknowledge actual collector graphs and throwing diagnostic sinks cannot change delivery', async () => {
  const collector = await startServers({ port: 0, inventoryPort: 0 }), rows = [];
  try {
    const origin = `http://127.0.0.1:${collector.port}`;
    assert.deepEqual(await exercise(origin, row => rows.push(row)), { startComplete: true, header: 'complete' });
    assert.equal(rows.at(-1).action, 'send-message');
    for (const phase of phases) {
      const value = rows.at(-1).phases[phase];
      assert.equal(value.attempted, 1); assert.equal(value.status, 202); assert.equal(value.bodyRead, 1);
      assert.equal(value.settled, 1); assert.equal(value.failure, 'none');
    }
    assert.deepEqual(await exercise(origin, () => { throw Error('canary-sink-secret'); }), { startComplete: true, header: 'complete' });
    assert.deepEqual(await exercise(origin, () => Promise.reject(Error('canary-rejected-sink-secret'))), { startComplete: true, header: 'complete' });
    assert.equal(collector.atlas.actions.size, 3); assert.ok([...collector.atlas.actions.values()].every(graph => graph.outcome === 'success'));
  } finally { await collector.close(); }
});
