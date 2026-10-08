import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

for (const { phase, occurrence } of [{ phase: 'action-start', occurrence: 1 }, { phase: 'outbound-result', occurrence: 2 }]) {
  // Process guard exceeds the unchanged 60s browser test plus bounded teardown.
  test(`controlled browser ${phase} failure preserves original assertion, diagnostics and owned cleanup`, { timeout: 75000 }, () => {
    const directory = 'reports/browser', before = new Set(readdirSync(directory));
    const env = { ...process.env, FLOWATLAS_INDEPENDENT_FAULT_STAGE: phase, FLOWATLAS_INDEPENDENT_FAULT_OCCURRENCE: String(occurrence),
      FLOWATLAS_TEST_PURPOSE: `Controlled independent browser ${phase} must retain failed completeness assertion` };
    delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', 'scripts/independent-browser-check.mjs'],
      { env, encoding: 'utf8', timeout: 70000, maxBuffer: 1024 * 1024, windowsHide: true });
    assert.equal(result.status, 1, 'The inner browser test must remain a failure');
    assert.match(result.stdout, /ERR_ASSERTION/); assert.match(result.stdout, /true !== false/);
    const folders = readdirSync(directory).filter(name => !before.has(name) && name.startsWith('independent-browser-'));
    assert.equal(folders.length, 1);
    const path = join(directory, folders[0], 'diagnostics.json'); assert.ok(existsSync(path));
    assert.equal(existsSync(join(directory, folders[0], 'result.json')), false, 'Failed assertions cannot publish a completed result');
    const report = JSON.parse(readFileSync(path));
    assert.equal(report.controlledStage, phase); assert.equal(report.controlledRejections, 1);
    assert.equal(report.controlledOccurrence, occurrence);
    assert.equal(report.assertionFailed, true); assert.equal(report.completenessAssertionFailed, true);
    assert.equal(report.browserStartBodiesSettled, true);
    assert.deepEqual(report.cleanup, { childClosed: true, browserClosed: true, collectorClosed: true, lockRemoved: true });
    assert.equal(report.browser.length, occurrence);
    const browser = report.browser.at(-1); assert.equal(browser.businessStatus, 200); assert.equal(browser.bodyCorrect, true);
    assert.equal(browser.incompleteWarning, true); assert.equal(browser.startComplete, phase !== 'action-start');
    assert.equal(browser.businessComplete, false); assert.equal(browser.readbackStatus, phase === 'action-start' ? 404 : 200);
    assert.equal(browser.readbackFailed, false);
    assert.equal(report.metadata.records.length, occurrence); assert.equal(report.metadata.invalidFrames + report.metadata.overflowFrames, 0);
    const record = report.metadata.records.at(-1).phases;
    if (occurrence === 2) {
      assert.equal(report.browser[0].action, 'view-message'); assert.equal(report.browser[0].incompleteWarning, false);
      assert.equal(browser.action, 'send-message'); assert.equal(browser.readbackShape.outcome, 'running');
      for (const value of Object.values(report.metadata.records[0].phases)) assert.equal(value.status, 202);
    }
    assert.equal(record[phase].status, 503); assert.equal(record[phase].failure, 'http-status');
    assert.equal(record[phase].attempted, 1); assert.equal(record[phase].settled, 1);
    assert.equal(record.finish.skipped, 1); assert.equal(record.finish.attempted, 0);
    assert.equal(record['handler-entry'].attempted, phase === 'action-start' ? 0 : 1);
    assert.equal(report.storageErrors.length, 0);
    assert.doesNotMatch(JSON.stringify(report), /Bearer|actionId|viewerUrl|http:\/\/|MSG-1|controlled metadata refusal/);
    console.log(`Retained failed independent browser phase report: ${path}`);
  });
}
