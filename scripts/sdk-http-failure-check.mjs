import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
test('SDK diagnostic rejected sink remains a failed measurement with retained fixture', { timeout: 180000 }, () => {
  const env = { ...process.env, FLOWATLAS_SDK_HTTP_FAULT: 'sink-reject',
    FLOWATLAS_TEST_PURPOSE: 'Controlled SDK HTTP sink rejection must fail measurement' };
  for (const key of Object.keys(env)) if (key.startsWith('NODE_')) delete env[key];
  const child = spawnSync(process.execPath, ['scripts/run-tests.mjs', 'scripts/benchmark-sdk-http.mjs'],
    { cwd: root, env, encoding: 'utf8', timeout: 150000, maxBuffer: 1024 * 1024 });
  assert.equal(child.status, 1, 'The inner measurement must remain failed');
  const output = child.stdout + child.stderr;
  const runnerPath = output.match(/Saved test results: (reports\/tests\/[\w-]+\.json)/)?.[1];
  const reportPath = output.match(/SDK HTTP diagnostic report: (reports\/benchmarks\/sdk-http-[\w-]+\.json)/)?.[1];
  assert.ok(runnerPath && reportPath);
  const runner = JSON.parse(readFileSync(join(root, runnerPath))), report = JSON.parse(readFileSync(join(root, reportPath)));
  assert.equal(runner.failed, 1); assert.equal(runner.passed, 0); assert.equal(runner.skipped, 0);
  assert.equal(report.controlledFault, 'sink-reject'); assert.equal(report.performanceAcceptance.met, null);
  assert.equal(report.conditions.length, 9);
  const rejected = report.conditions.find(r => r.round === 1 && r.mode === 'sdk-production-exporter-sink');
  assert.equal(rejected.complete, false); assert.equal(rejected.workspaceRemoved, false);
  assert.equal(rejected.delivery.httpSpans, 1051); assert.equal(rejected.delivery.delivered, 0);
  assert.equal(rejected.delivery.dropped, 1051); assert.equal(rejected.delivery.queued + rejected.delivery.inFlight, 0);
  assert.equal(rejected.sinkReceived, 0); assert.equal(rejected.failure, 'sdk_condition_validation_failed');
  assert.match(rejected.retainedWorkspace, /^reports\/storage\/sdk-http-[\w-]+$/);
  assert.equal(existsSync(join(root, rejected.retainedWorkspace)), true);
  assert.ok(report.conditions.filter(r => r !== rejected).every(r => r.complete && r.workspaceRemoved));
  console.log('Expected failed SDK measurement retained: ' + runnerPath + '; ' + reportPath);
});
