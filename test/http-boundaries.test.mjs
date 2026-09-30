import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';

test('malformed request URLs return 400 without terminating the authenticated collector', { timeout: 15000 }, async () => {
  const token = randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
import { startServers } from './src/server.mjs';
const servers = await startServers({ port: 0, inventoryPort: 0, sessionToken: process.env.FLOWATLAS_SESSION_TOKEN });
console.log('Collector: http://127.0.0.1:' + servers.port + '; inventory: http://127.0.0.1:' + servers.inventoryPort);
process.once('SIGTERM', () => servers.close());
`], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FLOWATLAS_SESSION_TOKEN: token } });
  let output = ''; child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const [base, inventory] = await new Promise((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('Collector readiness timed out')), 8000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/Collector: (http:\/\/127\.0\.0\.1:\d+); inventory: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); ready([match[1], match[2]]); }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Collector exited before readiness')); });
    });
    for (const target of [base, inventory]) {
      const status = await new Promise((done) => {
        const call = request({ hostname: '127.0.0.1', port: new URL(target).port,
          path: 'http://[', method: 'GET', timeout: 2000 }, (response) => {
          response.resume(); response.on('end', () => done(response.statusCode));
        });
        call.on('error', () => done(0)); call.on('timeout', () => call.destroy()); call.end();
      });
      assert.equal(status, 400, 'Malformed URL must receive a bounded error response');
    }
    assert.equal((await (await fetch(inventory + '/inventory/check')).json()).stock, 2);
    assert.equal((await fetch(base + '/flowatlas/status', { headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.equal(child.exitCode, null);
    assert.equal(output.includes(token), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  }
});
