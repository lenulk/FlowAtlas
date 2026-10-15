// QA-only production collector in a process separate from the HTTP workload driver.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { startServers } from '../src/server.mjs';
import { JsonActionStore } from '../src/action-store.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
let servers = null;
let started = false;
let stopping = false;
let closed = false;

function send(value) {
  if (process.connected) process.send(value, () => {});
}

async function start(message) {
  if (started || !message || message.kind !== 'start' || !validToken(message.sessionToken)
    || message.projectId !== 'sdk-durable-qa' || !/^[a-f0-9]{64}$/.test(message.codeDigest ?? '')
    || typeof message.workspace !== 'string') throw new Error('invalid_start');
  started = true;
  const directory = join(message.workspace, 'data/actions');
  servers = await startServers({ port: 0, inventoryPort: 0, dataDir: 'data/actions', workspace: message.workspace,
    sessionToken: message.sessionToken, traceTiming: true,
    projects: [{ id: 'sdk-durable-qa', root: 'app', files: ['server.mjs'] }], onStorageError: () => {} });
  if (servers.atlas.projectSources.version('sdk-durable-qa').digest !== message.codeDigest)
    throw new Error('source_mismatch');
  const store = servers.atlas.store;
  const save = store.save.bind(store);
  const accepted = new Set();
  let lastSaved = [];
  let observerFailure = false;
  store.save = function (actions) {
    const value = save(actions);
    try {
      for (const graph of actions) {
        const id = graph?.trace?.traceId;
        if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) observerFailure = true;
        else accepted.add(id);
      }
      lastSaved = actions;
    } catch { observerFailure = true; }
    return value;
  };
  let responses202 = 0;
  servers.app.on('request', (_request, response) => response.once('finish', () => {
    if (response.statusCode === 202) responses202++;
  }));
  send({ kind: 'ready', port: servers.port, codeDigest: message.codeDigest });

  process.on('message', async (next) => {
    if (next?.kind !== 'stop' || stopping) return;
    stopping = true;
    try {
      await servers.close();
      const savedDigest = digest(JSON.stringify(lastSaved));
      const reopened = new JsonActionStore(directory);
      let graphs;
      try { graphs = reopened.load(100); } finally { reopened.close(); }
      const reloadVerified = digest(JSON.stringify(graphs)) === savedDigest
        && graphs.every(graph => graph?.trace?.spans?.length === 1
          && graph.trace.spans[0].httpStatus === 200 && graph.outcome === 'success');
      const timing = store.timingHealth();
      closed = true;
      await new Promise(resolve => process.send({ kind: 'stopped', acceptedUnique: accepted.size, observerFailure, responses202,
        retainedActions: graphs.length, reloadVerified, savedDigest,
        reloadedDigest: digest(JSON.stringify(graphs)),
        storageTiming: { saves: timing.saves, failures: timing.failures, syncMs: timing.syncMs },
        closed: true }, resolve));
      process.disconnect();
    } catch {
      send({ kind: 'error', code: 'stop_failed' });
      process.disconnect();
      process.exitCode = 1;
    }
  });
}

process.once('message', message => {
  void start(message).catch(async () => {
    try { await servers?.close(); } catch {}
    send({ kind: 'error', code: 'setup_failed' });
    process.disconnect();
    process.exitCode = 1;
  });
});
process.once('disconnect', () => {
  if (closed) return;
  try { servers?.app.closeAllConnections(); servers?.inventory.closeAllConnections(); } catch {}
  if (servers) void servers.close().catch(() => {}).finally(() => { process.exitCode = 1; });
});
