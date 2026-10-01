import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PublicationReview, publicationReviewConfig } from '../workbench/publication-review';
import { WorkspaceStore } from '../workbench/store';
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'publication-review-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.resolve(import.meta.dirname, 'fixtures/content'); const content = path.join(root, 'content');
  cpSync(source, content, { recursive: true, filter: file => !path.relative(source, file).split(path.sep).some(part => part.startsWith('.')) });
  const git = (...args: string[]) => execFileSync('git', ['-C', content, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const store = new WorkspaceStore(content, path.join(root, 'private'));
  const config = { repository: content, baseCommit: git('rev-parse', 'HEAD'), visibility: 'private' as const };
  return { store, config, git, review: new PublicationReview(config) };
}
test('review configuration is opt-in, server-owned and fails closed on partial settings', () => {
  assert.equal(publicationReviewConfig({}), undefined);
  for (const env of [{ WORKBENCH_REVIEW_VISIBILITY: 'private' }, { WORKBENCH_REVIEW_REPOSITORY: 'relative', WORKBENCH_REVIEW_BASE_COMMIT: 'a'.repeat(40) }, { WORKBENCH_REVIEW_REPOSITORY: '/tmp/repo', WORKBENCH_REVIEW_BASE_COMMIT: 'main' }]) assert.throws(() => publicationReviewConfig(env));
  assert.equal(publicationReviewConfig({ WORKBENCH_REVIEW_REPOSITORY: '/tmp/repo', WORKBENCH_REVIEW_BASE_COMMIT: 'a'.repeat(40) })!.visibility, 'unknown');
});
test('web review runs the real offline CLI without writing Git or exporting Markdown', async t => {
  const f = fixture(t); const saved = f.store.get(); const before = readFileSync(path.join(f.store.directory, 'workspace.json'));
  const plan = await f.review.create(f.store, saved.revision);
  assert.equal(plan.canPublish, false); assert.equal(plan.noChanges, true); assert.equal(plan.checks.remoteChecked, false);
  assert.equal('snapshot' in plan, false); assert.equal(f.git('status', '--porcelain'), ''); assert.equal(f.git('rev-parse', 'HEAD'), f.config.baseCommit);
  assert.deepEqual(readFileSync(path.join(f.store.directory, 'workspace.json')), before);
});
test('review rejects stale callers, duplicate work and edits while the CLI is running', async t => {
  const f = fixture(t); const initial = f.store.get();
  await assert.rejects(f.review.create(f.store, '0'.repeat(64)), /已保存内容发生变化/);
  const first = f.review.create(f.store, initial.revision);
  await assert.rejects(f.review.create(f.store, initial.revision), /已有核对/);
  f.store.save(initial.revision, { type: 'addDirectory', parentId: 'root', id: 'during-review', label: 'New', kind: 'topic' });
  await assert.rejects(first, /核对期间内容发生变化/);
  const second = await f.review.create(f.store, f.store.get().revision);
  assert.equal(second.directories.added[0]!.id, 'during-review');
});
test('review refuses a mismatched baseline without exposing server paths or executing publication', async t => {
  const f = fixture(t); const broken = new PublicationReview({ ...f.config, baseCommit: 'f'.repeat(40) });
  await assert.rejects(broken.create(f.store, f.store.get().revision), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, new RegExp(f.config.repository)); assert.match(error.message, /无法核对本地基线/); return true;
  });
  assert.equal(f.git('status', '--porcelain'), '');
});
