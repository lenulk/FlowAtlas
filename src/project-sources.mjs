import { readFileSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, relative, isAbsolute, join } from 'node:path';

export function validSourcePath(file) {
  return typeof file === 'string' && file.length <= 200 && /\.(mjs|cjs|js|ts|tsx|jsx|html|css)$/.test(file)
    && !/[\\:\x00]/.test(file) && file.split('/').every((part) => part && !part.startsWith('.') && part !== 'node_modules');
}

function within(parent, target, allowEqual = false) {
  const path = relative(parent, target);
  return (allowEqual && !path) || (path && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path));
}

function readAllowedSource(root, file) {
  if (!validSourcePath(file)) throw new Error('Invalid project source path');
  let path = root;
  for (const component of file.split('/')) {
    path = join(path, component);
    if (lstatSync(path).isSymbolicLink()) throw new Error('Project source symlinks are not supported');
  }
  if (!within(realpathSync(root), realpathSync(path)) || !lstatSync(path).isFile()) throw new Error('Project source escaped its root');
  if (lstatSync(path).size > 1024 * 1024) throw new Error('Project source exceeds 1 MiB');
  return readFileSync(path);
}

export function captureProjectVersion(root, files, projectId) {
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(projectId) || !Array.isArray(files)
    || files.length < 1 || files.length > 64 || new Set(files).size !== files.length) throw new Error('Invalid project registration');
  const hashes = Object.fromEntries([...files].sort().map((file) => [file,
    createHash('sha256').update(readAllowedSource(root, file)).digest('hex')]));
  const digest = createHash('sha256').update(Object.entries(hashes).map(([file, hash]) => `${file}\0${hash}`).join('\n')).digest('hex');
  let commit = null;
  let dirty = null;
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (realpathSync(gitRoot) === realpathSync(root)) {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      dirty = execFileSync('git', ['status', '--porcelain', '--', ...files], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
    }
  } catch { /* Uncommitted projects still have an exact file digest. */ }
  return { projectId, commit, dirty, digest, files: Object.freeze(hashes) };
}

export class ProjectSources {
  constructor(projectRoot, registrations = []) {
    if (!Array.isArray(registrations) || registrations.length > 16) throw new Error('Invalid project registrations');
    this.projectRoot = realpathSync(projectRoot);
    this.projects = new Map();
    for (const entry of registrations) {
      if (!entry || typeof entry.root !== 'string' || this.projects.has(entry.id)) throw new Error('Invalid or duplicate project registration');
      const directory = realpathSync(resolve(projectRoot, entry.root));
      const first = relative(this.projectRoot, directory).split(/[\\/]/)[0].toLowerCase();
      if (!within(this.projectRoot, directory) || ['src', 'public', 'examples', '.git', '.codex', '.agents'].includes(first)) {
        throw new Error('Registered project must be inside the project folder and outside collector code');
      }
      const version = captureProjectVersion(directory, entry.files, entry.id);
      this.projects.set(entry.id, { directory, files: [...entry.files], version });
    }
  }

  version(id) { return this.projects.get(id)?.version ?? null; }

  read(snapshot, file) {
    const project = this.projects.get(snapshot.projectId);
    if (!project || !project.files.includes(file)) throw new Error('Project source is no longer registered');
    // Recheck the root as well as each path component after capture.
    if (!within(this.projectRoot, realpathSync(project.directory))) throw new Error('Project root escaped the project folder');
    return readAllowedSource(project.directory, file);
  }
}

export function readProjectConfig(projectRoot, configPath = 'flowatlas.config.json') {
  const path = resolve(projectRoot, configPath);
  if (!within(realpathSync(projectRoot), path)) throw new Error('Project config must be inside the project folder');
  if (!existsSync(path) && configPath === 'flowatlas.config.json') return [];
  if (!within(realpathSync(projectRoot), realpathSync(path)) || lstatSync(path).size > 65536) throw new Error('Invalid project config path or size');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!config || !Array.isArray(config.projects)) throw new Error('Invalid project config');
  return config.projects;
}
