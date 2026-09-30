import { constants, copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectSources, captureProjectVersion, validSourcePath } from '../src/project-sources.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const adapters = ['node-adapter.mjs', 'project-sources.mjs'];
const usage = 'Usage: node scripts/register-app.mjs --id ID --root apps/DIR [--entry server.mjs] [--source path]... [--config flowatlas.config.json]';

function inside(parent, target, allowEqual = false) {
  const path = relative(parent, target);
  return (allowEqual && !path) || (path && path !== '..' && !path.startsWith('../')
    && !path.startsWith('..\\') && !isAbsolute(path));
}

function existsIncludingSymlink(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function registerApp({ id, root, entry = 'server.mjs', sources = [], config = 'flowatlas.config.json' }) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)
    || typeof root !== 'string' || !root || typeof config !== 'string' || !config
    || typeof entry !== 'string' || !/\.(mjs|cjs|js)$/.test(entry) || !validSourcePath(entry)
    || !Array.isArray(sources) || sources.some((file) => !validSourcePath(file))) throw new Error(usage);

  const resolvedRoot = realpathSync(projectRoot);
  const targetPath = resolve(resolvedRoot, root);
  if (!inside(resolvedRoot, targetPath) || lstatSync(targetPath).isSymbolicLink()
    || !lstatSync(targetPath).isDirectory()) throw new Error('App root must be a real directory inside FlowAtlas');
  const appRoot = realpathSync(targetPath);
  if (!inside(resolvedRoot, appRoot) || ['src', 'public', 'examples', '.git', '.codex', '.agents']
    .includes(relative(resolvedRoot, appRoot).split(/[\\/]/)[0].toLowerCase())) {
    throw new Error('App root cannot point to collector code or leave FlowAtlas');
  }
  const configPath = resolve(resolvedRoot, config);
  if (!inside(resolvedRoot, configPath) || !inside(resolvedRoot, realpathSync(dirname(configPath)), true)
    || (existsIncludingSymlink(configPath) && (lstatSync(configPath).isSymbolicLink()
      || !lstatSync(configPath).isFile()))) throw new Error('Config must be a regular file inside FlowAtlas');
  const configExists = existsIncludingSymlink(configPath);
  if (configExists && lstatSync(configPath).size > 65536) throw new Error('Project config exceeds 64 KiB size limit');
  const current = configExists ? JSON.parse(readFileSync(configPath, 'utf8')) : { projects: [] };
  if (!current || !Array.isArray(current.projects)) throw new Error('Invalid project config');
  new ProjectSources(resolvedRoot, current.projects);
  if (current.projects.some((project) => project.id === id)) throw new Error(`Project ID already registered: ${id}`);
  if (current.projects.length >= 16) throw new Error('Project registration limit reached');

  const files = [...new Set([entry, ...sources, ...adapters])];
  if (files.length > 64) throw new Error('Too many source files');
  const registration = { id, root: relative(resolvedRoot, appRoot).replaceAll('\\', '/'), files };
  const updated = { ...current, projects: [...current.projects, registration] };
  const serialized = JSON.stringify(updated, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > 65536) throw new Error('Updated project config exceeds 64 KiB size limit');
  captureProjectVersion(appRoot, files.filter((file) => !adapters.includes(file)), id);
  for (const file of adapters) {
    const destination = join(appRoot, file);
    if (existsIncludingSymlink(destination) && (lstatSync(destination).isSymbolicLink()
      || !lstatSync(destination).isFile()
      || !readFileSync(destination).equals(readFileSync(join(resolvedRoot, 'src', file))))) {
      throw new Error(`Adapter already exists with different contents: ${file}`);
    }
  }

  const copied = [];
  let temporary;
  try {
    for (const file of adapters) {
      const destination = join(appRoot, file);
      if (!existsIncludingSymlink(destination)) {
        copyFileSync(join(resolvedRoot, 'src', file), destination, constants.COPYFILE_EXCL);
        copied.push(destination);
      }
    }
    new ProjectSources(resolvedRoot, updated.projects);
    temporary = join(dirname(configPath), `.flowatlas-config-${randomUUID()}.tmp`);
    writeFileSync(temporary, serialized, { flag: 'wx' });
    renameSync(temporary, configPath);
    temporary = undefined;
    return { registration, copied, configPath, entry };
  } catch (error) {
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
    for (const path of copied) unlinkSync(path);
    throw error;
  }
}

function parse(args) {
  const options = { sources: [] };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--id', '--root', '--entry', '--source', '--config'].includes(key) || !args[index + 1]
      || (key !== '--source' && Object.hasOwn(options, key))) throw new Error(usage);
    if (key === '--source') options.sources.push(args[index + 1]);
    else options[key] = args[index + 1];
  }
  return { id: options['--id'], root: options['--root'], entry: options['--entry'],
    sources: options.sources, config: options['--config'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = registerApp(parse(process.argv.slice(2)));
    console.log(`Registered ${result.registration.id} in ${result.configPath}`);
    console.log(`Copied ${result.copied.length} adapter file(s). Add browser action IDs and server instrumentation as described in docs/node-adapter.md`);
    console.log(`After instrumentation, run: node scripts/inspect.mjs --project ${result.registration.id} --entry ${result.entry} --config "${relative(projectRoot, result.configPath)}"`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
