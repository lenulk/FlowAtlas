import { sourceRef } from './flowatlas.mjs';
import { ingestHttpSpans, ingestHttpSpanBatch } from './http-spans.mjs';

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`Invalid ${field}`);
  return value;
}

function traceparent(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value)
    || /^00-0{32}-/.test(value) || /-0{16}-/.test(value)) {
    throw new Error('Invalid traceparent');
  }
  return value;
}

export function ingestEvent(atlas, event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid event');
  if (event.kind === 'otel-spans') return ingestHttpSpans(atlas, event);
  if (event.kind === 'otel-span-batch') return ingestHttpSpanBatch(atlas, event);
  const actionId = requiredText(event.actionId, 'actionId');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(actionId)) throw new Error('Invalid actionId');

  if (event.kind === 'action-start') {
    const name = requiredText(event.name, 'name');
    let version = atlas.version;
    if (event.projectId !== undefined) {
      version = atlas.projectSources?.version(requiredText(event.projectId, 'projectId'));
      if (!version) throw new Error('Project is not registered');
      if (typeof event.codeDigest !== 'string') throw new Error('Project code digest is required');
      if (event.codeDigest !== version.digest) {
        const error = new Error('Project code digest differs from the registered snapshot');
        error.code = 'FLOWATLAS_SNAPSHOT_MISMATCH';
        throw error;
      }
    }
    atlas.start(actionId, name, event.clientTime ?? null, 'client-reported', version);
    return { actionId };
  }

  const original = atlas.get(actionId);
  if (!original) throw new Error('Action has not been started');
  if (event.projectId !== original.codeVersion.projectId) throw new Error('Project identity does not match the action');
  atlas.assertCurrentVersion(original);
  // Validate and build on a copy; rejected events must never partially alter a graph.
  const action = structuredClone(original);

  if (event.kind === 'handler-entry') {
    if (event.name !== action.name) throw new Error('Action name does not match the registered action');
    const service = requiredText(event.service, 'service');
    const method = requiredText(event.method, 'method');
    const path = requiredText(event.path, 'path');
    const symbol = requiredText(event.symbol, 'symbol');
    const file = requiredText(event.file, 'file');
    const context = traceparent(event.traceparent);
    const apiNode = `api:${service}:${method}:${path}`;
    const codeNode = `code:${service}:${symbol}`;
    const source = sourceRef(action.codeVersion, file, symbol);
    atlas.node(action, { id: apiNode, type: 'api', label: `${method} ${path}`, service });
    atlas.node(action, { id: codeNode, type: 'code', label: symbol, service, source });
    const registered = action.nodes[0].origin === 'client-reported';
    atlas.edge(action, 'action', apiNode, registered ? 'observed' : 'unknown', registered ? {
      type: 'client-report-and-http-inbound', method, path, correlationId: actionId,
      service, traceparent: context,
    } : {
      type: 'coverage-gap', reason: 'No client action report was captured for this request.',
    });
    atlas.edge(action, apiNode, codeNode, 'observed', {
      type: 'instrumented-handler-entry', symbol, sourceDeclaration: source,
      service, traceparent: context,
    });
    atlas.commit(original, action);
    return { actionId, apiNode, codeNode };
  }

  if (event.kind === 'outbound-result') {
    const service = requiredText(event.service, 'service');
    const symbol = requiredText(event.symbol, 'symbol');
    const method = requiredText(event.method, 'method');
    const path = requiredText(event.path, 'path');
    const codeNode = `code:${service}:${symbol}`;
    const context = traceparent(event.traceparent);
    const receivedContext = traceparent(event.receivedTraceparent);
    if (receivedContext && receivedContext !== context) throw new Error('Trace context changed in transit');
    if (!action.nodes.some((node) => node.id === codeNode)) throw new Error('Handler entry is missing');
    const handlerContexts = action.edges.filter((edge) => edge.to === codeNode
      && edge.evidence.type === 'instrumented-handler-entry').map((edge) => edge.evidence.traceparent).filter(Boolean);
    if (context && handlerContexts.length && !handlerContexts.some((value) => value.split('-')[1] === context.split('-')[1])) {
      throw new Error('Outbound trace does not match the handler trace');
    }
    if (!['completed', 'failed'].includes(event.outcome)) throw new Error('Invalid outbound outcome');
    if (!Number.isFinite(event.durationMs) || event.durationMs < 0) throw new Error('Invalid outbound duration');
    if (event.outcome === 'completed' && (!Number.isInteger(event.status) || event.status < 100 || event.status > 599)) {
      throw new Error('Invalid HTTP status');
    }
    const destination = event.destination === undefined ? 'external service' : requiredText(event.destination, 'destination');
    const destinationKey = encodeURIComponent(destination);
    const externalNode = `http:${destinationKey}:${method}:${path}`;
    if (Boolean(event.routeFile) !== Boolean(event.routeSymbol)) throw new Error('Incomplete route source');
    const routeSource = event.routeFile ? sourceRef(action.codeVersion,
      requiredText(event.routeFile, 'routeFile'), requiredText(event.routeSymbol, 'routeSymbol')) : null;
    const failure = event.outcome === 'failed' ? requiredText(event.error, 'error') : null;
    atlas.node(action, {
      id: externalNode, type: 'external-request', label: `${method} ${destination} ${path}`, destination,
    });
    const evidence = {
      type: 'http-outbound', method, path, destination, correlationId: actionId,
      outcome: event.outcome, traceparent: context,
      receivedTraceparent: receivedContext,
      durationMs: event.durationMs,
    };
    if (event.outcome === 'completed') evidence.status = event.status;
    if (failure) evidence.error = failure;
    atlas.edge(action, codeNode, externalNode, 'observed', evidence);
    if (event.outcome === 'completed' && routeSource) {
      const routeNode = `external-route:${destinationKey}:${method}:${path}`;
      const gapNode = `unknown:${destinationKey}:${path}`;
      atlas.node(action, { id: routeNode, type: 'code', label: `${destination} ${path}`, source: routeSource });
      atlas.node(action, { id: gapNode, type: 'unknown', label: 'Untraced internal work' });
      atlas.edge(action, externalNode, routeNode, 'inferred', {
        type: 'source-route-match', reason: 'The request path was matched to a declared route in source code.', source: routeSource,
      });
      atlas.edge(action, routeNode, gapNode, 'unknown', {
        type: 'coverage-gap', reason: 'No internal spans were captured from the destination service.',
      });
    } else if (event.outcome === 'completed') {
      const gapNode = `unknown:${destinationKey}:${path}`;
      atlas.node(action, { id: gapNode, type: 'unknown', label: 'Untraced internal work' });
      atlas.edge(action, externalNode, gapNode, 'unknown', {
        type: 'coverage-gap', reason: 'No route source or internal spans were captured from the destination service.',
      });
    }
    atlas.commit(original, action);
    return { actionId, externalNode };
  }

  if (event.kind === 'finish') {
    if (!['success', 'error'].includes(event.outcome)) throw new Error('Invalid outcome');
    atlas.finish(actionId, event.outcome);
    return { actionId };
  }

  throw new Error('Unknown event kind');
}
