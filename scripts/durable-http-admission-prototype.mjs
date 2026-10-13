// QA-only HTTP admission model. This is not mounted by the product collector.
import { FlowAtlas } from '../src/flowatlas.mjs';
import { ingestHttpSpanBatch } from '../src/http-spans.mjs';

const BODY_LIMIT = 16_384;
const HOOK_LIMIT_MS = 1000;

function send(response, status, value) {
  if (response.destroyed || response.writableEnded) return false;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
  return true;
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  let overlong = false;
  for await (const chunk of request) {
    bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + chunk.length);
    if (bytes > BODY_LIMIT) overlong = true;
    else chunks.push(chunk);
  }
  if (overlong) throw new Error('qa_body_bound');
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'otel-span-batch') {
    throw new Error('qa_body_shape');
  }
  return value;
}

async function boundedHook(hook, view) {
  if (typeof hook !== 'function') return true;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => hook(view)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('qa_hook_timeout')), HOOK_LIMIT_MS); }),
    ]);
    return true;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export function createDurableHttpAdmission({ store, version, projectSources, windowMs = 20,
  onAdmitted, beforeSave, afterCommit } = {}) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function'
    || !version || typeof projectSources?.version !== 'function'
    || !Number.isInteger(windowMs) || windowMs < 0 || windowMs > 50
    || [onAdmitted, beforeSave, afterCommit].some(hook => hook !== undefined && typeof hook !== 'function')) {
    throw new TypeError('Invalid QA admission configuration');
  }

  let committed = new Map(store.load(100).map(action => [action.id, action]));
  let active = 0, pending = [], inFlight = [], timer = null, closing = false;
  const readers = new Set();
  const counters = { admitted: 0, saveAttempts: 0, saveFailures: 0, groupsCommitted: 0,
    serverResponseFinished: 0, uncertainAfterCommit: 0, rejected: 0 };

  const view = groupSize => Object.freeze({ groupSize, pending: pending.length, inFlight: inFlight.length });
  const settle = entry => {
    if (entry.settled) return false;
    entry.settled = true;
    active--;
    return true;
  };
  const respond = (entry, status, value) => {
    if (!settle(entry)) return;
    if (status !== 202) counters.rejected++;
    let sent = false;
    try { sent = send(entry.response, status, value); }
    catch { /* A broken QA response cannot revise a durable commit. */ }
    if (status === 202 && !sent && !entry.uncertainCounted) {
      counters.uncertainAfterCommit++;
      entry.uncertainCounted = true;
    }
  };
  const unavailable = entry => respond(entry, 503, { error: 'QA admission unavailable' });
  const invalid = entry => respond(entry, 400, { error: 'Invalid QA batch' });

  async function flush() {
    if (inFlight.length || !pending.length) return;
    clearTimeout(timer); timer = null;
    const group = pending.splice(0, 2);
    inFlight = group;
    let durable = false;
    try {
      const allowed = await boundedHook(beforeSave, view(group.length));
      if (!allowed || closing || group.some(entry => entry.aborted)) {
        for (const entry of group) unavailable(entry);
        return;
      }
      // The staged Atlas owns deep copies. Its normal validator runs, while its
      // temporary save is a NOOP; the single actual durable save follows both.
      const staged = new FlowAtlas(version, 100,
        { load: () => structuredClone([...committed.values()]), save: () => {} }, projectSources);
      try {
        for (const entry of group) ingestHttpSpanBatch(staged, entry.event);
      } catch {
        for (const entry of group) invalid(entry);
        return;
      }
      counters.saveAttempts++;
      try { store.save([...staged.actions.values()]); }
      catch {
        counters.saveFailures++;
        for (const entry of group) unavailable(entry);
        return;
      }
      committed = staged.actions;
      durable = true;
      counters.groupsCommitted++;
      for (const entry of group) entry.committed = true;
      // A QA hook can arrange a real socket abort between durable save and
      // response. Its failure cannot turn a completed save into a rejection.
      await boundedHook(afterCommit, view(group.length));
      for (const entry of group) respond(entry, 202, { accepted: true });
    } catch {
      // Unexpected QA failures cannot claim rejection for an already durable group.
      for (const entry of group) {
        if (durable) respond(entry, 202, { accepted: true });
        else unavailable(entry);
      }
    } finally {
      inFlight = [];
      if (pending.length && !closing) schedule();
    }
  }

  function schedule() {
    if (closing || inFlight.length || !pending.length) return;
    if (pending.length === 2) {
      clearTimeout(timer); timer = null;
      queueMicrotask(() => { void flush(); });
    } else if (timer === null) timer = setTimeout(() => { timer = null; void flush(); }, windowMs);
  }

  async function handle(request, response) {
    response.once('finish', () => { counters.serverResponseFinished++; });
    if (request.method !== 'POST' || request.url !== '/qa/ingest') {
      send(response, 404, { error: 'QA route unavailable' });
      return;
    }
    // Keep the two-slot bound even if an in-flight peer disconnects after save.
    if (closing || active >= 2 || inFlight.length) {
      counters.rejected++;
      send(response, 503, { error: 'QA admission unavailable' });
      request.resume();
      return;
    }
    active++;
    const entry = { response, event: null, settled: false, aborted: false,
      committed: false, uncertainCounted: false, cancelRead: null };
    readers.add(entry);
    response.once('close', () => {
      if (!response.writableFinished && entry.committed && !entry.uncertainCounted) {
        counters.uncertainAfterCommit++;
        entry.uncertainCounted = true;
      }
      if (response.writableFinished || entry.settled) return;
      entry.aborted = true;
      entry.cancelRead?.();
      readers.delete(entry);
      settle(entry);
      if (!inFlight.includes(entry)) {
        pending = pending.filter(value => value !== entry);
        if (!pending.length) { clearTimeout(timer); timer = null; }
      }
    });
    const cancelled = new Promise(resolve => { entry.cancelRead = () => resolve({ cancelled: true }); });
    const result = await Promise.race([
      readBody(request).then(event => ({ event }), () => ({ invalid: true })), cancelled,
    ]);
    entry.cancelRead = null;
    readers.delete(entry);
    if (result.cancelled || entry.settled) return;
    if (result.invalid) { invalid(entry); return; }
    entry.event = result.event;
    if (closing) { unavailable(entry); return; }
    pending.push(entry);
    counters.admitted++;
    try { onAdmitted?.(view(pending.length)); } catch { /* A QA observer cannot change admission. */ }
    schedule();
  }

  function close() {
    if (closing) return;
    closing = true;
    clearTimeout(timer); timer = null;
    for (const entry of readers) { unavailable(entry); entry.cancelRead?.(); }
    readers.clear();
    const queued = pending; pending = [];
    for (const entry of queued) unavailable(entry);
    // A group paused in beforeSave observes closing before its real save.
  }

  function snapshot() {
    return Object.freeze({ ...counters, pending: pending.length, inFlight: inFlight.length,
      reading: readers.size, active, retainedActions: committed.size, closing });
  }

  return Object.freeze({ handle, close, snapshot });
}
