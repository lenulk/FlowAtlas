import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import { hrtime } from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeSdkHttpSpan as productionNormalize } from '../src/otel-exporter.mjs';
import { httpMethods, validSpanId } from '../src/http-span-contract.mjs';
import { parseEvidenceTime, timestampCacheInfo } from '../src/evidence-time.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePaths = ['src/otel-exporter.mjs', 'src/http-span-contract.mjs', 'src/evidence-time.mjs'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const baselineCommit = '948336e363e5ba1d258ca95327183807e6488564';
const baselineSha256 = [
  '034e1dd98ad880fef21efd2eb89d74f87bc84e3653d762b6e8749d115a3a72c3',
  '63a627c50dd4256771d21de363448f88439859832a066fbc9c3e6e05a8e82e04',
  '3342afca7357b97a0b6a28b30d0dc8a93d53d08fa792723357f8be58f6c3cd93',
];
const baselineFunctionSha256 = {
  timestamp: 'a00f67b222dc4740319aa3657a6239fdcd0736034f117039a84a7af4c0e02ea9',
  clean: '41c770c63ae94d48420210aafb0db0a317fee354062fdfef0216ddf771d4f0e1',
  normalize: '954ddd1ff1271029a640555b896d1397ec55fd5597a1e96082eefa6b6b531e27',
  unchangedContractPrefix: 'b101df2029dd851d8451eaecc8809d5203fb827f2343e829cf1f8fecd6e53293',
};
const millis = ([seconds, nanos]) => seconds * 1000 + nanos / 1e6;

// The baseline copies the three short functions from baselineCommit. Only
// local names change. The old bytes are checked against fixed Git digests below.
const timestamp = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ? parseEvidenceTime(value) : NaN;
function legacyCleanHttpSpan(value) {
  const start = timestamp(value?.startedAt), end = timestamp(value?.endedAt);
  if (!value || typeof value !== 'object' || !validSpanId(value.spanId, 16)
    || (value.parentSpanId !== null && !validSpanId(value.parentSpanId, 16))
    || !['SERVER', 'CLIENT'].includes(value.kind) || !httpMethods.has(value.method)
    || Number.isNaN(start) || Number.isNaN(end) || end < start
    || !Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 86400000
    || typeof value.error !== 'boolean'
    || (value.httpStatus !== null && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599))) {
    throw new Error('Invalid normalized HTTP span');
  }
  // Deliberately discard every field outside this fixed vocabulary.
  return { spanId: value.spanId, parentSpanId: value.parentSpanId, kind: value.kind, method: value.method,
    startedAt: value.startedAt, endedAt: value.endedAt, durationMs: value.durationMs, httpStatus: value.httpStatus, error: value.error };
}
function legacyNormalize(span) {
  if (![1, 2].includes(span.kind)) return null;
  const attributes = span.attributes;
  const method = attributes['http.request.method'] ?? attributes['http.method'];
  if (method === undefined) return null;
  const identity = span.spanContext();
  if (!validSpanId(identity.traceId, 32)) throw new Error('Invalid SDK trace identity');
  const status = attributes['http.response.status_code'] ?? attributes['http.status_code'] ?? null;
  return { traceId: identity.traceId, span: legacyCleanHttpSpan({ spanId: identity.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null, kind: span.kind === 1 ? 'SERVER' : 'CLIENT',
    method: httpMethods.has(method) ? method : 'OTHER', startedAt: new Date(millis(span.startTime)).toISOString(),
    endedAt: new Date(millis(span.endTime)).toISOString(), durationMs: Math.round(millis(span.duration) * 1000) / 1000,
    httpStatus: status, error: span.status.code === 2 }) };
}

// Rejected QA candidate: the production refactor was reverted after its
// isolated, predeclared five-pair gate showed only three faster pairs.
function validateWithoutCopy(value) {
  const start = timestamp(value?.startedAt), end = timestamp(value?.endedAt);
  if (!value || typeof value !== 'object' || !validSpanId(value.spanId, 16)
    || (value.parentSpanId !== null && !validSpanId(value.parentSpanId, 16))
    || !['SERVER', 'CLIENT'].includes(value.kind) || !httpMethods.has(value.method)
    || Number.isNaN(start) || Number.isNaN(end) || end < start
    || !Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 86400000
    || typeof value.error !== 'boolean'
    || (value.httpStatus !== null && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599))) {
    throw new Error('Invalid normalized HTTP span');
  }
}
function candidateNormalize(span) {
  if (![1, 2].includes(span.kind)) return null;
  const attributes = span.attributes;
  const method = attributes['http.request.method'] ?? attributes['http.method'];
  if (method === undefined) return null;
  const identity = span.spanContext();
  if (!validSpanId(identity.traceId, 32)) throw new Error('Invalid SDK trace identity');
  const status = attributes['http.response.status_code'] ?? attributes['http.status_code'] ?? null;
  const traceId = identity.traceId;
  const normalized = { spanId: identity.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null, kind: span.kind === 1 ? 'SERVER' : 'CLIENT',
    method: httpMethods.has(method) ? method : 'OTHER', startedAt: new Date(millis(span.startTime)).toISOString(),
    endedAt: new Date(millis(span.endTime)).toISOString(), durationMs: Math.round(millis(span.duration) * 1000) / 1000,
    httpStatus: status, error: span.status.code === 2 };
  validateWithoutCopy(normalized);
  return { traceId, span: normalized };
}

function sourceProvenance() {
  const canonicalSourceHash = (fn) => hash(Function.prototype.toString.call(fn).replaceAll('\r\n', '\n'));
  assert.equal(canonicalSourceHash(timestamp), baselineFunctionSha256.timestamp);
  assert.equal(canonicalSourceHash(legacyCleanHttpSpan), baselineFunctionSha256.clean);
  assert.equal(canonicalSourceHash(legacyNormalize), baselineFunctionSha256.normalize);
  const rows = [];
  for (const [index, path] of sourcePaths.entries()) {
    const current = readFileSync(join(root, path));
    const currentDigest = hash(current);
    assert.equal(currentDigest, baselineSha256[index], `${path} must remain at the original production bytes`);
    rows.push({ module: path.split('/').at(-1), baselineSha256: baselineSha256[index], currentProductionSha256: currentDigest });
  }
  const contract = readFileSync(join(root, 'src/http-span-contract.mjs'), 'utf8').replaceAll('\r\n', '\n');
  const timestampIndex = contract.indexOf('const timestamp');
  assert.ok(timestampIndex > 0);
  assert.equal(hash(contract.slice(0, timestampIndex)), baselineFunctionSha256.unchangedContractPrefix);
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { /* Packed or shallow execution may not expose Git metadata. */ }
  if (commit !== null) assert.match(commit, /^[0-9a-f]{40}$/);
  return { baselineCommit, candidateCommit: commit, rows,
    baselineFunctionSha256: { timestamp: baselineFunctionSha256.timestamp,
      clean: baselineFunctionSha256.clean, normalize: baselineFunctionSha256.normalize } };
}

function sdkSpan(index = 1, patch = {}) {
  const span = {
    kind: 1,
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: index.toString(16).padStart(16, '0') }),
    startTime: [1790812800, 123456789], endTime: [1790812800, 223456789], duration: [0, 100000000],
    parentSpanContext: null, status: { code: 0 },
    attributes: { 'http.request.method': 'GET', 'http.response.status_code': 200, 'url.full': 'private-canary' },
  };
  return { ...span, ...patch };
}

function outcome(fn, value) {
  try { return { type: 'return', value: fn(value) }; }
  catch (error) { return { type: 'throw', name: error?.name ?? 'unknown', message: error?.message ?? 'unknown' }; }
}
function compareFactory(name, factory) {
  const reference = outcome(legacyNormalize, factory());
  const production = outcome(productionNormalize, factory());
  const candidate = outcome(candidateNormalize, factory());
  assert.deepEqual(production, reference, `pinned and current production parity: ${name}`);
  assert.deepEqual(candidate, reference, `normalization parity: ${name}`);
  assert.equal(JSON.stringify(candidate).includes('private-canary'), false);
}

function getterTrackedSpan(log) {
  const identity = {
    get traceId() { log.push('traceId'); return 'a'.repeat(32); },
    get spanId() { log.push('spanId'); return 'b'.repeat(16); },
  };
  const attributes = {
    get 'http.request.method'() { log.push('method'); return 'GET'; },
    get 'http.response.status_code'() { log.push('httpStatus'); return 200; },
  };
  return {
    get kind() { log.push('kind'); return 1; },
    get attributes() { log.push('attributes'); return attributes; },
    spanContext() { log.push('spanContext'); return identity; },
    get parentSpanContext() { log.push('parent'); return null; },
    get startTime() { log.push('startTime'); return [1790812800, 0]; },
    get endTime() { log.push('endTime'); return [1790812800, 100000000]; },
    get duration() { log.push('duration'); return [0, 100000000]; },
    get status() { log.push('status'); return { get code() { log.push('statusCode'); return 0; } }; },
  };
}

function equivalence() {
  const variants = [
    ['ordinary', () => sdkSpan()],
    ['client-legacy-method', () => sdkSpan(2, { kind: 2, attributes: { 'http.method': 'PATCH', 'http.status_code': 503 } })],
    ['ignored-kind', () => sdkSpan(3, { kind: 0 })],
    ['ignored-method', () => sdkSpan(4, { attributes: {} })],
    ['unknown-method', () => sdkSpan(5, { attributes: { 'http.request.method': 'private-canary' } })],
    ['invalid-trace', () => sdkSpan(6, { spanContext: () => ({ traceId: '0'.repeat(32), spanId: 'a'.repeat(16) }) })],
    ['invalid-parent', () => sdkSpan(7, { parentSpanContext: { spanId: '0'.repeat(16) } })],
    ['reverse-time', () => sdkSpan(8, { endTime: [1790812799, 0] })],
    ['negative-duration', () => sdkSpan(9, { duration: [-1, 0] })],
    ['long-duration', () => sdkSpan(10, { duration: [86401, 0] })],
    ['bad-status', () => sdkSpan(11, { attributes: { 'http.request.method': 'GET', 'http.response.status_code': 600 } })],
    ['missing-attributes', () => sdkSpan(22, { attributes: null })],
    ['missing-start', () => sdkSpan(23, { startTime: undefined })],
    ['missing-status', () => sdkSpan(24, { status: null })],
    ['zero-duration', () => sdkSpan(12, { duration: [0, 0] })],
    ['millisecond-truncation', () => sdkSpan(13, { startTime: [1790812800, 999999], endTime: [1790812800, 1000001] })],
    ['year-zero', () => sdkSpan(14, { startTime: [-62167219200, 0], endTime: [-62167219199, 0] })],
    ['year-9999', () => sdkSpan(15, { startTime: [253402300798, 0], endTime: [253402300799, 0] })],
    ['year-10000', () => sdkSpan(16, { startTime: [253402300800, 0], endTime: [253402300801, 0] })],
    ['timeclip-limit', () => sdkSpan(17, { startTime: [8640000000000, 0], endTime: [8640000000000, 0] })],
    ['timeclip-overflow', () => sdkSpan(18, { startTime: [8640000000001, 0] })],
    ['nan-time', () => sdkSpan(19, { startTime: [NaN, 0] })],
  ];
  for (const [name, factory] of variants) compareFactory(name, factory);

  const referenceLog = [], candidateLog = [];
  const reference = outcome(legacyNormalize, getterTrackedSpan(referenceLog));
  const candidate = outcome(candidateNormalize, getterTrackedSpan(candidateLog));
  assert.deepEqual(candidate, reference);
  assert.deepEqual(candidateLog, referenceLog, 'stateful SDK getter read order must match');

  const original = Date.parse;
  try {
    const span = () => sdkSpan(20, { startTime: [1938123456, 0], endTime: [1938123456, 100000000] });
    for (const [name, parser] of [
      ['delegating', (value) => original(value)],
      ['nan', () => NaN],
      ['reversed', (_value, index) => index === 1 ? 2000 : 1000],
    ]) {
      let calls = 0;
      Date.parse = (value) => parser(value, ++calls);
      const first = outcome(legacyNormalize, span());
      assert.equal(calls, 2, `${name} reference parser calls`);
      calls = 0;
      const second = outcome(candidateNormalize, span());
      assert.equal(calls, 2, `${name} candidate parser calls`);
      assert.deepEqual(second, first, `${name} override parity`);
    }
  } finally { Date.parse = original; }
  const one = candidateNormalize(sdkSpan(25)), two = candidateNormalize(sdkSpan(25));
  assert.notEqual(one, two);
  assert.notEqual(one.span, two.span);
  one.span.method = 'OTHER';
  assert.equal(two.span.method, 'GET');
  // Both paths must still invoke the shared parser. The first call computes
  // two fresh canonical values; the second reuses exactly those two entries.
  const beforeCache = timestampCacheInfo();
  const cacheSpan = () => sdkSpan(21, { startTime: [1938123457, 0], endTime: [1938123457, 100000000] });
  assert.deepEqual(outcome(candidateNormalize, cacheSpan()), outcome(legacyNormalize, cacheSpan()));
  const afterCache = timestampCacheInfo();
  assert.equal(afterCache.computed - beforeCache.computed, 2);
  assert.equal(afterCache.reused - beforeCache.reused, 2);
  assert.equal(afterCache.capacity, 2048);
  assert.ok(afterCache.size <= afterCache.capacity);
  return { variantCount: variants.length, getterOrderMatched: true,
    overrideModes: 3, overrideParseCallsPerCall: 2, sharedCacheComputed: 2, sharedCacheReused: 2 };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function timed(fn, pool, count) {
  let checksum = 0;
  const started = hrtime.bigint();
  for (let index = 0; index < count; index += 1) {
    const result = fn(pool[index % pool.length]);
    checksum += result.span.durationMs;
  }
  const elapsedNs = Number(hrtime.bigint() - started);
  assert.ok(Number.isSafeInteger(elapsedNs) && elapsedNs > 0 && Number.isFinite(checksum));
  return { elapsedNs, checksum };
}
function costExperiment() {
  const pool = Array.from({ length: 1051 }, (_, index) => sdkSpan(index + 1, {
    startTime: [1790812800 + index, 123456789], endTime: [1790812800 + index, 223456789],
  }));
  timed(legacyNormalize, pool, 10000);
  timed(candidateNormalize, pool, 10000);
  const pairs = [];
  for (let round = 0; round < 5; round += 1) {
    const order = round % 2 === 0 ? ['reference', 'candidate'] : ['candidate', 'reference'];
    const row = { round: round + 1, order, referenceNs: null, candidateNs: null };
    for (const condition of order) {
      const result = timed(condition === 'reference' ? legacyNormalize : candidateNormalize, pool, 20000);
      row[`${condition}Ns`] = result.elapsedNs;
      assert.equal(result.checksum, 2_000_000);
    }
    pairs.push(row);
  }
  const referenceMedianNs = median(pairs.map((row) => row.referenceNs));
  const candidateMedianNs = median(pairs.map((row) => row.candidateNs));
  return {
    workload: { poolSize: pool.length, callsPerConditionPerPair: 20000, pairs: 5 },
    pairs, referenceMedianNs, candidateMedianNs,
    candidateFasterPairs: pairs.filter((row) => row.candidateNs < row.referenceNs).length,
    relativeCandidateToReferencePercent: Number((candidateMedianNs / referenceMedianNs * 100).toFixed(3)),
    performanceAcceptance: null,
  };
}

test('QA SDK normalization allocation candidate preserves behavior and records its rejection', { timeout: 30000 }, () => {
  const provenance = sourceProvenance();
  const parity = equivalence();
  const costMeasured = process.env.FLOWATLAS_NORMALIZATION_COST === '1';
  const cost = costMeasured ? costExperiment() : null;
  const report = {
    schema: 'sdk-normalization-allocation-qa-v1',
    source: provenance,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, osRelease: release() },
    method: 'QA-only pinned production normalize/clean copies versus rejected local allocation candidate; shared timestamp parser cache, rotated order, local elapsed time; no HTTP, SDK lifecycle, collector, or p95 measurement',
    adoptionDecision: 'rejected_after_isolated_production_gate_3_of_5_faster_pairs',
    parity, costMeasured, cost,
  };
  mkdirSync(join(root, 'reports', 'benchmarks'), { recursive: true });
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `sdk-normalization-allocation-${suffix}.json`;
  writeFileSync(join(root, 'reports', 'benchmarks', filename), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(`QA normalization allocation report: reports/benchmarks/${filename}`);
});
