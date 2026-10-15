import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitMetadataBudget, GIT_METADATA_BUDGET_MS, readGitMetadata } from '../src/project-sources.mjs';
import { getCodeVersion } from '../src/flowatlas.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const storageRoot = join(projectRoot, 'reports', 'storage');

function makeWorkspace(t, prefix) {
  mkdirSync(storageRoot, { recursive: true });
  const workspace = mkdtempSync(join(storageRoot, prefix));
  const canonicalWorkspace = realpathSync(workspace);
  const canonicalStorage = realpathSync(storageRoot);
  const initialRelativePath = relative(canonicalStorage, canonicalWorkspace);
  assert.ok(initialRelativePath && !initialRelativePath.startsWith('..') && !isAbsolute(initialRelativePath),
    'fixture must stay under reports/storage');
  let verified = false;
  t.after(() => {
    if (!verified) return;
    assert.equal(lstatSync(workspace).isSymbolicLink(), false, 'fixture path must not be a symbolic link');
    const cleanupTarget = realpathSync(workspace);
    const withinStorage = relative(canonicalStorage, cleanupTarget);
    const cleanupParent = realpathSync(dirname(cleanupTarget));
    assert.equal(cleanupParent, canonicalStorage, 'fixture parent must remain reports/storage');
    assert.equal(cleanupTarget, canonicalWorkspace, 'fixture canonical path must remain unchanged');
    assert.ok(withinStorage && !withinStorage.startsWith('..') && !isAbsolute(withinStorage),
      'fixture cleanup must remain inside reports/storage');
    rmSync(cleanupTarget, { recursive: true, force: true });
  });
  return { root: workspace, markVerified() { verified = true; } };
}

function initializeGit(root) {
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=Codex', '-c', 'user.email=codex@localhost', 'commit', '-qm', 'budget fixture'], {
    cwd: root, stdio: 'ignore',
  });
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

test('Git metadata budget is immutable and returns trimmed output when Git completes in budget', (t) => {
  assert.equal(GIT_METADATA_BUDGET_MS, 1000);
  const { root, markVerified } = makeWorkspace(t, 'git-metadata-budget-');
  const budget = createGitMetadataBudget();
  assert.equal(Object.isFrozen(budget), true);
  assert.equal(typeof budget.runGit, 'function');

  let output;
  try {
    output = budget.runGit(root, ['--version']);
  } catch (error) {
    if (error?.message !== 'Git metadata budget exhausted' && error?.code !== 'ETIMEDOUT') throw error;
    t.diagnostic('Git did not complete within the one-second budget; verifying atomic metadata fallback.');
    assert.deepEqual(readGitMetadata(root, ['src'], budget), { commit: null, dirty: null });
    markVerified();
    return;
  }
  assert.match(output, /^git version \S+$/);
  assert.equal(output, output.trim());
  markVerified();
});

test('real Git metadata stays atomic and does not alter the public source snapshot', (t) => {
  const { root, markVerified } = makeWorkspace(t, 'git-metadata-snapshot-');
  for (const folder of ['src', 'public', 'examples']) mkdirSync(join(root, folder));
  writeFileSync(join(root, 'src', 'app.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'public', 'index.html'), '<!doctype html>\n');
  writeFileSync(join(root, 'examples', 'demo.mjs'), 'export const demo = true;\n');
  initializeGit(root);

  const before = getCodeVersion(root);
  const sourceBytes = readFileSync(join(root, 'src', 'app.mjs'));
  const metadata = readGitMetadata(root, ['src', 'public', 'examples']);
  const after = getCodeVersion(root);

  assert.deepEqual(after.files, before.files);
  assert.equal(after.digest, before.digest);
  assert.equal(readFileSync(join(root, 'src', 'app.mjs')).equals(sourceBytes), true);
  assert.ok(
    (metadata.commit === null && metadata.dirty === null)
      || (/^[a-f0-9]{40,64}$/.test(metadata.commit) && typeof metadata.dirty === 'boolean'),
    'metadata must be either a complete Git result or an atomic null fallback',
  );
  if (metadata.commit !== null) {
    if (before.commit !== null) assert.equal(metadata.commit, before.commit);
    assert.equal(metadata.dirty, false);
  }
  assert.equal(sha256(sourceBytes), before.files['src/app.mjs']);
  markVerified();
});

test('non-repository and exhausted budgets fall back atomically without changing file bytes', (t) => {
  const { root, markVerified } = makeWorkspace(t, 'git-metadata-fallback-');
  mkdirSync(join(root, 'src'));
  const file = join(root, 'src', 'app.mjs');
  writeFileSync(file, 'export const stable = true;\n');
  const beforeBytes = readFileSync(file);
  const beforeDigest = sha256(beforeBytes);

  assert.deepEqual(readGitMetadata(root, ['src']), { commit: null, dirty: null });

  let calls = 0;
  const expiredAfterPartialResult = Object.freeze({
    runGit() {
      calls++;
      if (calls === 1) return root;
      if (calls === 2) return 'a'.repeat(40);
      throw new Error('budget exhausted');
    },
  });
  assert.deepEqual(readGitMetadata(root, ['src'], expiredAfterPartialResult), { commit: null, dirty: null });
  assert.equal(calls, 3);
  const afterBytes = readFileSync(file);
  assert.equal(sha256(afterBytes), beforeDigest);
  assert.equal(afterBytes.equals(beforeBytes), true);
  markVerified();
});
