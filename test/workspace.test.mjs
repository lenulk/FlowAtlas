import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDirectory } from '../src/workspace.mjs';
import { startServers } from '../src/server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function workspace(t) {
  const parent = join(root, 'reports', 'storage'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'workspace-'));
  t.after(() => {
    const path = relative(parent, directory);
    assert.ok(path && !path.startsWith('..') && !isAbsolute(path));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
const run = (directory, ...args) => spawnSync(process.execPath, [join(root, 'scripts', 'cli.mjs'), '--workspace', directory, ...args],
  { cwd: dirname(root), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0' } });

test('workspace demo and doctor keep app/config outside installation and preserve tool workspace', (t) => {
  const directory = workspace(t);
  const ownerConfig = join(root, 'flowatlas.config.json');
  const before = existsSync(ownerConfig) ? readFileSync(ownerConfig) : null;
  const demo = run(directory, 'demo');
  assert.equal(demo.status, 0, demo.stderr);
  const config = JSON.parse(readFileSync(join(directory, 'flowatlas.config.json')));
  assert.equal(config.projects[0].root, 'apps/message-app');
  assert.deepEqual(readFileSync(join(directory, 'apps', 'message-app', 'node-adapter.mjs')), readFileSync(join(root, 'src', 'node-adapter.mjs')));
  const checked = run(directory, 'doctor', '--json');
  assert.equal(checked.status, 0, checked.stdout || checked.stderr);
  assert.equal(JSON.parse(checked.stdout).ok, true);
  assert.equal(existsSync(join(directory, 'data')), false);
  assert.equal(existsSync(ownerConfig), before !== null);
  if (before) assert.deepEqual(readFileSync(ownerConfig), before);
  const original = readFileSync(join(directory, 'flowatlas.config.json'));
  assert.equal(run(directory, 'demo').status, 1);
  assert.deepEqual(readFileSync(join(directory, 'flowatlas.config.json')), original);
});

test('workspace storage rejects parent escapes and symlinks and does not create external files', async (t) => {
  const directory = workspace(t);
  const outside = workspace(t);
  symlinkSync(outside, join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveDataDirectory(directory, 'linked/state'), /symlinks/);
  assert.throws(() => resolveDataDirectory(directory, '../escaped'), /Data directory/);
  await assert.rejects(startServers({ port: 0, inventoryPort: 0, workspace: directory, dataDir: 'linked/state' }), /symlinks/);
  assert.equal(existsSync(join(outside, 'state')), false);
});

test('collector stores history in selected workspace and reopens it with unchanged evidence', async (t) => {
  const directory = workspace(t);
  let servers = await startServers({ port: 0, inventoryPort: 0, workspace: directory, dataDir: 'data/actions' });
  try {
    const base = `http://127.0.0.1:${servers.port}`;
    const response = await fetch(`${base}/flowatlas/action-start`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'workspace-action', name: 'view-product' }) });
    assert.equal(response.status, 201);
    const before = structuredClone(servers.atlas.get('workspace-action'));
    assert.equal(existsSync(join(directory, 'data', 'actions', 'state.json')), true);
    await servers.close();
    servers = await startServers({ port: 0, inventoryPort: 0, workspace: directory, dataDir: 'data/actions' });
    assert.deepEqual(servers.atlas.get('workspace-action'), before);
  } finally { await servers.close(); }
});

test('CLI rejects missing workspace and tool code directories before running demo', (t) => {
  const directory = workspace(t);
  assert.equal(run(join(directory, 'missing'), 'demo').status, 1);
  assert.equal(run(join(root, 'src'), 'demo').status, 1);
  assert.equal(existsSync(join(root, 'src', 'apps')), false);
});
