#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkspace } from '../src/workspace.mjs';
import { QA_STARTUP_PREFIX, createQaStartupPhase, sanitizeQaStartupPhase } from './cli-startup-phases.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const input = process.argv.slice(2);
let workspace;
try {
  if (input[0] === '--workspace') {
    if (!input[1] || input[1].startsWith('--')) throw new Error('Usage: flowatlas [--workspace DIR] <command> [options]');
    workspace = resolveWorkspace(root, input[1]); input.splice(0, 2);
  } else workspace = resolveWorkspace(root);
} catch (error) { console.error(error.message); process.exitCode = 1; }
const [command, ...args] = input;
const commands = { doctor: 'doctor.mjs', register: 'register-app.mjs', inspect: 'inspect.mjs', demo: 'create-target-app.mjs', adapters: 'update-adapters.mjs' };
if (!workspace) {
  // Invalid workspace fails before any command can write files or open services.
} else if (!command || ['help', '--help', '-h'].includes(command)) {
  console.log('FlowAtlas: see how a web action reaches APIs, handlers and services.\n\nUsage: flowatlas [--workspace DIR] <command> [options]\nCommands: demo, register, doctor, inspect, adapters update|rollback\n\nStart: flowatlas demo → flowatlas doctor → flowatlas inspect\nUse docs/node-adapter.md to instrument your own app.');
} else if (command === '--version') {
  console.log(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
} else if (!Object.hasOwn(commands, command)) {
  console.error('Unknown command. Run flowatlas --help'); process.exitCode = 1;
} else {
  const managedInspector = command === 'inspect';
  let stopRequested = false, stopTimer;
  const qaStartup = managedInspector && process.env.FLOWATLAS_QA_STARTUP === '1';
  const qaStarted = qaStartup ? performance.now() : 0;
  let inspectorSpawned = false, managedChild;
  const qaPhase = (phase) => {
    if (!qaStartup) return;
    try {
      const record = createQaStartupPhase({ role: 'wrapper', phase,
        elapsedMs: Math.max(0, Math.round(performance.now() - qaStarted)),
        ownerConnected: Boolean(managedChild?.connected), childSpawned: inspectorSpawned });
      console.log(`${QA_STARTUP_PREFIX}${JSON.stringify(record)}`);
    } catch { /* QA output cannot affect CLI ownership. */ }
  };
  qaPhase('inspector-spawn-requested');
  const child = spawn(process.execPath, [join(root, 'scripts', commands[command]), ...args],
    { cwd: workspace, stdio: managedInspector ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
      detached: managedInspector && process.platform === 'win32', windowsHide: true,
      env: { ...process.env, FLOWATLAS_WORKSPACE_ROOT: workspace, ...(managedInspector ? { FLOWATLAS_CLI_OWNER: '1' } : {}) } });
  managedChild = child;
  if (qaStartup) child.once('spawn', () => { inspectorSpawned = true; qaPhase('inspector-spawned'); });
  if (managedInspector) child.on('message', (message) => {
    if (qaStartup && message && typeof message === 'object') {
      const record = sanitizeQaStartupPhase(message);
      if (record?.role === 'inspector') {
        try { console.log(`${QA_STARTUP_PREFIX}${JSON.stringify(record)}`); }
        catch { /* QA output cannot affect CLI ownership. */ }
        return;
      }
    }
    if (message === 'flowatlas:owner-check' && child.connected) {
      qaPhase('owner-check-received');
      child.send(stopRequested ? 'flowatlas:owner-stop' : 'flowatlas:owner-alive', (error) => {
        if (!error) qaPhase('owner-reply-sent');
      });
    }
  });
  const forward = (signal) => {
    if (!managedInspector) { child.kill(signal); return; }
    stopRequested = true;
    stopTimer ??= setTimeout(() => child.kill('SIGKILL'), 6000);
    if (child.connected) child.send('flowatlas:owner-stop', (error) => { if (error) child.kill(signal); });
    else child.kill(signal);
  };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  child.once('error', (error) => { qaPhase('inspector-error'); clearTimeout(stopTimer); console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    qaPhase('inspector-exited');
    clearTimeout(stopTimer);
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
