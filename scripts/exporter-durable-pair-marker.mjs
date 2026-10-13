const marker = 'FLOWATLAS_SLOW_SYNC ';
const maxTapBytes = 16 * 1024 * 1024;
const maxMarkerLineBytes = 256;

export function parseSlowSyncMarkers(tapText, expectedDelayMs = 120) {
  if (typeof tapText !== 'string' || Buffer.byteLength(tapText, 'utf8') > maxTapBytes
    || !Number.isSafeInteger(expectedDelayMs) || expectedDelayMs < 1) {
    throw new Error('invalid_slow_sync_marker');
  }

  const records = [];
  for (const line of tapText.split(/\r?\n/)) {
    if (!line.includes('FLOWATLAS_SLOW_SYNC')) continue;
    if (Buffer.byteLength(line, 'utf8') > maxMarkerLineBytes || records.length !== 0) {
      throw new Error('invalid_slow_sync_marker');
    }
    const payload = line.startsWith(marker) ? line.slice(marker.length)
      : line.startsWith('# ' + marker) ? line.slice(marker.length + 2) : null;
    if (payload === null) throw new Error('invalid_slow_sync_marker');

    let record;
    try { record = JSON.parse(payload); }
    catch { throw new Error('invalid_slow_sync_marker'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).sort().join(',') !== 'calls,delayMs,openDescriptors'
      || !Number.isSafeInteger(record.delayMs) || record.delayMs !== expectedDelayMs
      || !Number.isSafeInteger(record.calls) || record.calls < 1
      || !Number.isSafeInteger(record.openDescriptors) || record.openDescriptors < 0) {
      throw new Error('invalid_slow_sync_marker');
    }
    records.push({ delayMs: record.delayMs, calls: record.calls, openDescriptors: record.openDescriptors });
  }
  return records;
}
