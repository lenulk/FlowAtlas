const statusForType = Object.freeze({
  'client-report-and-http-inbound': 'observed',
  'instrumented-handler-entry': 'observed',
  'http-outbound': 'observed',
  'source-route-match': 'inferred',
  'coverage-gap': 'unknown',
});

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

function isTime(value) {
  return isText(value) && !Number.isNaN(Date.parse(value));
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

export function validateEdge(action, edge) {
  const issues = [];
  const label = `edge ${edge?.id ?? '?'}`;
  const nodes = Array.isArray(action?.nodes) ? action.nodes.filter((node) => node && typeof node === 'object') : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (!isText(edge?.from) || !isText(edge?.to) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
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
    if (nodes.find((node) => node.id === edge.from)?.origin !== 'client-reported') {
      issues.push(`${label}: no client-reported action exists`);
    }
    if (evidence.correlationId !== action.id || !isText(evidence.method) || !isText(evidence.path)) {
      issues.push(`${label}: correlation or HTTP request data is missing`);
    }
    const target = nodes.find((node) => node.id === edge.to);
    if (target?.type !== 'api' || target.label !== `${evidence.method} ${evidence.path}`) {
      issues.push(`${label}: HTTP evidence does not match the API node`);
    }
  } else if (evidence.type === 'instrumented-handler-entry') {
    if (!isText(evidence.symbol)) issues.push(`${label}: handler symbol is missing`);
    issues.push(...validateSource(evidence.sourceDeclaration, action.codeVersion, label));
    const target = nodes.find((node) => node.id === edge.to);
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
    const target = nodes.find((node) => node.id === edge.to);
    if (edge.to !== requestId || target?.type !== 'external-request'
      || (evidence.destination !== undefined && (!isText(evidence.destination) || target.destination !== evidence.destination))) {
      issues.push(`${label}: outbound evidence does not match the request node`);
    }
  } else if (evidence.type === 'source-route-match') {
    if (!isText(evidence.reason)) issues.push(`${label}: inference reason is missing`);
    issues.push(...validateSource(evidence.source, action.codeVersion, label));
    const target = nodes.find((node) => node.id === edge.to);
    if (target?.source?.file !== evidence.source?.file || target.source?.sha256 !== evidence.source?.sha256) {
      issues.push(`${label}: inferred source does not match the target node`);
    }
  } else if (evidence.type === 'coverage-gap' && !isText(evidence.reason)) {
    issues.push(`${label}: coverage gap reason is missing`);
  }
  return issues;
}

export function validateGraph(graph) {
  const issues = [];
  if (graph?.schemaVersion !== '0.1') issues.push('unsupported schema version');
  if (!isText(graph?.id) || !isText(graph?.name) || !isTime(graph?.startedAt)) {
    issues.push('action identity or start time is missing');
  }
  if (!['running', 'success', 'error'].includes(graph?.outcome)) issues.push('invalid action outcome');
  if (graph?.finishedAt !== null && !isTime(graph?.finishedAt)) issues.push('invalid finish time');
  if (!/^[a-f0-9]{64}$/.test(graph?.codeVersion?.digest ?? '')) issues.push('invalid code digest');
  if (!graph?.codeVersion?.files || typeof graph.codeVersion.files !== 'object') issues.push('code file hashes are missing');
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
    issues.push('nodes or edges are missing');
    return issues;
  }
  const nodeIds = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) { issues.push('invalid node'); continue; }
    if (!isText(node.id) || !isText(node.type) || !isText(node.label)) issues.push('invalid node');
    if (nodeIds.has(node.id)) issues.push(`duplicate node ${node.id}`);
    nodeIds.add(node.id);
    if (node.source) issues.push(...validateSource(node.source, graph.codeVersion, `node ${node.id}`));
  }
  const edgeIds = new Set();
  for (const edge of graph.edges) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) { issues.push('invalid edge'); continue; }
    if (!isText(edge.id) || edgeIds.has(edge.id)) issues.push(`duplicate or missing edge ID ${edge.id}`);
    edgeIds.add(edge.id);
    issues.push(...validateEdge(graph, edge));
  }
  return issues;
}
