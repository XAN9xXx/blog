import test from 'node:test';
import assert from 'node:assert/strict';
import { uniqueId, matchesArticle } from '../workbench/ui-helpers';

test('UI identifiers are editable safe defaults, including non-Latin titles', () => {
  assert.equal(uniqueId('My first note!', [], 'note-abc'), 'my-first-note');
  assert.equal(uniqueId('我的第一篇文章', [], 'note-abc'), 'note-abc');
  assert.equal(uniqueId('Café', [], 'note-abc'), 'cafe');
  assert.equal(uniqueId('', ['note-abc'], 'note-abc'), 'note-abc-2');
});
test('generated defaults avoid every existing identifier and leave suffix room', () => {
  assert.equal(uniqueId('Hello', ['hello', 'hello-2', 'hello-3'], 'note'), 'hello-4');
  const long = uniqueId('a'.repeat(300), ['a'.repeat(110)], 'note');
  assert.ok(long.length <= 128);
  assert.match(long, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
});
test('article search matches all words across title, summary and ID', () => {
  const a = { id: 'network', data: { title: 'Debian 笔记', description: 'SSH forwarding', draft: true } };
  assert.equal(matchesArticle(a, '  DEBIAN  ssh ', 'all'), true);
  assert.equal(matchesArticle(a, '笔记 network', 'draft'), true);
  assert.equal(matchesArticle(a, 'missing', 'all'), false);
  assert.equal(matchesArticle(a, '', 'ready'), false);
  assert.equal(matchesArticle({ ...a, data: { ...a.data, draft: false } }, '', 'ready'), true);
});
