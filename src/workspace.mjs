import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const protectedDirectories = ['src', 'public', 'examples', '.git', '.codex', '.agents'];
function inside(parent, target) {
  const path = relative(parent, target);
  return path && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path);
}
export function resolveWorkspace(toolRoot, requested = process.env.FLOWATLAS_WORKSPACE_ROOT ?? toolRoot) {
  const workspace = realpathSync(resolve(requested));
  if (!lstatSync(workspace).isDirectory()) throw new Error('Workspace must be an existing directory');
  const path = relative(realpathSync(toolRoot), workspace);
  if (inside(realpathSync(toolRoot), workspace) && protectedDirectories.includes(path.split(/[\\/]/)[0].toLowerCase())) {
    throw new Error('Workspace cannot be inside tool code or config directories');
  }
  return workspace;
}

export function resolveDataDirectory(workspace, requested) {
  const directory = resolve(workspace, requested);
  const path = relative(workspace, directory);
  if (!inside(workspace, directory) || protectedDirectories.includes(path.split(/[\\/]/)[0].toLowerCase())) {
    throw new Error('Data directory must be inside the workspace and outside code or Git directories');
  }
  let component = workspace;
  for (const part of path.split(/[\\/]/)) {
    component = resolve(component, part);
    try {
      if (lstatSync(component).isSymbolicLink()) throw new Error('Data directory symlinks are not supported');
    } catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  let parent = directory;
  while (!existsSync(parent)) parent = dirname(parent);
  if ((parent !== workspace && !inside(workspace, realpathSync(parent))) || !lstatSync(parent).isDirectory()) {
    throw new Error('Data directory parent must stay inside the workspace');
  }
  return directory;
}
