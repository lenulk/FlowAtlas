import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlowSyncMarkers } from '../scripts/exporter-durable-pair-marker.mjs';

const node22ArchivedTap = [
  'TAP version 13',
  '# Subtest: controlled durable-pair capture',
  '# FLOWATLAS_SLOW_SYNC {"delayMs":120,"calls":51,"openDescriptors":0}',
  'not ok 1 - controlled durable-pair capture',
].join('\n');

const node24PlainTap = [
  'TAP version 13',
  'not ok 1 - controlled durable-pair capture',
  'FLOWATLAS_SLOW_SYNC {"delayMs":120,"calls":49,"openDescriptors":0}',
].join('\r\n');

const expectedNode22 = [{ delayMs: 120, calls: 51, openDescriptors: 0 }];

test('parses the exact Node 22 archived TAP comment marker', () => {
  assert.deepEqual(parseSlowSyncMarkers(node22ArchivedTap), expectedNode22);
});

test('parses the exact bare Node 24 marker and ignores plain output without a marker', () => {
  assert.deepEqual(parseSlowSyncMarkers(node24PlainTap), [{ delayMs: 120, calls: 49, openDescriptors: 0 }]);
  assert.deepEqual(parseSlowSyncMarkers('TAP version 13\r\n# Subtest: ordinary Node 24 run\r\nok 1 - ordinary Node 24 run\r\n'), []);
});

test('rejects duplicate, indented, doubled-prefix and embedded marker text', () => {
  const marker = 'FLOWATLAS_SLOW_SYNC {"delayMs":120,"calls":1,"openDescriptors":0}';
  const invalid = [
    `${marker}\n${marker}`,
    ` ${marker}`,
    `\t${marker}`,
    `## ${marker}`,
    `notice ${marker}`,
  ];
  for (const tap of invalid) assert.throws(() => parseSlowSyncMarkers(tap), /invalid_slow_sync_marker/);
});

test('rejects malformed JSON, extra fields, wrong delay and invalid counters', () => {
  const invalidPayloads = [
    '{bad json}',
    '{"delayMs":120,"calls":1,"openDescriptors":0,"secret":"extra"}',
    '{"delayMs":121,"calls":1,"openDescriptors":0}',
    '{"delayMs":120,"calls":0,"openDescriptors":0}',
    '{"delayMs":120,"calls":-1,"openDescriptors":0}',
    '{"delayMs":120,"calls":1.5,"openDescriptors":0}',
    '{"delayMs":120,"calls":9007199254740992,"openDescriptors":0}',
    '{"delayMs":120,"calls":1,"openDescriptors":-1}',
    '{"delayMs":120,"calls":1,"openDescriptors":0.5}',
  ];
  for (const payload of invalidPayloads) {
    assert.throws(() => parseSlowSyncMarkers(`FLOWATLAS_SLOW_SYNC ${payload}`), /invalid_slow_sync_marker/);
  }
  assert.throws(() => parseSlowSyncMarkers(node22ArchivedTap, 0), /invalid_slow_sync_marker/);
});

test('bounds marker lines and the whole TAP input', () => {
  const longLine = `FLOWATLAS_SLOW_SYNC {"delayMs":120,"calls":1,"openDescriptors":0}${' '.repeat(220)}`;
  assert.throws(() => parseSlowSyncMarkers(longLine), /invalid_slow_sync_marker/);
  assert.throws(() => parseSlowSyncMarkers('x'.repeat(16 * 1024 * 1024 + 1)), /invalid_slow_sync_marker/);
});
