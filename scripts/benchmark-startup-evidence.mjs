// QA-only composition of the existing bounded owner and startup-phase observers.
// Raw child output is never included in a snapshot.
import { observeOwnedStartup } from './cli-owner-startup-diagnostics.mjs';
import { createQaStartupPhaseParser } from './cli-startup-phases.mjs';

export function observeBenchmarkStartup(child, lockExists) {
  const owner = observeOwnedStartup(child, lockExists);
  const phases = createQaStartupPhaseParser();
  const onStdout = (chunk) => {
    try { phases.write(chunk); }
    catch { /* Diagnostics cannot alter the benchmark or child outcome. */ }
  };
  child.stdout.on('data', onStdout);
  return Object.freeze({
    snapshot() {
      try { return { owner: owner.snapshot(), phases: phases.snapshot() }; }
      catch { return null; }
    },
    dispose() {
      try { child.stdout.off('data', onStdout); owner.dispose(); }
      catch { /* Diagnostic cleanup cannot replace the benchmark outcome. */ }
    },
  });
}
