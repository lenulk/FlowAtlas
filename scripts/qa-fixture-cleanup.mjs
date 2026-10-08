import { createConnection } from 'node:net';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { relative, isAbsolute, join } from 'node:path';

async function portClosed(origin, timeoutMs) {
  const url = new URL(origin);
  if (url.hostname !== '127.0.0.1' || !url.port) throw new Error('QA cleanup requires a known loopback port');
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(url.port) });
    const done = (closed) => { socket.destroy(); resolve(closed); };
    socket.once('connect', () => done(false));
    socket.once('error', (error) => done(error.code === 'ECONNREFUSED'));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

// QA only: never infer an owner from a PID or remove a stale lock to make a test pass.
export async function cleanupOwnedFixture({ child, closed, parent, workspace, canonical, origins, timeoutMs = 8000 }) {
  const inside = relative(realpathSync(parent), canonical);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || realpathSync(workspace) !== canonical) {
    throw new Error('QA cleanup workspace escaped its canonical parent');
  }
  let didClose = false;
  // Observe close from spawn time, including processes that exited before finally.
  const observed = closed.then(() => { didClose = true; }, () => {});
  if (child.exitCode === null && child.signalCode === null && child.stdin.writable && !child.stdin.destroyed) {
    child.stdin.end('stop\n', () => {});
  }
  const deadline = Date.now() + timeoutMs;
  let state;
  do {
    await Promise.race([observed, new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))))]);
    const portsClosed = await Promise.all(origins.map((origin) => portClosed(origin, Math.min(200, Math.max(1, deadline - Date.now())))));
    state = { closed: didClose, lockRemoved: !existsSync(join(canonical, 'data/actions/.writer.lock')), portsClosed };
    if (state.closed && state.lockRemoved && state.portsClosed.every(Boolean)) {
      rmSync(canonical, { recursive: true, force: true });
      return { ...state, removed: true };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);
  // Keep the generated workspace for diagnosis without leaving QA blocked on handles.
  child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.unref?.();
  return { ...state, removed: false };
}

// CLI owner QA: retain the fixture unless the wrapper closed and both lock-derived
// process identities are known to have stopped. An empty identity list is never proof.
export function finalizeCliOwnerFixture({ parent, workspace, canonical, lock, wrapperClosed,
  wrapperPid, ownedPids, isAlive }) {
  const inside = relative(realpathSync(parent), canonical);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || realpathSync(workspace) !== canonical) {
    throw new Error('QA cleanup workspace escaped its canonical parent');
  }
  const lockInside = relative(canonical, lock);
  if (!lockInside || lockInside.startsWith('..') || isAbsolute(lockInside)) {
    throw new Error('QA cleanup lock escaped its canonical workspace');
  }
  const identitiesKnown = Array.isArray(ownedPids) && ownedPids.length === 2 &&
    ownedPids.every(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && pid !== wrapperPid) &&
    ownedPids[0] !== ownedPids[1];
  const ownedStopped = identitiesKnown && ownedPids.every(pid => !isAlive(pid));
  const writerLockExists = existsSync(lock);
  const removed = Boolean(wrapperClosed && !writerLockExists && ownedStopped);
  if (removed) rmSync(canonical, { recursive: true, force: true });
  return { wrapperClosed: Boolean(wrapperClosed), writerLockExists, identitiesKnown, ownedStopped, removed };
}
