import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startServers } from '../src/server.mjs';

test('history queries filter name or ID and outcome before applying the limit', async () => {
  const servers = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${servers.port}`;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const send = (event) => fetch(`${base}/flowatlas/ingest`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
  try {
    for (const [i, name, outcome] of [[0, 'Message one', 'error'], [1, 'Other', 'success'], [2, 'Message two', null]]) {
      await send({ kind: 'action-start', actionId: ids[i], name });
      if (outcome) await send({ kind: 'finish', actionId: ids[i], outcome });
    }
    const list = async (query = '') => (await fetch(`${base}/flowatlas/actions${query}`)).json();
    assert.deepEqual((await list('?q=message')).map((action) => action.id), [ids[2], ids[0]]);
    assert.deepEqual((await list('?q=message&outcome=error&limit=1')).map((action) => action.id), [ids[0]]);
    assert.deepEqual((await list('?outcome=running')).map((action) => action.id), [ids[2]]);
    assert.deepEqual((await list(`?q=${ids[1]}`)).map((action) => action.id), [ids[1]]);
    assert.deepEqual(await list('?q=missing'), []);
    assert.equal((await list()).length, 3);
  } finally { await servers.close(); }
});

test('invalid history filters return 400 and storage status reflects the running mode', async () => {
  const servers = await startServers({ port: 0, inventoryPort: 0 });
  const base = `http://127.0.0.1:${servers.port}`;
  try {
    for (const query of ['?outcome=bad', '?limit=0', '?limit=101', '?limit=1.5', '?limit=NaN', `?q=${'x'.repeat(201)}`]) {
      assert.equal((await fetch(`${base}/flowatlas/actions${query}`)).status, 400, query);
    }
    assert.deepEqual(await (await fetch(`${base}/flowatlas/status`)).json(),
      { storage: 'memory', actionLimit: 100, retainedActions: 0 });
  } finally { await servers.close(); }
});
