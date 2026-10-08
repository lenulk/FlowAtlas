import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetadataDiagnostics, createMetadataDiagnosticParser } from '../scripts/independent-metadata-diagnostics.mjs';

const phases = ['action-start', 'handler-entry', 'outbound-result', 'finish'];
function sample(ordinal, action = 'send-message') {
  const diagnostic = createMetadataDiagnostics({ ordinal, action });
  for (const phase of phases) {
    diagnostic.attempt(phase);
    diagnostic.status(phase, phase === 'action-start' ? 202 : 200);
    diagnostic.bodyRead(phase);
    diagnostic.finish(phase, 7, 'none');
  }
  return diagnostic;
}
function frame(record, extra = '') {
  return `FlowAtlas independent metadata: ${JSON.stringify(record)}${extra}\n`;
}

test('metadata recorder tracks the four phases and returns detached snapshots', () => {
  const diagnostic = createMetadataDiagnostics({ ordinal: 2, action: 'send-message' });
  diagnostic.attempt('action-start'); diagnostic.skip('handler-entry');
  diagnostic.status('action-start', 202); diagnostic.bodyRead('action-start');
  diagnostic.finish('action-start', 12, 'none');
  diagnostic.attempt('outbound-result'); diagnostic.status('outbound-result', 200);
  diagnostic.finish('outbound-result', 9, 'timeout');
  const result = diagnostic.snapshot();
  assert.deepEqual(Object.keys(result), ['ordinal', 'action', 'phases']);
  assert.deepEqual(result.phases['action-start'], {
    attempted: 1, skipped: 0, status: 202, bodyRead: 1, settled: 1, elapsedMs: 12, failure: 'none',
  });
  assert.equal(result.phases['handler-entry'].skipped, 1);
  assert.equal(result.phases['outbound-result'].failure, 'timeout');
  result.phases.finish.status = 418;
  assert.equal(diagnostic.snapshot().phases.finish.status, null);
});

test('metadata recorder rejects invalid programmer inputs', () => {
  for (const options of [{ ordinal: 0, action: 'send-message' }, { ordinal: 1.5, action: 'send-message' },
    { ordinal: 1, action: 'other' }]) assert.throws(() => createMetadataDiagnostics(options), TypeError);
  const diagnostic = sample(1);
  for (const call of [() => diagnostic.attempt('unknown'), () => diagnostic.skip(null),
    () => diagnostic.status('finish', 99), () => diagnostic.status('finish', 600),
    () => diagnostic.bodyRead('other'), () => diagnostic.finish('finish', NaN),
    () => diagnostic.finish('finish', -1), () => diagnostic.finish('finish', 1, 'secret')]) {
    assert.throws(call, TypeError);
  }
});

test('metadata parser handles fragmented known frames and ignores unrelated output', () => {
  const parser = createMetadataDiagnosticParser();
  const data = `ordinary stdout\n${frame(sample(3).snapshot())}`;
  for (let i = 0; i < data.length; i += 5) parser.write(data.slice(i, i + 5));
  const result = parser.snapshot();
  assert.deepEqual(result.records.map((record) => record.ordinal), [3]);
  assert.equal(result.invalidFrames, 0);
  assert.equal(result.overflowFrames, 0);
});

test('metadata parser rejects malformed frames and oversized known-prefix frames', () => {
  const parser = createMetadataDiagnosticParser();
  parser.write('FlowAtlas independent metadata: {broken}\n');
  parser.write(`FlowAtlas independent metadata: ${'x'.repeat(8200)}\n`);
  const result = parser.snapshot();
  assert.equal(result.invalidFrames, 1);
  assert.equal(result.overflowFrames, 1);
  assert.deepEqual(result.records, []);
});

test('metadata parser keeps latest duplicate, caps distinct records, and sorts ordinals', () => {
  const parser = createMetadataDiagnosticParser({ limit: 2 });
  parser.write(frame(sample(9).snapshot()));
  parser.write(frame(sample(2).snapshot()));
  parser.write(frame(sample(9, 'fail-message').snapshot()));
  parser.write(frame(sample(10).snapshot()));
  const result = parser.snapshot();
  assert.deepEqual(result.records.map(({ ordinal, action }) => ({ ordinal, action })), [
    { ordinal: 2, action: 'send-message' }, { ordinal: 9, action: 'fail-message' },
  ]);
  assert.equal(result.overflowFrames, 1);
});

test('metadata parser limit is bounded from 1 through 100', () => {
  for (const limit of [0, 101, 1.5, NaN]) {
    assert.throws(() => createMetadataDiagnosticParser({ limit }), TypeError);
  }
  assert.doesNotThrow(() => createMetadataDiagnosticParser({ limit: 100 }));
});

test('metadata parser rejects missing phases, invalid enums, statuses and numeric values', () => {
  const parser = createMetadataDiagnosticParser();
  const bad = [
    { ...sample(1).snapshot(), phases: { 'action-start': {} } },
    { ...sample(2).snapshot(), action: 'private-action' },
    { ...sample(3).snapshot(), phases: { ...sample(3).snapshot().phases,
      finish: { ...sample(3).snapshot().phases.finish, status: 99 } } },
    { ...sample(4).snapshot(), phases: { ...sample(4).snapshot().phases,
      finish: { ...sample(4).snapshot().phases.finish, failure: 'secret-error' } } },
    { ...sample(5).snapshot(), phases: { ...sample(5).snapshot().phases,
      finish: { ...sample(5).snapshot().phases.finish, elapsedMs: NaN } } },
  ];
  for (const value of bad) parser.write(frame(value));
  assert.equal(parser.snapshot().invalidFrames, bad.length);
});

test('metadata parser drops extra fields and never returns canary data', () => {
  const canary = 'do-not-echo-this-secret';
  const record = sample(1).snapshot();
  record.requestUrl = canary;
  record.phases.finish.errorMessage = canary;
  const parser = createMetadataDiagnosticParser();
  parser.write(frame(record));
  const output = JSON.stringify(parser.snapshot());
  assert.equal(output.includes(canary), false);
  assert.deepEqual(Object.keys(parser.snapshot().records[0]), ['ordinal', 'action', 'phases']);
  assert.deepEqual(Object.keys(parser.snapshot().records[0].phases.finish),
    ['attempted', 'skipped', 'status', 'bodyRead', 'settled', 'elapsedMs', 'failure']);
});
