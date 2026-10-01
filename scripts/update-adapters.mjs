import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, realpathSync, existsSync, mkdirSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectSources, readProjectConfig } from '../src/project-sources.mjs';
import { resolveWorkspace, resolveDataDirectory } from '../src/workspace.mjs';

const toolRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const files = ['node-adapter.mjs', 'project-sources.mjs'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const history = JSON.parse(readFileSync(join(toolRoot, 'src/adapter-history.json'), 'utf8'));
const current = Object.fromEntries(files.map((file) => [file, readFileSync(join(toolRoot, 'src', file))]));
const known = (file, digest) => hash(current[file]) === digest || history.versions.some((version) =>
  version.files[file] === digest || version.windowsFiles?.[file] === digest);
const usage = 'Usage: flowatlas adapters update|rollback [--project ID] [--config local-file] [--data-dir local-dir] [--backup reports/adapter-backups/ID]';

function readRegular(path, max = 1048576) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > max) throw new Error('Expected a bounded regular adapter or backup file');
  return readFileSync(path);
}
function atomicWrite(path, bytes, rename = renameSync) {
  const temporary = join(dirname(path), `.flowatlas-adapter-${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temporary, 'wx', lstatSync(path).mode & 0o777); created = true;
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    rename(temporary, path); created = false;
  } finally { if (created && existsSync(temporary)) unlinkSync(temporary); }
}
function replaceFiles(target, desired, before, rename) {
  const attempted = [];
  try {
    for (const file of files) {
      if (!readRegular(join(target, file)).equals(before[file])) throw new Error('Adapter changed during update');
      if (desired[file].equals(before[file])) continue;
      attempted.push(file);
      atomicWrite(join(target, file), desired[file], rename);
    }
  } catch {
    let recovered = true;
    for (const file of attempted.reverse()) {
      try {
        // Preserve a concurrent owner edit; the verified backup remains available.
        const actual = readRegular(join(target, file));
        if (actual.equals(before[file])) continue;
        if (!actual.equals(desired[file])) { recovered = false; continue; }
        atomicWrite(join(target, file), before[file]);
      } catch { recovered = false; }
    }
    throw new Error(recovered ? 'Adapter update failed; previous files restored'
      : 'Adapter update failed; manual recovery from the verified backup is required');
  }
}

export function manageAdapters({ action, projectId, config = 'flowatlas.config.json', dataDir = 'data/actions', backup,
  workspace = resolveWorkspace(toolRoot) }, { rename = renameSync } = {}) {
  workspace = resolveWorkspace(toolRoot, workspace);
  if (!['update', 'rollback'].includes(action) || (action === 'update' && backup)
    || (action === 'rollback' && typeof backup !== 'string')) throw new Error(usage);
  const projects = readProjectConfig(workspace, config);
  new ProjectSources(workspace, projects);
  const project = projectId ? projects.find((item) => item.id === projectId) : projects.length === 1 ? projects[0] : null;
  if (!project || files.some((file) => !project.files.includes(file))) throw new Error('Choose a project with registered adapter files');
  const target = realpathSync(resolve(workspace, project.root));
  const data = resolveDataDirectory(workspace, dataDir);
  try { lstatSync(join(data, '.writer.lock')); throw new Error('Storage is locked; stop the inspector before changing adapters'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const before = Object.fromEntries(files.map((file) => [file, readRegular(join(target, file))]));
  for (const file of files) if (!known(file, hash(before[file]))) throw new Error(`Adapter has local edits; automatic replacement refused: ${file}`);
  let desired = current;
  let backupPath;
  if (action === 'update') {
    if (files.every((file) => current[file].equals(before[file]))) return { changed: false, projectId: project.id, backup: null };
    backupPath = resolveDataDirectory(workspace, `reports/adapter-backups/${randomUUID()}`);
    mkdirSync(backupPath, { recursive: true });
    for (const file of files) writeFileSync(join(backupPath, file), before[file], { flag: 'wx', mode: 0o600 });
    writeFileSync(join(backupPath, 'manifest.json'), JSON.stringify({ schemaVersion: 1, projectId: project.id,
      projectRoot: project.root, before: Object.fromEntries(files.map((file) => [file, hash(before[file])])),
      after: Object.fromEntries(files.map((file) => [file, hash(current[file])])) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } else {
    backupPath = resolveDataDirectory(workspace, backup);
    const path = relative(resolve(workspace, 'reports/adapter-backups'), backupPath);
    if (!path || path.startsWith('..') || path.includes('\\') || path.includes('/')) throw new Error('Backup must be a direct adapter-backups directory');
    let manifest;
    try { manifest = JSON.parse(readRegular(join(backupPath, 'manifest.json'), 8192)); }
    catch { throw new Error('Invalid adapter backup metadata'); }
    if (manifest.schemaVersion !== 1 || manifest.projectId !== project.id || manifest.projectRoot !== project.root) throw new Error('Backup does not match this project');
    desired = Object.fromEntries(files.map((file) => {
      const bytes = readRegular(join(backupPath, file));
      if (hash(bytes) !== manifest.before?.[file] || !known(file, hash(bytes))
        || !known(file, manifest.after?.[file])
        || ![manifest.before[file], manifest.after[file]].includes(hash(before[file]))) throw new Error('Backup hashes do not match managed adapters');
      return [file, bytes];
    }));
  }
  const result = { changed: files.some((file) => !before[file].equals(desired[file])), projectId: project.id,
    backup: relative(workspace, backupPath).replaceAll('\\', '/') };
  try { replaceFiles(target, desired, before, rename); }
  catch (error) { throw new Error(`${error.message}; backup: ${result.backup}`); }
  return result;
}

function parse(args) {
  const [action, ...rest] = args;
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!['--project', '--config', '--data-dir', '--backup'].includes(key) || !rest[index + 1]
      || rest[index + 1].startsWith('--') || Object.hasOwn(flags, key)) throw new Error(usage);
    flags[key] = rest[index + 1];
  }
  return { action, projectId: flags['--project'], config: flags['--config'], dataDir: flags['--data-dir'], backup: flags['--backup'] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(manageAdapters(parse(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
