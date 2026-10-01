import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function waitFor(predicate, milliseconds = 8000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await predicate(); if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Owned CLI services did not reach the expected lifecycle state');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
function portClosed(origin) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(origin).port) });
    const done = (closed) => { socket.destroy(); resolve(closed); };
    socket.once('connect', () => done(false)); socket.once('error', (error) => done(error.code === 'ECONNREFUSED'));
    socket.setTimeout(200, () => done(false));
  });
}

for (const stopMode of ['owner-kill', 'SIGINT', 'SIGTERM']) for (const traced of [false, true]) test(`CLI ${stopMode} closes owned services and lock (${traced ? 'HTTP SDK flush' : 'plain HTTP'})`, { timeout: 25000 }, async (t) => {
  const parent = join(root, 'reports/storage'); mkdirSync(parent, { recursive: true });
  const workspace = mkdtempSync(join(parent, 'cli-owner-')); const canonical = realpathSync(workspace);
  mkdirSync(join(workspace, 'app'));
  writeFileSync(join(workspace, 'app/server.mjs'), `import { createServer } from 'node:http';
const server=createServer((req,res)=>{res.setHeader('content-type','application/json');
res.end(JSON.stringify({pid:process.pid,ownerEnvironment:process.env.FLOWATLAS_CLI_OWNER??null}));
if(req.url==='/terminate') res.once('finish',()=>process.exit(0));});
server.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('Registered app: http://127.0.0.1:'+server.address().port));
process.stdin.resume();
`);
  writeFileSync(join(workspace, 'flowatlas.config.json'), JSON.stringify({ projects: [{ id: 'owner-qa', root: 'app', files: ['server.mjs'] }] }));
  // Test-only driver of the CLI's JS signal handler. This is not a real OS console signal.
  const signalDriver = join(workspace, 'signal-driver.mjs');
  if (stopMode !== 'owner-kill') writeFileSync(signalDriver, `process.on('message',message=>{
if(message==='test:SIGINT'||message==='test:SIGTERM')process.emit(message.slice(5));});process.channel?.unref();`);
  const lock = join(workspace, 'data/actions/.writer.lock');
  const child = spawn(process.execPath, [...(stopMode === 'owner-kill' ? [] : ['--import', pathToFileURL(signalDriver).href]),
    join(root, 'scripts/cli.mjs'), '--workspace', workspace, 'inspect', ...(traced ? ['--trace', 'http'] : [])],
    { cwd: root, env: { ...process.env, FLOWATLAS_SESSION_TOKEN: randomBytes(32).toString('base64url'),
      FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0' },
      stdio: stopMode === 'owner-kill' ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stdout.on('data', (part) => { output += part; }); child.stderr.on('data', (part) => { output += part; });
  let inspectorPid, targetPid, app;
  try {
    const ready = await waitFor(() => {
      if (child.exitCode !== null) throw new Error('Owned CLI exited before readiness');
      const collector = output.match(/FlowAtlas: (http:\/\/127\.0\.0\.1:\d+)/), target = output.match(/App: (http:\/\/127\.0\.0\.1:\d+)/);
      return collector && target && { collector: collector[1], target: target[1] };
    }, 12000);
    app = ready.target;
    const ownership = JSON.parse(readFileSync(lock, 'utf8'));
    assert.equal(ownership.host, hostname()); inspectorPid = ownership.pid;
    const target = await (await fetch(app, { signal: AbortSignal.timeout(2000) })).json(); targetPid = target.pid;
    for (const pid of [inspectorPid, targetPid]) assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && pid !== child.pid);
    assert.notEqual(inspectorPid, targetPid);
    assert.equal(target.ownerEnvironment, null, 'CLI ownership channel flag does not enter the app');
    const closed = once(child, 'close');
    if (stopMode === 'owner-kill') child.kill('SIGKILL'); else child.send('test:' + stopMode);
    // The descendants inherit stdio; close occurs only when their inherited handles close too.
    await waitFor(async () => !existsSync(lock) && !alive(inspectorPid) && !alive(targetPid)
      && await portClosed(ready.collector) && await portClosed(app)).catch(async (error) => {
        t.diagnostic('Owner stop state: ' + JSON.stringify({ lockExists: existsSync(lock), inspectorAlive: alive(inspectorPid),
          targetAlive: alive(targetPid), collectorClosed: await portClosed(ready.collector), targetClosed: await portClosed(app),
          wrapperExited: child.exitCode !== null || child.signalCode !== null }));
        t.diagnostic('Owner fixed error codes: ' + JSON.stringify(['EPIPE', 'ECONNRESET', 'ERR_IPC_CHANNEL_CLOSED',
          'ERR_STREAM_DESTROYED', 'Storage lock ownership changed', 'ENOENT'].filter((code) => output.includes(code))));
        throw error;
      });
    const [exitCode] = await closed;
    if (stopMode !== 'owner-kill') assert.equal(exitCode, 0, 'The controlled signal handler completes ordinary shutdown');
    if (traced) {
      const summaries = [...output.matchAll(/FlowAtlas trace summary: (\{[^\n]+\})/g)];
      assert.equal(summaries.length, 1);
      assert.deepEqual(JSON.parse(summaries[0][1]), { httpSpans: 1, invalidSpans: 0, delivered: 1, dropped: 0, queued: 0, inFlight: 0 });
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end('stop\n');
    // These identities came only from this generated fixture and its freshly created lock.
    if (targetPid && alive(targetPid)) {
      try { await fetch(app + '/terminate', { signal: AbortSignal.timeout(1000) }); } catch { /* Use the known owned PID below. */ }
      if (alive(targetPid)) process.kill(targetPid, 'SIGKILL');
    }
    if (inspectorPid && alive(inspectorPid)) process.kill(inspectorPid, 'SIGTERM');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const inside = relative(realpathSync(parent), canonical);
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside) && realpathSync(workspace) === canonical);
    if (!existsSync(lock) && (!targetPid || !alive(targetPid)) && (!inspectorPid || !alive(inspectorPid))) {
      rmSync(canonical, { recursive: true, force: true });
    } else console.log('CLI owner fixture retained because cleanup could not be confirmed.');
  }
});

for (const ownerState of ['disconnected', 'silent', 'stop-requested']) test(`startup owner ${ownerState} prevents target launch and releases storage`, { timeout: 15000 }, async () => {
  const parent = join(root, 'reports/storage'); mkdirSync(parent, { recursive: true });
  const workspace = mkdtempSync(join(parent, 'cli-owner-startup-')); const canonical = realpathSync(workspace);
  mkdirSync(join(workspace, 'app'));
  const marker = join(workspace, 'app/started');
  writeFileSync(join(workspace, 'app/server.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync('started','target started');process.stdin.resume();`);
  writeFileSync(join(workspace, 'flowatlas.config.json'), JSON.stringify({ projects: [{ id: 'startup-qa', root: 'app', files: ['server.mjs'] }] }));
  const lock = join(workspace, 'data/actions/.writer.lock');
  const child = spawn(process.execPath, [join(root, 'scripts/inspect.mjs')], { cwd: workspace,
    env: { ...process.env, FLOWATLAS_WORKSPACE_ROOT: workspace, FLOWATLAS_CLI_OWNER: '1',
      FLOWATLAS_SESSION_TOKEN: randomBytes(32).toString('base64url'), FLOWATLAS_COLLECTOR_PORT: '0', FLOWATLAS_INVENTORY_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.stdout.resume(); child.stderr.resume();
  const exited = once(child, 'exit'); const watchdog = setTimeout(() => child.kill('SIGKILL'), 12000);
  try {
    if (ownerState === 'disconnected') child.disconnect();
    if (ownerState === 'stop-requested') child.on('message', (message) => {
      if (message === 'flowatlas:owner-check' && child.connected) child.send('flowatlas:owner-stop', () => {});
    });
    assert.equal((await exited)[0], 1, 'An unconfirmed owner is a failed startup, with no services left running');
    assert.equal(existsSync(marker), false, 'No app is launched after its owner disappeared');
    assert.equal(existsSync(lock), false);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const inside = relative(realpathSync(parent), canonical);
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside) && realpathSync(workspace) === canonical);
    if (!existsSync(lock) && !existsSync(marker)) rmSync(canonical, { recursive: true, force: true });
    else console.log('CLI owner startup fixture retained because cleanup could not be confirmed.');
  }
});
