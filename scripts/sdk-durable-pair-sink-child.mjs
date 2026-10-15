import { createServer } from 'node:http';

const route = '/flowatlas/ingest';
const bodyLimit = 262_144;
const tracePattern = /^[a-f0-9]{32}$/;
const digestPattern = /^[a-f0-9]{64}$/;

let started = false;
let closing = false;
let parentDisconnected = false;
let sessionToken = null;
let projectId = null;
let codeDigest = null;
let server = null;
let closePromise = null;
const traceIds = new Set();
const counts = { received: 0, unique: 0, invalid: 0, requests: 0, responses202: 0 };

function sendMessage(message, callback) {
  if (typeof process.send !== 'function' || !process.connected) {
    callback?.(new Error('ipc_unavailable'));
    return;
  }
  process.send(message, callback);
}

function disconnect() {
  if (process.connected) process.disconnect();
}

function sendError(code, shouldDisconnect = true) {
  sendMessage({ kind: 'error', code }, () => {
    if (shouldDisconnect) disconnect();
  });
  if (shouldDisconnect && !process.connected) process.exitCode = 1;
}

function validStart(message) {
  return message && typeof message === 'object' && !Array.isArray(message)
    && Object.keys(message).sort().join(',') === 'codeDigest,kind,projectId,sessionToken'
    && message.kind === 'start'
    && message.projectId === 'sdk-durable-qa'
    && typeof message.sessionToken === 'string'
    && message.sessionToken.length >= 1 && message.sessionToken.length <= 512
    && /^[A-Za-z0-9._~-]+$/.test(message.sessionToken)
    && typeof message.codeDigest === 'string' && digestPattern.test(message.codeDigest);
}

function respond(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  let oversized = false;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > bodyLimit) {
      oversized = true;
      chunks.length = 0;
    } else if (!oversized) chunks.push(chunk);
  }
  if (oversized) throw new Error('invalid_batch');
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.kind !== 'otel-span-batch' || value.projectId !== projectId || value.codeDigest !== codeDigest
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 32) {
    throw new Error('invalid_batch');
  }

  const batchIds = [];
  const batchSet = new Set();
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.traceId !== 'string' || !tracePattern.test(item.traceId) || /^0+$/.test(item.traceId)
      || traceIds.has(item.traceId) || batchSet.has(item.traceId)
      || !item.span || typeof item.span !== 'object' || Array.isArray(item.span)
      || item.span.kind !== 'SERVER' || item.span.method !== 'GET' || item.span.httpStatus !== 200) {
      throw new Error('invalid_batch');
    }
    batchSet.add(item.traceId);
    batchIds.push(item.traceId);
  }
  return batchIds;
}

async function handleRequest(request, response) {
  counts.requests++;
  response.once('finish', () => {
    if (response.statusCode === 202) counts.responses202++;
  });
  if (closing || request.method !== 'POST' || request.url !== route) {
    counts.invalid++;
    request.resume();
    respond(response, 400, { error: 'Invalid QA batch' });
    return;
  }
  if (request.headers.authorization !== `Bearer ${sessionToken}`) {
    counts.invalid++;
    request.resume();
    respond(response, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const batchIds = await readJson(request);
    for (const id of batchIds) traceIds.add(id);
    counts.received += batchIds.length;
    counts.unique += batchIds.length;
    respond(response, 202, { accepted: true });
  } catch {
    counts.invalid++;
    respond(response, 400, { error: 'Invalid QA batch' });
  }
}

function closeServer() {
  if (closePromise) return closePromise;
  closing = true;
  closePromise = new Promise((resolve, reject) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  return closePromise;
}

async function stop() {
  if (closing) return;
  try {
    await closeServer();
    const snapshot = { kind: 'stopped', ...counts, closed: true };
    sendMessage(snapshot, () => disconnect());
  } catch {
    sendError('stop_failed');
  }
}

function listen() {
  server = createServer((request, response) => { void handleRequest(request, response); });
  server.once('error', () => {
    sendError('setup_failed');
  });
  server.listen(0, '127.0.0.1', () => {
    if (closing || parentDisconnected) {
      server.closeAllConnections();
      server.close(() => {});
      return;
    }
    const address = server.address();
    if (!address || typeof address === 'string' || !Number.isInteger(address.port)) {
      sendError('setup_failed');
      void closeServer().catch(() => {});
      return;
    }
    sendMessage({ kind: 'ready', port: address.port }, error => {
      if (error) void closeServer().catch(() => {});
    });
  });
}

process.on('message', message => {
  if (!started) {
    started = true;
    if (!validStart(message)) {
      sendError('setup_failed');
      return;
    }
    sessionToken = message.sessionToken;
    projectId = message.projectId;
    codeDigest = message.codeDigest;
    listen();
    return;
  }
  if (message?.kind === 'stop') void stop();
});

process.on('disconnect', () => {
  parentDisconnected = true;
  closing = true;
  if (server?.listening) void closeServer().catch(() => { process.exitCode = 1; });
});
