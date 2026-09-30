import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerApp } from '../scripts/register-app.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const parent = join(root, 'reports', 'storage');
function workspace(t) {
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'doctor-'));
  t.after(() => {
    const path = relative(parent, directory);
    assert.ok(path && !path.startsWith('..') && !isAbsolute(path));
    rmSync(directory, { recursive: true, force: true });
  });
  const app = join(directory, 'app'); mkdirSync(app);
  for (const file of ['server.mjs', 'index.html']) copyFileSync(join(root, 'examples', 'registered-app', file), join(app, file));
  const config = join(directory, 'config.json');
  registerApp({ id: 'doctor-app', root: relative(root, app), sources: ['index.html'], config: relative(root, config) });
  return { directory, app, config, data: join(directory, 'state') };
}
function runDoctor(work, args = [], env = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'cli.mjs'), 'doctor', '--config', relative(root, work.config),
    '--data-dir', relative(root, work.data), '--json', ...args], { cwd: work.directory, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0', ...env } });
}

test('CLI doctor checks registered entry, matching adapters, ports and storage without creating state', (t) => {
  const work = workspace(t);
  const before = readFileSync(work.config);
  const result = runDoctor(work);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 7);
  assert.ok(report.checks.every((item) => item.status === 'pass'));
  assert.equal(existsSync(work.data), false);
  assert.deepEqual(readFileSync(work.config), before);
});

test('doctor reports syntax, adapter mismatch and lock without changing owner files', (t) => {
  const work = workspace(t);
  const entry = join(work.app, 'server.mjs');
  const adapter = join(work.app, 'node-adapter.mjs');
  writeFileSync(entry, 'export function broken( {');
  writeFileSync(adapter, 'owner code');
  mkdirSync(work.data); writeFileSync(join(work.data, '.writer.lock'), 'owner lock');
  const result = runDoctor(work);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.filter((item) => item.status === 'fail').map((item) => item.id), ['entry', 'adapters', 'storage']);
  assert.equal(readFileSync(entry, 'utf8'), 'export function broken( {');
  assert.equal(readFileSync(adapter, 'utf8'), 'owner code');
  assert.equal(readFileSync(join(work.data, '.writer.lock'), 'utf8'), 'owner lock');
});

test('doctor rejects occupied ports and escaped data/config paths without starting the app', async (t) => {
  const work = workspace(t);
  const occupied = createServer();
  await new Promise((ready) => occupied.listen(0, '127.0.0.1', ready));
  try {
    const busy = runDoctor(work, [], { FLOWATLAS_COLLECTOR_PORT: String(occupied.address().port) });
    assert.equal(busy.status, 1);
    assert.equal(JSON.parse(busy.stdout).checks.find((item) => item.id === 'collector-port').status, 'fail');
    const escape = spawnSync(process.execPath, [join(root, 'scripts/cli.mjs'), 'doctor', '--config', '../outside.json',
      '--data-dir', '../outside', '--json'], { cwd: work.directory, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0' } });
    assert.equal(escape.status, 1);
    assert.deepEqual(JSON.parse(escape.stdout).checks.filter((item) => item.status === 'fail').map((item) => item.id), ['registration', 'storage']);
    assert.equal(existsSync(work.data), false);
  } finally { await new Promise((closed) => occupied.close(closed)); }
});

test('CLI help and version work from another directory and unknown commands fail', () => {
  const run = (...args) => spawnSync(process.execPath, [join(root, 'scripts/cli.mjs'), ...args],
    { cwd: dirname(root), encoding: 'utf8', timeout: 5000 });
  assert.match(run('--help').stdout, /doctor, inspect/);
  assert.equal(run('--version').stdout.trim(), JSON.parse(readFileSync(join(root, 'package.json'))).version);
  assert.equal(run('unknown').status, 1);
});
