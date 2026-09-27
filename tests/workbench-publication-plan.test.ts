import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyCommand, parseArticle, validateWorkspace, type Workspace } from '../workbench/model';
import { assertPublicationPlanCurrent, createPublicationPlan, publicationPlanSummary, PLAN_TTL_MS, type PublicationBaseline } from '../workbench/publication-plan';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = Date.parse('2026-09-27T06:00:00Z');
function fixture() {
  let workspace = validateWorkspace({ version: 1, topology: { document: { version: 1, root: { id: 'root', type: 'root', label: 'Root', children: [{ id: 'notes', type: 'topic', label: 'Notes', children: [] }] }, relations: [] }, articleRefs: {} }, articles: [] });
  workspace = applyCommand(workspace, { type: 'saveArticle', create: true, path: 'articles/hello.md', data: { id: 'hello', title: 'Hello', description: '', pubDate: '2026-09-27', draft: false, topics: ['notes'] }, body: 'PRIVATE_MARKDOWN_SENTINEL\n' });
  workspace = applyCommand(workspace, { type: 'bindArticle', parentId: 'notes', nodeId: 'hello-link', articleId: 'hello' });
  const snapshot = { version: 1 as const, baseRevision: hash(workspace), workspace };
  const baseline: PublicationBaseline = { commit: 'a'.repeat(40), headCommit: 'a'.repeat(40), preservedFileCount: 3, files: { 'articles/hello.md': workspace.articles[0]!.raw, 'topology.json': JSON.stringify(workspace.topology) + '\r\n' } };
  return { snapshot, baseline };
}
function edit(workspace: Workspace, update: Partial<{ path: string; title: string; draft: boolean; body: string }> = {}) {
  const a = parseArticle(workspace.articles[0]!);
  return applyCommand(workspace, { type: 'saveArticle', create: false, path: update.path ?? a.path, data: { ...a.data, title: update.title ?? a.data.title, draft: update.draft ?? a.data.draft }, body: update.body ?? a.body });
}
test('offline plans preserve unchanged raw files and distinguish review from publication', () => {
  const { snapshot, baseline } = fixture(); const input = JSON.stringify({ snapshot, baseline });
  const plan = createPublicationPlan({ ...snapshot, revision: hash(snapshot), sourceChanged: false }, baseline, { now });
  assert.equal(plan.noChanges, true); assert.deepEqual(plan.files, []); assert.deepEqual(plan.articles, []);
  assert.equal(plan.revision, hash(snapshot)); assert.equal(plan.canPublish, false); assert.equal(plan.checks.remoteChecked, false);
  assert.equal(plan.disclosure.preservedFileCount, 3); assert.equal(plan.disclosure.publicMapEntries, 1);
  assert.equal(plan.issues[0]!.code, 'visibility-unconfirmed');
  assert.equal(JSON.stringify({ snapshot, baseline }), input);
  assert.doesNotMatch(JSON.stringify(publicationPlanSummary(plan)), /PRIVATE_MARKDOWN_SENTINEL/);
  assert.equal('snapshot' in publicationPlanSummary(plan), false);
});
test('stable article IDs identify path moves, edits and draft transitions together', () => {
  const { snapshot, baseline } = fixture(); snapshot.workspace = edit(snapshot.workspace, { path: 'articles/moved/hello.md', title: 'Renamed', draft: true, body: 'new private text' });
  const plan = createPublicationPlan(snapshot, baseline, { now, visibility: 'private' });
  assert.deepEqual(plan.files.map(file => [file.path, file.kind]), [['articles/hello.md', 'deleted'], ['articles/moved/hello.md', 'added']]);
  assert.equal(plan.articles[0]!.kind, 'moved'); assert.equal(plan.articles[0]!.contentChanged, true);
  assert.equal(plan.articles[0]!.before!.draft, false); assert.equal(plan.articles[0]!.after!.draft, true);
  assert.deepEqual(plan.disclosure.drafts.map(a => a.id), ['hello']); assert.deepEqual(plan.disclosure.publicArticles, []);
  assert.equal(plan.disclosure.publicMapEntries, 0); assert.deepEqual(plan.issues, []); assert.equal(plan.canPublish, false);
});
test('article deletion and its directory binding stay in the same candidate', () => {
  const { snapshot, baseline } = fixture();
  snapshot.workspace = applyCommand(snapshot.workspace, { type: 'removeNode', id: 'hello-link', confirm: true });
  snapshot.workspace = applyCommand(snapshot.workspace, { type: 'deleteArticle', id: 'hello', confirm: true });
  const plan = createPublicationPlan(snapshot, baseline, { now, visibility: 'private' });
  assert.deepEqual(plan.files.map(file => [file.path, file.kind]), [['articles/hello.md', 'deleted'], ['topology.json', 'modified']]);
  assert.deepEqual(plan.directories.removed.map(n => n.id), ['hello-link']);
  assert.equal(plan.articles[0]!.kind, 'deleted'); assert.equal(plan.snapshot.workspace.articles.length, 0);
});
test('directory labels, ordering, bindings and relation changes are visible', () => {
  const { snapshot, baseline } = fixture();
  snapshot.workspace = applyCommand(snapshot.workspace, { type: 'editDirectory', id: 'notes', label: 'Writing', description: 'New description' });
  snapshot.workspace = applyCommand(snapshot.workspace, { type: 'addDirectory', parentId: 'root', id: 'empty', kind: 'index', label: 'Empty' });
  snapshot.workspace = applyCommand(snapshot.workspace, { type: 'moveNode', id: 'empty', parentId: 'root', index: 0 });
  snapshot.workspace.topology.document.relations.push(['empty', 'notes']);
  const plan = createPublicationPlan(snapshot, baseline, { now });
  assert.deepEqual(plan.directories.added.map(n => n.id), ['empty']);
  const change = plan.directories.modified.find(n => n.id === 'notes')!;
  assert.equal(change.before.position, 0); assert.equal(change.after.position, 1); assert.equal(change.after.label, 'Writing');
  assert.deepEqual(plan.directories.relationsAdded, [['empty', 'notes']]);
});
test('public or unconfirmed repository visibility blocks full snapshots containing drafts', () => {
  const { snapshot, baseline } = fixture(); snapshot.workspace = edit(snapshot.workspace, { draft: true });
  for (const visibility of ['public', 'unknown'] as const) {
    const plan = createPublicationPlan(snapshot, baseline, { now, visibility });
    assert.ok(plan.issues.some(issue => issue.code === 'draft-privacy')); assert.equal(plan.canPublish, false);
  }
});
test('invalid references, executable frontmatter, unsafe paths and bad baseline provenance fail closed', () => {
  const { snapshot, baseline } = fixture();
  assert.throws(() => createPublicationPlan({ ...snapshot, baseRevision: 'b'.repeat(64) }, baseline, { now }), /导入基线/);
  assert.throws(() => createPublicationPlan({ ...snapshot, revision: 'wrong' }, baseline, { now }), /版本与内容/);
  assert.throws(() => createPublicationPlan(snapshot, { ...baseline, headCommit: 'b'.repeat(40) }, { now }), /HEAD/);
  assert.throws(() => createPublicationPlan(snapshot, { ...baseline, files: { ...baseline.files, '.github/workflows/deploy.yml': 'malicious' } }, { now }), /只能管理/);
  const invalid = structuredClone(snapshot); invalid.workspace.topology.articleRefs['hello-link'] = 'missing';
  assert.throws(() => createPublicationPlan(invalid, baseline, { now }), /Unknown article/);
  invalid.workspace = structuredClone(snapshot.workspace); invalid.workspace.articles[0]!.path = 'articles/../secret.md';
  assert.throws(() => createPublicationPlan(invalid, baseline, { now }));
  invalid.workspace = structuredClone(snapshot.workspace); invalid.workspace.articles[0]!.raw = '---javascript\nthrow new Error("bad");\n---\n';
  assert.throws(() => createPublicationPlan(invalid, baseline, { now }), /可执行/);
});
test('plans freeze version R and invalidate on edits, commit changes, privacy changes, tampering or expiry', () => {
  const { snapshot, baseline } = fixture(); const plan = createPublicationPlan(snapshot, baseline, { now, visibility: 'private' });
  assertPublicationPlanCurrent(plan, snapshot, baseline, 'private', now + 1);
  assertPublicationPlanCurrent(plan, snapshot, baseline, 'private', now + PLAN_TTL_MS - 1);
  assert.throws(() => assertPublicationPlanCurrent(plan, snapshot, baseline, 'private', now + PLAN_TTL_MS), /过期/);
  assert.throws(() => assertPublicationPlanCurrent(plan, snapshot, baseline, 'private', now - 1), /时间/);
  assert.throws(() => assertPublicationPlanCurrent(plan, snapshot, baseline, 'public', now), /变化/);
  assert.throws(() => assertPublicationPlanCurrent(plan, snapshot, { ...baseline, commit: 'b'.repeat(40), headCommit: 'b'.repeat(40) }, 'private', now), /变化/);
  const tampered = structuredClone(plan); tampered.disclosure.preservedFileCount++;
  assert.throws(() => assertPublicationPlanCurrent(tampered, snapshot, baseline, 'private', now), /变化/);
  assert.throws(() => { plan.snapshot.workspace.articles[0]!.raw = 'overwrite'; }, TypeError);
  snapshot.workspace = edit(snapshot.workspace, { body: 'R2 new edits' });
  assert.throws(() => assertPublicationPlanCurrent(plan, snapshot, baseline, 'private', now), /变化/);
  assert.match(plan.snapshot.workspace.articles[0]!.raw, /PRIVATE_MARKDOWN_SENTINEL/);
  assert.match(snapshot.workspace.articles[0]!.raw, /R2 new edits/);
});
