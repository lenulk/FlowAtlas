const PREFIX = 'FlowAtlas independent metadata: ';
const MAX_FRAME_BYTES = 8192;
const PHASES = ['action-start', 'handler-entry', 'outbound-result', 'finish'];
const ACTIONS = ['view-message', 'send-message', 'fail-message'];
const FAILURES = ['none', 'timeout', 'network', 'http-status', 'body', 'unknown'];
const FIELDS = ['attempted', 'skipped', 'status', 'bodyRead', 'settled', 'elapsedMs', 'failure'];

function failType(message) { throw new TypeError(message); }

function validPhase(phase) {
  if (!PHASES.includes(phase)) failType('Invalid metadata phase');
}

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validStatus(value) {
  return value === null || (Number.isInteger(value) && value >= 100 && value <= 599);
}

function validElapsed(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function emptyPhase() {
  return { attempted: 0, skipped: 0, status: null, bodyRead: 0, settled: 0, elapsedMs: 0, failure: 'none' };
}

function cloneRecord(record) {
  return {
    ordinal: record.ordinal,
    action: record.action,
    phases: Object.fromEntries(PHASES.map((phase) => [phase, { ...record.phases[phase] }])),
  };
}

export function createMetadataDiagnostics({ ordinal, action } = {}) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) failType('Invalid metadata ordinal');
  if (!ACTIONS.includes(action)) failType('Invalid metadata action');

  const record = { ordinal, action, phases: Object.fromEntries(PHASES.map((phase) => [phase, emptyPhase()])) };
  const phaseState = (phase) => { validPhase(phase); return record.phases[phase]; };
  const increment = (state, field) => {
    if (state[field] === Number.MAX_SAFE_INTEGER) failType('Metadata counter overflow');
    state[field]++;
  };

  return Object.freeze({
    attempt(phase) { increment(phaseState(phase), 'attempted'); },
    skip(phase) { increment(phaseState(phase), 'skipped'); },
    status(phase, code) {
      if (!validStatus(code)) failType('Invalid metadata HTTP status');
      phaseState(phase).status = code;
    },
    bodyRead(phase) { increment(phaseState(phase), 'bodyRead'); },
    finish(phase, elapsedMs, failure = 'none') {
      if (!validElapsed(elapsedMs)) failType('Invalid metadata elapsed time');
      if (!FAILURES.includes(failure)) failType('Invalid metadata failure');
      const state = phaseState(phase);
      if (state.elapsedMs > Number.MAX_SAFE_INTEGER - elapsedMs) failType('Metadata elapsed time overflow');
      increment(state, 'settled');
      state.elapsedMs += elapsedMs;
      state.failure = failure;
    },
    snapshot() { return cloneRecord(record); },
  });
}

function sanitizedRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1 || !ACTIONS.includes(value.action)
    || !value.phases || typeof value.phases !== 'object' || Array.isArray(value.phases)) return null;

  const phaseNames = Object.keys(value.phases);
  if (phaseNames.length !== PHASES.length || PHASES.some((phase) => !Object.hasOwn(value.phases, phase))) return null;
  const phases = {};
  for (const phase of PHASES) {
    const source = value.phases[phase];
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || FIELDS.some((field) => !Object.hasOwn(source, field))) return null;
    const { attempted, skipped, status, bodyRead, settled, elapsedMs, failure } = source;
    if (![attempted, skipped, bodyRead, settled].every(validCounter)
      || !validStatus(status) || !validElapsed(elapsedMs) || !FAILURES.includes(failure)) return null;
    phases[phase] = { attempted, skipped, status, bodyRead, settled, elapsedMs, failure };
  }
  return { ordinal: value.ordinal, action: value.action, phases };
}

export function createMetadataDiagnosticParser({ limit = 100 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) failType('Invalid metadata record limit');
  const records = new Map();
  const decoder = new TextDecoder();
  let frame = [];
  let overlong = false;
  let invalidFrames = 0;
  let overflowFrames = 0;

  function processFrame(bytes) {
    const startsWithPrefix = bytes.length >= PREFIX.length
      && String.fromCharCode(...bytes.slice(0, PREFIX.length)) === PREFIX;
    if (!startsWithPrefix) return;
    if (overlong) { overflowFrames++; return; }
    let parsed;
    try {
      parsed = JSON.parse(decoder.decode(Uint8Array.from(bytes.slice(PREFIX.length))));
    } catch {
      invalidFrames++;
      return;
    }
    const record = sanitizedRecord(parsed);
    if (!record) { invalidFrames++; return; }
    if (!records.has(record.ordinal) && records.size >= limit) { overflowFrames++; return; }
    records.set(record.ordinal, record);
  }

  return Object.freeze({
    write(chunk) {
      let bytes;
      if (typeof chunk === 'string') bytes = new TextEncoder().encode(chunk);
      else if (chunk instanceof Uint8Array) bytes = chunk;
      else failType('Metadata parser chunks must be strings or Uint8Array values');
      for (const byte of bytes) {
        if (byte === 10) {
          processFrame(frame);
          frame = [];
          overlong = false;
          continue;
        }
        if (frame.length < MAX_FRAME_BYTES) frame.push(byte);
        else overlong = true;
      }
    },
    snapshot() {
      return {
        records: [...records.values()].sort((a, b) => a.ordinal - b.ordinal).map(cloneRecord),
        invalidFrames,
        overflowFrames,
      };
    },
  });
}
