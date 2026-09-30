import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createTargetApp, targetFiles } from '../scripts/create-target-app.mjs';
import { startServers } from '../src/server.mjs';
import { captureProjectVersion } from '../src/project-sources.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function launch(directory, collectorUrl) {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: directory,
    env: { ...process.env, FLOWATLAS_URL: collectorUrl, PORT: '0', EXTERNAL_PORT: '0', FLOWATLAS_PROJECT_ID: 'message-app' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Target did not start: ${output}`)); }, 8000);
    child.stdout.on('data', (chunk) => { output += chunk; const match = output.match(/Registered app: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Target exited ${code}: ${output}`)); });
  });
  return { ready, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); const timer = setTimeout(() => child.kill(), 5000);
    child.stdin.end('stop\n');
    try { const [code] = await exited; assert.equal(code, 0); } finally { clearTimeout(timer); }
  } };
}

test('copied adapter in a different Git repository captures three actions and survives collector outage', async () => {
  const parent = join(root, 'reports', 'storage'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'external-repo-'));
  const target = createTargetApp(join(directory, 'target'));
  execFileSync('git', ['init', '-q'], { cwd: target });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: target });
  execFileSync('git', ['add', '.'], { cwd: target });
  execFileSync('git', ['-c', 'user.name=Codex', '-c', 'user.email=codex@localhost', 'commit', '-qm', 'Independent target fixture'], { cwd: target });
  const targetVersion = captureProjectVersion(target, targetFiles, 'message-app');
  const options = { port: 0, inventoryPort: 0, projects: [{ id: 'message-app', root: relative(root, target), files: targetFiles }], dataDir: join(directory, 'state') };
  let collector = await startServers(options);
  const base = `http://127.0.0.1:${collector.port}`;
  const processApp = launch(target, base);
  try {
    const app = await processApp.ready;
    assert.equal((await fetch(app)).status, 200);
    const saved = [];
    for (const [name, method, path, status, outcome] of [
      ['view-message', 'GET', '/api/message', 200, 'success'], ['send-message', 'POST', '/api/send', 200, 'success'],
      ['fail-message', 'POST', '/api/fail', 503, 'error']]) {
      const id = randomUUID();
      const start = await fetch(`${app}/action-start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, name }) });
      assert.equal(start.status, 201); assert.equal((await start.json()).complete, true);
      const response = await fetch(`${app}${path}`, { method, headers: { 'x-flowatlas-action-id': id } });
      assert.equal(response.status, status); assert.equal(response.headers.get('x-flowatlas-telemetry'), 'complete');
      const graph = await (await fetch(`${base}/flowatlas/actions/${id}`)).json();
      assert.equal(graph.outcome, outcome); assert.deepEqual(graph.codeVersion, targetVersion);
      assert.notEqual(graph.codeVersion.commit, collector.atlas.version.commit);
      assert.equal(graph.codeVersion.dirty, false);
      assert.deepEqual(graph.edges.map((edge) => edge.status), ['observed', 'observed', 'observed', 'unknown']);
      assert.equal(graph.edges[2].evidence.traceparent, graph.edges[2].evidence.receivedTraceparent);
      const source = graph.nodes.find((node) => node.source).source;
      const sourceResponse = await fetch(`${base}/flowatlas/source?actionId=${id}&file=${source.file}&sha256=${source.sha256}`);
      assert.equal(sourceResponse.status, 200);
      const sourceText = await sourceResponse.text();
      assert.match(sourceText, /createFlowAtlasClient/);
      assert.match(sourceText, new RegExp(`async function ${source.symbol}\\(`), 'handler symbol must be a real function in the target source');
      assert.equal((await fetch(`${app}${path}`, { method, headers: { 'x-flowatlas-action-id': id } })).status, 409);
      saved.push(graph);
    }
    assert.equal((await fetch(`${app}/api/message`)).status, 400);
    await collector.close();
    const id = randomUUID();
    const start = await fetch(`${app}/action-start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, name: 'view-message' }) });
    assert.equal(start.status, 201); assert.equal((await start.json()).complete, false);
    const outage = await fetch(`${app}/api/message`, { headers: { 'x-flowatlas-action-id': id } });
    assert.equal(outage.status, 200); assert.equal(outage.headers.get('x-flowatlas-telemetry'), 'incomplete');
    assert.equal((await outage.json()).viewerUrl, null);
    collector = await startServers(options);
    for (const graph of saved) assert.deepEqual(await (await fetch(`http://127.0.0.1:${collector.port}/flowatlas/actions/${graph.id}`)).json(), graph);
    assert.equal(collector.atlas.get(id), null);
  } finally {
    try { await processApp.stop(); } finally { await collector.close(); }
    const within = relative(parent, directory); assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
    rmSync(directory, { recursive: true, force: true });
  }
});
