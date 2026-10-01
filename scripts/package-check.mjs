// Optional gate after an offline npm package installation and `flowatlas demo`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
test('installed package CLI records three actions, preserves history and closes both services', { timeout: 30000 }, async () => {
  const installed = realpathSync(process.env.FLOWATLAS_INSTALLED_ROOT ?? 'missing-installed-package');
  const path = relative(realpathSync(join(root, 'reports', 'storage')), installed);
  assert.ok(path && !path.startsWith('..') && !isAbsolute(path), 'Use a disposable installation under reports/storage');
  const workspace = realpathSync(process.env.FLOWATLAS_PACKAGE_WORKSPACE ?? installed);
  const workspacePath = relative(realpathSync(join(root, 'reports', 'storage')), workspace);
  assert.ok(workspacePath && !workspacePath.startsWith('..') && !isAbsolute(workspacePath));
  const { getCodeVersion } = await import(pathToFileURL(join(installed, 'src', 'flowatlas.mjs')));
  assert.equal(getCodeVersion(installed).commit, null, 'Package must not inherit parent Git identity');
  // Exercise the packaged update command against a known historical adapter in this disposable demo.
  const adapterPath = join(workspace, 'apps/message-app/node-adapter.mjs');
  const expectedAdapter = readFileSync(join(installed, 'src/node-adapter.mjs'));
  assert.deepEqual(readFileSync(adapterPath), expectedAdapter, 'Package QA must use an unmodified demo adapter');
  const statePath = join(workspace, 'data/actions/state.json');
  assert.equal(existsSync(join(workspace, 'data/actions/.writer.lock')), false, 'Stop the demo inspector before package QA');
  const previousState = existsSync(statePath) ? readFileSync(statePath) : null;
  const previousConfig = readFileSync(join(workspace, 'flowatlas.config.json'));
  writeFileSync(adapterPath, readFileSync(join(root, 'test/fixtures/adapter-fc273a9/node-adapter.mjs.txt')));
  const upgraded = spawnSync(process.execPath, [join(installed, 'scripts/cli.mjs'), '--workspace', workspace,
    'adapters', 'update', '--project', 'message-app'], { cwd: installed, encoding: 'utf8', timeout: 10000 });
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.equal(JSON.parse(upgraded.stdout).changed, true);
  assert.deepEqual(readFileSync(adapterPath), expectedAdapter);
  assert.deepEqual(readFileSync(join(workspace, 'flowatlas.config.json')), previousConfig);
  if (previousState) assert.deepEqual(readFileSync(statePath), previousState);
  let child;
  let credential;
  const read = (url) => fetch(url, { headers: { authorization: `Bearer ${credential}` } });
  const launch = async () => {
    credential = randomBytes(32).toString('base64url');
    child = spawn(process.execPath, [join(installed, 'scripts', 'cli.mjs'), '--workspace', workspace, 'inspect'], {
      cwd: installed, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
        FLOWATLAS_SESSION_TOKEN: credential, FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    return new Promise((ready, reject) => {
      const timer = setTimeout(() => reject(new Error(`Package startup timeout: ${output}`)), 10000);
      const inspect = () => {
        const collector = output.match(/FlowAtlas: (http:\/\/127\.0\.0\.1:\d+)/);
        const app = output.match(/App: (http:\/\/127\.0\.0\.1:\d+)/);
        if (collector && app) { clearTimeout(timer); child.stdout.off('data', inspect); ready({ collector: collector[1], app: app[1] }); }
      };
      child.stdout.on('data', inspect);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Package exited ${code}: ${output}`)); });
    });
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const current = child;
    const done = new Promise((closed) => current.once('exit', closed));
    const timer = setTimeout(() => current.kill(), 6000);
    current.stdin.write('stop\n');
    try { assert.equal(await done, 0); } finally { clearTimeout(timer); }
  };
  const post = (base, route, body) => fetch(`${base}${route}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const graphs = [];
  try {
    const first = await launch();
    assert.equal((await fetch(`${first.collector}/flowatlas/actions`)).status, 401);
    const previous = await (await read(`${first.collector}/flowatlas/actions`)).json();
    assert.ok(previous.length <= 3, 'Use a fresh fixture workspace or one prior package-check run');
    const previousGraphs = await Promise.all(previous.map(async ({ id }) =>
      (await read(`${first.collector}/flowatlas/actions/${id}`)).json()));
    for (const [name, route, method, status] of [
      ['view-message', '/api/message', 'GET', 200], ['send-message', '/api/send', 'POST', 200],
      ['fail-message', '/api/fail', 'POST', 503],
    ]) {
      const id = randomUUID();
      assert.equal((await post(first.app, '/action-start', { id, name })).status, 201);
      assert.equal((await fetch(`${first.app}${route}`, { method, headers: { 'x-flowatlas-action-id': id } })).status, status);
      const graph = await (await read(`${first.collector}/flowatlas/actions/${id}`)).json();
      assert.equal(graph.outcome, status === 200 ? 'success' : 'error');
      assert.equal(graph.codeVersion.commit, null);
      assert.deepEqual(graph.edges.map((edge) => edge.status), ['observed', 'observed', 'observed', 'unknown']);
      const source = await read(`${first.collector}/flowatlas/source?actionId=${id}&file=server.mjs&sha256=${graph.codeVersion.files['server.mjs']}`);
      assert.equal(source.status, 200);
      assert.match(await source.text(), /async function viewMessage/);
      graphs.push(graph);
    }
    await stop();
    assert.equal(readFileSync(join(workspace, 'data/actions/state.json'), 'utf8').includes(credential), false);
    const oldCredential = credential;
    await assert.rejects(fetch(first.app)); await assert.rejects(fetch(first.collector));
    assert.equal(existsSync(join(workspace, 'data', 'actions', '.writer.lock')), false);
    const restarted = await launch();
    assert.equal((await fetch(`${restarted.collector}/flowatlas/actions`, { headers: { authorization: `Bearer ${oldCredential}` } })).status, 401);
    assert.equal((await (await read(`${restarted.collector}/flowatlas/actions`)).json()).length, previous.length + 3);
    for (const graph of [...previousGraphs, ...graphs]) assert.deepEqual(await (await read(`${restarted.collector}/flowatlas/actions/${graph.id}`)).json(), graph);
    await stop();
    assert.equal(existsSync(join(workspace, 'data', 'actions', '.writer.lock')), false);
    if (workspace !== installed) {
      assert.equal(existsSync(join(installed, 'flowatlas.config.json')), false);
      assert.equal(existsSync(join(installed, 'apps')), false);
      assert.equal(existsSync(join(installed, 'data')), false);
    }
  } finally { await stop(); }
});
