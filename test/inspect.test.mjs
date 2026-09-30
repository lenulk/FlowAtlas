import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { createTargetApp, targetFiles } from '../scripts/create-target-app.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const credential = randomBytes(32).toString('base64url');
test('one command starts a registered app and collector, records an action, then closes cleanly', async () => {
  const parent = join(root, 'reports', 'storage'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'inspect-'));
  const target = createTargetApp(join(directory, 'target'));
  const config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ projects: [{ id: 'message-app', root: relative(root, target), files: targetFiles }] }));
  const child = spawn(process.execPath, ['scripts/inspect.mjs', '--project', 'message-app',
    '--config', relative(root, config), '--data-dir', relative(root, join(directory, 'state'))], {
    cwd: root, env: { ...process.env, FLOWATLAS_SESSION_TOKEN: credential, FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  try {
    const [collector, app] = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error(`Inspector not ready: ${output}`)), 12000);
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
    const started = await fetch(`${app}/action-start`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'view-message' }) });
    assert.equal(started.status, 201);
    const response = await fetch(`${app}/api/message`, { headers: { 'x-flowatlas-action-id': id } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.complete, true);
    assert.equal(result.viewerUrl, `${collector}/?actionId=${id}`);
    assert.equal(output.includes(credential), false, 'Redirected CLI output must not contain the credential');
    assert.equal((await fetch(`${collector}/flowatlas/actions/${id}`)).status, 401);
    const graph = await (await fetch(`${collector}/flowatlas/actions/${id}`, { headers: { authorization: `Bearer ${credential}` } })).json();
    assert.equal(graph.outcome, 'success');
    assert.equal(graph.codeVersion.projectId, 'message-app');
    assert.equal(graph.nodes.length, 5);
    assert.deepEqual(graph.edges.map((edge) => edge.status), ['observed', 'observed', 'observed', 'unknown']);
    const exited = once(child, 'exit'); child.stdin.write('stop\n');
    const [code] = await exited; assert.equal(code, 0, output);
    await assert.rejects(fetch(collector));
    await assert.rejects(fetch(app));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.stdin.end('stop\n');
      const exited = once(child, 'exit'); const timer = setTimeout(() => child.kill(), 5000);
      try { await exited; } finally { clearTimeout(timer); } }
    const within = relative(parent, directory);
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inspector rejects nonlocal app URLs before opening a server', () => {
  const run = spawnSync(process.execPath, ['scripts/inspect.mjs', '--project', 'message-app',
    '--app-url', 'https://example.com'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /App URL must be a local HTTP origin/);
});

test('app startup failure releases collector storage lock', () => {
  const parent = join(root, 'reports', 'storage'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'inspect-failed-'));
  try {
    const target = createTargetApp(join(directory, 'target'));
    writeFileSync(join(target, 'server.mjs'), 'process.exit(9);\n');
    const config = join(directory, 'config.json');
    writeFileSync(config, JSON.stringify({ projects: [{ id: 'message-app', root: relative(root, target), files: targetFiles }] }));
    const state = join(directory, 'state');
    const run = spawnSync(process.execPath, ['scripts/inspect.mjs', '--config', relative(root, config),
      '--data-dir', relative(root, state)], { cwd: root, encoding: 'utf8', timeout: 12000,
      env: { ...process.env, FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0' } });
    assert.equal(run.status, 1, run.error?.message ?? run.stderr);
    assert.match(run.stderr, /App exited before readiness/);
    assert.equal(existsSync(join(state, '.writer.lock')), false);
  } finally {
    const within = relative(parent, directory);
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('app crash after readiness fails the CLI and releases collector port and lock', async () => {
  const parent = join(root, 'reports', 'storage'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'inspect-crash-'));
  let child;
  try {
    const target = createTargetApp(join(directory, 'target'));
    writeFileSync(join(target, 'server.mjs'), `import { createServer } from 'node:http';
const server = createServer((request, response) => {
  response.end('ok');
  if (request.url === '/crash') setTimeout(() => process.exit(9), 50);
});
server.listen(0, '127.0.0.1', () => console.log('Registered app: http://127.0.0.1:' + server.address().port));
`);
    const config = join(directory, 'config.json');
    writeFileSync(config, JSON.stringify({ projects: [{ id: 'message-app', root: relative(root, target), files: targetFiles }] }));
    const state = join(directory, 'state');
    child = spawn(process.execPath, ['scripts/cli.mjs', 'inspect', '--config', relative(root, config),
      '--data-dir', relative(root, state)], { cwd: root,
      env: { ...process.env, FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const exited = once(child, 'exit');
    const [collector, app] = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('Inspector readiness timed out')), 12000);
      const inspect = () => {
        const a = output.match(/FlowAtlas: (http:\/\/127\.0\.0\.1:\d+)/);
        const b = output.match(/App: (http:\/\/127\.0\.0\.1:\d+)/);
        if (a && b) { clearTimeout(timer); resolveReady([a[1], b[1]]); }
      };
      child.stdout.on('data', inspect);
      child.once('error', (error) => { clearTimeout(timer); rejectReady(error); });
      child.once('exit', () => { clearTimeout(timer); rejectReady(new Error('Inspector exited before ready')); });
    });
    assert.equal((await fetch(`${app}/crash`)).status, 200);
    const [code] = await exited;
    assert.equal(code, 1, output);
    assert.match(output, /App exited unexpectedly \(9\)/);
    assert.equal(existsSync(join(state, '.writer.lock')), false);
    await assert.rejects(fetch(collector));
    await assert.rejects(fetch(app));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end('stop\n');
      await once(child, 'exit');
    }
    const within = relative(parent, directory);
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
    rmSync(directory, { recursive: true, force: true });
  }
});
