import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTiming, exporterTimingFields, storageTimingFields } from '../scripts/trace-timing-report.mjs';
test('timing artifact parser only retains numeric allowlisted fields and rejects incomplete diagnostics', () => {
  for (const fields of [exporterTimingFields, storageTimingFields]) {
    const value = Object.fromEntries(fields.map(field => [field, 1]));
    const parse = value => parseTiming('Timing: ' + JSON.stringify(value), 'Timing: ', fields);
    assert.deepEqual(parse({ ...value, token: 'canary-secret', body: 'canary-body' }), value);
    for (const invalid of [-1, null, 'canary', Number.MAX_SAFE_INTEGER + 1]) assert.equal(parse({ ...value, [fields[0]]: invalid }), null);
    assert.equal(parse({ ...value, [fields[0]]: 0.5 }), null);
    assert.equal(parse({}), null); assert.equal(parseTiming('Timing: invalid','Timing: ',fields), null);
  }
});
