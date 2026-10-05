import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowAtlas } from '../src/flowatlas.mjs';
import { validateGraph } from '../src/evidence-contract.mjs';

const hash = 'a'.repeat(64);
const version = { commit: null, digest: hash, files: { 'src/example.mjs': hash } };
const source = { file: 'src/example.mjs', symbol: 'handler', sha256: hash, status: 'inferred' };

test('the evidence contract accepts a graph with runtime, source, and gap evidence', () => {
  const atlas = new FlowAtlas(version);
  const action = atlas.start('action-1234', 'example');
  atlas.node(action, { id: 'api', type: 'api', label: 'GET /api/example' });
  atlas.node(action, { id: 'code', type: 'code', label: 'handler', source });
  atlas.node(action, { id: 'gap', type: 'unknown', label: 'Untraced work' });
  atlas.edge(action, 'action', 'api', 'observed', {
    type: 'client-report-and-http-inbound', method: 'GET', path: '/api/example', correlationId: action.id,
  });
  atlas.edge(action, 'api', 'code', 'inferred', {
    type: 'source-route-match', reason: 'The route is registered in source.', source,
  });
  atlas.edge(action, 'code', 'gap', 'unknown', {
    type: 'coverage-gap', reason: 'No internal spans were captured.',
  });
  atlas.finish(action.id, 'success');
  assert.deepEqual(validateGraph(action), []);
});

test('a coverage gap or timestamp proximity cannot masquerade as observed evidence', () => {
  const atlas = new FlowAtlas(version);
  const action = atlas.start('action-5678', 'example');
  atlas.node(action, { id: 'api', type: 'api', label: 'GET /api/example' });
  assert.throws(() => atlas.edge(action, 'action', 'api', 'observed', {
    type: 'coverage-gap', reason: 'No browser event was captured.',
  }), /cannot support observed/);
  assert.throws(() => atlas.edge(action, 'action', 'api', 'observed', {
    type: 'timestamp-proximity', reason: 'Occurred at about the same time.',
  }), /cannot support observed/);
  assert.equal(action.edges.length, 0);
});

test('wrong correlation and source snapshot are rejected', () => {
  const atlas = new FlowAtlas(version);
  const action = atlas.start('action-9999', 'example');
  atlas.node(action, { id: 'api', type: 'api', label: 'GET /api/example' });
  assert.throws(() => atlas.edge(action, 'action', 'api', 'observed', {
    type: 'client-report-and-http-inbound', method: 'GET', path: '/api/example', correlationId: 'other-action',
  }), /correlation/);
  atlas.node(action, { id: 'code', type: 'code', label: 'handler', source: { ...source, sha256: 'b'.repeat(64) } });
  assert.ok(validateGraph(action).some((issue) => issue.includes('source hash does not match')));
});

test('validation reads the current nodes and preserves first-match diagnostics for duplicates', () => {
  const atlas = new FlowAtlas(version);
  const action = atlas.start('action-index', 'example');
  atlas.node(action, { id: 'api', type: 'api', label: 'GET /api/example' });
  atlas.edge(action, 'action', 'api', 'observed', {
    type: 'client-report-and-http-inbound', method: 'GET', path: '/api/example', correlationId: action.id,
  });
  assert.deepEqual(validateGraph(action), []);
  action.nodes.push({ ...action.nodes[0], origin: 'unverified' });
  assert.deepEqual(validateGraph(action), ['duplicate node action']);
  action.nodes[0].origin = 'unverified';
  assert.deepEqual(validateGraph(action), ['duplicate node action', 'edge e1: no client-reported action exists']);
  action.nodes.splice(0, 1); action.nodes[1].origin = 'client-reported';
  assert.deepEqual(validateGraph(action), []);
  action.nodes[0].label = 'POST /wrong';
  assert.deepEqual(validateGraph(action), ['edge e1: HTTP evidence does not match the API node']);
});
