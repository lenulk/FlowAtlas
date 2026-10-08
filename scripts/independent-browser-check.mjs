// Optional browser check for the separate-process web app. Keep Playwright outside app dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServers } from '../src/server.mjs';
import { getCodeVersion } from '../src/flowatlas.mjs';
import { createMetadataDiagnosticParser } from './independent-metadata-diagnostics.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = `independent-browser-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const evidence = join(root, 'reports', 'browser', run);
const dataDir = join(root, 'reports', 'storage', run);
mkdirSync(evidence, { recursive: true });

function launchApp(collectorUrl) {
  const diagnostics = createMetadataDiagnosticParser();
  const child = spawn(process.execPath, ['examples/independent-app/server.mjs'], {
    cwd: root, env: { ...process.env, FLOWATLAS_URL: collectorUrl, PORT: '0', EXTERNAL_PORT: '0', FLOWATLAS_INDEPENDENT_DIAG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let childClosed = false;
  const closed = new Promise(resolveClosed => child.once('close', () => { childClosed = true; resolveClosed(); }));
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
      diagnostics.write(chunk);
      output = (output + chunk).slice(-8192);
      const match = output.match(/Independent app: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) finish(null, match[1]);
    };
    const timer = setTimeout(() => finish(new Error('Independent app startup timeout')), 10000);
    child.stdout.on('data', inspect);
    child.stderr.on('data', () => {});
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`Independent app exited ${code}`)));
  });
  return { child, ready, closed, diagnostics, get childClosed() { return childClosed; } };
}

async function waitBounded(promise, timeoutMs) {
  let timer;
  try { return await Promise.race([promise.then(() => true, () => false), new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

async function stopApp(child, closed) {
  if (!child) return;
  const exited = closed ?? new Promise((resolveExit) => child.once('close', resolveExit));
  if (child.exitCode === null && child.signalCode === null) child.kill();
  if (!await waitBounded(exited, 3000)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitBounded(exited, 1000);
  }
}

const phases = ['action-start', 'handler-entry', 'outbound-result', 'finish'];
const controlledStage = process.env.FLOWATLAS_INDEPENDENT_FAULT_STAGE ?? null;
const controlledOccurrence = Number(process.env.FLOWATLAS_INDEPENDENT_FAULT_OCCURRENCE ?? 1);
if (controlledStage !== null && !phases.includes(controlledStage)) throw new Error('Invalid controlled metadata phase');
if (![1, 2, 3].includes(controlledOccurrence)) throw new Error('Invalid controlled metadata occurrence');
function rejectOwnedPhase(server) {
  const handlers = server.listeners('request'); assert.equal(handlers.length, 1);
  const original = handlers[0]; let rejected = 0, matches = 0;
  server.off('request', original);
  server.on('request', async (req, res) => {
    if (req.method === 'POST' && req.url === '/flowatlas/ingest') {
      const chunks = []; let bytes = 0;
      try {
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw Error(); chunks.push(chunk); }
        const body = Buffer.concat(chunks), event = JSON.parse(body);
        if (event.kind === controlledStage) matches++;
        if (event.kind === controlledStage && matches === controlledOccurrence && rejected === 0) {
          rejected++; res.writeHead(503); res.end('{"error":"controlled metadata refusal"}'); return;
        }
        req[Symbol.asyncIterator] = async function* () { yield body; };
      } catch { res.writeHead(400); res.end(); return; }
    }
    original.call(server, req, res);
  });
  return () => rejected;
}

test('a second web app works through actual browser clicks and FlowAtlas graph links', { timeout: 60000 }, async () => {
  assert.ok(process.env.FLOWATLAS_PLAYWRIGHT_PACKAGE, 'Set FLOWATLAS_PLAYWRIGHT_PACKAGE to playwright-core package.json');
  const require = createRequire(resolve(process.env.FLOWATLAS_PLAYWRIGHT_PACKAGE));
  const { chromium } = require('playwright-core');
  let collector, app, browser, browserVersion, context, appUrl, collectorUrl, originalFailure, activeRow, rejectedProbe;
  const pageErrors = [], actions = [];
  const browserRows = [], privateIds = new Map(), pending = new Set();
  const version = getCodeVersion(root);
  const diagnostic = { sourceCommit: version.commit, sourceDigest: version.digest, sourceDirty: version.dirty,
    evidenceKind: 'owned independent fixture; browser and child metadata phases, not real app pilot',
    controlledStage, controlledOccurrence, controlledRejections: 0, browser: browserRows, metadata: null, storageErrors: [], storageErrorsOmitted: 0,
    storageTiming: null, assertionFailed: false, completenessAssertionFailed: false, browserStartBodiesSettled: false,
    cleanup: { childClosed: false, browserClosed: false, collectorClosed: false, lockRemoved: false },
    scriptDigest: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    diagnosticHelperDigest: createHash('sha256').update(readFileSync(join(root, 'scripts/independent-metadata-diagnostics.mjs'))).digest('hex') };
  try {
    browser = await chromium.launch({ channel: process.env.FLOWATLAS_BROWSER_CHANNEL ?? 'msedge', headless: true });
    browserVersion = browser.version();
    context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    context.setDefaultTimeout(8000);
    context.setDefaultNavigationTimeout(8000);
    context.on('response', response => {
      if (!activeRow || !appUrl) return;
      const url = new URL(response.url()); if (url.origin !== appUrl) return;
      const row = activeRow;
      if (url.pathname === '/action-start') {
        row.startStatus = response.status();
        const work = response.json().then(value => {
          row.startBodyRead = true; row.startComplete = value?.telemetry?.complete === true;
          if (typeof value?.id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value.id)) privateIds.set(row.ordinal, value.id);
        }).catch(() => { row.startBodyRead = false; }).finally(() => pending.delete(work));
        pending.add(work);
      } else if (url.pathname === row.businessPath) {
        row.businessStatus = response.status(); row.businessComplete = response.headers()['x-flowatlas-telemetry'] === 'complete';
      }
    });
    context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
    collector = await startServers({ port: 0, inventoryPort: 0, dataDir, traceTiming: true, onStorageError: value => {
      if (diagnostic.storageErrors.length < 16) diagnostic.storageErrors.push({ code: value.code, operation: value.operation, stage: value.stage, causeCode: value.causeCode });
      else diagnostic.storageErrorsOmitted++;
    } });
    if (controlledStage) rejectedProbe = rejectOwnedPhase(collector.app);
    collectorUrl = `http://127.0.0.1:${collector.port}`;
    app = launchApp(collectorUrl);
    appUrl = await app.ready;
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
      const businessPath = name === 'view-message' ? '/api/message' : name === 'send-message' ? '/api/send' : '/api/fail';
      activeRow = { ordinal: browserRows.length + 1, action: name, businessPath, startStatus: null, startBodyRead: null, startComplete: null,
        businessStatus: null, businessComplete: null, bodyCorrect: false, incompleteWarning: null, readbackStatus: null,
        readbackShape: null, readbackFailed: false, readbackFailure: 'none' };
      browserRows.push(activeRow);
      await page.locator(`button[data-name="${name}"]`).click();
      await page.waitForFunction((expected) => document.querySelector('#result')?.textContent.startsWith(`HTTP ${expected}\n`), status);
      console.log(`${name} returned HTTP ${status}`);
      const resultText = await page.locator('#result').innerText();
      const body = JSON.parse(resultText.split('\nบันทึกหลักฐานไม่ครบ')[0].split('\n').slice(1).join('\n'));
      const expectedBody = name === 'view-message' ? { message: 'Hello from the separate message service' }
        : name === 'send-message' ? { messageId: 'MSG-1' } : { error: 'Message service is temporarily unavailable' };
      activeRow.bodyCorrect = JSON.stringify(body) === JSON.stringify(expectedBody); assert.deepEqual(body, expectedBody);
      activeRow.incompleteWarning = resultText.includes('บันทึกหลักฐานไม่ครบ');
      diagnostic.completenessAssertionFailed = activeRow.incompleteWarning === true;
      assert.equal(activeRow.incompleteWarning, false);
      await page.locator('#graph-link').click();
      const viewer = page;
      await viewer.locator('#trace-content').waitFor({ state: 'visible' });
      assert.equal(new URL(viewer.url()).origin, collectorUrl);
      console.log(`${name} viewer loaded`);
      const id = await viewer.locator('#action-id').innerText();
      const response = await context.request.get(`${collectorUrl}/flowatlas/actions/${id}`);
      activeRow.readbackStatus = response.status();
      assert.equal(response.status(), 200);
      const graph = await response.json();
      activeRow.readbackShape = { nodes: graph.nodes.length, edges: graph.edges.length, outcome: graph.outcome };
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
    await stopApp(app.child, app.closed);
    assert.equal(app.childClosed, true, 'Owned child close must be confirmed before publishing a complete result');
    const metadata = app.diagnostics.snapshot();
    assert.equal(metadata.records.length, 3); assert.equal(metadata.invalidFrames + metadata.overflowFrames, 0);
    for (const record of metadata.records) {
      assert.equal(record.action, browserRows[record.ordinal - 1].action);
      for (const phase of phases) {
        const value = record.phases[phase];
        assert.equal(value.attempted, 1); assert.equal(value.skipped, 0); assert.equal(value.status, 202);
        assert.equal(value.bodyRead, 1); assert.equal(value.settled, 1); assert.equal(value.failure, 'none');
      }
    }
    await assert.rejects(fetch(appUrl));
    await browser.close(); browser = null; diagnostic.cleanup.browserClosed = true;
    diagnostic.storageTiming = collector.atlas.store?.timingHealth() ?? null;
    await collector.close(); collector = null; diagnostic.cleanup.collectorClosed = true;
    await assert.rejects(fetch(collectorUrl));
    assert.equal(existsSync(join(dataDir, '.writer.lock')), false);
  } catch (error) { originalFailure = error; diagnostic.assertionFailed = error.code === 'ERR_ASSERTION'; throw error;
  } finally {
    let cleanupProblem = false;
    try {
      diagnostic.browserStartBodiesSettled = await waitBounded(Promise.allSettled([...pending]), 1000);
      if (collector) {
        diagnostic.storageTiming = collector.atlas.store?.timingHealth() ?? null;
        for (const row of browserRows) {
          const id = privateIds.get(row.ordinal); if (!id) continue;
          try {
            const response = await context.request.get(`${collectorUrl}/flowatlas/actions/${id}`, { timeout: 1000 });
            row.readbackStatus = response.status();
            if (response.ok()) {
              const graph = await response.json(); row.readbackShape = { nodes: graph.nodes.length, edges: graph.edges.length,
                outcome: ['success', 'error', 'unknown', 'pending', 'running'].includes(graph.outcome) ? graph.outcome : 'other' };
            }
          } catch (error) { row.readbackFailed = true; row.readbackFailure = error.name === 'TimeoutError' ? 'timeout' : 'other'; }
        }
      }
    } catch { cleanupProblem = true; }
    try { await stopApp(app?.child, app?.closed); } catch { cleanupProblem = true; }
      diagnostic.cleanup.childClosed = app?.childClosed ?? false;
    try { if (browser) { await browser.close(); diagnostic.cleanup.browserClosed = true; } } catch { cleanupProblem = true; }
    try { if (collector) { await collector.close(); diagnostic.cleanup.collectorClosed = true; } } catch { cleanupProblem = true; }
      diagnostic.cleanup.lockRemoved = !existsSync(join(dataDir, '.writer.lock'));
    {
      diagnostic.metadata = app?.diagnostics.snapshot() ?? { records: [], invalidFrames: 0, overflowFrames: 0 };
      diagnostic.controlledRejections = rejectedProbe?.() ?? 0;
      // Raw stdout, error messages, IDs, body, headers and URLs stay out of this artifact.
      diagnostic.browser = browserRows.map(({ businessPath, ...row }) => row);
      try { writeFileSync(join(evidence, 'diagnostics.json'), JSON.stringify(diagnostic, null, 2) + '\n'); }
      catch { if (!originalFailure) throw new Error('Independent diagnostic report failed'); }
      console.log(`Independent phase diagnostics: ${relative(root, join(evidence, 'diagnostics.json'))}`);
    }
    if (cleanupProblem && !originalFailure) throw new Error('Independent fixture cleanup failed');
  }
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ complete: true, platform: process.platform,
    browser: browserVersion, actions, pageErrors }, null, 2) + '\n');
  console.log(`Independent browser evidence: ${relative(root, evidence)}`);
});
