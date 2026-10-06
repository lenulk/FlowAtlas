import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

test('a controlled business response error fails the sustained reference and retains owned evidence', { timeout: 30000 }, () => {
  const directory = 'reports/benchmarks', before = new Set(readdirSync(directory));
  const env = { ...process.env, FLOWATLAS_SUSTAINED_DURATION_MS: '4000', FLOWATLAS_SUSTAINED_FAULT: 'business-status',
    FLOWATLAS_TEST_PURPOSE: 'Controlled sustained reference business response must fail measurement' };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', 'scripts/sustained-reference-check.mjs'],
    { env, encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024, windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stdout, /Sustained reference failed/);
  const files = readdirSync(directory).filter(file => !before.has(file) && /^sustained-reference-.+\.json$/.test(file));
  assert.equal(files.length, 1);
  const report = JSON.parse(readFileSync(join(directory, files[0])));
  assert.equal(report.fault, 'business-status'); assert.equal(report.failure, 'business_response_mismatch');
  assert.equal(report.complete, false); assert.equal(report.workspaceRemoved, false);
  assert.equal(report.sustainedAcceptance.met, null); assert.equal(report.performanceAcceptance.met, null);
  assert.equal(report.childClosed, true); assert.equal(report.collectorClosed, true);
  assert.equal(report.summary.dropped, 0); assert.equal(report.summary.delivered, report.app.requests);
  assert.equal(report.responses, report.app.requests - 1); assert.equal(report.invalidGraphs, 1);
  assert.ok(report.retainedWorkspace?.startsWith('reports/storage/sustained-reference-') && !report.retainedWorkspace.includes('..'));
  assert.ok(existsSync(report.retainedWorkspace));
  assert.equal(existsSync(join(report.retainedWorkspace, 'data/actions/.writer.lock')), false);
  console.log(`Controlled sustained failure report: ${files[0]}`);
});
