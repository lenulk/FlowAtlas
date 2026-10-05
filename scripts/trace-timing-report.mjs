export const exporterTimingFields = Object.freeze(['batches', 'acknowledgedBatches', 'batchTotalMs', 'batchMaxMs', 'firstBatchMs',
  'shutdownQueued', 'shutdownInFlight', 'shutdownDelivered', 'shutdownMs', 'deadlineFired', 'deadlineLateMs']);
export const storageTimingFields = Object.freeze(['saves', 'failures', 'totalMs', 'maxMs',
  'validateMs', 'serializeMs', 'openMs', 'writeMs', 'syncMs', 'closeMs', 'renameMs',
  'validateMaxMs', 'serializeMaxMs', 'openMaxMs', 'writeMaxMs', 'syncMaxMs', 'closeMaxMs', 'renameMaxMs']);
export function parseTiming(output, label, fields) {
  const line = output.split('\n').find(line => line.startsWith(label));
  try {
    const value = JSON.parse(line?.slice(label.length));
    if (fields.some(field => !Number.isFinite(value[field]) || value[field] < 0 || value[field] > Number.MAX_SAFE_INTEGER
      || (!field.endsWith('Ms') && !Number.isSafeInteger(value[field])))) return null;
    return Object.fromEntries(fields.map(field => [field, value[field]]));
  } catch { return null; }
}
