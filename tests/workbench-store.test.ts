import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../workbench/store';
import { applyCommand, parseArticle, preview, validateWorkspace, type Workspace } from '../workbench/model';

function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'blog-workbench-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const content = path.join(root, 'content');
  cpSync(path.resolve(import.meta.dirname, 'fixtures/content'), content, { recursive: true });
  const directory = path.join(root, 'private');
  return { root, content, directory, store: new WorkspaceStore(content, directory) };
}
const createArticle = { type: 'saveArticle', create: true, path: 'articles/draft.md', body: '# Draft body',
  data: { id: 'draft', title: 'Draft title', description: 'Private', pubDate: '2026-09-26', draft: true, topics: [] } };
test('private atomic save persists across restart without modifying content or allowing stale writers', t => {
  const f = setup(t); const original = readFileSync(path.join(f.content, 'topology.json'), 'utf8');
  const first = f.store.get(); const second = f.store.save(first.revision, createArticle);
  assert.notEqual(first.revision, second.revision);
  assert.equal(second.workspace.articles.length, first.workspace.articles.length + 1);
  assert.ok(!existsSync(path.join(f.content, 'articles/draft.md')));
  assert.equal(readFileSync(path.join(f.content, 'topology.json'), 'utf8'), original);
  assert.throws(() => f.store.save(first.revision, createArticle), /另一个页面/);
  assert.deepEqual(new WorkspaceStore(f.content, f.directory).get(), second);
});
test('invalid edits leave the saved snapshot unchanged', t => {
  const f = setup(t); const first = f.store.get();
  for (const command of [
    { ...createArticle, path: 'articles/../../.env' },
    { ...createArticle, data: { ...createArticle.data, topics: ['missing-topic'] } },
    { type: 'bindArticle', nodeId: 'bad', parentId: 'root', articleId: 'missing' },
    { type: 'moveNode', id: 'infrastructure', parentId: 'cicd', index: 0 },
  ]) assert.throws(() => f.store.save(first.revision, command));
  assert.equal(f.store.get().revision, first.revision);
});
test('editing preview retains empty directories and drafts; public preview hides both', t => {
  const f = setup(t); let current = f.store.get();
  current = f.store.save(current.revision, createArticle);
  current = f.store.save(current.revision, { type: 'bindArticle', nodeId: 'draft-node', parentId: 'software', articleId: 'draft' });
  const editing = preview(current.workspace, 'editing'); const published = preview(current.workspace, 'public');
  assert.ok(JSON.stringify(editing).includes('Draft title'));
  assert.ok(editing.root.children!.some(n => n.id === 'compilers'));
  assert.ok(!JSON.stringify(published).includes('Draft title'));
  assert.ok(!published.root.children!.some(n => n.id === 'software'));
});
test('directory editing supports move/order/rebinding and safe recursive removal', t => {
  const f = setup(t); let w = f.store.get().workspace; const initial = w.articles.length;
  w = applyCommand(w, { type: 'addDirectory', id: 'new-dir', parentId: 'root', kind: 'topic', label: 'New' });
  w = applyCommand(w, { type: 'editDirectory', id: 'new-dir', label: 'Renamed', description: 'Notes' });
  w = applyCommand(w, { type: 'moveNode', id: 'new-dir', parentId: 'root', index: 0 });
  assert.equal(w.topology.document.root.children![0]!.label, 'Renamed');
  w = applyCommand(w, { type: 'bindArticle', nodeId: 'duplicate', parentId: 'new-dir', articleId: 'hello' });
  assert.throws(() => applyCommand(w, { type: 'deleteArticle', id: 'hello', confirm: true }), /hello.*duplicate|duplicate.*hello/);
  assert.throws(() => applyCommand(w, { type: 'removeNode', id: 'infrastructure', confirm: true }), /主题分类/);
  w = applyCommand(w, createArticle);
  w = applyCommand(w, { type: 'rebindArticle', nodeId: 'duplicate', articleId: 'draft' });
  w.topology.document.relations.push(['new-dir', 'software']);
  w = applyCommand(w, { type: 'removeNode', id: 'new-dir', confirm: true });
  assert.ok(!w.topology.articleRefs.duplicate);
  assert.ok(!w.topology.document.relations.some(edge => edge.includes('new-dir')));
  assert.equal(w.articles.length, initial + 1, 'removing an entry must not delete its article');
  w = applyCommand(w, { type: 'deleteArticle', id: 'draft', confirm: true });
  assert.equal(w.articles.length, initial);
});
test('article title and path edits preserve ID, custom frontmatter and canonical links', t => {
  const f = setup(t); let w = f.store.get().workspace;
  w.articles[0]!.raw = w.articles[0]!.raw.replace('id: hello', 'id: hello\ncustom: preserved');
  const a = parseArticle(w.articles[0]!);
  w = applyCommand(w, { type: 'saveArticle', create: false, path: 'articles/moved/renamed.md', data: { ...a.data, title: 'Renamed' }, body: 'Updated body' });
  const parsed = parseArticle(w.articles[0]!);
  assert.equal(parsed.metadata.custom, 'preserved'); assert.equal(parsed.id, 'hello');
  assert.ok(JSON.stringify(preview(w, 'public')).includes('/notes/hello/'));
  assert.equal(parsed.body.trim(), 'Updated body');
});
test('source drift is visible and never silently replaces private work', t => {
  const f = setup(t); const before = f.store.get();
  writeFileSync(path.join(f.content, 'articles/new.md'), '---\nid: new\ntitle: New\ndescription: desc\npubDate: 2026-09-26\n---\nnew');
  const after = f.store.get(); assert.equal(after.sourceChanged, true);
  assert.equal(after.revision, before.revision); assert.deepEqual(after.workspace, before.workspace);
});
test('state paths cannot overlap sources or public output and symlink inputs fail closed', t => {
  const f = setup(t);
  assert.throws(() => new WorkspaceStore(f.content, path.join(f.content, 'assets/private')), /重叠/);
  assert.throws(() => new WorkspaceStore(f.content, f.root), /重叠/);
  if (process.platform !== 'win32') {
    symlinkSync(f.directory, path.join(f.root, 'alias'));
    assert.throws(() => new WorkspaceStore(f.content, path.join(f.root, 'alias/state')), /符号链接/);
  }
});
test('untrusted snapshots reject executable frontmatter, duplicate paths and authored URLs', t => {
  const f = setup(t); const w = f.store.get().workspace;
  const bad = structuredClone(w); bad.articles[0]!.raw = '---javascript\n({id: "attack"})\n---\nbody';
  assert.throws(() => validateWorkspace(bad), /可执行/);
  const duplicate: Workspace = structuredClone(w); duplicate.articles.push({ ...duplicate.articles[0]! });
  assert.throws(() => validateWorkspace(duplicate), /路径重复/);
  const linked = structuredClone(w); linked.topology.document.root.href = '/arbitrary';
  assert.throws(() => validateWorkspace(linked), /Authored href/);
});

test('leftover write locks and corrupt snapshots fail closed', t => {
  const f = setup(t); const before = f.store.get();
  writeFileSync(path.join(f.directory, 'write.lock'), '');
  assert.throws(() => f.store.save(before.revision, createArticle), /中断锁/);
  assert.equal(f.store.get().revision, before.revision);
  writeFileSync(path.join(f.directory, 'workspace.json'), '{broken');
  assert.throws(() => new WorkspaceStore(f.content, f.directory));
  assert.equal(readFileSync(path.join(f.directory, 'workspace.json'), 'utf8'), '{broken');
});


test('repeated Markdown saves preserve leading whitespace without accumulating blank lines', () => {
  for (const input of ['text\n', '\ntext\n', '\n\ntext\n', '']) {
    let workspace: Workspace = { version: 1, topology: { document: { version: 1, root: { id: 'root', type: 'root', label: 'Root', children: [] }, relations: [] }, articleRefs: {} }, articles: [] };
    let body = input;
    for (let n = 0; n < 5; n++) {
      workspace = applyCommand(workspace, { ...createArticle, create: n === 0, body, data: { ...createArticle.data, description: '' } });
      body = parseArticle(workspace.articles[0]!).body;
      assert.equal(body, input || '\n');
    }
  }
});
