export const QA_STARTUP_PREFIX = 'FlowAtlas QA startup: ';

const MAX_FRAME_BYTES = 8192;
const ROLES = Object.freeze({
  wrapper: new Set([
    'inspector-spawn-requested', 'inspector-spawned', 'owner-check-received',
    'owner-reply-sent', 'inspector-error', 'inspector-exited',
  ]),
  inspector: new Set([
    'collector-start-requested', 'collector-started', 'owner-confirm-requested',
    'owner-confirmed', 'owner-rejected', 'target-spawn-requested', 'target-spawned',
    'target-readiness-observed', 'target-readiness-failed',
  ]),
});

function validRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(ROLES, value.role) && ROLES[value.role].has(value.phase)
    && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0
    && typeof value.ownerConnected === 'boolean'
    && typeof value.childSpawned === 'boolean';
}

function canonicalRecord(value) {
  return {
    role: value.role,
    phase: value.phase,
    elapsedMs: value.elapsedMs,
    ownerConnected: value.ownerConnected,
    childSpawned: value.childSpawned,
  };
}

export function createQaStartupPhase({ role, phase, elapsedMs, ownerConnected, childSpawned } = {}) {
  const value = { role, phase, elapsedMs, ownerConnected, childSpawned };
  if (!validRecord(value)) throw new TypeError('Invalid QA startup phase');
  return canonicalRecord(value);
}

export function sanitizeQaStartupPhase(value) {
  return validRecord(value) ? canonicalRecord(value) : null;
}

export function createQaStartupPhaseParser({ limit = 20 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new TypeError('Invalid QA startup record limit');
  }

  const records = [];
  let frame = [];
  let overlong = false;
  let invalidFrames = 0;
  let overflowFrames = 0;

  function processFrame(bytes) {
    const prefixBytes = Buffer.from(QA_STARTUP_PREFIX, 'utf8');
    const startsWithPrefix = bytes.length >= prefixBytes.length
      && Buffer.from(bytes.slice(0, prefixBytes.length)).equals(prefixBytes);
    if (!startsWithPrefix) return;
    if (overlong) { overflowFrames++; return; }

    let parsed;
    try { parsed = JSON.parse(Buffer.from(bytes.slice(prefixBytes.length)).toString('utf8')); }
    catch { invalidFrames++; return; }
    const record = sanitizeQaStartupPhase(parsed);
    if (!record) { invalidFrames++; return; }
    if (records.length >= limit) { overflowFrames++; return; }
    records.push(record);
  }

  return Object.freeze({
    write(chunk) {
      let bytes;
      if (typeof chunk === 'string') bytes = Buffer.from(chunk, 'utf8');
      else if (Buffer.isBuffer(chunk)) bytes = chunk;
      else throw new TypeError('QA startup parser chunks must be Buffer or string values');

      for (const byte of bytes) {
        if (byte === 10) {
          processFrame(frame);
          frame = [];
          overlong = false;
        } else if (frame.length < MAX_FRAME_BYTES) frame.push(byte);
        else overlong = true;
      }
    },
    snapshot() {
      return {
        records: records.map((record) => ({ ...record })),
        invalidFrames,
        overflowFrames,
      };
    },
  });
}
