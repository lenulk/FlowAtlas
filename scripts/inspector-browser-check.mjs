// Optional end-to-end audit of the on-demand command in a real browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTargetApp, targetFiles } from './create-target-app.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = `inspector-browser-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const work = join(root, 'reports', 'storage', run);
const evidence = join(root, 'reports', 'vm', run);
mkdirSync(evidence, { recursive: true });
const target = createTargetApp(join(work, 'target'));
const config = join(work, 'config.json');
const dataDir = join(work, 'state');
writeFileSync(config, JSON.stringify({ projects: [{ id: 'message-app', root: relative(root, target), files: targetFiles }] }, null, 2));
let current;
let credential;
async function launch() {
  credential = randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, ['scripts/inspect.mjs', '--project', 'message-app',
    '--config', relative(root, config), '--data-dir', relative(root, dataDir)], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FLOWATLAS_SESSION_TOKEN: credential, FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0' },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const ready = await new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.stdout.off('data', inspect);
      if (error) rejectReady(error); else resolveReady(value);
    };
    const inspect = () => {
      const collector = output.match(/FlowAtlas: (http:\/\/127\.0\.0\.1:\d+)/);
      const app = output.match(/App: (http:\/\/127\.0\.0\.1:\d+)/);
      if (collector && app) finish(null, { collector: collector[1], app: app[1] });
    };
    const timer = setTimeout(() => finish(new Error(`Inspector startup timeout: ${output}`)), 12000);
    child.stdout.on('data', inspect);
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`Inspector exited before ready (${code}): ${output}`)));
    inspect();
  });
  return current = { child, output: () => output, ...ready };
}
async function stop() {
  const session = current;
  if (!session) return;
  current = null;
  const { child } = session;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  child.stdin.write('stop\n');
  try { assert.equal(await exited, 0, session.output()); } finally { clearTimeout(timer); }
}

test('on-demand command supports a complete browser journey and persisted replay', { timeout: 60000 }, async () => {
  assert.ok(process.env.FLOWATLAS_PLAYWRIGHT_PACKAGE, 'Set FLOWATLAS_PLAYWRIGHT_PACKAGE to Playwright package.json');
  const require = createRequire(resolve(process.env.FLOWATLAS_PLAYWRIGHT_PACKAGE));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, channel: process.env.FLOWATLAS_BROWSER_CHANNEL || undefined });
  const browserErrors = [], actions = [];
  const createContext = async () => {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    context.setDefaultTimeout(8000); context.setDefaultNavigationTimeout(8000);
    context.on('page', (page) => page.on('pageerror', (error) => browserErrors.push(error.message)));
    return context;
  };
  let context = await createContext();
  const enterPairing = async (page, value) => {
    // Playwright fill errors can include the input; keep it out of TAP artifacts.
    try { await page.locator('#session-code').fill(value); }
    catch { throw new Error('Cannot enter the session pairing code'); }
  };
  const pair = async (page) => {
    await page.locator('#session-panel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#trace-content').isVisible(), false);
    await enterPairing(page, credential);
    await page.locator('#session-form button').click();
    await page.locator('#session-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#session-code').inputValue(), '');
    assert.equal((await page.evaluate(() => localStorage.length + sessionStorage.length)), 0);
    assert.equal(page.url().includes(credential), false);
    assert.equal((await context.cookies()).length, 0);
  };
  try {
    console.log('Inspector: starting app and collector');
    let { app, collector } = await launch();
    const page = await context.newPage();
    assert.equal((await page.goto(app)).status(), 200);
    for (const [name, http, outcome, symbol] of [
      ['view-message', 200, 'success', 'viewMessage'],
      ['send-message', 200, 'success', 'sendMessage'],
      ['fail-message', 503, 'error', 'failMessage'],
    ]) {
      console.log(`Inspector: clicking ${name}`);
      const previousResult = await page.locator('#result').innerText();
      await page.locator(`button[data-name="${name}"]`).click();
      await page.waitForFunction(({ expected, previous }) => {
        const result = document.querySelector('#result')?.textContent;
        return result !== previous && result?.startsWith(`HTTP ${expected}\n`);
      }, { expected: http, previous: previousResult });
      assert.equal(await page.locator('#warning').isVisible(), false);
      const viewerOpened = context.waitForEvent('page');
      await page.locator('#viewer').click();
      const viewer = await viewerOpened;
      await pair(viewer);
      await viewer.locator('#trace-content').waitFor({ state: 'visible' });
      const id = await viewer.locator('#action-id').innerText();
      const graphResponse = await context.request.get(`${collector}/flowatlas/actions/${id}`, { headers: { authorization: `Bearer ${credential}` } })
        .catch(() => { throw new Error('Authorized graph request failed'); });
      assert.equal(graphResponse.status(), 200);
      const graph = await graphResponse.json();
      assert.equal(graph.name, name); assert.equal(graph.outcome, outcome);
      assert.equal(graph.codeVersion.projectId, 'message-app');
      assert.equal(await viewer.locator('#map .map-node').count(), 5);
      assert.equal(await viewer.locator('#map .map-edge.observed').count(), 3);
      assert.equal(await viewer.locator('#map .map-edge.unknown').count(), 1);
      const handler = viewer.locator('#evidence details').nth(1);
      await handler.locator('summary').click();
      assert.match(await handler.locator('a').innerText(), new RegExp(symbol));
      const sourceOpened = context.waitForEvent('page');
      await handler.locator('a').click(); const source = await sourceOpened;
      await source.waitForLoadState();
      await source.waitForFunction((name) => document.body.textContent.includes(`async function ${name}(`), symbol);
      assert.match(await source.locator('body').innerText(), new RegExp(`async function ${symbol}\\(`));
      await source.close();
      if (name === 'fail-message') await viewer.screenshot({ path: join(evidence, 'inspector-graph.png'), fullPage: true, timeout: 20000 });
      await viewer.close();
      actions.push({ id, name, outcome, nodes: graph.nodes.length, edges: graph.edges.length });
    }
    console.log('Inspector: two concurrent action scopes through the browser module');
    const concurrent = await page.evaluate(async () => {
      const { createBrowserActions } = await import('/browser-client.mjs');
      const client = createBrowserActions();
      return Promise.all([['view-message', '/api/message', 'GET'], ['send-message', '/api/send', 'POST']].map(async ([name, path, method]) => {
        const scope = await client.start(name);
        const response = await scope.fetch(path, { method });
        const body = await response.json();
        return { id: scope.id, name, status: response.status, complete: scope.complete, message: body.message };
      }));
    });
    assert.notEqual(concurrent[0].id, concurrent[1].id);
    for (const result of concurrent) {
      assert.equal(result.status, 200); assert.equal(result.complete, true); assert.equal(result.message, 'MSG-1');
      const response = await context.request.get(`${collector}/flowatlas/actions/${result.id}`, { headers: { authorization: `Bearer ${credential}` } })
        .catch(() => { throw new Error('Concurrent authorized graph request failed'); });
      assert.equal(response.status(), 200);
      const graph = await response.json();
      assert.equal(graph.name, result.name); assert.equal(graph.outcome, 'success');
      assert.deepEqual(graph.edges.map((edge) => edge.status), ['observed', 'observed', 'observed', 'unknown']);
      assert.ok(graph.edges.filter((edge) => edge.evidence.correlationId).every((edge) => edge.evidence.correlationId === result.id));
      actions.push({ id: result.id, name: result.name, outcome: graph.outcome, nodes: graph.nodes.length, edges: graph.edges.length });
    }
    console.log('Inspector: closing browser connections before first stop');
    await context.close();
    await stop();
    await assert.rejects(fetch(app));
    await assert.rejects(fetch(collector));
    assert.equal(existsSync(join(dataDir, '.writer.lock')), false);
    console.log('Inspector: restarting app and collector');
    ({ app, collector } = await launch());
    context = await createContext();
    const viewer = await context.newPage();
    assert.equal((await viewer.goto(`${collector}/?actionId=${actions[0].id}`)).status(), 200);
    await viewer.locator('#session-panel').waitFor({ state: 'visible' });
    await enterPairing(viewer, randomBytes(32).toString('base64url'));
    await viewer.locator('#session-form button').click();
    await viewer.waitForFunction(() => document.querySelector('#session-message').textContent.includes('เชื่อมต่อไม่สำเร็จ'));
    assert.equal(await viewer.locator('#trace-content').isVisible(), false);
    await pair(viewer);
    await viewer.locator('#trace-content').waitFor({ state: 'visible' });
    assert.equal(await viewer.locator('#action-id').innerText(), actions[0].id);
    await viewer.locator('#history-status').waitFor();
    await viewer.waitForFunction(() => document.querySelectorAll('#history-list tr').length === 5);
    assert.equal(await viewer.locator('#history-list tr').count(), 5);
    await viewer.screenshot({ path: join(evidence, 'inspector-restart.png'), fullPage: true, timeout: 20000 });
    await viewer.locator('#session-lock').click();
    await viewer.locator('#session-panel').waitFor({ state: 'visible' });
    assert.equal(await viewer.locator('#history-list tr').count(), 0);
    assert.equal(await viewer.locator('#map .map-node').count(), 0);
    await pair(viewer);
    await viewer.reload();
    await viewer.locator('#session-panel').waitFor({ state: 'visible' });
    assert.equal(await viewer.locator('#trace-content').isVisible(), false);
    assert.deepEqual(browserErrors, []);
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ platform: process.platform,
      browser: browser.version(), actions, restored: true, browserErrors }, null, 2) + '\n');
    console.log('Inspector: closing browser connections before final stop');
    await context.close();
    await stop();
    await assert.rejects(fetch(app));
    await assert.rejects(fetch(collector));
    assert.equal(existsSync(join(dataDir, '.writer.lock')), false);
  } finally { try { await browser.close(); } finally { await stop(); } }
  console.log(`Inspector browser evidence: ${relative(root, evidence)}`);
});
