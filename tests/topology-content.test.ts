import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleHref, compilePublicTopology, publicAuthoringSource } from '../src/lib/topology-content';

function fixture() {
  const article = { id: 'hello', data: { id: 'hello', title: 'Real title', description: 'Real description', pubDate: new Date('2026-09-21'), draft: false, topics: ['software'] } };
  const source = { document: { version: 1, root: { id: 'root', label: 'XAN9x', type: 'root', children: [
    { id: 'software', label: 'Software', type: 'topic', children: [{ id: 'hello-node', label: 'Stale title', type: 'article' }] },
  ] }, relations: [['software', 'hello-node']] }, articleRefs: { 'hello-node': 'hello' } };
  return { source, article };
}
test('resolves canonical article metadata and stable ID route without mutating source', () => {
  const { source, article } = fixture();
  const result = compilePublicTopology(source, [article]);
  const leaf = result.document.root.children![0]!.children![0]!;
  assert.equal(leaf.label, 'Real title'); assert.equal(leaf.href, '/notes/hello/');
  assert.equal(leaf.meta, '2026-09-21'); assert.equal(leaf.description, 'Real description');
  assert.equal(source.document.root.children[0]!.children[0]!.label, 'Stale title');
});
test('draft body metadata, node, binding and touching relations never reach public map', () => {
  const { source, article } = fixture(); article.data.draft = true;
  const result = compilePublicTopology(source, [article]);
  assert.deepEqual(result.articleRefs, {}); assert.deepEqual(result.document.relations, []);
  assert.deepEqual(result.document.root.children![0]!.children, []);
  assert.ok(!JSON.stringify(result).includes('Real title'));
});
test('public authoring projection round trips and regenerates links', () => {
  const { source, article } = fixture(); const compiled = compilePublicTopology(source, [article]);
  assert.deepEqual(compilePublicTopology(publicAuthoringSource(compiled), [article]), compiled);
});
for (const [name, mutate, message] of [
  ['missing article', (f: ReturnType<typeof fixture>) => { f.source.articleRefs['hello-node'] = 'missing'; }, /Unknown article/],
  ['missing binding', (f: ReturnType<typeof fixture>) => { delete (f.source.articleRefs as Record<string, string>)['hello-node']; }, /Missing article reference/],
  ['wrong binding target', (f: ReturnType<typeof fixture>) => { Object.assign(f.source.articleRefs, { software: 'hello' }); }, /must target an article node/],
  ['invalid topic', (f: ReturnType<typeof fixture>) => { f.article.data.topics = ['missing']; }, /Unknown topic/],
  ['article is not a topic', (f: ReturnType<typeof fixture>) => { f.article.data.topics = ['hello-node']; }, /Unknown topic/],
  ['broken relation', (f: ReturnType<typeof fixture>) => { f.source.document.relations.push(['software', 'missing']); }, /Unknown relation endpoint/],
  ['duplicate node', (f: ReturnType<typeof fixture>) => { f.source.document.root.children[0]!.children.push({ id: 'hello-node', label: 'Duplicate', type: 'article' }); }, /Duplicate node/],
  ['authored link bypass', (f: ReturnType<typeof fixture>) => { Object.assign(f.source.document.root.children[0]!, { href: '/notes/secret/' }); }, /Authored href/],
  ['unimplemented project', (f: ReturnType<typeof fixture>) => { f.source.document.root.children[0]!.children[0]!.type = 'project'; f.source.articleRefs = {} as typeof f.source.articleRefs; }, /Project content/],
] as const) {
  test('rejects ' + name, () => { const f = fixture(); mutate(f); assert.throws(() => compilePublicTopology(f.source, [f.article]), message); });
}
test('drafts are validated too', () => { const { source, article } = fixture(); article.data.draft = true; article.data.topics = ['missing']; assert.throws(() => compilePublicTopology(source, [article]), /Unknown topic/); });
test('duplicate and mismatched content IDs fail', () => {
  const { source, article } = fixture(); assert.throws(() => compilePublicTopology(source, [article, article]), /Duplicate article ID/);
  assert.throws(() => compilePublicTopology(source, [{ ...article, id: 'other' }]), /ID mismatch/);
});
test('route IDs cannot escape one stable route segment', () => {
  for (const id of ['../secret', 'a/b', 'bad space', '', '<script>', '%2f']) assert.throws(() => articleHref(id));
  assert.equal(articleHref('hello-v2.1'), '/notes/hello-v2.1/');
});

test('article text remains data and cannot choose its own navigation URL', () => {
  const { source, article } = fixture(); article.data.title = '</script><img src=x onerror=alert(1)>';
  const result = compilePublicTopology(source, [article]);
  const node = result.document.root.children![0]!.children![0]!;
  assert.equal(node.label, article.data.title); assert.equal(node.href, '/notes/hello/');
});
