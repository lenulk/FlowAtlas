import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregatePerformance, comparePerformance, comparePairPerformance } from '../scripts/benchmark-statistics.mjs';

function condition(p95Ms) {
  return { valid: true, workloadDigest: 'matched-workload', requestIdDigest: 'matched-ids',
    measurement: { count: 1000, correctResponses: 1000, failedResponses: 0, p95Ms } };
}
function pair(baseline, traced) {
  const comparison = comparePerformance(baseline, traced);
  return { baseline: condition(baseline), traced: condition(traced), deltaP95Ms: comparison.deltaMs,
    relativeP95OverheadPercent: comparison.relativePercent };
}
test('missing opposite conditions cannot combine independent medians into a performance pass', () => {
  const rounds = [pair(10, null), pair(null, 5), pair(10, 20)];
  rounds[0].traced.measurement = null; rounds[1].baseline.measurement = null;
  const result = aggregatePerformance(rounds);
  assert.equal(result.assessable, false);
  assert.equal(result.met, null);
  assert.equal(result.aggregateRelativeP95OverheadPercent, null);
  assert.equal(result.reason, 'incomplete_or_invalid_pairs');
  assert.equal(result.completedPairs, 1);
  assert.equal(comparePairPerformance(rounds[0]).acceptance.met, null);
});
test('short, incorrect or mismatched workloads cannot certify overhead', () => {
  for (const alter of [
    (rounds) => rounds.pop(),
    (rounds) => { rounds[0].traced.measurement.count = 999; },
    (rounds) => { rounds[1].baseline.measurement.correctResponses = 999; },
    (rounds) => { rounds[1].traced.measurement.failedResponses = 1; },
    (rounds) => { rounds[2].traced.workloadDigest = 'different-workload'; },
    (rounds) => { rounds[2].baseline.requestIdDigest = 'different-ids'; },
    (rounds) => { rounds[0].baseline.measurement.p95Ms = NaN; },
    (rounds) => { rounds[0].traced.valid = false; },
    (rounds) => { rounds[2].baseline.workloadDigest = rounds[2].traced.workloadDigest = 'different-round'; },
    (rounds) => { rounds[2].baseline.requestIdDigest = rounds[2].traced.requestIdDigest = 'different-round-ids'; },
  ]) {
    const rounds = [pair(10, 10), pair(10, 10), pair(10, 10)]; alter(rounds);
    assert.equal(aggregatePerformance(rounds).met, null);
  }
});
test('complete paired workloads retain original relative and tiny baseline thresholds', () => {
  const relative = aggregatePerformance([pair(10, 11), pair(12, 13.2), pair(11, 12.1)]);
  assert.equal(relative.assessable, true); assert.equal(relative.met, true);
  assert.equal(relative.aggregateRelativeP95OverheadPercent, 10);
  assert.deepEqual(relative.threshold, { relativePercent: 10 });
  const tiny = aggregatePerformance([pair(0.2, 5.2), pair(0.3, 5.3), pair(0.4, 5.4)]);
  assert.equal(tiny.met, true); assert.deepEqual(tiny.threshold, { deltaMs: 5 });
  assert.equal(aggregatePerformance([pair(10, 12), pair(10, 12), pair(10, 12)]).met, false);
  assert.equal(aggregatePerformance([pair(0.3, 5.301), pair(0.3, 5.301), pair(0.3, 5.301)]).met, false);
});
test('profiled timings retain samples but cannot certify ordinary performance acceptance', () => {
  const result = aggregatePerformance([pair(10, 9), pair(10, 9), pair(10, 9)], { profiled: true });
  assert.equal(result.assessable, false); assert.equal(result.met, null); assert.equal(result.reason, 'profiled_run');
  assert.equal(comparePairPerformance(pair(10, 9), { profiled: true }).acceptance.met, null);
});
