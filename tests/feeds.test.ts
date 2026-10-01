import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absoluteUrls, robotsTxt, rssXml, sitemapXml, xmlText } from '../src/lib/feeds';

const site = new URL('https://blog.xan9x.com');
const article = (id: string, pubDate: string, title = id, html = `<p>${id}</p>`) =>
  ({ id, data: { title, description: `About ${id}`, pubDate: new Date(pubDate) }, html });

test('text is escaped and characters XML 1.0 cannot carry are dropped', () => {
  assert.equal(xmlText(`a & b < c > "d" 'e'`), 'a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
  assert.equal(xmlText('bell\u0007 tab\t 中文'), 'bell tab\t 中文');
});

test('root-relative links and images become absolute; other URLs are left alone', () => {
  const html = '<a href="/notes/a/">a</a><img src="/assets/x.png"><a href="//cdn.example/x">c</a><a href="https://example.com/">e</a><a href="#part">p</a>';
  assert.equal(absoluteUrls(html, site),
    '<a href="https://blog.xan9x.com/notes/a/">a</a><img src="https://blog.xan9x.com/assets/x.png"><a href="//cdn.example/x">c</a><a href="https://example.com/">e</a><a href="#part">p</a>');
});

test('the feed lists full articles newest first and dates itself from content, not the build', () => {
  const feed = rssXml(site, [article('old', '2026-09-21'), article('new', '2026-10-01', 'R&D <notes>', '<p><a href="/notes/old/">old</a></p>')]);
  const items = feed.split('<item>').slice(1);
  assert.equal(items.length, 2);
  assert.match(items[0]!, /<title>R&amp;D &lt;notes&gt;<\/title>/);
  assert.match(items[0]!, /<link>https:\/\/blog\.xan9x\.com\/notes\/new\/<\/link>/);
  assert.match(items[0]!, /<guid isPermaLink="true">https:\/\/blog\.xan9x\.com\/notes\/new\/<\/guid>/);
  assert.match(items[0]!, /<pubDate>Thu, 01 Oct 2026 00:00:00 GMT<\/pubDate>/);
  assert.match(items[0]!, /<content:encoded>&lt;p&gt;&lt;a href=&quot;https:\/\/blog\.xan9x\.com\/notes\/old\/&quot;&gt;/);
  assert.match(items[1]!, /<link>https:\/\/blog\.xan9x\.com\/notes\/old\/<\/link>/);
  assert.match(feed, /<lastBuildDate>Thu, 01 Oct 2026 00:00:00 GMT<\/lastBuildDate>/);
  assert.match(feed, /<atom:link href="https:\/\/blog\.xan9x\.com\/rss\.xml" rel="self" type="application\/rss\+xml"\/>/);
  assert.equal(rssXml(site, [article('new', '2026-10-01'), article('old', '2026-09-21')]), rssXml(site, [article('old', '2026-09-21'), article('new', '2026-10-01')]),
    'same content, same bytes');
});

test('an empty feed is still a valid channel without items or a build date', () => {
  const feed = rssXml(site, []);
  assert.doesNotMatch(feed, /<item>|lastBuildDate/);
  assert.match(feed, /<channel>[\s\S]*<\/channel>/);
});

test('the sitemap lists the home page, the list and every article with content dates', () => {
  const map = sitemapXml(site, [article('old', '2026-09-21'), article('new', '2026-10-01')]);
  assert.deepEqual([...map.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?<\/url>/g)].map(m => [m[1], m[2]]), [
    ['https://blog.xan9x.com/', '2026-10-01'],
    ['https://blog.xan9x.com/notes/', '2026-10-01'],
    ['https://blog.xan9x.com/notes/new/', '2026-10-01'],
    ['https://blog.xan9x.com/notes/old/', '2026-09-21'],
  ]);
  assert.match(sitemapXml(site, []), /<url><loc>https:\/\/blog\.xan9x\.com\/<\/loc><\/url>/);
});

test('robots.txt allows crawling and points at the sitemap', () => {
  assert.equal(robotsTxt(site), 'User-agent: *\nAllow: /\n\nSitemap: https://blog.xan9x.com/sitemap.xml\n');
});
