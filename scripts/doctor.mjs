import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectSources, readProjectConfig } from '../src/project-sources.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const usage = 'Usage: flowatlas doctor [--project ID] [--entry server.mjs] [--config local-file] [--data-dir local-dir] [--json]';
function inside(parent, target) {
  const path = relative(parent, target);
  return path && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path);
}
function parse(args) {
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (Object.hasOwn(flags, key)) throw new Error(usage);
    if (key === '--json') flags[key] = true;
    else if (['--project', '--entry', '--config', '--data-dir'].includes(key) && args[index + 1]
      && !args[index + 1].startsWith('--')) flags[key] = args[++index];
    else throw new Error(usage);
  }
  return flags;
}
async function portAvailable(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535');
  const server = createServer();
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', ready);
  });
  await new Promise((closed, reject) => server.close((error) => error ? reject(error) : closed()));
}

export async function doctor(args = []) {
  const flags = parse(args);
  const checks = [];
  const check = async (id, work) => {
    try { checks.push({ id, status: 'pass', message: await work() }); }
    catch (error) { checks.push({ id, status: 'fail', message: error.code === 'EADDRINUSE'
      ? 'Port is already in use; choose another port or stop its owner' : error.message }); }
  };
  await check('runtime', () => {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node 20 or later is required');
    return `Node ${process.versions.node}; check docs/ci.md for tested versions`;
  });
  let project;
  await check('registration', () => {
    const registrations = readProjectConfig(root, flags['--config'] ?? 'flowatlas.config.json');
    new ProjectSources(root, registrations);
    project = flags['--project'] ? registrations.find((item) => item.id === flags['--project'])
      : registrations.length === 1 ? registrations[0] : null;
    if (!project) throw new Error('Choose one registered project with --project; use flowatlas register first');
    return `${project.id}: ${project.files.length} allowed source files`;
  });
  if (project) {
    const directory = realpathSync(resolve(root, project.root));
    await check('entry', () => {
      const entry = flags['--entry'] ?? 'server.mjs';
      if (!project.files.includes(entry) || !/\.(mjs|cjs|js)$/.test(entry)) throw new Error('Entry must be a registered Node source file');
      const result = spawnSync(process.execPath, ['--check', join(directory, entry)],
        { cwd: directory, encoding: 'utf8', timeout: 5000 });
      if (result.status !== 0) throw new Error('Entry syntax check failed; run node --check on the entry to diagnose');
      return 'Entry syntax is valid; app startup and instrumentation still need a running check';
    });
    await check('adapters', () => {
      for (const file of ['node-adapter.mjs', 'project-sources.mjs']) {
        const adapter = join(directory, file);
        if (!existsSync(adapter) || lstatSync(adapter).isSymbolicLink() || !lstatSync(adapter).isFile()
          || !readFileSync(adapter).equals(readFileSync(join(root, 'src', file)))) {
          throw new Error(`Adapter missing or differs from this tool version: ${file}`);
        }
      }
      return 'Adapter files match this tool version';
    });
  }
  await check('storage', () => {
    const directory = resolve(root, flags['--data-dir'] ?? 'data/actions');
    const path = relative(root, directory);
    if (!inside(root, directory) || ['src', 'public', 'examples', '.git', '.codex', '.agents']
      .includes(path.split(/[\\/]/)[0].toLowerCase())) throw new Error('Storage must be inside FlowAtlas and outside code/config directories');
    let parent = directory;
    while (!existsSync(parent)) parent = dirname(parent);
    if ((parent !== root && !inside(realpathSync(root), realpathSync(parent))) || !lstatSync(parent).isDirectory()) {
      throw new Error('Storage parent must be a real directory inside FlowAtlas');
    }
    accessSync(parent, constants.W_OK);
    if (existsSync(join(directory, '.writer.lock'))) throw new Error('Storage is locked; inspect its owner before starting, do not delete the lock automatically');
    return 'Parent is writable and no writer lock exists; no storage files were created';
  });
  const collectorPort = Number(process.env.FLOWATLAS_COLLECTOR_PORT ?? 4173);
  const inventoryPort = Number(process.env.FLOWATLAS_INVENTORY_PORT ?? 4174);
  await check('collector-port', async () => { await portAvailable(collectorPort); return `Loopback port ${collectorPort} available at check time`; });
  await check('inventory-port', async () => {
    if (collectorPort !== 0 && collectorPort === inventoryPort) throw new Error('Collector and inventory ports must differ');
    await portAvailable(inventoryPort); return `Loopback port ${inventoryPort} available at check time`;
  });
  return { ok: checks.every((item) => item.status === 'pass'), checks, json: Boolean(flags['--json']) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await doctor(process.argv.slice(2));
    console.log(result.json ? JSON.stringify({ ok: result.ok, checks: result.checks }, null, 2)
      : result.checks.map((item) => `${item.status.toUpperCase()} ${item.id}: ${item.message}`).join('\n'));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
