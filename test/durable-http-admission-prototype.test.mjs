import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, renameSync, rmdirSync, rmSync,
  realpathSync, lstatSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonActionStore } from '../src/action-store.mjs';
import { createDurableHttpAdmission } from '../scripts/durable-http-admission-prototype.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const storageParent = join(root, 'reports/storage');
const inside = (parent, path) => {
  const child = relative(parent, path);
  return Boolean(child) && !child.startsWith('..') && !isAbsolute(child);
};
const files = Object.freeze({ 'src/server.mjs': 'b'.repeat(64) });
const version = Object.freeze({ projectId: 'component', files, commit: null, dirty: null,
  digest: createHash('sha256').update(`src/server.mjs\0${files['src/server.mjs']}`).digest('hex') });
const projectSources = Object.freeze({ version: projectId => projectId === version.projectId ? version : null });

function span(spanId, parentSpanId = null, overrides = {}) {
  return { spanId, parentSpanId, kind: parentSpanId ? 'CLIENT' : 'SERVER', method: 'POST',
    startedAt: '2026-10-01T00:00:00.000Z', endedAt: '2026-10-01T00:00:00.100Z',
    durationMs: 100, httpStatus: 200, error: false, ...overrides };
}

function batch(traceId, spans, extra = {}) {
  return { kind: 'otel-span-batch', projectId: version.projectId, codeDigest: version.digest,
    items: spans.map(value => ({ traceId, span: value })), ...extra };
}

function responseBody(response) {
  return response.json();
}

function boundedResponse(operation, label, milliseconds = 5000) {
  let timer;
  return Promise.race([operation.response, new Promise((_, reject) => {
    timer = setTimeout(() => {
      operation.request.destroy();
      reject(new Error(`Timed out waiting for ${label}`));
    }, milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function boundedWait(promise, label, onTimeout, milliseconds = 5000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`Timed out waiting for ${label}`));
    }, milliseconds);
  })]).finally(() => clearTimeout(timer));
}

async function post(base, event) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${base}/qa/ingest`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), signal: controller.signal });
    return {
      status: response.status,
      async json() { try { return await response.json(); } finally { clearTimeout(timer); } },
      async text() { try { return await response.text(); } finally { clearTimeout(timer); } },
    };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, message, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function makeFixture(t, { windowMs, onAdmitted, beforeSave, afterCommit, instrumentRequests } = {}) {
  mkdirSync(storageParent, { recursive: true });
  const workspace = realpathSync(mkdtempSync(join(storageParent, 'durable-http-admission-')));
  const canonical = workspace;
  assert.ok(inside(realpathSync(storageParent), canonical));
  assert.equal(lstatSync(canonical).isSymbolicLink(), false);
  const directory = join(workspace, 'actions');
  mkdirSync(directory);
  const statePath = join(directory, 'state.json');
  let store = new JsonActionStore(directory, { timing: true });
  let admission;
  let observedRequests = 0;
  const observed = deferred();
  const handlerTasks = new Set();
  let verified = false;
  admission = createDurableHttpAdmission({ store, version, projectSources, windowMs,
    onAdmitted, beforeSave, afterCommit });
  const server = createServer((req, res) => {
    instrumentRequests?.(req, res);
    const task = Promise.resolve(admission.handle(req, res));
    handlerTasks.add(task);
    task.catch(() => {}).finally(() => handlerTasks.delete(task));
    observedRequests++;
    observed.resolve(observedRequests);
  });
  server.listen(0, '127.0.0.1');
  const listening = new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const tasksForCleanup = async () => { await Promise.allSettled([...handlerTasks]); };
  const closeServer = async () => {
    if (!server.listening) return true;
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    try {
      await boundedWait(closed, 'HTTP server close', () => server.closeAllConnections(), 2000);
      return true;
    } catch { return false; }
  };
  const closeStore = () => {
    if (!store) return;
    store.close();
    store = null;
  };
  const fixture = {
    workspace, directory, statePath, server, admission,
    get base() { return `http://127.0.0.1:${server.address().port}`; },
    get store() { return store; },
    get observedRequests() { return observedRequests; },
    async waitForRequests(count) {
      await until(() => observedRequests >= count, `Expected ${count} HTTP requests to reach the admission handler`);
    },
    async settleHandlers() {
      await boundedWait(tasksForCleanup(), 'HTTP handlers settle',
        () => server.closeAllConnections(), 2000);
    },
    markVerified() { verified = true; },
    closeStore,
    async reopen() {
      const reopened = new JsonActionStore(directory);
      try { return reopened.load(100); } finally { reopened.close(); }
    },
    closeServer,
  };

  t.after(async () => {
    try { await admission.close(); } catch { /* Preserve test result; fixture stays if ownership is unresolved. */ }
    const serverClosed = await closeServer();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline
      && (handlerTasks.size > 0 || admission.snapshot().inFlight > 0)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const fullySettled = handlerTasks.size === 0 && admission.snapshot().inFlight === 0;
    if (fullySettled) {
      try { closeStore(); } catch { /* Preserve the lock and workspace as evidence. */ }
    }
    if (verified && serverClosed && fullySettled && !existsSync(join(directory, '.writer.lock'))
      && realpathSync(workspace) === canonical && inside(realpathSync(storageParent), canonical)
      && !lstatSync(canonical).isSymbolicLink() && !existsSync(join(directory, '.writer.lock'))) {
      rmSync(canonical, { recursive: true, force: true });
    }
  });

  return { fixture, listening };
}

function beginPartialPost(base, event) {
  const body = JSON.stringify(event);
  const request = httpRequest(`${base}/qa/ingest`, { method: 'POST', headers: {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
  } });
  const response = new Promise((resolve, reject) => {
    request.once('response', resolve);
    request.once('error', reject);
  });
  response.catch(() => {});
  request.on('error', () => {});
  request.write(body.slice(0, Math.max(1, Math.floor(body.length / 3))));
  return { request, response };
}

function beginHeldPost(base, event) {
  const body = JSON.stringify(event);
  const split = Math.max(1, Math.floor(body.length / 3));
  const request = httpRequest(`${base}/qa/ingest`, { method: 'POST', headers: {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
  } });
  const response = new Promise((resolve, reject) => {
    request.once('response', resolve);
    request.once('error', reject);
  });
  response.catch(() => {});
  request.on('error', () => {});
  request.write(body.slice(0, split));
  return { request, response, release() { request.end(body.slice(split)); } };
}

async function postPair(fixture, events, afterFirstRelease) {
  const before = fixture.observedRequests;
  const held = events.map(event => beginHeldPost(fixture.base, event));
  try {
    await fixture.waitForRequests(before + held.length);
    held[0].release();
    if (afterFirstRelease) {
      await boundedWait(afterFirstRelease(), 'first admission before second release',
        () => { for (const operation of held.slice(1)) operation.request.destroy(); });
    }
    for (const operation of held.slice(1)) operation.release();
    const responses = await Promise.all(held.map((operation, index) =>
      boundedResponse(operation, `held request ${index + 1}`)));
    return responses.map(response => ({
      status: response.statusCode,
      json: async () => JSON.parse(await boundedWait(new Promise((resolve, reject) => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.once('error', reject);
      }), 'held response body', () => response.destroy())),
    }));
  } catch (error) {
    for (const operation of held) operation.request.destroy();
    throw error;
  }
}

function beginAbortablePost(base, event) {
  const body = JSON.stringify(event);
  const request = httpRequest(`${base}/qa/ingest`, { method: 'POST', headers: {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
  } });
  const response = new Promise((resolve, reject) => {
    request.once('response', resolve);
    request.once('error', reject);
  });
  request.end(body);
  return { request, response };
}

test('valid concurrent batches commit once and both receive the fixed 202 response', { timeout: 15000 }, async (t) => {
  const { fixture, listening } = makeFixture(t, { windowMs: 50 });
  await listening;
  const first = batch('1'.repeat(32), [span('1'.repeat(16))]);
  const second = batch('2'.repeat(32), [span('2'.repeat(16))]);
  const responses = await postPair(fixture, [first, second]);

  assert.deepEqual(responses.map(response => response.status), [202, 202]);
  assert.deepEqual(await Promise.all(responses.map(responseBody)), [{ accepted: true }, { accepted: true }]);
  assert.equal(fixture.store.timingHealth().saves, 1);
  const actions = fixture.store.load(100);
  assert.equal(actions.length, 2);
  assert.deepEqual(new Set(actions.map(action => action.trace.traceId)), new Set(['1'.repeat(32), '2'.repeat(32)]));
  assert.equal(fixture.admission.snapshot().groupsCommitted, 1);
  assert.equal(fixture.admission.snapshot().uncertainAfterCommit, 0);
  fixture.markVerified();
});

test('two partial request bodies occupy both slots and the third request receives fixed 503', { timeout: 15000 }, async (t) => {
  const { fixture, listening } = makeFixture(t, { windowMs: 50 });
  await listening;
  const first = beginPartialPost(fixture.base, batch('3'.repeat(32), [span('3'.repeat(16))]));
  const second = beginPartialPost(fixture.base, batch('4'.repeat(32), [span('4'.repeat(16))]));
  await fixture.waitForRequests(2);

  const busy = await post(fixture.base, batch('5'.repeat(32), [span('5'.repeat(16))]));
  assert.equal(busy.status, 503);
  assert.deepEqual(await responseBody(busy), { error: 'QA admission unavailable' });
  assert.equal(fixture.admission.snapshot().active, 2);
  assert.equal(fixture.store.timingHealth().saves, 0);

  first.request.destroy();
  second.request.destroy();
  await fixture.settleHandlers();
  fixture.markVerified();
});

test('closing during an incomplete body returns fixed 503 and prevents a later save', { timeout: 15000 }, async (t) => {
  const { fixture, listening } = makeFixture(t, { windowMs: 50 });
  await listening;
  const partial = beginHeldPost(fixture.base, batch('a'.repeat(32), [span('a'.repeat(16))]));
  await fixture.waitForRequests(1);

  await fixture.admission.close();
  partial.release();
  const response = await boundedResponse(partial, 'closing incomplete body');
  assert.equal(response.statusCode, 503);
  const chunks = [];
  await boundedWait((async () => {
    for await (const chunk of response) chunks.push(chunk);
  })(), 'incomplete-body 503 response body', () => {
    response.destroy();
    partial.request.destroy();
  });
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), { error: 'QA admission unavailable' });
  partial.request.destroy();
  await fixture.settleHandlers();
  assert.equal(fixture.store.timingHealth().saves, 0);
  assert.equal(fixture.store.load(100).length, 0);
  assert.equal(fixture.admission.snapshot().closing, true);
  fixture.markVerified();
});

test('a semantically invalid member rejects both admitted requests without saving either', { timeout: 15000 }, async (t) => {
  const { fixture, listening } = makeFixture(t, { windowMs: 50 });
  await listening;
  const valid = batch('6'.repeat(32), [span('6'.repeat(16))]);
  const invalid = batch('7'.repeat(32), [span('7'.repeat(16), null, { method: 'INVALID' })]);
  const responses = await postPair(fixture, [valid, invalid]);

  assert.deepEqual(responses.map(response => response.status), [400, 400]);
  assert.deepEqual(await Promise.all(responses.map(responseBody)), [
    { error: 'Invalid QA batch' }, { error: 'Invalid QA batch' },
  ]);
  assert.equal(fixture.store.timingHealth().saves, 0);
  assert.deepEqual(fixture.store.load(100), []);
  assert.equal(fixture.admission.snapshot().rejected, 2);
  fixture.markVerified();
});

test('closing a pending single batch rejects it without a durability attempt', { timeout: 15000 }, async (t) => {
  const admitted = deferred();
  let hookMetadata;
  const { fixture, listening } = makeFixture(t, { windowMs: 50,
    onAdmitted(metadata) { hookMetadata = metadata; admitted.resolve(); } });
  await listening;
  const pendingResponse = post(fixture.base, batch('8'.repeat(32), [span('8'.repeat(16))]));
  await boundedWait(admitted.promise, 'pending request admission');
  assert.deepEqual(Object.keys(hookMetadata).sort(), ['groupSize', 'inFlight', 'pending']);
  assert.equal(hookMetadata.groupSize, 1);
  assert.equal(hookMetadata.pending, 1);

  await fixture.admission.close();
  const response = await pendingResponse;
  assert.equal(response.status, 503);
  assert.deepEqual(await responseBody(response), { error: 'QA admission unavailable' });
  assert.equal(fixture.store.timingHealth().saves, 0);
  assert.equal(fixture.admission.snapshot().closing, true);
  fixture.markVerified();
});

test('closing during a held pre-save gate rejects the pair without a late commit', { timeout: 15000 }, async (t) => {
  const gateEntered = deferred();
  const releaseSave = deferred();
  const { fixture, listening } = makeFixture(t, { windowMs: 50,
    beforeSave() { gateEntered.resolve(); return releaseSave.promise; } });
  await listening;
  const pair = postPair(fixture, [
    batch('8'.repeat(32), [span('8'.repeat(16))]),
    batch('9'.repeat(32), [span('9'.repeat(16))]),
  ]);
  try {
    await boundedWait(gateEntered.promise, 'pre-save gate', () => releaseSave.resolve());
    await fixture.admission.close();
    releaseSave.resolve();
    const responses = await pair;
    assert.deepEqual(responses.map(response => response.status), [503, 503]);
    assert.deepEqual(await Promise.all(responses.map(responseBody)), [
      { error: 'QA admission unavailable' }, { error: 'QA admission unavailable' },
    ]);
    assert.equal(fixture.store.timingHealth().saves, 0);
    assert.equal(fixture.admission.snapshot().saveAttempts, 0);
    await boundedWait(until(() => fixture.admission.snapshot().inFlight === 0,
      'the closed pre-save group settles'), 'pre-save group settlement',
    () => fixture.server.closeAllConnections());
    fixture.closeStore();
    assert.deepEqual(await fixture.reopen(), []);
  } finally {
    releaseSave.resolve();
  }
  fixture.markVerified();
});

test('oversized bodies are bounded and return no body data', { timeout: 15000 }, async (t) => {
  const { fixture, listening } = makeFixture(t);
  await listening;
  const canary = 'QA_BODY_CANARY_DO_NOT_ECHO';
  const oversized = { ...batch('9'.repeat(32), [span('9'.repeat(16))]), extra: canary.repeat(900) };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 16 * 1024);
  const response = await post(fixture.base, oversized);
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.equal(body, JSON.stringify({ error: 'Invalid QA batch' }));
  assert.equal(body.includes(canary), false);
  assert.equal(JSON.stringify(fixture.admission.snapshot()).includes(canary), false);
  assert.equal(fixture.store.timingHealth().saves, 0);
  fixture.markVerified();
});

test('a conflicting trace update rejects the whole pair and leaves the committed graph unchanged', { timeout: 15000 }, async (t) => {
  const firstMutationAdmitted = deferred();
  let observePair = false;
  const { fixture, listening } = makeFixture(t, { windowMs: 50,
    onAdmitted() { if (observePair) firstMutationAdmitted.resolve(); } });
  await listening;
  const traceId = 'a'.repeat(32), rootId = 'a'.repeat(16), childId = 'b'.repeat(16);
  const initial = await post(fixture.base, batch(traceId, [span(rootId)]));
  assert.equal(initial.status, 202);
  assert.deepEqual(await responseBody(initial), { accepted: true });
  const savedBytes = readFileSync(fixture.statePath, 'utf8');
  const before = fixture.store.load(100);

  const childUpdate = batch(traceId, [span(childId, rootId)]);
  const conflictingRoot = batch(traceId, [span(rootId, null, { httpStatus: 503, error: true })]);
  observePair = true;
  const responses = await postPair(fixture, [childUpdate, conflictingRoot], () => firstMutationAdmitted.promise);
  assert.deepEqual(responses.map(response => response.status), [400, 400]);
  assert.deepEqual(await Promise.all(responses.map(responseBody)), [
    { error: 'Invalid QA batch' }, { error: 'Invalid QA batch' },
  ]);
  assert.equal(readFileSync(fixture.statePath, 'utf8'), savedBytes);
  assert.deepEqual(fixture.store.load(100), before);
  assert.equal(fixture.store.load(100)[0].trace.spans.some(value => value.spanId === childId), false);
  assert.equal(fixture.admission.snapshot().rejected, 2);
  const duplicate = await post(fixture.base, batch(traceId, [span(rootId)]));
  assert.equal(duplicate.status, 202);
  assert.deepEqual(await responseBody(duplicate), { accepted: true });
  assert.equal(fixture.store.load(100)[0].trace.spans.some(value => value.spanId === childId), false);
  fixture.markVerified();
});

test('a real rename obstruction returns fixed 503 to both and preserves exact reloadable state', { timeout: 15000 }, async (t) => {
  const beforeSaveReached = deferred();
  const releaseSave = deferred();
  let blockWrites = false;
  const { fixture, listening } = makeFixture(t, { windowMs: 50,
    beforeSave() {
      if (!blockWrites) return;
      beforeSaveReached.resolve();
      return releaseSave.promise;
    } });
  await listening;
  const baseline = await postPair(fixture, [
    batch('d'.repeat(32), [span('d'.repeat(16))]),
    batch('e'.repeat(32), [span('e'.repeat(16))]),
  ]);
  assert.deepEqual(baseline.map(response => response.status), [202, 202]);
  await Promise.all(baseline.map(responseBody));
  const state = fixture.statePath;
  const backup = join(fixture.directory, 'preserved-state.json');
  const beforeBytes = readFileSync(state, 'utf8');
  const beforeActions = fixture.store.load(100);
  blockWrites = true;
  renameSync(state, backup);
  mkdirSync(state);

  try {
    const rejectedResponses = postPair(fixture, [
      batch('f'.repeat(32), [span('f'.repeat(16))]),
      batch('1'.repeat(32), [span('2'.repeat(16))]),
    ]);
    await boundedWait(beforeSaveReached.promise, 'storage save gate', () => releaseSave.resolve());
    releaseSave.resolve();
    const responses = await rejectedResponses;
    assert.deepEqual(responses.map(response => response.status), [503, 503]);
    assert.deepEqual(await Promise.all(responses.map(responseBody)), [
      { error: 'QA admission unavailable' }, { error: 'QA admission unavailable' },
    ]);
    assert.equal(fixture.store.timingHealth().failures, 1);
    assert.equal(JSON.stringify(fixture.admission.snapshot()).includes(fixture.workspace), false);
    assert.equal(readFileSync(backup, 'utf8'), beforeBytes);
  } finally {
    releaseSave.resolve();
    if (existsSync(state)) rmdirSync(state);
    if (existsSync(backup)) renameSync(backup, state);
  }

  assert.equal(readFileSync(state, 'utf8'), beforeBytes);
  fixture.closeStore();
  assert.deepEqual(await fixture.reopen(), beforeActions);
  fixture.markVerified();
});

test('client close after durable commit is classified as an uncertain acknowledgement', { timeout: 15000 }, async (t) => {
  const commitReached = deferred();
  const releaseAfterCommit = deferred();
  const serverResponseClosed = deferred();
  let responseFinished = false;
  let serverCloseObserved = false;
  const { fixture, listening } = makeFixture(t, { windowMs: 20,
    afterCommit() { commitReached.resolve(); return releaseAfterCommit.promise; },
    instrumentRequests(_request, response) {
      if (fixture.observedRequests !== 0) return;
      response.once('finish', () => { responseFinished = true; });
      response.once('close', () => { serverCloseObserved = true; serverResponseClosed.resolve(); });
    } });
  await listening;
  const operation = beginAbortablePost(fixture.base, batch('2'.repeat(32), [span('3'.repeat(16))]));
  operation.response.catch(() => {});
  try {
    await boundedWait(commitReached.promise, 'after-commit gate', () => releaseAfterCommit.resolve());
    assert.equal(fixture.store.load(100).length, 1, 'the graph is durable before the client disconnects');

    operation.request.destroy();
    await boundedWait(serverResponseClosed.promise, 'server response close',
      () => operation.request.destroy());
    const whileUncertain = await post(fixture.base, batch('4'.repeat(32), [span('4'.repeat(16))]));
    assert.equal(whileUncertain.status, 503);
    assert.deepEqual(await responseBody(whileUncertain), { error: 'QA admission unavailable' });
    assert.equal(fixture.store.timingHealth().saves, 1);
  } finally {
    releaseAfterCommit.resolve();
    operation.request.destroy();
  }
  await fixture.settleHandlers();

  assert.equal(serverCloseObserved, true);
  assert.equal(responseFinished, false);
  assert.equal(fixture.admission.snapshot().uncertainAfterCommit, 1);
  assert.equal(fixture.store.load(100).length, 1);
  assert.equal(JSON.stringify(fixture.admission.snapshot()).includes('2'.repeat(32)), false);
  fixture.markVerified();
});
