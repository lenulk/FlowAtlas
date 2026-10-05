import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvidenceTime, timestampCacheInfo } from '../src/evidence-time.mjs';

test('timestamp parsing keeps native values and unusual formats without retaining mutable inputs', () => {
  for (const value of ['2026-10-01T00:00:00.000Z', '0000-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z',
    '2026-02-30T00:00:00.000Z', '2026-01-01T24:00:00.000Z', '2026-99-99T99:99:99.999Z',
    'Thu, 01 Oct 2026 00:00:00 GMT', '2026-10-01T00:00:00+07:00', 'not-a-date', '', null, 0])
    assert.equal(parseEvidenceTime(value), Date.parse(value));
  let value = '2026-10-01T00:00:00.000Z'; const mutable = { toString: () => value };
  assert.equal(parseEvidenceTime(mutable), Date.parse(value)); value = 'not-a-date';
  assert.equal(Number.isNaN(parseEvidenceTime(mutable)), true);
});
test('an unchanged canonical timestamp is computed once without caching its surrounding graph', () => {
  const value = '2025-07-13T10:11:12.345Z', initial = timestampCacheInfo();
  const expected = Date.parse(value);
  assert.equal(parseEvidenceTime(value), expected); assert.equal(parseEvidenceTime(value), expected);
  const final = timestampCacheInfo();
  assert.equal(final.computed - initial.computed, 1);
  assert.equal(final.reused - initial.reused, 1);
  assert.equal(Object.isFrozen(final), true);
  assert.deepEqual(Object.keys(final).sort(), ['capacity', 'size', 'computed', 'reused'].sort());
});
test('a replaced Date.parse is called fresh even when a canonical value was cached', (t) => {
  const value = '2025-08-14T11:12:13.456Z'; const expected = Date.parse(value);
  assert.equal(parseEvidenceTime(value), expected); let called = 0;
  const mocked = t.mock.method(Date, 'parse', () => ++called);
  try { assert.equal(parseEvidenceTime(value), 1); assert.equal(parseEvidenceTime(value), 2); }
  finally { mocked.mock.restore(); }
  assert.equal(parseEvidenceTime(value), expected);
});
test('a parser replaced before module loading remains fresh', async (t) => {
  let called = 0; const mocked = t.mock.method(Date, 'parse', () => ++called);
  try {
    const module = await import('../src/evidence-time.mjs?preexisting-parser-override');
    const value = '2025-09-15T12:13:14.567Z';
    assert.equal(module.parseEvidenceTime(value), 1); assert.equal(module.parseEvidenceTime(value), 2);
    assert.equal(module.timestampCacheInfo().size, 0);
  } finally { mocked.mock.restore(); }
});
test('canonical timestamp cache has a fixed resource bound and evicted values remain correct', () => {
  const { capacity } = timestampCacheInfo(), base = Date.UTC(2022, 0, 1);
  for (let index = 0; index < capacity + 20; index++) {
    const value = new Date(base + index).toISOString(); assert.equal(parseEvidenceTime(value), base + index);
  }
  assert.equal(timestampCacheInfo().size, capacity);
  assert.equal(parseEvidenceTime(new Date(base).toISOString()), base);
  assert.equal(timestampCacheInfo().size, capacity);
});
