// QA only. Never publish child output, paths, ports, tokens or error messages.
import { performance } from 'node:perf_hooks';

const codes = new Set(['EACCES', 'EPERM', 'ENOENT', 'EMFILE', 'ENFILE', 'ENOMEM']);
const signals = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV']);
export async function awaitOwnedReadiness(wait, observer, diagnostic) {
  try { return await wait(); }
  catch (error) {
    try { diagnostic('Owner startup state: ' + JSON.stringify(observer.snapshot())); }
    catch { /* Reporting must not replace the original readiness failure. */ }
    throw error;
  } finally { observer.dispose(); }
}
export function observeOwnedStartup(child, lockExists, clock = () => performance.now()) {
  const started = clock();
  const state = { spawned: false, exited: false, closed: false, collectorReported: false,
    targetReported: false, stdoutBytes: 0, stderrBytes: 0, errorCode: null,
    exitCode: null, signal: null };
  let tail = '';
  const onSpawn = () => { state.spawned = true; };
  const onError = (error) => { state.errorCode = codes.has(error.code) ? error.code : 'OTHER'; };
  const onExit = (code, signal) => {
    state.exited = true;
    state.exitCode = Number.isSafeInteger(code) ? code : null;
    state.signal = signals.has(signal) ? signal : signal ? 'OTHER' : null;
  };
  const onClose = () => { state.closed = true; };
  const onStdout = (chunk) => {
    state.stdoutBytes = Math.min(Number.MAX_SAFE_INTEGER, state.stdoutBytes + Buffer.byteLength(chunk));
    // Bounded private tail allows a readiness marker split across pipe chunks.
    // These are observed fixture log markers, not proof that a port is reachable.
    const text = tail + chunk.toString();
    state.collectorReported ||= /FlowAtlas: http:\/\/127\.0\.0\.1:\d+/.test(text);
    state.targetReported ||= /App: http:\/\/127\.0\.0\.1:\d+/.test(text);
    tail = text.slice(-128);
  };
  const onStderr = (chunk) => {
    state.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, state.stderrBytes + Buffer.byteLength(chunk));
  };
  child.on('spawn', onSpawn); child.on('error', onError);
  child.on('exit', onExit); child.on('close', onClose);
  child.stdout.on('data', onStdout); child.stderr.on('data', onStderr);
  return {
    snapshot() {
      let writerLockExists = null;
      try { writerLockExists = Boolean(lockExists()); } catch { /* Diagnostic reads never replace the startup failure. */ }
      return { ...state, elapsedMs: Math.max(0, Math.round(clock() - started)), writerLockExists };
    },
    dispose() {
      child.off('spawn', onSpawn); child.off('error', onError);
      child.off('exit', onExit); child.off('close', onClose);
      child.stdout.off('data', onStdout); child.stderr.off('data', onStderr);
      tail = '';
    },
  };
}
