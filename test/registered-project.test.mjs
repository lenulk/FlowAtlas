import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServers } from '../src/server.mjs';
import { readProjectConfig } from '../src/project-sources.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const parent = join(root, 'reports', 'storage');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'registered-'));
  const app = join(directory, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'server.mjs'), 'export function handler() { return 42; }\n');
  writeFileSync(join(app, 'secret.txt'), 'must never be served\n');
  t.after(() => {
    const within = relative(parent, directory);
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, app, projects: [{ id: 'target-app', root: relative(root, app), files: ['server.mjs'] }] };
}
const post = (base, body) => fetch(`${base}/flowatlas/ingest`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('registered projects use their own source snapshot and preserve it after restart', async (t) => {
  const f = fixture(t);
  let collector = await startServers({ port: 0, inventoryPort: 0, projects: f.projects, dataDir: join(f.directory, 'state') });
  try {
    let base = `http://127.0.0.1:${collector.port}`;
    const registration = await fetch(`${base}/flowatlas/projects/target-app`);
    assert.equal(registration.status, 200);
    const version = await registration.json();
    const id = randomUUID();
    assert.equal((await post(base, { kind: 'action-start', actionId: id, name: 'external',
      projectId: 'target-app', codeDigest: version.digest })).status, 202);
    assert.equal((await post(base, { kind: 'handler-entry', actionId: id, name: 'external',
      projectId: 'target-app', service: 'target', method: 'GET', path: '/api', symbol: 'handler', file: 'server.mjs' })).status, 202);
    const graph = await (await fetch(`${base}/flowatlas/actions/${id}`)).json();
    assert.equal(graph.codeVersion.projectId, 'target-app');
    assert.deepEqual(Object.keys(graph.codeVersion.files), ['server.mjs']);
    const source = `/flowatlas/source?actionId=${id}&file=server.mjs&sha256=${version.files['server.mjs']}`;
    assert.equal(await (await fetch(`${base}${source}`)).text(), 'export function handler() { return 42; }\n');
    assert.equal((await fetch(`${base}/flowatlas/source?actionId=${id}&file=secret.txt&sha256=${'a'.repeat(64)}`)).status, 404);
    assert.equal((await fetch(`${base}/api/product`, { headers: { 'x-flowatlas-action-id': id } })).status, 409);
    assert.deepEqual(await (await fetch(`${base}/flowatlas/actions/${id}`)).json(), graph);
    await collector.close();
    collector = await startServers({ port: 0, inventoryPort: 0, projects: f.projects, dataDir: join(f.directory, 'state') });
    base = `http://127.0.0.1:${collector.port}`;
    assert.deepEqual(await (await fetch(`${base}/flowatlas/actions/${id}`)).json(), graph);
    assert.equal((await fetch(`${base}${source}`)).status, 200);
    writeFileSync(join(f.app, 'server.mjs'), 'export function handler() { return 43; }\n');
    assert.equal((await fetch(`${base}${source}`)).status, 409);
    await collector.close();
    collector = await startServers({ port: 0, inventoryPort: 0, projects: f.projects, dataDir: join(f.directory, 'state') });
    base = `http://127.0.0.1:${collector.port}`;
    assert.equal((await post(base, { kind: 'finish', actionId: id, projectId: 'target-app', outcome: 'success' })).status, 409);
    assert.deepEqual(await (await fetch(`${base}/flowatlas/actions/${id}`)).json(), graph);
  } finally { await collector.close(); }
});

test('project identity and claimed code digest are checked before accepting any evidence', async (t) => {
  const f = fixture(t);
  const collector = await startServers({ port: 0, inventoryPort: 0, projects: f.projects });
  try {
    const base = `http://127.0.0.1:${collector.port}`;
    const version = await (await fetch(`${base}/flowatlas/projects/target-app`)).json();
    for (const [status, extras] of [[400, { projectId: 'missing', codeDigest: version.digest }],
      [400, { projectId: 'target-app' }], [409, { projectId: 'target-app', codeDigest: 'a'.repeat(64) }]]) {
      const id = randomUUID();
      assert.equal((await post(base, { kind: 'action-start', actionId: id, name: 'external', ...extras })).status, status);
      assert.equal(collector.atlas.get(id), null);
    }
    const id = randomUUID();
    assert.equal((await post(base, { kind: 'action-start', actionId: id, name: 'external',
      projectId: 'target-app', codeDigest: version.digest })).status, 202);
    const before = structuredClone(collector.atlas.get(id));
    assert.equal((await post(base, { kind: 'finish', actionId: id, projectId: 'other', outcome: 'success' })).status, 400);
    assert.equal((await post(base, { kind: 'finish', actionId: id, outcome: 'success' })).status, 400);
    assert.deepEqual(collector.atlas.get(id), before);
  } finally { await collector.close(); }
});

test('source junctions and config paths cannot bypass registration boundaries', async (t) => {
  const f = fixture(t);
  const other = join(f.directory, 'other'); mkdirSync(other);
  writeFileSync(join(other, 'server.mjs'), 'must not be read through a junction');
  symlinkSync(other, join(f.app, 'linked'), 'junction');
  await assert.rejects(startServers({ port: 0, inventoryPort: 0, projects: [{ ...f.projects[0], files: ['linked/server.mjs'] }] }), /symlink/);
  const collector = await startServers({ port: 0, inventoryPort: 0, projects: f.projects });
  try {
    const base = `http://127.0.0.1:${collector.port}`;
    const version = await (await fetch(`${base}/flowatlas/projects/target-app`)).json();
    const id = randomUUID();
    await post(base, { kind: 'action-start', actionId: id, name: 'external', projectId: 'target-app', codeDigest: version.digest });
    renameSync(f.app, join(f.directory, 'original-app'));
    symlinkSync(other, f.app, 'junction');
    const source = await fetch(`${base}/flowatlas/source?actionId=${id}&file=server.mjs&sha256=${version.files['server.mjs']}`);
    assert.equal(source.status, 409);
    assert.doesNotMatch(await source.text(), /must not be read/);
  } finally { await collector.close(); }
  assert.throws(() => readProjectConfig(root, '../outside.json'), /inside/);
  const config = join(f.directory, 'config.json');
  writeFileSync(config, '{"projects":[]}');
  assert.deepEqual(readProjectConfig(root, config), []);
  writeFileSync(config, '{"projects":null}');
  assert.throws(() => readProjectConfig(root, config), /Invalid/);
});

test('registration rejects path escapes, non-code files, duplicate IDs and inherited Git roots', async (t) => {
  const f = fixture(t);
  for (const projects of [
    [{ id: 'target-app', root: '..', files: ['server.mjs'] }],
    [{ id: 'target-app', root: relative(root, f.app), files: ['../secret.mjs'] }],
    [{ id: 'target-app', root: relative(root, f.app), files: ['secret.txt'] }],
    [f.projects[0], f.projects[0]],
    [{ ...f.projects[0], id: true }],
  ]) {
    let opened;
    try { await assert.rejects(async () => { opened = await startServers({ port: 0, inventoryPort: 0, projects }); }, /project|source|registration/i); }
    finally { if (opened) await opened.close(); }
  }
  const collector = await startServers({ port: 0, inventoryPort: 0, projects: f.projects });
  try {
    const version = await (await fetch(`http://127.0.0.1:${collector.port}/flowatlas/projects/target-app`)).json();
    assert.equal(version.commit, null, 'parent collector commit must not be reported as target commit');
  } finally { await collector.close(); }
});
