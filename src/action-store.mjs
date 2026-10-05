import { openSync, closeSync, writeFileSync, readFileSync, fsyncSync, renameSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { validateGraph } from './evidence-contract.mjs';
import { validSourcePath } from './project-sources.mjs';

const maxBytes = 64 * 1024 * 1024;
const storageOperations = new Set(['initialize', 'load', 'save']);
const storageStages = new Set(['directory', 'lock', 'stat', 'read', 'parse', 'validate', 'retention',
  'open', 'write', 'sync', 'close', 'rename']);
const filesystemCodes = new Set(['EACCES', 'EPERM', 'EIO', 'EROFS', 'EBADF', 'EINVAL', 'EMFILE', 'ENFILE',
  'ENOTDIR', 'EISDIR', 'EEXIST', 'ENOENT', 'ENOSPC', 'EBUSY', 'ENOTEMPTY', 'EFBIG', 'EDQUOT',
  'ENOMEM', 'EXDEV', 'ENAMETOOLONG', 'ELOOP']);
const renamePauses = [5, 10, 20, 40];
const renameWait = new Int32Array(new SharedArrayBuffer(4));
const immutableFileDigests = new WeakMap();

function fileDigest(files) {
  const previous = immutableFileDigests.get(files);
  if (previous !== undefined) return previous;
  const digest = createHash('sha256').update(Object.keys(files).sort()
    .map((file) => `${file}\0${files[file]}`).join('\n')).digest('hex');
  // Only frozen own string data is immutable. A frozen getter can still change.
  if (files && typeof files === 'object' && !Array.isArray(files) && Object.isFrozen(files)
    && [Object.prototype, null].includes(Object.getPrototypeOf(files))
    && Object.values(Object.getOwnPropertyDescriptors(files)).every((entry) => typeof entry.value === 'string')) {
    immutableFileDigests.set(files, digest);
  }
  return digest;
}

export function replaceStateFile(source, destination, { platform = process.platform, rename = renameSync,
  pause = (milliseconds) => Atomics.wait(renameWait, 0, 0, milliseconds) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { rename(source, destination); return; }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
        || attempt >= renamePauses.length) throw error;
      // Reuse the same flushed temporary file. Memory changes only after a successful replacement.
      pause(renamePauses[attempt]);
    }
  }
}
export class StorageError extends Error {
  constructor(message, cause, { operation, stage } = {}) {
    super(message, { cause });
    this.code = 'FLOWATLAS_STORAGE_ERROR';
    this.operation = operation;
    this.stage = stage;
  }
}

// Only fixed vocabulary is allowed: filesystem messages and paths may contain private data.
export function storageErrorDiagnostic(error) {
  let cause = error.cause;
  for (let depth = 0; depth < 4 && cause instanceof StorageError; depth++) cause = cause.cause;
  return Object.freeze({
    code: 'FLOWATLAS_STORAGE_ERROR',
    operation: storageOperations.has(error.operation) ? error.operation : 'unknown',
    stage: storageStages.has(error.stage) ? error.stage : 'unknown',
    causeCode: filesystemCodes.has(cause?.code) ? cause.code : 'UNKNOWN',
  });
}

function validateSavedAction(action) {
  const issues = validateGraph(action);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(action?.id ?? '') || action.name.length > 200
    || action.nodes.length > 100 || action.edges.length > 200) issues.push('invalid action bounds');
  const files = action.codeVersion?.files;
  const projectId = action.codeVersion?.projectId;
  if (projectId !== undefined && (typeof projectId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(projectId))) issues.push('invalid project ID');
  if (!files || Array.isArray(files) || Object.keys(files).length > 2048) issues.push('invalid source snapshot');
  else {
    for (const [file, hash] of Object.entries(files)) {
      if ((projectId === undefined ? !/^(src|public|examples)\//.test(file) : !validSourcePath(file)) || /[\\:\x00]/.test(file)
        || file.split('/').some((part) => !part || part === '.' || part === '..')
        || !/^[a-f0-9]{64}$/.test(hash)) issues.push('invalid source path or hash');
    }
    const digest = fileDigest(files);
    if (digest !== action.codeVersion.digest) issues.push('invalid snapshot digest');
  }
  return issues;
}

export class JsonActionStore {
  constructor(directory, { timing = false } = {}) {
    this.timing = timing === true ? { saves: 0, failures: 0, totalMs: 0, maxMs: 0,
      validateMs: 0, serializeMs: 0, openMs: 0, writeMs: 0, syncMs: 0, closeMs: 0, renameMs: 0,
      validateMaxMs: 0, serializeMaxMs: 0, openMaxMs: 0, writeMaxMs: 0, syncMaxMs: 0, closeMaxMs: 0, renameMaxMs: 0 } : null;
    this.directory = directory;
    this.file = join(directory, 'state.json');
    this.lock = join(directory, '.writer.lock');
    this.token = randomUUID();
    this.closed = false;
    let stage = 'directory';
    try {
      mkdirSync(directory, { recursive: true });
      stage = 'lock';
      const fd = openSync(this.lock, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token: this.token })); }
      finally { closeSync(fd); }
    } catch (error) {
      throw new StorageError(error.code === 'EEXIST'
        ? 'Storage directory is locked; another collector or a stale lock may exist'
        : 'Unable to initialize action storage', error, { operation: 'initialize', stage });
    }
  }

  load(limit) {
    let stage = 'stat';
    try {
      let content;
      try {
        if (statSync(this.file).size > maxBytes) throw new Error('Storage size limit exceeded');
        stage = 'read';
        content = readFileSync(this.file, 'utf8');
      } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      stage = 'parse';
      const state = JSON.parse(content);
      stage = 'validate';
      if (state.storageVersion !== 1 || !Array.isArray(state.actions) || state.actions.length > 100) throw new Error('Invalid storage format');
      const ids = new Set();
      for (const action of state.actions) {
        if (validateSavedAction(action).length || ids.has(action.id)) throw new Error('Invalid saved graph');
        ids.add(action.id);
      }
      const retained = state.actions.slice(-limit);
      stage = 'retention';
      if (retained.length !== state.actions.length) this.save(retained);
      return retained;
    } catch (error) {
      throw new StorageError('Invalid saved actions; original file has been preserved', error,
        { operation: 'load', stage });
    }
  }

  save(actions) {
    const started = this.timing ? performance.now() : null;
    let measuredAt = started, measuredStage = 'validate';
    const measure = this.timing ? (next) => {
      const now = performance.now(), elapsed = now - measuredAt;
      this.timing[`${measuredStage}Ms`] += elapsed;
      this.timing[`${measuredStage}MaxMs`] = Math.max(this.timing[`${measuredStage}MaxMs`], elapsed);
      measuredAt = now; measuredStage = next;
    } : null;
    const temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
    let fd;
    let created = false;
    let stage = 'validate';
    try {
      if (this.closed) throw new Error('Storage is closed');
      if (actions.length > 100 || actions.some((action) => validateSavedAction(action).length)) throw new Error('Invalid graph');
      measure?.('serialize');
      const content = JSON.stringify({ storageVersion: 1, actions });
      if (Buffer.byteLength(content) > maxBytes) throw new Error('Storage size limit exceeded');
      measure?.('open');
      stage = 'open';
      fd = openSync(temporary, 'wx', 0o600);
      created = true;
      measure?.('write');
      stage = 'write';
      writeFileSync(fd, content);
      measure?.('sync');
      stage = 'sync';
      fsyncSync(fd);
      measure?.('close');
      stage = 'close';
      closeSync(fd);
      fd = undefined;
      measure?.('rename');
      stage = 'rename';
      replaceStateFile(temporary, this.file);
    } catch (error) {
      if (this.timing) this.timing.failures++;
      if (fd !== undefined) closeSync(fd);
      if (created) { try { unlinkSync(temporary); } catch { /* Preserve the original state on write failure. */ } }
      throw new StorageError('Unable to persist action; previous saved state has been preserved', error,
        { operation: 'save', stage });
    } finally {
      if (this.timing) {
        measure(measuredStage); const elapsed = performance.now() - started;
        this.timing.saves++; this.timing.totalMs += elapsed; this.timing.maxMs = Math.max(this.timing.maxMs, elapsed);
      }
    }
  }

  timingHealth() { return this.timing ? Object.freeze({ ...this.timing }) : null; }

  close() {
    if (this.closed) return;
    const owner = JSON.parse(readFileSync(this.lock, 'utf8'));
    if (owner.token !== this.token) throw new StorageError('Storage lock ownership changed');
    unlinkSync(this.lock);
    this.closed = true;
  }
}
