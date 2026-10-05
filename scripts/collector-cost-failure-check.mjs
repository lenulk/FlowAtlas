import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

test('rejected component replay remains a reported failure and retains its owned workspace', () => {
  const directory = 'reports/benchmarks'; mkdirSync(directory, { recursive: true });
  const before = new Set(readdirSync(directory));
  const env = { ...process.env, FLOWATLAS_COLLECTOR_COST_FAULT: 'transport-reject' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', 'scripts/benchmark-collector-cost.mjs'],
    { env, encoding: 'utf8', timeout: 150000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const tap = (result.stdout ?? '') + (result.stderr ?? '');
  const evidence = join(directory, `collector-cost-fault-${Date.now()}.tap`); writeFileSync(evidence, tap);
  assert.equal(result.status, 1, 'An explicit rejected replay must fail its capture check');
  assert.match(tap, /Component capture\/reload failed/);
  const files = readdirSync(directory).filter(file => !before.has(file) && /^collector-cost-fault-.+\.json$/.test(file));
  assert.equal(files.length, 1);
  const report = JSON.parse(readFileSync(join(directory, files[0])));
  assert.equal(report.performanceAcceptance.met, null);
  const fault = report.conditions.find(value => value.mode === 'transport' && value.round === 1);
  assert.equal(fault.complete, false); assert.equal(fault.worker.summary.delivered, 0);
  assert.equal(fault.worker.health.rejected, 1051); assert.equal(fault.workspaceRemoved, false);
  assert.ok(fault.retainedWorkspace?.startsWith('reports/storage/collector-cost-') && !fault.retainedWorkspace.includes('..'));
  assert.ok(existsSync(fault.retainedWorkspace));
  assert.ok(report.conditions.filter(value => value !== fault).every(value => value.complete && value.workspaceRemoved));
  console.log(`Controlled failure evidence: ${evidence}`);
});
