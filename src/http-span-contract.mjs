export const httpMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE', 'OTHER']);
export const validSpanId = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value) && !/^0+$/.test(value);
const time = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));

export function cleanHttpSpan(value) {
  if (!value || typeof value !== 'object' || !validSpanId(value.spanId, 16)
    || (value.parentSpanId !== null && !validSpanId(value.parentSpanId, 16))
    || !['SERVER', 'CLIENT'].includes(value.kind) || !httpMethods.has(value.method)
    || !time(value.startedAt) || !time(value.endedAt) || Date.parse(value.endedAt) < Date.parse(value.startedAt)
    || !Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 86400000
    || typeof value.error !== 'boolean'
    || (value.httpStatus !== null && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599))) {
    throw new Error('Invalid normalized HTTP span');
  }
  // Deliberately discard every field outside this fixed vocabulary.
  return { spanId: value.spanId, parentSpanId: value.parentSpanId, kind: value.kind, method: value.method,
    startedAt: value.startedAt, endedAt: value.endedAt, durationMs: value.durationMs, httpStatus: value.httpStatus, error: value.error };
}
