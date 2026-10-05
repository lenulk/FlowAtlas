import { cleanHttpSpan } from './http-span-contract.mjs';
import { parseEvidenceTime } from './evidence-time.mjs';

const statusForType = Object.freeze({
  'client-report-and-http-inbound': 'observed',
  'instrumented-handler-entry': 'observed',
  'http-outbound': 'observed',
  'source-route-match': 'inferred',
  'coverage-gap': 'unknown',
  'otel-span-parent': 'observed',
});

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

function isTime(value) {
  return isText(value) && !Number.isNaN(parseEvidenceTime(value));
}

function validateSource(source, version, location) {
  const issues = [];
  if (!source || !isText(source.file) || !isText(source.symbol) || source.status !== 'inferred') {
    issues.push(`${location}: invalid source reference`);
  } else if (!/^[a-f0-9]{64}$/.test(source.sha256 ?? '')
    || !Object.hasOwn(version?.files ?? {}, source.file)
    || version.files[source.file] !== source.sha256) {
    issues.push(`${location}: source hash does not match code snapshot`);
  }
  return issues;
}

function indexNodes(nodes) {
  const indexed = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    // Preserve find()'s first-match behavior even in a graph with duplicate IDs.
    if (node && typeof node === 'object' && !indexed.has(node.id)) indexed.set(node.id, node);
  }
  return indexed;
}

export function validateEdge(action, edge) {
  return validateIndexedEdge(action, edge, indexNodes(action?.nodes));
}

function validateIndexedEdge(action, edge, nodes) {
  const issues = [];
  const label = `edge ${edge?.id ?? '?'}`;
  if (!isText(edge?.from) || !isText(edge?.to) || !nodes.has(edge.from) || !nodes.has(edge.to)) {
    issues.push(`${label}: endpoint is missing`);
  }
  const evidence = edge?.evidence;
  if (!evidence || !isText(evidence.id) || !isTime(evidence.recordedAt)) {
    issues.push(`${label}: evidence ID or timestamp is missing`);
    return issues;
  }
  if (statusForType[evidence.type] !== edge.status) {
    issues.push(`${label}: ${evidence.type ?? 'missing evidence type'} cannot support ${edge.status}`);
    return issues;
  }

  if (evidence.type === 'client-report-and-http-inbound') {
    if (nodes.get(edge.from)?.origin !== 'client-reported') {
      issues.push(`${label}: no client-reported action exists`);
    }
    if (evidence.correlationId !== action.id || !isText(evidence.method) || !isText(evidence.path)) {
      issues.push(`${label}: correlation or HTTP request data is missing`);
    }
    const target = nodes.get(edge.to);
    if (target?.type !== 'api' || target.label !== `${evidence.method} ${evidence.path}`) {
      issues.push(`${label}: HTTP evidence does not match the API node`);
    }
  } else if (evidence.type === 'instrumented-handler-entry') {
    if (!isText(evidence.symbol)) issues.push(`${label}: handler symbol is missing`);
    issues.push(...validateSource(evidence.sourceDeclaration, action.codeVersion, label));
    const target = nodes.get(edge.to);
    if (target?.type !== 'code' || target.source?.symbol !== evidence.symbol
      || target.source?.file !== evidence.sourceDeclaration?.file) {
      issues.push(`${label}: handler evidence does not match the code node`);
    }
  } else if (evidence.type === 'http-outbound') {
    if (evidence.correlationId !== action.id || !isText(evidence.method) || !isText(evidence.path)) {
      issues.push(`${label}: correlation or HTTP request data is missing`);
    }
    if (!['attempted', 'completed', 'failed'].includes(evidence.outcome)) {
      issues.push(`${label}: outbound outcome is invalid`);
    }
    if (evidence.outcome === 'completed' && (!Number.isInteger(evidence.status) || evidence.status < 100 || evidence.status > 599)) {
      issues.push(`${label}: completed request has no HTTP status`);
    }
    if (evidence.outcome === 'failed' && !isText(evidence.error)) {
      issues.push(`${label}: failed request has no error`);
    }
    if (evidence.outcome !== 'attempted' && (!Number.isFinite(evidence.durationMs) || evidence.durationMs < 0)) {
      issues.push(`${label}: outbound duration is invalid`);
    }
    const requestId = evidence.destination === undefined ? `http:${evidence.method}:${evidence.path}`
      : `http:${encodeURIComponent(evidence.destination)}:${evidence.method}:${evidence.path}`;
    const target = nodes.get(edge.to);
    if (edge.to !== requestId || target?.type !== 'external-request'
      || (evidence.destination !== undefined && (!isText(evidence.destination) || target.destination !== evidence.destination))) {
      issues.push(`${label}: outbound evidence does not match the request node`);
    }
  } else if (evidence.type === 'source-route-match') {
    if (!isText(evidence.reason)) issues.push(`${label}: inference reason is missing`);
    issues.push(...validateSource(evidence.source, action.codeVersion, label));
    const target = nodes.get(edge.to);
    if (target?.source?.file !== evidence.source?.file || target.source?.sha256 !== evidence.source?.sha256) {
      issues.push(`${label}: inferred source does not match the target node`);
    }
  } else if (evidence.type === 'otel-span-parent') {
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    if (action.schemaVersion !== '0.2' || from?.type !== 'http-span' || to?.type !== 'http-span'
      || !/^[a-f0-9]{32}$/.test(evidence.traceId ?? '') || evidence.traceId !== action.trace?.traceId
      || from.span?.spanId !== evidence.parentSpanId || to.span?.spanId !== evidence.spanId
      || to.span?.parentSpanId !== evidence.parentSpanId) issues.push(`${label}: span ancestry does not match captured spans`);
  } else if (evidence.type === 'coverage-gap' && !isText(evidence.reason)) {
    issues.push(`${label}: coverage gap reason is missing`);
  }
  return issues;
}

export function validateGraph(graph) {
  const issues = [];
  if (!['0.1', '0.2'].includes(graph?.schemaVersion)) issues.push('unsupported schema version');
  if (graph?.schemaVersion === '0.2' && (!/^[a-f0-9]{32}$/.test(graph.trace?.traceId ?? '')
    || graph.trace.coverage !== 'partial' || !Array.isArray(graph.trace.spans)
    || graph.trace.spans.length < 1 || graph.trace.spans.length > 48)) issues.push('invalid HTTP trace metadata');
  if (!isText(graph?.id) || !isText(graph?.name) || !isTime(graph?.startedAt)) {
    issues.push('action identity or start time is missing');
  }
  if (!['running', 'success', 'error'].includes(graph?.outcome)) issues.push('invalid action outcome');
  if (graph?.finishedAt !== null && !isTime(graph?.finishedAt)) issues.push('invalid finish time');
  if (!/^[a-f0-9]{64}$/.test(graph?.codeVersion?.digest ?? '')) issues.push('invalid code digest');
  const projectId = graph?.codeVersion?.projectId;
  if (projectId !== undefined && (typeof projectId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(projectId))) issues.push('invalid project ID');
  if (!graph?.codeVersion?.files || typeof graph.codeVersion.files !== 'object') issues.push('code file hashes are missing');
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
    issues.push('nodes or edges are missing');
    return issues;
  }
  const nodeIds = new Set();
  const traceSpans = new Map();
  if (graph.schemaVersion === '0.2') {
    for (const span of Array.isArray(graph.trace?.spans) ? graph.trace.spans : []) {
      try {
        const clean = cleanHttpSpan(span);
        const inputJson = JSON.stringify(span), cleanJson = JSON.stringify(clean);
        if (inputJson !== cleanJson || traceSpans.has(span.spanId)) issues.push('invalid or duplicate trace span');
        // Reuse only within this call; node input is still serialized independently.
        traceSpans.set(span.spanId, cleanJson);
      } catch { issues.push('invalid trace span'); }
    }
  } else if (graph.trace !== undefined || graph.nodes.some((node) => ['http-span', 'http-trace'].includes(node?.type))) {
    issues.push('HTTP trace nodes require schema 0.2');
  }
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) { issues.push('invalid node'); continue; }
    if (!isText(node.id) || !isText(node.type) || !isText(node.label)) issues.push('invalid node');
    if (nodeIds.has(node.id)) issues.push(`duplicate node ${node.id}`);
    nodeIds.add(node.id);
    if (node.type === 'http-span' && (node.id !== `span:${node.span?.spanId}`
      || JSON.stringify(node.span) !== traceSpans.get(node.span?.spanId))) issues.push('span node does not match trace metadata');
    if (node.source) issues.push(...validateSource(node.source, graph.codeVersion, `node ${node.id}`));
  }
  if (graph.schemaVersion === '0.2' && (graph.nodes.filter((node) => node?.type === 'http-span').length !== traceSpans.size
    || graph.nodes[0]?.type !== 'http-trace')) issues.push('HTTP trace graph has missing span nodes');
  const edgeIds = new Set();
  // One index per validation call; no cached result can outlive graph mutations.
  const indexedNodes = indexNodes(graph.nodes);
  for (const edge of graph.edges) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) { issues.push('invalid edge'); continue; }
    if (!isText(edge.id) || edgeIds.has(edge.id)) issues.push(`duplicate or missing edge ID ${edge.id}`);
    edgeIds.add(edge.id);
    issues.push(...validateIndexedEdge(graph, edge, indexedNodes));
  }
  return issues;
}
