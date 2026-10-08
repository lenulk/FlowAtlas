import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QA_STARTUP_PREFIX,
  createQaStartupPhase,
  sanitizeQaStartupPhase,
  createQaStartupPhaseParser,
} from '../scripts/cli-startup-phases.mjs';

function sample(role = 'wrapper', phase = 'inspector-spawn-requested', extra = {}) {
  return { role, phase, elapsedMs: 12, ownerConnected: true, childSpawned: false, ...extra };
}

function frame(record) { return `${QA_STARTUP_PREFIX}${JSON.stringify(record)}\n`; }

test('QA startup phases validate role-specific milestones and return canonical records', () => {
  const valid = [
    sample('wrapper', 'inspector-spawn-requested'), sample('wrapper', 'inspector-spawned'),
    sample('wrapper', 'owner-check-received'), sample('wrapper', 'owner-reply-sent'),
    sample('wrapper', 'inspector-error'), sample('wrapper', 'inspector-exited'),
    sample('inspector', 'collector-start-requested'), sample('inspector', 'collector-started'),
    sample('inspector', 'owner-confirm-requested'), sample('inspector', 'owner-confirmed'),
    sample('inspector', 'owner-rejected'), sample('inspector', 'target-spawn-requested'),
    sample('inspector', 'target-spawned'), sample('inspector', 'target-readiness-observed'),
    sample('inspector', 'target-readiness-failed'),
  ];
  for (const value of valid) {
    const record = createQaStartupPhase(value);
    assert.deepEqual(record, {
      role: value.role, phase: value.phase, elapsedMs: 12,
      ownerConnected: true, childSpawned: false,
    });
    assert.deepEqual(Object.keys(record), ['role', 'phase', 'elapsedMs', 'ownerConnected', 'childSpawned']);
  }
});

test('QA startup phase creator and sanitizer reject invalid role, phase, time, and booleans', () => {
  const invalid = [
    sample('unknown', 'inspector-spawned'),
    sample('wrapper', 'collector-started'),
    sample('inspector', 'inspector-spawned'),
    sample('inspector', 'target-readiness-failed', { elapsedMs: NaN }),
    sample('inspector', 'target-readiness-failed', { elapsedMs: -1 }),
    sample('inspector', 'target-readiness-failed', { elapsedMs: Number.MAX_SAFE_INTEGER + 1 }),
    sample('inspector', 'target-readiness-failed', { ownerConnected: 1 }),
    sample('inspector', 'target-readiness-failed', { childSpawned: 'true' }),
    null, [], 'not an object',
  ];
  for (const value of invalid) {
    assert.throws(() => createQaStartupPhase(value ?? {}), TypeError);
    assert.equal(sanitizeQaStartupPhase(value), null);
  }
  assert.deepEqual(createQaStartupPhase(sample('inspector', 'target-readiness-observed', {
    elapsedMs: Number.MAX_SAFE_INTEGER,
  })).elapsedMs, Number.MAX_SAFE_INTEGER);
});

test('QA startup parser accepts fragmented Buffer and string frames and ignores unrelated stdout', () => {
  const parser = createQaStartupPhaseParser();
  const expected = createQaStartupPhase(sample());
  const text = `ordinary stdout\n${frame({ ...expected, extra: 'private canary' })}`;
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += 3) parser.write(bytes.subarray(offset, offset + 3));
  parser.write(frame(sample('inspector', 'collector-started')).slice(0, 17));
  parser.write(frame(sample('inspector', 'collector-started')).slice(17));
  const result = parser.snapshot();
  assert.deepEqual(result.records, [expected, sample('inspector', 'collector-started')]);
  assert.equal(result.invalidFrames, 0);
  assert.equal(result.overflowFrames, 0);
});

test('QA startup parser caps records and validates its limit', () => {
  const parser = createQaStartupPhaseParser({ limit: 2 });
  parser.write(frame(sample('wrapper', 'inspector-spawn-requested')));
  parser.write(frame(sample('inspector', 'collector-started')));
  parser.write(frame(sample('inspector', 'target-spawned')));
  assert.equal(parser.snapshot().records.length, 2);
  assert.equal(parser.snapshot().overflowFrames, 1);
  for (const limit of [0, 21, 1.5, NaN]) {
    assert.throws(() => createQaStartupPhaseParser({ limit }), TypeError);
  }
  assert.doesNotThrow(() => createQaStartupPhaseParser({ limit: 20 }));
});

test('QA startup parser counts malformed known frames and drops extra canary fields', () => {
  const parser = createQaStartupPhaseParser();
  parser.write(`${QA_STARTUP_PREFIX}{broken}\n`);
  parser.write(frame(sample('wrapper', 'collector-started')));
  parser.write(frame(sample('wrapper', 'inspector-spawned', { elapsedMs: NaN })));
  parser.write(frame(sample('wrapper', 'inspector-spawned', { childSpawned: 'yes' })));
  const secret = 'private-diagnostic-canary';
  parser.write(frame({ ...sample(), url: secret, headers: { authorization: secret }, body: secret, error: secret }));
  const snapshot = parser.snapshot();
  assert.equal(snapshot.invalidFrames, 4);
  assert.equal(snapshot.records.length, 1);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('url'), false);
  assert.equal(serialized.includes('headers'), false);
  assert.deepEqual(Object.keys(snapshot.records[0]), ['role', 'phase', 'elapsedMs', 'ownerConnected', 'childSpawned']);
});

test('QA startup parser bounds oversized known frames without retaining canary content', () => {
  const parser = createQaStartupPhaseParser();
  const canary = 'oversized-private-canary';
  parser.write(`${QA_STARTUP_PREFIX}{"${canary}":"${'x'.repeat(8300)}"}\n`);
  const result = parser.snapshot();
  assert.deepEqual(result, { records: [], invalidFrames: 0, overflowFrames: 1 });
  assert.equal(JSON.stringify(result).includes(canary), false);
});
