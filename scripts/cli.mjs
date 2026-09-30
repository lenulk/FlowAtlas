#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [command, ...args] = process.argv.slice(2);
const commands = { doctor: 'doctor.mjs', register: 'register-app.mjs', inspect: 'inspect.mjs', demo: 'create-target-app.mjs' };
if (!command || ['help', '--help', '-h'].includes(command)) {
  console.log('FlowAtlas: see how a web action reaches APIs, handlers and services.\n\nUsage: flowatlas <command> [options]\nCommands: demo, register, doctor, inspect\n\nStart: flowatlas demo → flowatlas doctor → flowatlas inspect\nUse docs/node-adapter.md to instrument your own app.');
} else if (command === '--version') {
  console.log(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
} else if (!Object.hasOwn(commands, command)) {
  console.error('Unknown command. Run flowatlas --help'); process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [join(root, 'scripts', commands[command]), ...args], { cwd: root, stdio: 'inherit' });
  const forward = (signal) => child.kill(signal);
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
