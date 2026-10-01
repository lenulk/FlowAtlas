import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonActionStore } from '../src/action-store.mjs';
import { createRequire } from 'node:module';

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
for (const extension of ['cjs', 'mjs']) test(`real OTel preload captures ${extension} HTTP/Undici fan-out and isolates concurrent requests`, { timeout: 25000 }, async () => {
  mkdirSync(parent, { recursive: true }); const workspace = mkdtempSync(join(parent, 'otel-runtime-'));
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
      } finally { await browser.close(); }
    }
    const done = once(child, 'close'); child.stdin.write('stop\n'); assert.equal((await done)[0], 0);
    const summaries = [...output.matchAll(/FlowAtlas trace summary: (\{[^\n]+\})/g)];
    assert.equal(summaries.length, 1, 'Shutdown reports one sanitized capture summary');
    assert.deepEqual(JSON.parse(summaries[0][1]), { httpSpans: 6, invalidSpans: 0, delivered: 6, dropped: 0, queued: 0, inFlight: 0 });
    assert.equal(existsSync(join(workspace, 'data/actions/.writer.lock')), false);
    const state = readFileSync(join(workspace, 'data/actions/state.json'), 'utf8');
    assert.equal(state.includes('canary-'), false); assert.equal(state.includes(token), false);
    const restored = new JsonActionStore(join(workspace, 'data/actions'));
    try { assert.deepEqual(restored.load(100), graphs.reverse(), 'Schema 0.2 graphs reload exactly after stop'); }
    finally { restored.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
    const path = relative(parent, workspace); assert.ok(path && !path.startsWith('..') && !isAbsolute(path));
    rmSync(workspace, { recursive: true, force: true });
  }
});
