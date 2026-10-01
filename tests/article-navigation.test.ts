import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjacentArticles, articlePlacements, groupByYear, isoDate } from '../src/lib/article-navigation';
import { compilePublicTopology, publicDirectoryDocument } from '../src/lib/topology-content';

const article = (id: string, pubDate: string, draft = false) =>
  ({ id, data: { id, title: id.toUpperCase(), description: '', pubDate: new Date(pubDate), draft, topics: [] } });
const articles = [article('old', '2025-12-31'), article('mid', '2026-03-01'), article('new', '2026-09-30'), article('secret', '2026-10-01', true)];
const topology = {
  document: { version: 1, relations: [], root: { id: 'root', type: 'root', label: 'XAN9x', children: [
    { id: 'infrastructure', type: 'topic', label: 'Infrastructure', color: 'var(--infra)', children: [
      { id: 'cicd', type: 'index', label: 'CI / CD', children: [{ id: 'mid-cicd', type: 'article', label: 'x' }] },
      { id: 'selfhosting', type: 'index', label: 'Self-hosting', children: [{ id: 'mid-self', type: 'article', label: 'x' }, { id: 'secret-self', type: 'article', label: 'x' }] },
    ] },
    { id: 'software', type: 'topic', label: 'Software', color: '#657df2', children: [{ id: 'new-software', type: 'article', label: 'x' }] },
    { id: 'old-root', type: 'article', label: 'x' },
  ] } },
  articleRefs: { 'mid-cicd': 'mid', 'mid-self': 'mid', 'secret-self': 'secret', 'new-software': 'new', 'old-root': 'old' },
};
const map = publicDirectoryDocument(compilePublicTopology(topology, articles).document);

test('every public map entry becomes a placement with a deep link to its directory and the branch colour', () => {
  assert.deepEqual(articlePlacements(map, 'mid'), [
    { labels: ['Infrastructure', 'CI / CD'], href: '/#topic=infrastructure/cicd', color: 'var(--infra)' },
    { labels: ['Infrastructure', 'Self-hosting'], href: '/#topic=infrastructure/selfhosting', color: 'var(--infra)' },
  ]);
  assert.deepEqual(articlePlacements(map, 'new'), [{ labels: ['Software'], href: '/#topic=software', color: '#657df2' }]);
  assert.deepEqual(articlePlacements(map, 'old'), [{ labels: ['XAN9x'], href: '/#map' }], 'an entry directly under the root opens the map');
});

test('drafts and articles without public entries have no placement', () => {
  assert.deepEqual(articlePlacements(map, 'secret'), []);
  assert.deepEqual(articlePlacements(map, 'unplaced'), []);
});

test('previous is the next older article and next the next newer one; ties fall back to the ID', () => {
  const published = articles.filter(a => !a.data.draft);
  assert.deepEqual(adjacentArticles(published, 'mid'), { previous: published[0], next: published[2] });
  assert.deepEqual(adjacentArticles(published, 'old'), { previous: undefined, next: published[1] });
  assert.deepEqual(adjacentArticles(published, 'new'), { previous: published[1], next: undefined });
  assert.deepEqual(adjacentArticles(published, 'missing'), {});
  const tied = [article('b', '2026-01-01'), article('a', '2026-01-01')];
  assert.equal(adjacentArticles(tied, 'a').previous?.id, 'b');
});

test('the list groups newest first by the same UTC date that pages display', () => {
  const groups = groupByYear(articles.filter(a => !a.data.draft));
  assert.deepEqual(groups.map(g => [g.year, g.articles.map(a => a.id)]), [['2026', ['new', 'mid']], ['2025', ['old']]]);
  // 00:30 on 1 Jan in UTC+8 is still the previous year in UTC, and is shown as such everywhere.
  const edge = new Date('2025-12-31T16:30:00Z');
  assert.equal(isoDate(edge), '2025-12-31');
  assert.equal(groupByYear([{ id: 'edge', data: { pubDate: edge } }])[0]!.year, '2025');
});
