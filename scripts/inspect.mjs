import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync, lstatSync } from 'node:fs';
import { startServers } from '../src/server.mjs';
import { readProjectConfig } from '../src/project-sources.mjs';
import { resolveWorkspace } from '../src/workspace.mjs';
import { sessionToken, showPairing } from '../src/session-access.mjs';

const toolRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = resolveWorkspace(toolRoot);
const usage = 'Usage: node scripts/inspect.mjs [--project ID] [--entry registered-file] [--config local-path] [--data-dir local-path] [--app-url local-origin] [--trace http]';
function inside(parent, path) {
  const rel = relative(parent, path);
  return rel && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}
function localOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('App URL must be a local HTTP origin');
  }
  return url.origin;
}
function parse(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--project', '--entry', '--config', '--data-dir', '--app-url', '--trace'].includes(key)
      || !args[index + 1] || Object.hasOwn(options, key)) throw new Error(usage);
    options[key] = args[index + 1];
  }
  return options;
}
function confirmOwner() {
  if (!process.connected || typeof process.send !== 'function') return Promise.resolve(false);
  return new Promise((resolveOwner) => {
    const finish = (alive) => {
      clearTimeout(timer); process.off('message', message); process.off('disconnect', disconnected); resolveOwner(alive);
    };
    const message = (value) => {
      if (value === 'flowatlas:owner-alive') finish(true);
      else if (value === 'flowatlas:owner-stop') finish(false);
    };
    const disconnected = () => finish(false);
    const timer = setTimeout(() => finish(false), 1000);
    process.on('message', message); process.once('disconnect', disconnected);
    try { process.send('flowatlas:owner-check', (error) => { if (error) finish(false); }); }
    catch { finish(false); }
  });
}
async function stopTarget(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const terminate = () => child.kill('SIGTERM');
  const flushed = (message) => { if (message === 'flowatlas:flushed' || message === 'flowatlas:flush-failed') terminate(); };
  if (child.connected) {
    child.on('message', flushed);
    child.send('flowatlas:shutdown', (error) => { if (error) terminate(); });
  } else terminate();
  try { await exited; } finally { clearTimeout(timer); child.off('message', flushed); }
}
function waitForTarget(child, expectedOrigin) {
  return new Promise((resolveReady, rejectReady) => {
    let output = '';
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      child.stdout.off('data', onData); child.off('error', onError); child.off('exit', onExit);
      if (error) rejectReady(error); else resolveReady(value);
    };
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-8192);
      if (expectedOrigin) return;
      const match = output.match(/Registered app: (http:\/\/(?:127\.0\.0\.1|localhost):\d+)/);
      if (match) finish(null, localOrigin(match[1]));
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`App exited before readiness (${code})`));
    const timer = setTimeout(() => finish(new Error('App did not become ready within 10 seconds')), 10000);
    child.stdout.on('data', onData); child.once('error', onError); child.once('exit', onExit);
    if (expectedOrigin) {
      (async () => {
        while (!done) {
          try { const response = await fetch(expectedOrigin, { signal: AbortSignal.timeout(1000) });
            if (response.ok) { finish(null, expectedOrigin); break; }
          } catch { /* Wait until the app listens. */ }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        }
      })().catch(onError);
    }
  });
}

async function runInspector(args = process.argv.slice(2)) {
  const flags = parse(args);
  if (flags['--trace'] !== undefined && flags['--trace'] !== 'http') throw new Error('Trace mode must be http');
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (flags['--trace'] && (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 6))) throw new Error('HTTP trace mode requires Node 20.6 or newer; certified matrix is Node 22/24');
  const appUrl = flags['--app-url'] ? localOrigin(flags['--app-url']) : null;
  const config = readProjectConfig(root, flags['--config'] ?? 'flowatlas.config.json');
  const project = flags['--project'] ? config.find((item) => item.id === flags['--project'])
    : config.length === 1 ? config[0] : null;
  if (!project) throw new Error('Choose one registered project with --project; run node scripts/create-target-app.mjs to create the example');
  const projectRoot = realpathSync(resolve(root, project.root));
  if (!inside(realpathSync(root), projectRoot)) throw new Error('Project must be inside FlowAtlas folder');
  const entry = flags['--entry'] ?? 'server.mjs';
  if (!Array.isArray(project.files) || !project.files.includes(entry)) throw new Error('Entry must be a registered project source file');
  const entryPath = realpathSync(join(projectRoot, entry));
  if (!inside(projectRoot, entryPath) || lstatSync(entryPath).isSymbolicLink()
    || !lstatSync(entryPath).isFile() || !/\.(mjs|cjs|js)$/.test(entry)) throw new Error('Entry must be a Node source file inside the registered project');
  const dataDir = flags['--data-dir'] ?? 'data/actions';
  const credential = sessionToken(process.env.FLOWATLAS_SESSION_TOKEN);
  const servers = await startServers({ port: Number(process.env.FLOWATLAS_COLLECTOR_PORT ?? 4173),
    inventoryPort: Number(process.env.FLOWATLAS_INVENTORY_PORT ?? 4174), dataDir, projects: config, workspace: root, sessionToken: credential });
  const collectorUrl = `http://127.0.0.1:${servers.port}`;
  let target, input;
  let stopping;
  const stop = () => stopping ??= (async () => {
    input?.close();
    process.stdin.destroy();
    try { await stopTarget(target); } finally { await servers.close(); }
  })();
  const onSignal = () => stop().catch((error) => { console.error(error); process.exitCode = 1; });
  const onOwnerMessage = (message) => { if (message === 'flowatlas:owner-stop') onSignal(); };
  const managedOwner = process.env.FLOWATLAS_CLI_OWNER === '1';
  if (managedOwner) {
    // The private parent channel carries only fixed lifecycle messages, without app data.
    process.once('disconnect', onSignal);
    process.on('message', onOwnerMessage);
    process.channel?.unref();
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    // The CLI may have disappeared while storage/listeners were initializing.
    if (managedOwner && !(await confirmOwner())) {
      await stop();
      throw new Error('CLI ownership confirmation failed');
    }
    if (managedOwner && (stopping || !process.connected)) { await stop(); return; }
    const trace = flags['--trace'] === 'http';
    const targetEnv = { ...process.env };
    delete targetEnv.FLOWATLAS_CLI_OWNER;
    if (trace) {
      for (const key of Object.keys(targetEnv)) if (key.startsWith('OTEL_')) delete targetEnv[key];
      Object.assign(targetEnv, { OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none',
        OTEL_LOG_LEVEL: 'none', FLOWATLAS_TRACE_DIGEST: servers.atlas.projectSources.version(project.id).digest });
    }
    const preload = trace ? ['--experimental-loader', pathToFileURL(createRequire(import.meta.url).resolve('@opentelemetry/instrumentation/hook.mjs')).href,
      '--import', pathToFileURL(join(toolRoot, 'src/otel-preload.mjs')).href] : [];
    target = spawn(process.execPath, [...preload, entryPath], { cwd: projectRoot,
      env: { ...targetEnv, FLOWATLAS_URL: collectorUrl, FLOWATLAS_PROJECT_ID: project.id, FLOWATLAS_SESSION_TOKEN: credential,
        PORT: process.env.FLOWATLAS_APP_PORT ?? '0', EXTERNAL_PORT: process.env.FLOWATLAS_EXTERNAL_PORT ?? '0' },
      stdio: trace ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'] });
    const targetExited = once(target, 'exit');
    target.stderr.on('data', (chunk) => process.stderr.write(chunk));
    const readyUrl = await waitForTarget(target, appUrl);
    if (target.exitCode !== null || target.signalCode !== null) throw new Error('App exited during startup');
    target.stdout.pipe(process.stdout);
    console.log(`FlowAtlas: ${collectorUrl}`);
    showPairing(credential);
    console.log(`App: ${readyUrl}`);
    console.log(`Project: ${project.id}; history: ${dataDir}`);
    console.log('Click an action in the app, then open its FlowAtlas link. Type stop to close both servers.');
    input = createInterface({ input: process.stdin });
    input.on('line', (line) => { if (line.trim() === 'stop') stop().catch((error) => { console.error(error); process.exitCode = 1; }); });
    const closedInput = once(input, 'close').then(() => stop());
    const exitedTarget = targetExited.then(([code, signal]) => {
      if (!stopping) throw new Error(`App exited unexpectedly (${code ?? signal})`);
      return stop();
    });
    await Promise.race([closedInput, exitedTarget]);
    await stop();
  } catch (error) {
    await stop();
    throw error;
  } finally {
    if (managedOwner) { process.off('disconnect', onSignal); process.off('message', onOwnerMessage); }
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runInspector().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
