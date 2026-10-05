import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
test('deliberate browser assertion retains its original report and confirms fixture cleanup', { timeout: 35000 }, async (t) => {
  const parent = join(root, 'reports/browser'); mkdirSync(parent, { recursive: true });
  const evidence = mkdtempSync(join(parent, 'otel-runtime-fault-'));
  const driver = join(evidence, 'assertion-fault-driver.mjs');
  writeFileSync(driver, `import assert from 'node:assert/strict';
const original=assert.deepEqual;
assert.deepEqual=function(...args){
if(args[2]==='Relationship paths must stay outside all card interiors')
return original([1], [], 'FA15 deliberate assertion fault to inspect failed fixture cleanup');
return Reflect.apply(original,this,args);
};\n`);
  const env = { ...process.env, FLOWATLAS_OTEL_BROWSER_CHECK: '1' };
  // This is a separate runner, not a recursive invocation within the parent test.
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=cjs',
    '--import', pathToFileURL(driver).href, 'test/otel-runtime.test.mjs'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (part) => { output += part; }); child.stderr.on('data', (part) => { output += part; });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 30000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }); }
  finally { clearTimeout(watchdog); writeFileSync(join(evidence, 'assertion-fault.tap'), output); }
  t.diagnostic(`Deliberate failure evidence: ${evidence}`);
  assert.equal(code, 1, 'Injected assertion must remain a failed test, without a native exit');
  assert.match(output, /FA15 deliberate assertion fault to inspect failed fixture cleanup/);
  assert.match(output, /code: 'ERR_ASSERTION'/);
  assert.match(output, /operator: 'deepStrictEqual'/);
  assert.match(output, /auditMap/);
  assert.match(output, /Traced fixture cleanup: \{"closed":true,"lockRemoved":true,"portsClosed":\[true,true\],"removed":true\}/);
  assert.doesNotMatch(output, /Unconfirmed fixture retained|cleanup failed/);
});
