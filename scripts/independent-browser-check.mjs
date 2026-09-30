// Optional browser check for the separate-process web app. Keep Playwright outside app dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServers } from '../src/server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = `independent-browser-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const evidence = join(root, 'reports', 'browser', run);
const dataDir = join(root, 'reports', 'storage', run);
mkdirSync(evidence, { recursive: true });

function launchApp(collectorUrl) {
  const child = spawn(process.execPath, ['examples/independent-app/server.mjs'], {
    cwd: root, env: { ...process.env, FLOWATLAS_URL: collectorUrl, PORT: '0', EXTERNAL_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectReady(error); else resolveReady(url);
    };
    const inspect = (chunk) => {
      output += chunk;
      const match = output.match(/Independent app: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) finish(null, match[1]);
    };
    const timer = setTimeout(() => finish(new Error(`Independent app startup timeout: ${output}`)), 10000);
    child.stdout.on('data', inspect);
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`Independent app exited ${code}: ${output}`)));
  });
  return { child, ready };
}

async function stopApp(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.kill();
  let timer;
  try {
    await Promise.race([exited, new Promise((resolveTimeout) => { timer = setTimeout(resolveTimeout, 3000); })]);
  } finally { clearTimeout(timer); }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test('a second web app works through actual browser clicks and FlowAtlas graph links', { timeout: 60000 }, async () => {
  assert.ok(process.env.FLOWATLAS_PLAYWRIGHT_PACKAGE, 'Set FLOWATLAS_PLAYWRIGHT_PACKAGE to playwright-core package.json');
  const require = createRequire(resolve(process.env.FLOWATLAS_PLAYWRIGHT_PACKAGE));
  const { chromium } = require('playwright-core');
  let collector, app, browser;
  const pageErrors = [], actions = [];
  try {
    browser = await chromium.launch({ channel: process.env.FLOWATLAS_BROWSER_CHANNEL ?? 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    context.setDefaultTimeout(8000);
    context.setDefaultNavigationTimeout(8000);
    context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
    collector = await startServers({ port: 0, inventoryPort: 0, dataDir });
    const collectorUrl = `http://127.0.0.1:${collector.port}`;
    app = launchApp(collectorUrl);
    const appUrl = await app.ready;
    const page = await context.newPage();
    assert.equal((await page.goto(appUrl)).status(), 200);
    assert.equal(await page.locator('h1').innerText(), 'Message App');
    console.log('Independent app loaded in browser');
    for (const [name, status, outcome, symbol] of [
      ['view-message', 200, 'success', 'viewMessage'],
      ['send-message', 200, 'success', 'sendMessage'],
      ['fail-message', 503, 'error', 'failMessage'],
    ]) {
      console.log(`Clicking ${name}`);
      await page.locator(`button[data-name="${name}"]`).click();
      await page.waitForFunction((expected) => document.querySelector('#result')?.textContent.startsWith(`HTTP ${expected}\n`), status);
      console.log(`${name} returned HTTP ${status}`);
      assert.equal(await page.locator('#result').innerText().then((text) => text.includes('บันทึกหลักฐานไม่ครบ')), false);
      await page.locator('#graph-link').click();
      const viewer = page;
      await viewer.locator('#trace-content').waitFor({ state: 'visible' });
      assert.equal(new URL(viewer.url()).origin, collectorUrl);
      console.log(`${name} viewer loaded`);
      const id = await viewer.locator('#action-id').innerText();
      const response = await context.request.get(`${collectorUrl}/flowatlas/actions/${id}`);
      assert.equal(response.status(), 200);
      const graph = await response.json();
      assert.equal(graph.name, name);
      assert.equal(graph.outcome, outcome);
      assert.deepEqual(graph.edges.map((edge) => edge.status),
        ['observed', 'observed', 'observed', 'inferred', 'unknown']);
      assert.equal(await viewer.locator('#map .map-edge.observed').count(), 3);
      assert.equal(await viewer.locator('#map .map-edge.unknown').count(), 1);
      const details = viewer.locator('#evidence details').nth(1);
      await details.locator('summary').click();
      const sourceLink = details.locator('a');
      assert.match(await sourceLink.innerText(), new RegExp(symbol));
      const sourcePopup = context.waitForEvent('page');
      await sourceLink.click();
      const source = await sourcePopup;
      await source.waitForLoadState();
      await source.waitForFunction((name) => document.body.textContent.includes(`async function ${name}(`), symbol);
      assert.match(await source.locator('body').innerText(), new RegExp(`async function ${symbol}\\(`));
      await source.close();
      console.log(`${name} source verified`);
      if (name === 'fail-message') await viewer.screenshot({ path: join(evidence, 'graph.png'), fullPage: true, timeout: 20000 });
      await page.goto(appUrl);
      actions.push({ id, name, outcome, nodes: graph.nodes.length, edges: graph.edges.length });
    }
    assert.deepEqual(pageErrors, []);
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ platform: process.platform,
      browser: browser.version(), actions, pageErrors }, null, 2) + '\n');
    await stopApp(app.child);
    await assert.rejects(fetch(appUrl));
    await browser.close(); browser = null;
    await collector.close(); collector = null;
    await assert.rejects(fetch(collectorUrl));
    assert.equal(existsSync(join(dataDir, '.writer.lock')), false);
  } finally {
    await stopApp(app?.child);
    await browser?.close();
    await collector?.close();
  }
  console.log(`Independent browser evidence: ${relative(root, evidence)}`);
});
