import { mkdirSync, existsSync, copyFileSync, realpathSync, writeFileSync, readFileSync, lstatSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectSources, readProjectConfig } from '../src/project-sources.mjs';
import { resolveWorkspace } from '../src/workspace.mjs';

const toolRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = resolveWorkspace(toolRoot);
export const targetFiles = ['server.mjs', 'index.html', 'node-adapter.mjs', 'project-sources.mjs'];
export function createTargetApp(destination) {
  const directory = resolve(root, destination);
  const within = relative(root, directory);
  if (!within || within === '..' || within.startsWith('..\\') || within.startsWith('../') || isAbsolute(within)
    || !['apps', 'reports'].includes(within.split(/[\\/]/)[0])) throw new Error('Target app must be inside apps/ or reports/ in this project');
  if (existsSync(directory)) throw new Error('Target app already exists; no files were overwritten');
  let ancestor = dirname(directory);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const physical = relative(realpathSync(root), realpathSync(ancestor));
  if (physical === '..' || physical.startsWith('..\\') || physical.startsWith('../') || isAbsolute(physical)) throw new Error('Target app path escaped the project');
  mkdirSync(directory, { recursive: true });
  for (const file of targetFiles) copyFileSync(join(toolRoot, file.endsWith('adapter.mjs') || file === 'project-sources.mjs' ? 'src' : 'examples/registered-app', file), join(directory, file));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'flowatlas-target-example', private: true, type: 'module', scripts: { start: 'node server.mjs' } }, null, 2) + '\n');
  return directory;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = join(root, 'flowatlas.config.json');
  if (existsSync(configPath) && lstatSync(configPath).isSymbolicLink()) throw new Error('Project config symlinks are not supported');
  const registered = readProjectConfig(root);
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : { projects: registered };
  new ProjectSources(root, config.projects);
  if (config.projects.length >= 16 || config.projects.some((project) => project.id === 'message-app')) throw new Error('message-app is already configured or project limit reached');
  const directory = createTargetApp(process.argv[2] ?? 'apps/message-app');
  config.projects.push({ id: 'message-app', root: relative(root, directory).replaceAll('\\', '/'), files: targetFiles });
  const temporary = join(root, `.flowatlas-config-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  renameSync(temporary, configPath);
  console.log(`Created target app: ${directory}\nStart collector: node src/server.mjs\nStart target: node "${join(directory, 'server.mjs')}"`);
}
