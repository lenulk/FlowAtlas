import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function launch(dataDir) {
  const child = spawn(process.execPath, ['scripts/qa-session.mjs'], { cwd: root,
    env: { ...process.env, FLOWATLAS_DATA_DIR: dataDir, PORT: '0', INVENTORY_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Collector did not start: ${output}`)); }, 8000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/QA: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Collector exited ${code}: ${output}`)); });
  });
  return { child, ready, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdin.write('stop\n');
    try { const [code] = await exited; assert.equal(code, 0); }
    finally { clearTimeout(timer); }
  } };
}

test('a fresh Node process loads the exact graph saved by the previous process', async () => {
  const parent = join(root, 'reports', 'storage');
  mkdirSync(parent, { recursive: true });
  const dataDir = mkdtempSync(join(parent, 'process-'));
  let processServer = launch(dataDir);
  try {
    const base = await processServer.ready;
    const id = randomUUID();
    const start = await fetch(`${base}/flowatlas/action-start`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, name: 'check-stock' }) });
    assert.equal(start.status, 201);
    assert.equal((await fetch(`${base}/api/check-stock`, { method: 'POST', headers: { 'x-flowatlas-action-id': id } })).status, 200);
    const captured = await (await fetch(`${base}/flowatlas/actions/${id}`)).json();
    await processServer.stop();
    processServer = launch(dataDir);
    const reopened = await processServer.ready;
    const response = await fetch(`${reopened}/flowatlas/actions/${id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), captured);
    assert.equal((await (await fetch(`${reopened}/flowatlas/status`)).json()).storage, 'disk');
  } finally {
    await processServer.stop();
    const within = relative(parent, dataDir);
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
