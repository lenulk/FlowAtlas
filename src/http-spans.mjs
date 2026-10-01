import { createHash, randomUUID } from 'node:crypto';
import { validateGraph } from './evidence-contract.mjs';

import { cleanHttpSpan, validSpanId } from './http-span-contract.mjs';

export function ingestHttpSpans(atlas, event) {
  const { graph, result } = prepareHttpSpans(atlas, event);
  if (graph) atlas.putTraceGraph(graph);
  return result;
}

export function ingestHttpSpanBatch(atlas, event) {
  if (!Array.isArray(event.items) || event.items.length < 1 || event.items.length > 32) throw new Error('Invalid HTTP span batch');
  const groups = new Map();
  for (const item of event.items) {
    if (!item || typeof item !== 'object' || !validSpanId(item.traceId, 32)) throw new Error('Invalid HTTP span batch');
    if (!groups.has(item.traceId)) groups.set(item.traceId, []);
    groups.get(item.traceId).push(item.span);
  }
  // Build every graph before the single durable commit. A bad item cannot partly accept a batch.
  const prepared = [...groups].map(([traceId, spans]) => prepareHttpSpans(atlas,
    { projectId: event.projectId, codeDigest: event.codeDigest, traceId, spans }));
  const graphs = prepared.map((item) => item.graph).filter(Boolean);
  if (graphs.length) atlas.putTraceGraphs(graphs);
  return { actions: prepared.map((item) => item.result) };
}

function prepareHttpSpans(atlas, event) {
  if (typeof event.projectId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(event.projectId)
    || !validSpanId(event.traceId, 32) || !Array.isArray(event.spans) || event.spans.length < 1 || event.spans.length > 32) {
    throw new Error('Invalid HTTP span batch');
  }
  const version = atlas.projectSources?.version(event.projectId);
  if (!version) throw new Error('Project is not registered');
  if (typeof event.codeDigest !== 'string' || event.codeDigest !== version.digest) {
    const error = new Error('Project code digest differs from the registered snapshot');
    error.code = 'FLOWATLAS_SNAPSHOT_MISMATCH'; throw error;
  }
  const actionId = `otel-${createHash('sha256').update(event.projectId).digest('hex').slice(0, 16)}-${event.traceId}`;
  const original = atlas.get(actionId);
  if (original && (original.schemaVersion !== '0.2' || original.codeVersion.projectId !== event.projectId)) throw new Error('Trace identity conflict');
  atlas.assertCurrentVersion(original, version);
  const spans = new Map((original?.trace.spans ?? []).map((span) => [span.spanId, span]));
  let changed = !original;
  for (const input of event.spans) {
    const span = cleanHttpSpan(input); const prior = spans.get(span.spanId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(span)) throw new Error('Conflicting duplicate span');
    if (!prior) { spans.set(span.spanId, span); changed = true; }
  }
  if (spans.size > 48) throw new Error('Graph capacity exceeded');
  // Cycles would claim an impossible ancestry, including batches with mutually referring IDs.
  for (const span of spans.values()) {
    const visited = new Set([span.spanId]); let parent = span.parentSpanId;
    while (parent && spans.has(parent)) {
      if (visited.has(parent)) throw new Error('Cyclic span ancestry');
      visited.add(parent); parent = spans.get(parent).parentSpanId;
    }
  }
  if (!changed) return { graph: null, result: { actionId, duplicate: true } };
  const ordered = [...spans.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.spanId.localeCompare(b.spanId));
  const displayOrder = []; const seen = new Set();
  const visit = (span) => {
    if (seen.has(span.spanId)) return;
    if (spans.has(span.parentSpanId)) visit(spans.get(span.parentSpanId));
    seen.add(span.spanId); displayOrder.push(span);
  };
  ordered.forEach(visit);
  const root = ordered.find((span) => span.kind === 'SERVER' && span.parentSpanId === null);
  const graph = { schemaVersion: '0.2', id: actionId, name: `HTTP ${root?.method ?? 'trace'}`, clientTime: null,
    startedAt: ordered[0].startedAt, finishedAt: root?.endedAt ?? null,
    outcome: root ? root.error || root.httpStatus >= 400 ? 'error' : 'success' : 'running', codeVersion: version,
    trace: { traceId: event.traceId, coverage: 'partial', spans: ordered },
    nodes: [{ id: 'action', type: 'http-trace', label: 'HTTP trace · client action unverified', origin: 'instrumented-http' }], edges: [] };
  for (const span of displayOrder) graph.nodes.push({ id: `span:${span.spanId}`, type: 'http-span', service: event.projectId,
    label: `${span.kind} ${span.method}${span.httpStatus === null ? '' : ` · HTTP ${span.httpStatus}`} · ${span.spanId.slice(-8)}`, span });
  const edge = (from, to, status, evidence) => graph.edges.push({ id: `e${graph.edges.length + 1}`, from, to, status,
    evidence: { ...evidence, id: randomUUID(), recordedAt: new Date().toISOString() } });
  for (const span of ordered) {
    const to = `span:${span.spanId}`;
    if (span.parentSpanId && spans.has(span.parentSpanId)) {
      edge(`span:${span.parentSpanId}`, to, 'observed', { type: 'otel-span-parent', traceId: event.traceId,
        parentSpanId: span.parentSpanId, spanId: span.spanId });
    } else if (span.parentSpanId) {
      const missing = `missing:${span.parentSpanId}`;
      if (!graph.nodes.some((node) => node.id === missing)) {
        graph.nodes.splice(graph.nodes.findIndex((node) => node.id === to), 0, { id: missing, type: 'unknown', label: 'Parent span not captured' });
        edge('action', missing, 'unknown', { type: 'coverage-gap', reason: 'No client action or parent span was captured.' });
      }
      edge(missing, to, 'unknown', { type: 'coverage-gap', reason: 'The child reports a parent ID, but its parent span has not been captured.' });
    } else {
      edge('action', to, 'unknown', { type: 'coverage-gap', reason: 'HTTP runtime span exists; no verified client action report was captured.' });
    }
  }
  graph.nodes.push({ id: 'coverage', type: 'unknown', label: 'Uninstrumented code and services' });
  edge('action', 'coverage', 'unknown', { type: 'coverage-gap', reason: 'HTTP spans do not prove internal functions or complete capture; events can be dropped.' });
  if (graph.nodes.length > 100 || graph.edges.length > 200) throw new Error('Graph capacity exceeded');
  if (validateGraph(graph).length) throw new Error('Invalid normalized HTTP trace graph');
  return { graph, result: { actionId, duplicate: false } };
}
