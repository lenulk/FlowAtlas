import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateEdge } from './evidence-contract.mjs';

const allowedStatuses = new Set(['observed', 'inferred', 'unknown']);

function codeFiles(root, directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const name = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? codeFiles(root, name) : [name];
  });
}

export function getCodeVersion(root) {
  const files = {};
  for (const file of [...codeFiles(root, 'src'), ...codeFiles(root, 'public'), ...codeFiles(root, 'examples')].sort()) {
    files[file] = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  }
  const digest = createHash('sha256')
    .update(Object.entries(files).map(([file, hash]) => `${file}\0${hash}`).join('\n'))
    .digest('hex');
  let commit = null;
  let dirty = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'public', 'examples'], {
      cwd: root, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim().length > 0;
  } catch {
    // A file digest still identifies the running code before the first commit.
  }
  return { commit, dirty, digest, files };
}

export function sourceRef(version, file, symbol) {
  if (!Object.hasOwn(version.files, file)) throw new Error(`Source file is outside the code snapshot: ${file}`);
  return { file, symbol, sha256: version.files[file], status: 'inferred' };
}

export class FlowAtlas {
  constructor(version, limit = 100, store = null, projectSources = null) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid action limit');
    this.version = version;
    this.limit = limit;
    this.store = store;
    this.projectSources = projectSources;
    this.actions = new Map((store?.load(limit) ?? []).map((action) => [action.id, action]));
  }

  start(id, name, clientTime = null, origin = 'client-reported', version = this.version) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error('Invalid action ID');
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Invalid action name');
    if (clientTime !== null && (typeof clientTime !== 'string' || clientTime.length > 64
      || Number.isNaN(Date.parse(clientTime)))) throw new Error('Invalid client time');
    if (this.actions.has(id)) throw new Error('Action ID already exists');
    const action = {
      schemaVersion: '0.1', id, name, clientTime,
      startedAt: new Date().toISOString(), finishedAt: null, outcome: 'running',
      codeVersion: version,
      nodes: [{ id: 'action', type: 'user-action', label: name, origin }], edges: [],
    };
    const next = new Map(this.actions);
    next.set(id, action);
    if (next.size > this.limit) next.delete(next.keys().next().value);
    this.store?.save([...next.values()]);
    this.actions = next;
    return action;
  }

  ensure(id, name = 'Unregistered action') {
    const existing = this.actions.get(id);
    this.assertCurrentVersion(existing, this.version);
    return existing ?? this.start(id, name, null, 'unverified');
  }

  assertCurrentVersion(action, current = action?.codeVersion.projectId
    ? this.projectSources?.version(action.codeVersion.projectId) : this.version) {
    if (action && (!current || action.codeVersion.projectId !== current.projectId || action.codeVersion.digest !== current.digest)) {
      const error = new Error('Action belongs to a different code snapshot; start a new action');
      error.code = 'FLOWATLAS_SNAPSHOT_MISMATCH';
      throw error;
    }
  }

  node(action, node) {
    const existing = action.nodes.find((item) => item.id === node.id);
    if (existing) {
      if (['type', 'label', 'service'].some((key) => existing[key] !== node[key])
        || ['file', 'symbol', 'sha256', 'status'].some((key) => existing.source?.[key] !== node.source?.[key])) {
        throw new Error(`Conflicting node declaration: ${node.id}`);
      }
      return;
    }
    if (action.nodes.length >= 100) throw new Error('Graph capacity exceeded');
    action.nodes.push(node);
  }

  edge(action, from, to, status, evidence) {
    if (action.edges.length >= 200) throw new Error('Graph capacity exceeded');
    if (!allowedStatuses.has(status)) throw new Error(`Invalid evidence status: ${status}`);
    if (!action.nodes.some((node) => node.id === from) || !action.nodes.some((node) => node.id === to)) {
      throw new Error(`Missing endpoint for edge ${from} -> ${to}`);
    }
    const edge = {
      id: `e${action.edges.length + 1}`, from, to, status,
      evidence: { ...evidence, id: randomUUID(), recordedAt: new Date().toISOString() },
    };
    const issues = validateEdge(action, edge);
    if (issues.length) throw new Error(`Invalid evidence: ${issues.join('; ')}`);
    action.edges.push(edge);
    return edge;
  }

  finish(id, outcome) {
    const action = this.actions.get(id);
    if (!action) return;
    if (!['success', 'error'].includes(outcome)) throw new Error('Invalid outcome');
    this.commit(action, { ...action, finishedAt: new Date().toISOString(), outcome });
  }

  commit(original, staged) {
    this.store?.save([...this.actions.values()].map((action) => action.id === staged.id ? staged : action));
    Object.assign(original, staged);
  }

  get(id) { return this.actions.get(id) ?? null; }

  list({ query = '', outcome = null, limit = this.limit } = {}) {
    const term = query.trim().toLowerCase();
    return [...this.actions.values()].reverse()
      .filter((action) => (!outcome || action.outcome === outcome)
        && (!term || action.name.toLowerCase().includes(term) || action.id.toLowerCase().includes(term)))
      .slice(0, limit).map(({ id, name, startedAt, outcome }) => ({ id, name, startedAt, outcome }));
  }
}
