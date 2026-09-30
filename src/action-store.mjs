import { openSync, closeSync, writeFileSync, readFileSync, fsyncSync, renameSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { validateGraph } from './evidence-contract.mjs';

const maxBytes = 64 * 1024 * 1024;
export class StorageError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.code = 'FLOWATLAS_STORAGE_ERROR';
  }
}

function validateSavedAction(action) {
  const issues = validateGraph(action);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(action?.id ?? '') || action.name.length > 200
    || action.nodes.length > 100 || action.edges.length > 200) issues.push('invalid action bounds');
  const files = action.codeVersion?.files;
  if (!files || Array.isArray(files) || Object.keys(files).length > 2048) issues.push('invalid source snapshot');
  else {
    for (const [file, hash] of Object.entries(files)) {
      if (!/^(src|public|examples)\//.test(file) || /[\\:\x00]/.test(file)
        || file.split('/').some((part) => !part || part === '.' || part === '..')
        || !/^[a-f0-9]{64}$/.test(hash)) issues.push('invalid source path or hash');
    }
    const digest = createHash('sha256').update(Object.keys(files).sort()
      .map((file) => `${file}\0${files[file]}`).join('\n')).digest('hex');
    if (digest !== action.codeVersion.digest) issues.push('invalid snapshot digest');
  }
  return issues;
}

export class JsonActionStore {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'state.json');
    this.lock = join(directory, '.writer.lock');
    this.token = randomUUID();
    this.closed = false;
    try {
      mkdirSync(directory, { recursive: true });
      const fd = openSync(this.lock, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token: this.token })); }
      finally { closeSync(fd); }
    } catch (error) {
      throw new StorageError(error.code === 'EEXIST'
        ? 'Storage directory is locked; another collector or a stale lock may exist'
        : 'Unable to initialize action storage', error);
    }
  }

  load(limit) {
    try {
      let content;
      try {
        if (statSync(this.file).size > maxBytes) throw new Error('Storage size limit exceeded');
        content = readFileSync(this.file, 'utf8');
      } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const state = JSON.parse(content);
      if (state.storageVersion !== 1 || !Array.isArray(state.actions) || state.actions.length > 100) throw new Error('Invalid storage format');
      const ids = new Set();
      for (const action of state.actions) {
        if (validateSavedAction(action).length || ids.has(action.id)) throw new Error('Invalid saved graph');
        ids.add(action.id);
      }
      const retained = state.actions.slice(-limit);
      if (retained.length !== state.actions.length) this.save(retained);
      return retained;
    } catch (error) {
      throw new StorageError('Invalid saved actions; original file has been preserved', error);
    }
  }

  save(actions) {
    const temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
    let fd;
    let created = false;
    try {
      if (this.closed) throw new Error('Storage is closed');
      if (actions.length > 100 || actions.some((action) => validateSavedAction(action).length)) throw new Error('Invalid graph');
      const content = JSON.stringify({ storageVersion: 1, actions });
      if (Buffer.byteLength(content) > maxBytes) throw new Error('Storage size limit exceeded');
      fd = openSync(temporary, 'wx', 0o600);
      created = true;
      writeFileSync(fd, content);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.file);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (created) { try { unlinkSync(temporary); } catch { /* Preserve the original state on write failure. */ } }
      throw new StorageError('Unable to persist action; previous saved state has been preserved', error);
    }
  }

  close() {
    if (this.closed) return;
    const owner = JSON.parse(readFileSync(this.lock, 'utf8'));
    if (owner.token !== this.token) throw new StorageError('Storage lock ownership changed');
    unlinkSync(this.lock);
    this.closed = true;
  }
}
