// Run this isolated check through run-tests.mjs: it creates only a disposable source fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServers } from '../src/server.mjs';

test('source links reject changed and removed files from an actual captured snapshot', async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const file = `public/qa-source-${randomUUID()}.txt`;
  const absolute = join(root, file);
  const storageRoot = join(root, 'reports', 'storage');
  mkdirSync(storageRoot, { recursive: true });
  const dataDir = mkdtempSync(join(storageRoot, 'source-'));
  writeFileSync(absolute, 'captured source\n');
  let servers;
  try {
    servers = await startServers({ port: 0, inventoryPort: 0, dataDir });
    const id = randomUUID();
    servers.atlas.start(id, 'source snapshot');
    const captured = structuredClone(servers.atlas.get(id).codeVersion);
    const path = `/flowatlas/source?actionId=${id}&file=${encodeURIComponent(file)}&sha256=${captured.files[file]}`;
    const url = `http://127.0.0.1:${servers.port}${path}`;
    const original = await fetch(url);
    assert.equal(original.status, 200);
    assert.equal(await original.text(), 'captured source\n');
    writeFileSync(absolute, 'changed source\n');
    assert.equal((await fetch(url)).status, 409);
    await servers.close();
    servers = await startServers({ port: 0, inventoryPort: 0, dataDir });
    assert.notEqual(servers.atlas.version.digest, captured.digest);
    assert.deepEqual(servers.atlas.get(id).codeVersion, captured);
    assert.equal((await fetch(`http://127.0.0.1:${servers.port}${path}`)).status, 409);
    const before = structuredClone(servers.atlas.get(id));
    const reused = await fetch(`http://127.0.0.1:${servers.port}/api/product`, { headers: { 'x-flowatlas-action-id': id } });
    assert.equal(reused.status, 409, 'new runtime must not append to an action captured with different code');
    const continued = await fetch(`http://127.0.0.1:${servers.port}/flowatlas/ingest`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'handler-entry', actionId: id,
        name: 'source snapshot', service: 'app', method: 'GET', path: '/source', symbol: 'handler', file: 'src/server.mjs' }) });
    assert.equal(continued.status, 409);
    assert.deepEqual(servers.atlas.get(id), before);
    unlinkSync(absolute);
    assert.equal((await fetch(`http://127.0.0.1:${servers.port}${path}`)).status, 409);
  } finally {
    if (servers) await servers.close();
    if (existsSync(absolute)) unlinkSync(absolute);
    const within = relative(storageRoot, dataDir);
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
