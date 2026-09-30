// Run this isolated check through run-tests.mjs: it creates only a disposable source fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServers } from '../src/server.mjs';

test('source links reject changed and removed files from an actual captured snapshot', async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const file = `public/qa-source-${randomUUID()}.txt`;
  const absolute = join(root, file);
  writeFileSync(absolute, 'captured source\n');
  let servers;
  try {
    servers = await startServers({ port: 0, inventoryPort: 0 });
    const url = `http://127.0.0.1:${servers.port}/flowatlas/source?file=${encodeURIComponent(file)}&sha256=${servers.atlas.version.files[file]}`;
    const original = await fetch(url);
    assert.equal(original.status, 200);
    assert.equal(await original.text(), 'captured source\n');
    writeFileSync(absolute, 'changed source\n');
    assert.equal((await fetch(url)).status, 409);
    unlinkSync(absolute);
    assert.equal((await fetch(url)).status, 409);
  } finally {
    if (servers) await servers.close();
    if (existsSync(absolute)) unlinkSync(absolute);
  }
});
