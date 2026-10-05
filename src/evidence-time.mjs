// Shared timestamp parsing; strings are immutable and no graph validity is cached.
const capacity = 2048;
const nativeParse = Date.parse;
const standardParser = nativeParse.name === 'parse' && nativeParse.length === 1
  && Function.prototype.toString.call(nativeParse).replace(/\s/g, '') === 'functionparse(){[nativecode]}';
const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const cache = new Map();
let computed = 0, reused = 0;
export function parseEvidenceTime(value) {
  // Overrides may be stateful. Only memoize the original parser on immutable,
  // fixed-width UTC strings; unusual formats and mutable inputs stay fresh.
  const originalParser = standardParser && Date.parse === nativeParse;
  if (originalParser && typeof value === 'string') {
    const prior = cache.get(value);
    if (prior !== undefined) { reused = Math.min(Number.MAX_SAFE_INTEGER, reused + 1); return prior; }
  }
  computed = Math.min(Number.MAX_SAFE_INTEGER, computed + 1);
  const result = Date.parse(value);
  if (originalParser && typeof value === 'string' && value.length === 24 && canonical.test(value)) {
    if (cache.size >= capacity) cache.delete(cache.keys().next().value);
    cache.set(value, result);
  }
  return result;
}
export function timestampCacheInfo() { return Object.freeze({ capacity, size: cache.size, computed, reused }); }
