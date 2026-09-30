import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const startedAt = new Date();
const runId = startedAt.toISOString().replace(/[:.]/g, '-');
const reports = join(root, 'reports', 'tests');
mkdirSync(reports, { recursive: true });
function filesIn(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}
const files = Object.fromEntries(['src', 'public', 'examples', 'test', 'scripts'].flatMap(filesIn)
  .concat('package.json').sort().map((file) => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')]));
const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
let commit = null;
let dirty = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim().length > 0;
} catch { /* Tests can also run before Git is initialized. */ }
const purpose = process.env.FLOWATLAS_TEST_PURPOSE ?? 'ตรวจคุณภาพปัจจุบัน';
const args = ['--test', '--test-reporter=tap', ...process.argv.slice(2)];
const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
child.stderr.on('data', (chunk) => { output += chunk; process.stderr.write(chunk); });
const exitCode = await new Promise((resolve) => {
  child.once('error', (error) => { output += `${error.stack}\n`; resolve(1); });
  child.once('close', (code) => resolve(code ?? 1));
});
const count = (name) => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0);
const failures = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
const result = {
  runId, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
  node: process.version, commit, dirty, digest, files, purpose, args, exitCode,
  tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), failures,
};
writeFileSync(join(reports, `${runId}.tap`), output);
writeFileSync(join(reports, `${runId}.json`), JSON.stringify(result, null, 2) + '\n');
const log = join(root, 'docs', 'TEST-RUNS.md');
if (!existsSync(log)) writeFileSync(log, '# บันทึกการรันทดสอบ\n\nสร้างโดย `node scripts/run-tests.mjs` ทุกครั้ง รายละเอียด TAP และ metadata อยู่ใน `reports/tests/` เวลาเป็น UTC; การวิเคราะห์และการแก้อยู่ใน [QUALITY.md](QUALITY.md)\n');
appendFileSync(log, `\n## ${runId}\n\n- จุดประสงค์: ${purpose}\n- ผล: ${exitCode === 0 ? 'ผ่าน' : 'ไม่ผ่าน'} — ${result.passed}/${result.tests}; failed ${result.failed}; skipped ${result.skipped}\n- Node: ${result.node}; commit: ${commit ?? 'ไม่มี'}; dirty: ${dirty}\n- หลักฐาน: \`reports/tests/${runId}.tap\` และ \`.json\`\n${failures.map((name) => `- ไม่ผ่าน: ${name}\n`).join('')}`);
console.log(`\nSaved test results: reports/tests/${runId}.json`);
process.exitCode = exitCode;
