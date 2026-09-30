import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerApp } from '../scripts/register-app.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const credential = randomBytes(32).toString('base64url');
const parent = join(root, 'reports', 'storage');
function workspace() { mkdirSync(parent, { recursive: true }); return mkdtempSync(join(parent, 'register-')); }
function cleanup(directory) {
  const path = relative(parent, directory);
  assert.ok(path && !path.startsWith('..') && !isAbsolute(path));
  rmSync(directory, { recursive: true, force: true });
}

test('register command copies adapters, configures a separate app, and inspector captures its action', { timeout: 30000 }, async () => {
  const directory = workspace();
  const target = join(directory, 'target'); mkdirSync(target);
  for (const file of ['server.mjs', 'index.html']) copyFileSync(join(root, 'examples', 'registered-app', file), join(target, file));
  const config = join(directory, 'config.json');
  const state = join(directory, 'state');
  let child;
  try {
    const registered = spawnSync(process.execPath, ['scripts/register-app.mjs', '--id', 'registered-qa',
      '--root', relative(root, target), '--source', 'index.html', '--config', relative(root, config)],
    { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.equal(registered.status, 0, registered.stderr || registered.error?.message);
    assert.match(registered.stdout, /Copied 2 adapter file/);
    const record = JSON.parse(readFileSync(config, 'utf8')).projects[0];
    assert.equal(record.id, 'registered-qa');
    assert.deepEqual(record.files, ['server.mjs', 'index.html', 'node-adapter.mjs', 'project-sources.mjs']);
    for (const file of ['node-adapter.mjs', 'project-sources.mjs']) {
      assert.deepEqual(readFileSync(join(target, file)), readFileSync(join(root, 'src', file)));
    }
    child = spawn(process.execPath, ['scripts/inspect.mjs', '--project', 'registered-qa',
      '--config', relative(root, config), '--data-dir', relative(root, state)], {
      cwd: root, env: { ...process.env, FLOWATLAS_SESSION_TOKEN: credential, FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const [collector, app] = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error(`Inspector startup timeout: ${output}`)), 12000);
      const inspect = () => {
        const a = output.match(/FlowAtlas: (http:\/\/127\.0\.0\.1:\d+)/);
        const b = output.match(/App: (http:\/\/127\.0\.0\.1:\d+)/);
        if (a && b) { clearTimeout(timer); resolveReady([a[1], b[1]]); }
      };
      child.stdout.on('data', inspect); inspect();
      child.once('error', (error) => { clearTimeout(timer); rejectReady(error); });
      child.once('exit', (code) => { clearTimeout(timer); rejectReady(new Error(`Inspector exited ${code}: ${output}`)); });
    });
    assert.equal((await fetch(app)).status, 200);
    const id = randomUUID();
    const start = await fetch(`${app}/action-start`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'view-message' }) });
    assert.equal(start.status, 201);
    const response = await fetch(`${app}/api/message`, { headers: { 'x-flowatlas-action-id': id } });
    assert.equal(response.status, 200);
    const graph = await (await fetch(`${collector}/flowatlas/actions/${id}`, { headers: { authorization: `Bearer ${credential}` } })).json();
    assert.equal(graph.codeVersion.projectId, 'registered-qa');
    assert.equal(graph.outcome, 'success');
    assert.deepEqual(graph.edges.map((edge) => edge.status), ['observed', 'observed', 'observed', 'unknown']);
    const exited = once(child, 'exit'); child.stdin.write('stop\n');
    assert.equal((await exited)[0], 0, output);
    await assert.rejects(fetch(app));
    await assert.rejects(fetch(collector));
    assert.equal(existsSync(join(state, '.writer.lock')), false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.stdin.write('stop\n');
      const timer = setTimeout(() => child.kill(), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    cleanup(directory);
  }
});

test('registration refuses conflicting adapters and leaves config and target unchanged', () => {
  const directory = workspace();
  const target = join(directory, 'target'); mkdirSync(target);
  const config = join(directory, 'config.json');
  const before = '{"projects":[]}\n';
  try {
    writeFileSync(join(target, 'server.mjs'), 'console.log("existing app");\n');
    writeFileSync(join(target, 'node-adapter.mjs'), 'owner code\n');
    writeFileSync(config, before);
    assert.throws(() => registerApp({ id: 'owner-app', root: relative(root, target), config: relative(root, config) }),
      /Adapter already exists with different contents/);
    assert.equal(readFileSync(config, 'utf8'), before);
    assert.equal(readFileSync(join(target, 'node-adapter.mjs'), 'utf8'), 'owner code\n');
    assert.equal(existsSync(join(target, 'project-sources.mjs')), false);
    assert.throws(() => registerApp({ id: 'owner-app', root: relative(root, target),
      sources: ['missing.js'], config: relative(root, config) }));
    assert.equal(readFileSync(config, 'utf8'), before);
  } finally { cleanup(directory); }
});

test('duplicate registration is rejected without changing existing config', () => {
  const directory = workspace();
  const target = join(directory, 'target'); mkdirSync(target);
  const config = join(directory, 'config.json');
  try {
    writeFileSync(join(target, 'server.mjs'), 'console.log("existing app");\n');
    const options = { id: 'owner-app', root: relative(root, target), config: relative(root, config) };
    registerApp(options);
    const before = readFileSync(config, 'utf8');
    assert.throws(() => registerApp(options), /already registered/);
    assert.equal(readFileSync(config, 'utf8'), before);
  } finally { cleanup(directory); }
});

test('registration rejects a config that inspector cannot load', () => {
  const directory = workspace();
  const target = join(directory, 'target'); mkdirSync(target);
  const config = join(directory, 'config.json');
  try {
    writeFileSync(join(target, 'server.mjs'), 'console.log("existing app");\n');
    const before = JSON.stringify({ projects: [], padding: 'x'.repeat(65536) });
    writeFileSync(config, before);
    assert.throws(() => registerApp({ id: 'owner-app', root: relative(root, target), config: relative(root, config) }),
      /config.*size/i);
    assert.equal(readFileSync(config, 'utf8'), before);
    assert.equal(existsSync(join(target, 'node-adapter.mjs')), false);
    const baseline = JSON.stringify({ projects: [], padding: '' });
    const nearLimit = JSON.stringify({ projects: [], padding: 'x'.repeat(65535 - Buffer.byteLength(baseline)) });
    assert.equal(Buffer.byteLength(nearLimit), 65535);
    writeFileSync(config, nearLimit);
    assert.throws(() => registerApp({ id: 'owner-app', root: relative(root, target), config: relative(root, config) }),
      /config.*size/i);
    assert.equal(readFileSync(config, 'utf8'), nearLimit);
    assert.equal(existsSync(join(target, 'node-adapter.mjs')), false);
  } finally { cleanup(directory); }
});
