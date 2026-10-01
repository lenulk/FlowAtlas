import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manageAdapters } from '../scripts/update-adapters.mjs';
import { startServers } from '../src/server.mjs';
import { ingestEvent } from '../src/ingest.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const parent = join(root, 'reports/storage');
function fixture(t) {
  mkdirSync(parent, { recursive: true }); const workspace = mkdtempSync(join(parent, 'adapter-update-'));
  const target = join(workspace, 'apps/target'); mkdirSync(target, { recursive: true });
  const old = Object.fromEntries(['node-adapter.mjs', 'project-sources.mjs'].map((file) => {
    const bytes = readFileSync(file === 'node-adapter.mjs' ? join(root, 'test/fixtures/adapter-fc273a9/node-adapter.mjs.txt') : join(root, 'src', file));
    writeFileSync(join(target, file), bytes); return [file, bytes];
  }));
  copyFileSync(join(root, 'examples/registered-app/server.mjs'), join(target, 'server.mjs'));
  copyFileSync(join(root, 'examples/registered-app/index.html'), join(target, 'index.html'));
  copyFileSync(join(root, 'src/browser-client.mjs'), join(target, 'browser-client.mjs'));
  const config = join(workspace, 'flowatlas.config.json');
  writeFileSync(config, JSON.stringify({ projects: [{ id: 'target', root: 'apps/target',
    files: ['server.mjs', 'index.html', 'node-adapter.mjs', 'project-sources.mjs', 'browser-client.mjs'] }] }));
  t.after(() => {
    const path = relative(parent, workspace); assert.ok(path && !path.startsWith('..') && !isAbsolute(path));
    rmSync(workspace, { recursive: true, force: true });
  });
  const run = (...args) => spawnSync(process.execPath, ['scripts/cli.mjs', '--workspace', workspace, 'adapters', ...args],
    { cwd: root, encoding: 'utf8', timeout: 10000 });
  return { workspace, target, config, old, run };
}

test('managed adapter update and rollback preserve owner files, config and persisted state', (t) => {
  const work = fixture(t);
  const state = join(work.workspace, 'data/actions'); mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'state.json'), '{"owner-data":"unchanged"}');
  const unchanged = Object.fromEntries([work.config, join(work.target, 'server.mjs'), join(work.target, 'index.html'),
    join(state, 'state.json')].map((path) => [path, readFileSync(path)]));
  const updated = work.run('update', '--project', 'target');
  assert.equal(updated.status, 0, updated.stderr);
  const result = JSON.parse(updated.stdout);
  assert.equal(result.changed, true);
  for (const file of Object.keys(work.old)) {
    assert.deepEqual(readFileSync(join(work.target, file)), readFileSync(join(root, 'src', file)));
    assert.deepEqual(readFileSync(join(work.workspace, result.backup, file)), work.old[file]);
  }
  const again = work.run('update', '--project', 'target');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).changed, false);
  const rolled = work.run('rollback', '--project', 'target', '--backup', result.backup);
  assert.equal(rolled.status, 0, rolled.stderr);
  for (const file of Object.keys(work.old)) assert.deepEqual(readFileSync(join(work.target, file)), work.old[file]);
  for (const [path, bytes] of Object.entries(unchanged)) assert.deepEqual(readFileSync(path), bytes);
});

test('update refuses edited adapters and active storage without touching owner files', (t) => {
  const work = fixture(t);
  writeFileSync(join(work.target, 'node-adapter.mjs'), '// owner customization\n', { flag: 'a' });
  const before = readFileSync(join(work.target, 'node-adapter.mjs'));
  const failed = work.run('update', '--project', 'target');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /local edits/);
  assert.deepEqual(readFileSync(join(work.target, 'node-adapter.mjs')), before);
  assert.equal(existsSync(join(work.workspace, 'reports/adapter-backups')), false);
  writeFileSync(join(work.target, 'node-adapter.mjs'), work.old['node-adapter.mjs']);
  const state = join(work.workspace, 'data/actions'); mkdirSync(state, { recursive: true });
  writeFileSync(join(state, '.writer.lock'), 'owner lock');
  const locked = work.run('update', '--project', 'target');
  assert.equal(locked.status, 1); assert.match(locked.stderr, /locked/);
  for (const file of Object.keys(work.old)) assert.deepEqual(readFileSync(join(work.target, file)), work.old[file]);
});

test('rollback refuses modified files and escaped or tampered backups', (t) => {
  const work = fixture(t);
  const updated = work.run('update', '--project', 'target'); assert.equal(updated.status, 0, updated.stderr);
  const result = JSON.parse(updated.stdout);
  writeFileSync(join(work.target, 'node-adapter.mjs'), '// owner edit after update\n', { flag: 'a' });
  const before = readFileSync(join(work.target, 'node-adapter.mjs'));
  const failed = work.run('rollback', '--project', 'target', '--backup', result.backup);
  assert.equal(failed.status, 1); assert.match(failed.stderr, /local edits/);
  assert.deepEqual(readFileSync(join(work.target, 'node-adapter.mjs')), before);
  assert.equal(work.run('rollback', '--project', 'target', '--backup', '../outside').status, 1);
  writeFileSync(join(work.target, 'node-adapter.mjs'), readFileSync(join(root, 'src/node-adapter.mjs')));
  writeFileSync(join(work.workspace, result.backup, 'node-adapter.mjs'), 'changed backup');
  assert.equal(work.run('rollback', '--project', 'target', '--backup', result.backup).status, 1);
  assert.deepEqual(readFileSync(join(work.target, 'node-adapter.mjs')), readFileSync(join(root, 'src/node-adapter.mjs')));
});

test('a replacement failure restores recognized originals and keeps a verified recovery backup', (t) => {
  const work = fixture(t);
  assert.throws(() => manageAdapters({ action: 'update', projectId: 'target', workspace: work.workspace }, {
    rename(from, to) { renameSync(from, to); throw new Error('simulated failure after replacement'); },
  }), /previous files restored/);
  for (const file of Object.keys(work.old)) assert.deepEqual(readFileSync(join(work.target, file)), work.old[file]);
  assert.equal(readdirSync(work.target).some((file) => file.startsWith('.flowatlas-adapter-')), false);
  const backups = readdirSync(join(work.workspace, 'reports/adapter-backups'));
  assert.equal(backups.length, 1);
  assert.deepEqual(readFileSync(join(work.workspace, 'reports/adapter-backups', backups[0], 'node-adapter.mjs')), work.old['node-adapter.mjs']);
  assert.equal(work.run('rollback', '--project', 'target', '--backup', `reports/adapter-backups/${backups[0]}`).status, 0);
});

test('recognized Windows line endings update safely and rollback restores exact original bytes', (t) => {
  const work = fixture(t);
  const windows = Buffer.from(work.old['node-adapter.mjs'].toString('utf8').replace(/\r?\n/g, '\r\n'));
  writeFileSync(join(work.target, 'node-adapter.mjs'), windows);
  const updated = work.run('update', '--project', 'target'); assert.equal(updated.status, 0, updated.stderr);
  const backup = JSON.parse(updated.stdout).backup;
  assert.deepEqual(readFileSync(join(work.workspace, backup, 'node-adapter.mjs')), windows);
  assert.equal(work.run('rollback', '--project', 'target', '--backup', backup).status, 0);
  assert.deepEqual(readFileSync(join(work.target, 'node-adapter.mjs')), windows);
});

test('upgraded adapter captures a real HTTP action and retains a previous snapshot graph', { timeout: 20000 }, async (t) => {
  const work = fixture(t);
  const projects = JSON.parse(readFileSync(work.config, 'utf8')).projects;
  const servers = await startServers({ port: 0, inventoryPort: 0, workspace: work.workspace, projects, dataDir: 'data/actions' });
  const oldId = randomUUID();
  let old;
  try {
    // Seed a validated old snapshot; this is a storage simulation, not a business run.
    ingestEvent(servers.atlas, { kind: 'action-start', actionId: oldId, name: 'old-history', projectId: 'target',
      codeDigest: servers.atlas.projectSources.version('target').digest });
    ingestEvent(servers.atlas, { kind: 'handler-entry', actionId: oldId, name: 'old-history', projectId: 'target',
      service: 'target', method: 'GET', path: '/api/message', symbol: 'viewMessage', file: 'server.mjs' });
    ingestEvent(servers.atlas, { kind: 'finish', actionId: oldId, projectId: 'target', outcome: 'success' });
    old = structuredClone(servers.atlas.get(oldId));
  } finally { await servers.close(); }
  const state = join(work.workspace, 'data/actions/state.json'); const before = readFileSync(state);
  const updated = work.run('update', '--project', 'target'); assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(readFileSync(state), before);
  const token = randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, ['scripts/cli.mjs', '--workspace', work.workspace, 'inspect'], { cwd: root,
    env: { ...process.env, FLOWATLAS_SESSION_TOKEN: token, FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stderr.on('data', (chunk) => { output += chunk; });
  const read = (url) => fetch(url, { headers: { authorization: `Bearer ${token}` } });
  try {
    const [base, target] = await new Promise((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('Upgraded inspector readiness timed out')), 10000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const a = output.match(/FlowAtlas: (http:\/\/127\.0\.0\.1:\d+)/), b = output.match(/App: (http:\/\/127\.0\.0\.1:\d+)/);
        if (a && b) { clearTimeout(timer); ready([a[1], b[1]]); }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Upgraded inspector exited before readiness')); });
    });
    assert.deepEqual(await (await read(base + `/flowatlas/actions/${oldId}`)).json(), old);
    const id = randomUUID();
    assert.equal((await fetch(target + '/action-start', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'view-message' }) })).status, 201);
    const response = await fetch(target + '/api/message', { headers: { 'x-flowatlas-action-id': id } });
    assert.equal(response.status, 200); assert.equal((await response.json()).complete, true);
    const graph = await (await read(base + `/flowatlas/actions/${id}`)).json();
    assert.equal(graph.outcome, 'success'); assert.notEqual(graph.codeVersion.digest, old.codeVersion.digest);
    const source = await read(base + `/flowatlas/source?actionId=${oldId}&file=node-adapter.mjs&sha256=${old.codeVersion.files['node-adapter.mjs']}`);
    assert.equal(source.status, 409, 'Old code must be unavailable rather than show the new adapter');
    assert.equal(output.includes(token), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.stdin.write('stop\n'); assert.equal((await exited)[0], 0);
    }
  }
});
