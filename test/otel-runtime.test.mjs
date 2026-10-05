import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonActionStore } from '../src/action-store.mjs';
import { createRequire } from 'node:module';
import { validateGraph } from '../src/evidence-contract.mjs';
import { cleanupOwnedFixture } from '../scripts/qa-fixture-cleanup.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const parent = join(root, 'reports/storage');
const toolRoot = process.env.FLOWATLAS_TRACED_TOOL_ROOT ? realpathSync(process.env.FLOWATLAS_TRACED_TOOL_ROOT) : root;
if (toolRoot !== root) {
  const path = relative(realpathSync(parent), toolRoot);
  assert.ok(path && !path.startsWith('..') && !isAbsolute(path), 'Installed trace QA must stay under reports/storage');
}
async function waitFor(work, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await work(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error('Asynchronous span delivery did not reach the expected state');
}
async function auditMap(page, graph, evidence, name) {
  const geometry = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#map .map-node')].map((group) => ({
      id: group.dataset.nodeId, box: group.querySelector('rect').getBBox(),
    }));
    const routes = [...document.querySelectorAll('#map .map-edge')].map((path) => ({
      id: path.dataset.edgeId, route: path.getAttribute('d'), status: path.getAttribute('class'),
      marker: path.getAttribute('marker-end'), title: path.querySelector('title')?.textContent,
      height: path.getBBox().height,
    }));
    const crossings = [...document.querySelectorAll('#map .map-edge')].flatMap((path) => {
      const length = path.getTotalLength(), touched = new Set();
      for (let distance = 0; distance <= length; distance += 1) {
        const point = path.getPointAtLength(distance);
        for (const { id, box } of cards) if (point.x > box.x + 2 && point.x < box.x + box.width - 2
          && point.y > box.y + 2 && point.y < box.y + box.height - 2) touched.add(id);
      }
      return [...touched].map((nodeId) => ({ edgeId: path.dataset.edgeId, nodeId }));
    });
    const map = document.querySelector('#map'), wrap = map.parentElement;
    return { nodeIds: cards.map((card) => card.id), routes, crossings,
      width: map.getBoundingClientRect().width, viewWidth: map.viewBox.baseVal.width,
      scrollWidth: wrap.scrollWidth, viewportWidth: wrap.clientWidth };
  });
  writeFileSync(join(evidence, `${name}-geometry.json`), JSON.stringify(geometry, null, 2));
  assert.deepEqual(geometry.nodeIds, graph.nodes.map((node) => node.id));
  assert.deepEqual(geometry.routes.map((route) => route.id), graph.edges.map((edge) => edge.id));
  assert.equal(new Set(geometry.routes.map((route) => route.route)).size, graph.edges.length);
  assert.deepEqual(geometry.crossings, [], 'Relationship paths must stay outside all card interiors');
  for (const [index, route] of geometry.routes.entries()) {
    assert.equal(route.status, `map-edge ${graph.edges[index].status}`);
    assert.equal(route.marker, `url(#map-arrow-${graph.edges[index].status})`);
    assert.ok(route.title.includes('→'));
    if (graph.edges[index].from === graph.edges[index].to) assert.ok(route.height > 20, 'A self-relationship must form a visible loop');
  }
  assert.equal(geometry.width, geometry.viewWidth, 'Wide maps scroll without shrinking labels');
  return geometry;
}
for (const extension of ['cjs', 'mjs']) test(`real OTel preload captures ${extension} HTTP/Undici fan-out and isolates concurrent requests`, { timeout: 25000 }, async (t) => {
  mkdirSync(parent, { recursive: true }); const workspace = mkdtempSync(join(parent, 'otel-runtime-'));
  const canonical = realpathSync(workspace);
  const app = join(workspace, 'app'); mkdirSync(app); const entry = `server.${extension}`;
  const contexts = [];
  const upstream = createServer((req, res) => { contexts.push(req.headers.traceparent); res.end('real-upstream'); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  // This app contains no FlowAtlas imports, handler hooks or telemetry calls.
  const imports = extension === 'cjs' ? "const {createServer, get}=require('node:http');" : "import {createServer, get} from 'node:http';";
  writeFileSync(join(app, entry), imports + `
const app=createServer(async(req,res)=>{
  await Promise.all([
    new Promise((resolve,reject)=>get('${upstreamUrl}/native?token=canary-query',r=>{r.resume();r.on('end',resolve)}).on('error',reject)),
    fetch('${upstreamUrl}/fetch?token=canary-query',{headers:{authorization:'canary-auth'}}).then(r=>r.text())
  ]);
  res.writeHead(req.url.startsWith('/error')?503:200); res.end('canary-business-response');
});
app.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('Registered app: http://127.0.0.1:'+app.address().port));
process.stdin.resume();
`);
  writeFileSync(join(workspace, 'flowatlas.config.json'), JSON.stringify({ projects: [{ id: 'auto-target', root: 'app', files: [entry] }] }));
  const token = randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, [join(toolRoot, 'scripts/cli.mjs'), '--workspace', workspace, 'inspect', '--entry', entry, '--trace', 'http'],
    { cwd: root, env: { ...process.env, FLOWATLAS_SESSION_TOKEN: token, FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9/canary-exporter', OTEL_SERVICE_NAME: 'canary-resource' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (part) => { output += part; }); child.stderr.on('data', (part) => { output += part; });
  const closed = new Promise((resolve) => child.once('close', (...args) => resolve(args)));
  // Handle early process/pipe failures without losing the original assertion in finally.
  child.stdin.on('error', () => {});
  let failed = false;
  const read = (url) => fetch(url, { headers: { authorization: `Bearer ${token}` } });
  try {
    const ready = await waitFor(() => {
      if (child.exitCode !== null) throw new Error('Traced target exited before readiness: ' + output);
      const collector = output.match(/FlowAtlas: (http:\/\/127\.0\.0\.1:\d+)/), target = output.match(/App: (http:\/\/127\.0\.0\.1:\d+)/);
      return collector && target && { collector: collector[1], target: target[1] };
    }, 12000).catch(() => { throw new Error('Traced inspector readiness failed: ' + output.replaceAll(token, '[redacted]')); });
    const responses = await Promise.all(['/success?secret=canary-query', '/error?secret=canary-query'].map((path) =>
      fetch(ready.target + path, { headers: { authorization: 'canary-auth', cookie: 'canary-cookie', baggage: 'secret=canary-baggage' } })));
    assert.deepEqual(responses.map((response) => response.status), [200, 503]);
    for (const response of responses) assert.equal(await response.text(), 'canary-business-response');
    const graphs = await waitFor(async () => {
      const list = await (await read(ready.collector + '/flowatlas/actions')).json();
      const graphs = await Promise.all(list.map(async ({ id }) => (await read(ready.collector + '/flowatlas/actions/' + id)).json()));
      return graphs.length === 2 && graphs.every((graph) => graph.trace?.spans.length === 3) && graphs;
    });
    assert.deepEqual(graphs.map((graph) => graph.outcome).sort(), ['error', 'success']);
    assert.equal(new Set(graphs.map((graph) => graph.trace.traceId)).size, 2);
    for (const graph of graphs) {
      assert.equal(graph.schemaVersion, '0.2'); assert.equal(graph.codeVersion.projectId, 'auto-target');
      assert.equal(graph.trace.spans.filter((span) => span.kind === 'SERVER').length, 1);
      assert.equal(graph.trace.spans.filter((span) => span.kind === 'CLIENT').length, 2);
      assert.equal(graph.edges.filter((edge) => edge.status === 'observed').length, 2);
      assert.equal(graph.trace.coverage, 'partial'); assert.equal(JSON.stringify(graph).includes('canary-'), false);
    }
    assert.equal(contexts.length, 4); assert.ok(contexts.every((value) => /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/.test(value)));
    assert.equal(output.includes(token), false); assert.equal(output.includes('canary-'), false);
    if (process.env.FLOWATLAS_OTEL_BROWSER_CHECK === '1') {
      const { chromium } = createRequire(process.env.FLOWATLAS_PLAYWRIGHT_PACKAGE)('playwright');
      const browser = await chromium.launch({ headless: true, channel: process.env.FLOWATLAS_BROWSER_CHANNEL || undefined });
      try {
        const page = await browser.newPage(); page.setDefaultTimeout(8000);
        await page.goto(`${ready.collector}/?actionId=${graphs[0].id}`);
        try { await page.locator('#session-code').fill(token); } catch { throw new Error('Cannot pair the trace viewer'); }
        await page.locator('#session-form button').click();
        await page.locator('#trace-content').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#session-code').inputValue(), '');
        assert.match(await page.locator('#trace-subtitle').innerText(), /หลักฐาน HTTP บางส่วน/);
        assert.equal(await page.locator('#map .http-span').count(), 3);
        assert.equal(await page.locator('#map .map-edge.observed').count(), 2);
        assert.equal((await page.locator('body').innerText()).includes('canary-'), false);
        const evidence = join(root, 'reports/browser', `otel-runtime-${Date.now()}-${extension}`);
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, 'http-trace.png'), fullPage: true, timeout: 20000 });
        console.log(`HTTP trace browser evidence: ${relative(root, evidence)}`);
        await auditMap(page, graphs[0], evidence, 'actual-http');
        if (extension === 'mjs') {
          // Viewer-only synthetic boundary: cycles, self-edge, disconnected cards,
          // and the allowed 200-edge maximum. This is not captured business data.
          const { trace, ...boundary } = graphs[0];
          boundary.schemaVersion = '0.1';
          boundary.nodes = ['a', 'b', 'c', 'd', 'isolated', 'unconnected'].map((id) => ({ id, type: 'unknown', label: `Geometry fixture ${id}` }));
          const pairs = [['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'd'], ['d', 'b'], ['b', 'b']];
          boundary.edges = Array.from({ length: 200 }, (_, index) => ({ id: `fixture-${index}`,
            from: pairs[index % pairs.length][0], to: pairs[index % pairs.length][1], status: 'unknown',
            evidence: { type: 'coverage-gap', id: randomBytes(16).toString('hex'), recordedAt: boundary.startedAt,
              reason: 'Synthetic viewer geometry fixture, not runtime evidence.' } }));
          assert.deepEqual(validateGraph(boundary), []);
          await page.route(`${ready.collector}/flowatlas/actions/${boundary.id}`, (route) => route.fulfill({
            status: 200, contentType: 'application/json', body: JSON.stringify(boundary),
          }));
          await page.reload();
          try { await page.locator('#session-code').fill(token); } catch { throw new Error('Cannot pair the boundary viewer'); }
          await page.locator('#session-form button').click();
          await page.locator('#map .map-edge').nth(199).waitFor({ state: 'attached' });
          const geometry = await auditMap(page, boundary, evidence, 'synthetic-boundary');
          assert.ok(geometry.scrollWidth > geometry.viewportWidth);
          await page.locator('.map-wrap').evaluate((wrap) => { wrap.scrollLeft = wrap.scrollWidth; });
          await page.screenshot({ path: join(evidence, 'synthetic-boundary.png'), fullPage: true, timeout: 20000 });
        }
      } finally { await browser.close(); }
    }
    child.stdin.end('stop\n');
    let closeTimer;
    try { assert.equal((await Promise.race([closed, new Promise((_, reject) => {
      closeTimer = setTimeout(() => reject(new Error('Traced fixture did not close after stop')), 8000);
    })]))[0], 0); } finally { clearTimeout(closeTimer); }
    const summaries = [...output.matchAll(/FlowAtlas trace summary: (\{[^\n]+\})/g)];
    assert.equal(summaries.length, 1, 'Shutdown reports one sanitized capture summary');
    const summary = JSON.parse(summaries[0][1]);
    if (summary.dropped) {
      for (const [prefix, fields] of [
        ['delivery', ['overflow', 'invalid', 'rejected', 'timeout', 'transport', 'shutdown']],
        ['rejection', ['400', '401', '403', '409', '413', '503', 'other']],
        ['transport', ['batches', 'submittedSpans', 'smallBatches', 'peakRequests']]]) {
        const match = output.match(new RegExp(`FlowAtlas trace ${prefix} health: (\\{[^\\n]+\\})`));
        const health = match ? JSON.parse(match[1]) : null;
        if (health && fields.every((field) => Number.isSafeInteger(health[field]) && health[field] >= 0)) {
          t.diagnostic(`SDK ${prefix} diagnosis: ${JSON.stringify(Object.fromEntries(fields.map((field) => [field, health[field]])))}`);
        }
      }
    }
    assert.deepEqual(summary, { httpSpans: 6, invalidSpans: 0, delivered: 6, dropped: 0, queued: 0, inFlight: 0 });
    assert.equal(existsSync(join(workspace, 'data/actions/.writer.lock')), false);
    const state = readFileSync(join(workspace, 'data/actions/state.json'), 'utf8');
    assert.equal(state.includes('canary-'), false); assert.equal(state.includes(token), false);
    const restored = new JsonActionStore(join(workspace, 'data/actions'));
    try { assert.deepEqual(restored.load(100), graphs.reverse(), 'Schema 0.2 graphs reload exactly after stop'); }
    finally { restored.close(); }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
      const origins = [...output.matchAll(/(?:FlowAtlas|App): (http:\/\/127\.0\.0\.1:\d+)/g)].map((match) => match[1]);
      const cleanup = await cleanupOwnedFixture({ child, closed, parent, workspace, canonical, origins });
      t.diagnostic(`Traced fixture cleanup: ${JSON.stringify(cleanup)}`);
      if (!cleanup.removed) t.diagnostic(`Unconfirmed fixture retained: ${relative(root, workspace)}`);
      if (!failed) assert.equal(cleanup.removed, true, 'Traced fixture cleanup must be confirmed');
    } catch (error) {
      t.diagnostic(`Traced fixture cleanup failed; workspace retained (${error.code ?? error.name})`);
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.unref?.();
      if (!failed) throw error;
    }
  }
});
