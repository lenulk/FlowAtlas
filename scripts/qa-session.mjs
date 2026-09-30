import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { startServers } from '../src/server.mjs';

// Manual browser QA with an isolated, retained data directory in this project.
const dataDir = process.env.FLOWATLAS_DATA_DIR ?? `reports/storage/ui-${randomUUID()}`;
const options = { dataDir, port: Number(process.env.PORT ?? 4173), inventoryPort: Number(process.env.INVENTORY_PORT ?? 4174) };
let servers = await startServers(options);
console.log(`QA: http://127.0.0.1:${servers.port}; data: ${dataDir}`);
console.log('Commands: restart, stop');
const input = createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    if (line.trim() === 'stop') break;
    if (line.trim() === 'restart') {
      await servers.close();
      servers = await startServers(options);
      console.log(`Restarted: http://127.0.0.1:${servers.port}; retained: ${servers.atlas.actions.size}`);
    }
  }
} finally { input.close(); await servers.close(); }
