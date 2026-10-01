import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FlowAtlas } from '../src/flowatlas.mjs';
import { ingestEvent } from '../src/ingest.mjs';
import { validateGraph } from '../src/evidence-contract.mjs';

const files = { 'server.mjs': 'b'.repeat(64) };
const version = { projectId: 'target', files, digest: createHash('sha256').update(`server.mjs\0${files['server.mjs']}`).digest('hex'), commit: null, dirty: null };
const traceId = 'a'.repeat(32);
const rootId = '1'.repeat(16), childId = '2'.repeat(16);
const span = (spanId, parentSpanId = null, extra = {}) => ({ spanId, parentSpanId, kind: 'SERVER', method: 'GET',
  startedAt: '2026-10-01T00:00:00.000Z', endedAt: '2026-10-01T00:00:00.100Z', durationMs: 100, httpStatus: 200, error: false, ...extra });
const make = () => new FlowAtlas(version, 100, null, { version: (project) => project === 'target' ? version : null });
const send = (atlas, spans, extra = {}) => ingestEvent(atlas, { kind: 'otel-spans', projectId: 'target', codeDigest: version.digest, traceId, spans, ...extra });

test('out-of-order HTTP spans resolve parent gaps without claiming a user action or function', () => {
  const atlas = make();
  const result = send(atlas, [span(childId, rootId, { kind: 'CLIENT' })]);
  const graph = atlas.get(result.actionId);
  assert.equal(graph.schemaVersion, '0.2'); assert.equal(graph.outcome, 'running');
  assert.equal(graph.edges.some((edge) => edge.status === 'observed'), false);
  assert.ok(graph.nodes.some((node) => node.id === `missing:${rootId}`));
  send(atlas, [span(rootId)]);
  assert.equal(graph.outcome, 'success'); assert.equal(graph.trace.coverage, 'partial');
  assert.equal(graph.nodes.some((node) => node.type === 'code' || node.type === 'user-action'), false);
  assert.equal(graph.nodes.some((node) => node.id === `missing:${rootId}`), false);
  assert.equal(graph.edges.filter((edge) => edge.status === 'observed').length, 1);
  assert.ok(graph.nodes.findIndex((node) => node.id === `span:${rootId}`) < graph.nodes.findIndex((node) => node.id === `span:${childId}`));
  assert.deepEqual(validateGraph(graph), []);
  const remote = send(atlas, [span(rootId, '3'.repeat(16))], { traceId: 'e'.repeat(32) });
  assert.equal(atlas.get(remote.actionId).outcome, 'running', 'A server with an uncaptured parent cannot prove the trace root outcome');
  assert.equal(atlas.get(remote.actionId).finishedAt, null);
  const tied = send(atlas, [span('0'.repeat(15) + '1', 'f'.repeat(16), { kind: 'CLIENT' }), span('f'.repeat(16))], { traceId: 'f'.repeat(32) });
  const tiedGraph = atlas.get(tied.actionId);
  assert.ok(tiedGraph.nodes.findIndex((node) => node.id === `span:${'f'.repeat(16)}`) < tiedGraph.nodes.findIndex((node) => node.id === `span:${'0'.repeat(15)}1`), 'Parent order must win over a child ID that sorts first within one millisecond');
});

test('identical HTTP span replay is idempotent; conflicting IDs and invalid batches are atomic', () => {
  const atlas = make(); const result = send(atlas, [span(rootId)]);
  const before = structuredClone(atlas.get(result.actionId));
  assert.equal(send(atlas, [span(rootId)]).duplicate, true);
  assert.deepEqual(atlas.get(result.actionId), before);
  for (const incoming of [[span(childId, rootId), span(rootId, null, { httpStatus: 503 })],
    [span(childId, rootId, { method: 'canary-secret-method' })], [span(childId, childId)],
    [span(childId, '3'.repeat(16)), span('3'.repeat(16), childId)]]) {
    assert.throws(() => send(atlas, incoming)); assert.deepEqual(atlas.get(result.actionId), before);
  }
});

test('HTTP span normalization drops arbitrary names, URLs, exceptions, bodies and resource data', () => {
  const atlas = make(); const result = send(atlas, [span(rootId, null, { httpStatus: 503, error: true,
    name: 'canary-name', attributes: { 'url.full': 'http://canary-host/?secret=canary-query' },
    body: 'canary-body', events: [{ exception: 'canary-stack' }], resource: { token: 'canary-token' } })]);
  const graph = atlas.get(result.actionId);
  assert.equal(graph.outcome, 'error'); assert.equal(JSON.stringify(graph).includes('canary-'), false);
  assert.deepEqual(Object.keys(graph.trace.spans[0]).sort(), ['durationMs', 'endedAt', 'error', 'httpStatus', 'kind', 'method', 'parentSpanId', 'spanId', 'startedAt'].sort());
  const broken = structuredClone(graph); broken.schemaVersion = '0.1';
  assert.ok(validateGraph(broken).length > 0, 'New ancestry evidence requires schema 0.2');
});

test('span batches enforce project snapshot, bounds and concurrency identities before inserting graphs', () => {
  const atlas = make();
  for (const extra of [{ projectId: 'other' }, { codeDigest: 'c'.repeat(64) }, { traceId: '0'.repeat(32) }]) assert.throws(() => send(atlas, [span(rootId)], extra));
  assert.throws(() => send(atlas, [])); assert.throws(() => send(atlas, Array.from({ length: 33 }, () => span(rootId))));
  assert.equal(atlas.actions.size, 0);
  const first = send(atlas, [span(rootId)]), second = send(atlas, [span(rootId)], { traceId: 'd'.repeat(32) });
  assert.notEqual(first.actionId, second.actionId); assert.equal(atlas.actions.size, 2);
  const additions = Array.from({ length: 48 }, (_v, index) => span((index + 100).toString(16).padStart(16, '0'), rootId, { kind: 'CLIENT' }));
  send(atlas, additions.slice(0, 32));
  const before = structuredClone(atlas.get(first.actionId));
  assert.throws(() => send(atlas, additions.slice(32)), /capacity/);
  assert.deepEqual(atlas.get(first.actionId), before);
});
