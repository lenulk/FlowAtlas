import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { FlowAtlas, getCodeVersion, sourceRef } from './flowatlas.mjs';
import { getProduct } from './catalog.mjs';
import { createInventoryService } from './inventory-service.mjs';
import { validateGraph } from './evidence-contract.mjs';
import { ingestEvent } from './ingest.mjs';
import { JsonActionStore, storageErrorDiagnostic } from './action-store.mjs';
import { ProjectSources, readProjectConfig } from './project-sources.mjs';
import { resolveWorkspace, resolveDataDirectory } from './workspace.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const staticFiles = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
]);

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const part of request) {
    bytes += part.length;
    if (bytes > 16_384) throw new Error('Request body is too large');
    chunks.push(part);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const value = text ? JSON.parse(text) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON object');
  return value;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function checkStock(inventoryUrl, actionId) {
  return fetch(`${inventoryUrl}/inventory/check`, {
    method: 'GET', headers: { 'x-flowatlas-action-id': actionId },
  });
}

function placeOrder(inventoryUrl, actionId) {
  return fetch(`${inventoryUrl}/inventory/reserve`, {
    method: 'POST', headers: { 'x-flowatlas-action-id': actionId },
  });
}

export async function startServers({ port = 4173, inventoryPort = 4174, dataDir = null, actionLimit = 100, projects = [], workspace,
  onStorageError = (diagnostic) => console.error(`FlowAtlas storage: ${JSON.stringify(diagnostic)}`) } = {}) {
  const reportStorageError = (error) => {
    if (error.code !== 'FLOWATLAS_STORAGE_ERROR') return;
    try { onStorageError(storageErrorDiagnostic(error)); }
    catch { /* A diagnostic sink must not change the request result or storage cleanup. */ }
  };
  const version = getCodeVersion(root);
  const workspaceRoot = resolveWorkspace(root, workspace);
  const projectSources = new ProjectSources(workspaceRoot, projects);
  let store = null;
  let atlas;
  try {
    if (dataDir !== null) {
      const directory = resolveDataDirectory(workspaceRoot, dataDir);
      store = new JsonActionStore(directory);
    }
    atlas = new FlowAtlas(version, actionLimit, store, projectSources);
  } catch (error) { reportStorageError(error); store?.close(); throw error; }
  const inventory = createInventoryService();
  let actualInventoryPort;
  try { actualInventoryPort = await listen(inventory, inventoryPort); }
  catch (error) { store?.close(); throw error; }
  const inventoryUrl = `http://127.0.0.1:${actualInventoryPort}`;

  const app = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let currentActionId = null;
    try {
      if (request.method === 'POST' && url.pathname === '/flowatlas/ingest') {
        try {
          const result = ingestEvent(atlas, await readJson(request));
          sendJson(response, 202, result);
        } catch (error) {
          reportStorageError(error);
          sendJson(response, error.code === 'FLOWATLAS_STORAGE_ERROR' ? 503
            : error.code === 'FLOWATLAS_SNAPSHOT_MISMATCH' || error.message === 'Action ID already exists' ? 409
            : error.message === 'Graph capacity exceeded' ? 413 : 400, { error: error.message });
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/flowatlas/status') {
        sendJson(response, 200, { storage: store ? 'disk' : 'memory', actionLimit: atlas.limit, retainedActions: atlas.actions.size });
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/flowatlas/projects/')) {
        const registered = projectSources.version(decodeURIComponent(url.pathname.slice('/flowatlas/projects/'.length)));
        sendJson(response, registered ? 200 : 404, registered ?? { error: 'Project is not registered' });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/flowatlas/action-start') {
        const body = await readJson(request);
        if (typeof body.id !== 'string' || !['view-product', 'check-stock', 'place-order'].includes(body.name)) {
          sendJson(response, 400, { error: 'Invalid action' });
          return;
        }
        atlas.start(body.id, body.name, body.clientTime ?? null);
        sendJson(response, 201, { id: body.id });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/flowatlas/actions') {
        const query = url.searchParams.get('q') ?? '';
        const outcome = url.searchParams.get('outcome') || null;
        const limitText = url.searchParams.get('limit');
        const limit = limitText === null ? atlas.limit : Number(limitText);
        if (query.length > 200 || (outcome && !['running', 'success', 'error'].includes(outcome))
          || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          sendJson(response, 400, { error: 'Invalid history filter' });
          return;
        }
        sendJson(response, 200, atlas.list({ query, outcome, limit }));
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/flowatlas/actions/')) {
        const action = atlas.get(decodeURIComponent(url.pathname.slice('/flowatlas/actions/'.length)));
        if (!action) {
          sendJson(response, 404, { error: 'Action not found' });
          return;
        }
        const issues = validateGraph(action);
        sendJson(response, issues.length ? 500 : 200,
          issues.length ? { error: 'Invalid evidence graph', issues } : action);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/flowatlas/source') {
        const file = url.searchParams.get('file');
        const expectedHash = url.searchParams.get('sha256');
        const sourceActionId = url.searchParams.get('actionId');
        const snapshot = sourceActionId ? atlas.get(sourceActionId)?.codeVersion : version;
        if (!file || !snapshot || !Object.hasOwn(snapshot.files, file) || snapshot.files[file] !== expectedHash) {
          sendJson(response, 404, { error: 'Source is not in this code snapshot' });
          return;
        }
        let content;
        try {
          content = snapshot.projectId ? projectSources.read(snapshot, file) : readFileSync(join(root, file));
        } catch (error) {
          if (!snapshot.projectId && error.code !== 'ENOENT') throw error;
          sendJson(response, 409, { error: 'Source is unavailable for the captured code snapshot' });
          return;
        }
        if (createHash('sha256').update(content).digest('hex') !== expectedHash) {
          sendJson(response, 409, { error: 'Source differs from the captured code snapshot' });
          return;
        }
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end(content);
        return;
      }

      if (request.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        response.end(readFileSync(join(root, file)));
        return;
      }

      const apiRoutes = new Map([
        ['GET /api/product', { name: 'view-product', symbol: 'getProduct', file: 'src/catalog.mjs' }],
        ['POST /api/check-stock', { name: 'check-stock', symbol: 'checkStock', file: 'src/server.mjs' }],
        ['POST /api/place-order', { name: 'place-order', symbol: 'placeOrder', file: 'src/server.mjs' }],
      ]);
      const route = apiRoutes.get(`${request.method} ${url.pathname}`);
      if (!route) {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }

      const suppliedId = request.headers['x-flowatlas-action-id'];
      const actionId = typeof suppliedId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(suppliedId) ? suppliedId : randomUUID();
      currentActionId = actionId;
      const wasRegistered = atlas.get(actionId)?.nodes[0]?.origin === 'client-reported';
      const action = atlas.ensure(actionId, route.name);
      response.setHeader('x-flowatlas-action-id', actionId);
      const apiNode = `api:${request.method}:${url.pathname}`;
      const codeNode = `code:${route.symbol}`;
      atlas.node(action, { id: apiNode, type: 'api', label: `${request.method} ${url.pathname}` });
      atlas.node(action, { id: codeNode, type: 'code', label: route.symbol, source: sourceRef(version, route.file, route.symbol) });
      atlas.edge(action, 'action', apiNode, wasRegistered ? 'observed' : 'unknown',
        wasRegistered ? {
          type: 'client-report-and-http-inbound', method: request.method, path: url.pathname,
          correlationId: actionId,
        } : {
          type: 'coverage-gap', reason: 'No browser action-start event was received for this API request.',
          method: request.method, path: url.pathname, correlationId: actionId,
        });
      atlas.edge(action, apiNode, codeNode, 'observed', {
        type: 'instrumented-handler-entry', symbol: route.symbol,
        sourceDeclaration: sourceRef(version, route.file, route.symbol),
      });

      if (route.name === 'view-product') {
        const result = getProduct();
        atlas.finish(actionId, 'success');
        sendJson(response, 200, result);
        return;
      }

      const method = route.name === 'check-stock' ? 'GET' : 'POST';
      const externalPath = route.name === 'check-stock' ? '/inventory/check' : '/inventory/reserve';
      const externalNode = `http:${method}:${externalPath}`;
      const routeNode = `external-route:${method}:${externalPath}`;
      const unknownNode = `unknown:${externalPath}`;
      atlas.node(action, { id: externalNode, type: 'external-request', label: `${method} inventory service ${externalPath}` });
      const started = performance.now();
      const outboundEdge = atlas.edge(action, codeNode, externalNode, 'observed', {
        type: 'http-outbound', method, path: externalPath,
        correlationId: actionId, outcome: 'attempted',
      });
      let externalResponse;
      try {
        externalResponse = route.name === 'check-stock'
          ? await checkStock(inventoryUrl, actionId)
          : await placeOrder(inventoryUrl, actionId);
      } catch (error) {
        outboundEdge.evidence.durationMs = Math.round(performance.now() - started);
        outboundEdge.evidence.outcome = 'failed';
        outboundEdge.evidence.error = error.message;
        throw error;
      }
      const result = await externalResponse.json();
      outboundEdge.evidence.status = externalResponse.status;
      outboundEdge.evidence.durationMs = Math.round(performance.now() - started);
      outboundEdge.evidence.outcome = 'completed';
      atlas.node(action, {
        id: routeNode, type: 'code', label: `inventory service ${externalPath}`,
        source: sourceRef(version, 'src/inventory-service.mjs', 'createInventoryService'),
      });
      atlas.node(action, { id: unknownNode, type: 'unknown', label: 'Untraced internal work' });
      atlas.edge(action, externalNode, routeNode, 'inferred', {
        type: 'source-route-match', reason: 'Matched the request path to the mock service route in source code.',
        source: sourceRef(version, 'src/inventory-service.mjs', 'createInventoryService'),
      });
      atlas.edge(action, routeNode, unknownNode, 'unknown', {
        type: 'coverage-gap', reason: 'The mock service has no internal spans for this request.',
      });
      atlas.finish(actionId, externalResponse.ok ? 'success' : 'error');
      sendJson(response, externalResponse.status, result);
    } catch (error) {
      if (currentActionId && !['FLOWATLAS_STORAGE_ERROR', 'FLOWATLAS_SNAPSHOT_MISMATCH'].includes(error.code)) {
        try { atlas.finish(currentActionId, 'error'); } catch (failure) { error = failure; }
      }
      const status = error.code === 'FLOWATLAS_STORAGE_ERROR' ? 503
        : error.code === 'FLOWATLAS_SNAPSHOT_MISMATCH' || error.message === 'Action ID already exists' ? 409
        : error.message === 'Graph capacity exceeded' ? 413
        : ['Invalid action ID', 'Invalid action name', 'Invalid client time', 'Invalid JSON object', 'Request body is too large'].includes(error.message)
          || error instanceof SyntaxError ? 400 : 500;
      reportStorageError(error);
      sendJson(response, status, { error: error.message });
    }
  });

  try {
    const actualPort = await listen(app, port);
    let closing;
    return {
      app, inventory, atlas, port: actualPort, inventoryPort: actualInventoryPort,
      async close() {
        closing ??= (async () => {
          try { await Promise.all([app, inventory].map((server) => new Promise((resolve) => server.close(resolve)))); }
          finally { store?.close(); }
        })();
        return closing;
      },
    };
  } catch (error) {
    await new Promise((resolve) => inventory.close(resolve));
    store?.close();
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const servers = await startServers({
    port: Number(process.env.PORT ?? 4173),
    inventoryPort: Number(process.env.INVENTORY_PORT ?? 4174),
    dataDir: process.env.FLOWATLAS_MEMORY_ONLY === '1' ? null : process.env.FLOWATLAS_DATA_DIR ?? 'data/actions',
    projects: readProjectConfig(resolveWorkspace(root), process.env.FLOWATLAS_CONFIG ?? 'flowatlas.config.json'),
  });
  console.log(`FlowAtlas MVP: http://127.0.0.1:${servers.port}`);
  const stop = () => servers.close().catch((error) => { console.error(error.message); process.exitCode = 1; });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
