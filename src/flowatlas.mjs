import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateEdge } from './evidence-contract.mjs';

const allowedStatuses = new Set(['observed', 'inferred', 'unknown']);

function codeFiles(root, directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const name = `${directory}/${entry.name}`;
    return entry.isDirectory() ? codeFiles(root, name) : [name];
  });
}

export function getCodeVersion(root) {
  const files = {};
  for (const file of [...codeFiles(root, 'src'), ...codeFiles(root, 'public')].sort()) {
    files[file] = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  }
  const digest = createHash('sha256')
    .update(Object.entries(files).map(([file, hash]) => `${file}\0${hash}`).join('\n'))
    .digest('hex');
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    // A file digest still identifies the running code before the first commit.
  }
  return { commit, digest, files };
}

export function sourceRef(version, file, symbol) {
  if (!version.files[file]) throw new Error(`Source file is outside the code snapshot: ${file}`);
  return { file, symbol, sha256: version.files[file], status: 'inferred' };
}

export class FlowAtlas {
  constructor(version, limit = 100) {
    this.version = version;
    this.limit = limit;
    this.actions = new Map();
  }

  start(id, name, clientTime = null, origin = 'client-reported') {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error('Invalid action ID');
    if (this.actions.has(id)) throw new Error('Action ID already exists');
    const action = {
      schemaVersion: '0.1', id, name, clientTime,
      startedAt: new Date().toISOString(), finishedAt: null, outcome: 'running',
      codeVersion: this.version,
      nodes: [{ id: 'action', type: 'user-action', label: name, origin }], edges: [],
    };
    this.actions.set(id, action);
    if (this.actions.size > this.limit) this.actions.delete(this.actions.keys().next().value);
    return action;
  }

  ensure(id, name = 'Unregistered action') {
    return this.actions.get(id) ?? this.start(id, name, null, 'unverified');
  }

  node(action, node) {
    if (!action.nodes.some((existing) => existing.id === node.id)) action.nodes.push(node);
  }

  edge(action, from, to, status, evidence) {
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
    action.finishedAt = new Date().toISOString();
    action.outcome = outcome;
  }

  get(id) { return this.actions.get(id) ?? null; }

  list() {
    return [...this.actions.values()].reverse().map(({ id, name, startedAt, outcome }) => ({ id, name, startedAt, outcome }));
  }
}
