export function percentile(samples, fraction) {
  if (!samples.length) return null;
  const ordered = [...samples].sort((a, b) => a - b);
  return Number(ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)].toFixed(3));
}

export function comparePerformance(baselineP95Ms, tracedP95Ms) {
  if (![baselineP95Ms, tracedP95Ms].every((value) => Number.isFinite(value) && value >= 0)) {
    return { deltaMs: null, relativePercent: null,
      acceptance: { assessable: false, criterion: null, met: null, threshold: null, reason: 'incomplete_or_invalid_pairs' } };
  }
  const deltaMs = baselineP95Ms === null || tracedP95Ms === null ? null : Number((tracedP95Ms - baselineP95Ms).toFixed(3));
  const relativePercent = baselineP95Ms > 0 && tracedP95Ms !== null
    ? Number(((tracedP95Ms / baselineP95Ms - 1) * 100).toFixed(3)) : null;
  const criterion = baselineP95Ms !== null && baselineP95Ms < 1 ? 'absolute_overhead_ms' : 'relative_increase_percent';
  const met = criterion === 'absolute_overhead_ms' ? deltaMs !== null && deltaMs <= 5
    : relativePercent !== null && relativePercent <= 10;
  return { deltaMs, relativePercent, acceptance: { assessable: true, criterion, met, reason: null,
    threshold: criterion === 'absolute_overhead_ms' ? { deltaMs: 5 } : { relativePercent: 10 } } };
}

function validPair({ baseline, traced }, measuredRequests) {
  return [baseline, traced].every((condition) => condition?.valid === true
    && condition.measurement?.count === measuredRequests
    && condition.measurement.correctResponses === measuredRequests && condition.measurement.failedResponses === 0
    && Number.isFinite(condition.measurement.p95Ms) && condition.measurement.p95Ms >= 0)
    && typeof baseline.workloadDigest === 'string' && Boolean(baseline.workloadDigest)
    && baseline.workloadDigest === traced.workloadDigest
    && typeof baseline.requestIdDigest === 'string' && Boolean(baseline.requestIdDigest)
    && baseline.requestIdDigest === traced.requestIdDigest;
}

export function comparePairPerformance(pair, { measuredRequests = 1000, profiled = false } = {}) {
  if (profiled || !validPair(pair, measuredRequests)) {
    const result = comparePerformance(null, null);
    result.acceptance.reason = profiled ? 'profiled_run' : 'incomplete_or_invalid_pairs';
    return result;
  }
  return comparePerformance(pair.baseline.measurement.p95Ms, pair.traced.measurement.p95Ms);
}

export function aggregatePerformance(rounds, { expectedRounds = 3, measuredRequests = 1000, profiled = false } = {}) {
  const completedPairs = rounds.filter((round) => validPair(round, measuredRequests)).length;
  const sameWorkload = rounds.every((round) => round.baseline?.workloadDigest === rounds[0]?.baseline?.workloadDigest
    && round.baseline?.requestIdDigest === rounds[0]?.baseline?.requestIdDigest);
  const assessable = !profiled && rounds.length === expectedRounds && completedPairs === expectedRounds && sameWorkload;
  const baseline = assessable ? percentile(rounds.map((round) => round.baseline.measurement.p95Ms), 0.5) : null;
  const traced = assessable ? percentile(rounds.map((round) => round.traced.measurement.p95Ms), 0.5) : null;
  const comparison = comparePerformance(baseline, traced);
  return { ...comparison.acceptance, reason: profiled ? 'profiled_run' : comparison.acceptance.reason,
    completedPairs, expectedPairs: expectedRounds, aggregateMethod: 'ratio_or_difference_of_condition_medians',
    aggregateDeltaP95Ms: comparison.deltaMs, aggregateRelativeP95OverheadPercent: comparison.relativePercent,
    medianBaselineP95Ms: baseline, medianTracedP95Ms: traced,
    medianDeltaP95Ms: assessable ? percentile(rounds.map((round) => comparePairPerformance(round, { measuredRequests }).deltaMs), 0.5) : null,
    medianPairedRelativeP95OverheadPercent: assessable ? percentile(rounds.map((round) => comparePairPerformance(round, { measuredRequests }).relativePercent).filter(Number.isFinite), 0.5) : null };
}
