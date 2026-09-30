// Optional real-browser gate. Install Playwright in an isolated QA runtime and
// run through scripts/run-tests.mjs; the dependency is not needed by the app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startServers } from '../src/server.mjs';
import { createTargetApp, targetFiles } from './create-target-app.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = `browser-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const directory = join(root, 'reports', 'storage', run);
const evidence = join(root, 'reports', 'vm', run);
mkdirSync(evidence, { recursive: true });
const errors = [], actions = [];
let collector, targetProcess, browser, context, appPage, viewer, base, appUrl, options, target;
let targetOutput = '';
const watch = (page) => page.on('pageerror', (error) => errors.push({ url: page.url(), message: error.message }));
const waitText = (page, selector, text) => page.waitForFunction(({ selector, text }) =>
  document.querySelector(selector)?.textContent.includes(text), { selector, text });
const screenshot = (page, name) => page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
async function history(count) {
  await viewer.locator('#history-form button').click();
  await waitText(viewer, '#history-status', count ? `แสดง ${count} รายการ` : 'ยังไม่มีรายการ');
  assert.equal(await viewer.locator('#history-list tr').count(), count);
}
before(async () => {
  assert.ok(process.env.FLOWATLAS_PLAYWRIGHT_PACKAGE, 'Set FLOWATLAS_PLAYWRIGHT_PACKAGE to the absolute Playwright package.json path');
  const require = createRequire(resolve(process.env.FLOWATLAS_PLAYWRIGHT_PACKAGE));
  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.on('page', watch);
  writeFileSync(join(evidence, 'environment.json'), JSON.stringify({ node: process.version,
    platform: process.platform, arch: process.arch, browser: browser.version(),
    playwright: require('playwright/package.json').version, headless: true, viewport: { width: 1440, height: 1000 } }, null, 2));
  target = createTargetApp(join(directory, 'target'));
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Codex', '-c', 'user.email=codex@localhost', 'commit', '-qm', 'Browser target fixture']])
    execFileSync('git', args, { cwd: target });
  options = { port: 0, inventoryPort: 0, dataDir: join(directory, 'state'),
    projects: [{ id: 'message-app', root: relative(root, target), files: targetFiles }] };
  collector = await startServers(options);
  options.port = collector.port;
  base = `http://127.0.0.1:${collector.port}`;
  targetProcess = spawn(process.execPath, ['server.mjs'], { cwd: target,
    env: { ...process.env, FLOWATLAS_URL: base, PORT: '0', EXTERNAL_PORT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  appUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Target startup timeout: ${targetOutput}`)), 8000);
    targetProcess.stdout.on('data', (data) => { targetOutput += data; const match = targetOutput.match(/Registered app: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); } });
    targetProcess.stderr.on('data', (data) => { targetOutput += data; });
    targetProcess.once('error', (error) => { clearTimeout(timer); reject(error); });
    targetProcess.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Target exited ${code}`)); });
  });
  appPage = await context.newPage(); await appPage.goto(appUrl);
}, { timeout: 30000 });

for (const [name, status, outcome, symbol] of [
  ['view-message', 200, 'success', 'viewMessage'], ['send-message', 200, 'success', 'sendMessage'],
  ['fail-message', 503, 'error', 'failMessage']]) {
  test(`Linux browser: ${name}, graph, evidence and source popup`, async () => {
    await appPage.locator(`button[data-name="${name}"]`).click();
    await waitText(appPage, '#result', `HTTP ${status}`);
    assert.equal(await appPage.locator('#warning').isVisible(), false);
    const opened = context.waitForEvent('page');
    await appPage.locator('#viewer').click(); viewer = await opened;
    await viewer.locator('#trace-content').waitFor({ state: 'visible' });
    assert.match(await viewer.locator('#trace-subtitle').innerText(), new RegExp(`${name}.*5 nodes`));
    assert.equal(await viewer.locator('#demo-actions').isVisible(), false);
    assert.equal(await viewer.locator('#map .map-node').count(), 5);
    assert.equal(await viewer.locator('#map .map-edge.observed').count(), 3);
    assert.equal(await viewer.locator('#map .map-edge.unknown').count(), 1);
    const id = await viewer.locator('#action-id').innerText();
    const graph = await (await context.request.get(`${base}/flowatlas/actions/${id}`)).json();
    assert.equal(graph.outcome, outcome); actions.push(graph);
    const details = viewer.locator('#evidence details').nth(1); await details.locator('summary').click();
    const link = details.locator('a'); assert.match(await link.innerText(), new RegExp(symbol));
    const popupEvent = context.waitForEvent('page'); await link.click(); const source = await popupEvent;
    await source.waitForLoadState();
    assert.match(await source.locator('body').innerText(), new RegExp(`async function ${symbol}\\(`));
    await source.close();
    await screenshot(viewer, name);
    if (name !== 'fail-message') await viewer.close();
  });
}

test('Linux browser: history search, outcome filter, no matches and keyboard submit', async () => {
  await history(3);
  await viewer.locator('#history-query').fill(actions[0].id);
  await viewer.locator('#history-query').press('Enter');
  await waitText(viewer, '#history-status', 'แสดง 1 รายการ');
  assert.equal(await viewer.locator('#history-list a').innerText(), 'view-message');
  await viewer.locator('#history-query').fill('');
  await viewer.locator('#history-outcome').selectOption('error'); await history(1);
  assert.equal(await viewer.locator('#history-list a').innerText(), 'fail-message');
  await viewer.locator('#history-query').fill('does-not-exist'); await history(0);
  await viewer.locator('#history-query').fill(''); await viewer.locator('#history-outcome').selectOption('');
  await history(3);
});

test('Linux browser: collector restart preserves history and graph links', async () => {
  await collector.close(); collector = await startServers(options);
  await viewer.reload(); await viewer.locator('#trace-content').waitFor({ state: 'visible' });
  await history(3);
  await viewer.locator('#history-list a').filter({ hasText: 'view-message' }).click();
  await waitText(viewer, '#trace-subtitle', 'view-message');
  assert.equal(await viewer.locator('#action-id').innerText(), actions[0].id);
  for (const graph of actions) assert.deepEqual(await (await context.request.get(`${base}/flowatlas/actions/${graph.id}`)).json(), graph);
  await screenshot(viewer, 'history-after-restart');
});

test('Linux browser: narrow viewport contains page and allows graph scrolling', async () => {
  await viewer.setViewportSize({ width: 390, height: 844 });
  assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page must not overflow viewport');
  assert.ok(await viewer.locator('.map-wrap').evaluate((element) => element.scrollWidth > element.clientWidth), 'Wide graph must scroll inside its container');
  await viewer.locator('.map-wrap').evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  assert.ok(await viewer.locator('.map-wrap').evaluate((element) => element.scrollLeft > 0));
  await screenshot(viewer, 'mobile-viewer');
});

test('Linux browser: changed source popup returns conflict rather than new source', async () => {
  const path = join(target, 'server.mjs'); const original = readFileSync(path);
  appendFileSync(path, '\n// browser QA changed source\n');
  try {
    await viewer.locator('#evidence details').nth(1).locator('summary').click();
    const popupEvent = context.waitForEvent('page');
    await viewer.locator('#evidence details').nth(1).locator('a').click();
    const popup = await popupEvent; await popup.waitForLoadState();
    const response = await context.request.get(popup.url()); assert.equal(response.status(), 409);
    assert.doesNotMatch(await popup.locator('body').innerText(), /browser QA changed source/);
    await screenshot(popup, 'changed-source-conflict'); await popup.close();
  } finally { writeFileSync(path, original); }
});

test('Linux browser: collector outage keeps app usable and hides graph link', async () => {
  await collector.close();
  await appPage.locator('button[data-name="view-message"]').click();
  await waitText(appPage, '#result', 'HTTP 200');
  await appPage.locator('#warning').waitFor({ state: 'visible' });
  assert.equal(await appPage.locator('#viewer').isVisible(), false);
  assert.equal(await appPage.locator('button:disabled').count(), 0);
  await screenshot(appPage, 'collector-outage');
  assert.deepEqual(errors, [], 'No uncaught browser JavaScript errors');
});

after(async () => {
  try {
    if (targetProcess && targetProcess.exitCode === null) {
      const exited = once(targetProcess, 'exit'); const timer = setTimeout(() => targetProcess.kill(), 5000);
      targetProcess.stdin.end('stop\n');
      try { const [code] = await exited; assert.equal(code, 0); } finally { clearTimeout(timer); }
    }
  } finally {
    await collector?.close(); await browser?.close();
    writeFileSync(join(evidence, 'browser-errors.json'), JSON.stringify(errors, null, 2));
    writeFileSync(join(evidence, 'graphs.json'), JSON.stringify(actions, null, 2));
    writeFileSync(join(evidence, 'target-console.log'), targetOutput);
    console.log(`Browser evidence: ${relative(root, evidence)}`);
  }
});
