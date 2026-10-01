import { articleHref } from './topology-content';
import { isoDate, newestFirst } from './article-navigation';

export interface FeedArticle { id: string; data: { title: string; description: string; pubDate: Date }; html: string }

const INVALID_XML = /[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/gu;
const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Text content for XML: escaped, with characters XML 1.0 cannot carry removed. */
export function xmlText(text: string): string {
  return text.replace(INVALID_XML, '').replace(/[&<>"']/g, char => ENTITIES[char]!);
}

/** Feed readers resolve relative links inconsistently, so root-relative URLs become absolute. */
export function absoluteUrls(html: string, site: URL): string {
  return html.replace(/(\s(?:href|src)=")\/(?!\/)/g, `$1${site.origin}/`);
}

// Output depends only on content, never on build time, so an unchanged site produces identical files.
export function rssXml(site: URL, articles: readonly FeedArticle[]): string {
  const sorted = [...articles].sort(newestFirst);
  const url = (path: string) => xmlText(new URL(path, site).href);
  const items = sorted.map(article => [
    '<item>',
    `<title>${xmlText(article.data.title)}</title>`,
    `<link>${url(articleHref(article.id))}</link>`,
    `<guid isPermaLink="true">${url(articleHref(article.id))}</guid>`,
    `<pubDate>${article.data.pubDate.toUTCString()}</pubDate>`,
    `<description>${xmlText(article.data.description)}</description>`,
    `<content:encoded>${xmlText(absoluteUrls(article.html, site))}</content:encoded>`,
    '</item>',
  ].join('\n'));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '<channel>',
    '<title>XAN9x</title>',
    `<link>${url('/')}</link>`,
    '<description>软件、Linux、基础设施、开源与编译器的技术笔记。</description>',
    '<language>zh-CN</language>',
    `<atom:link href="${url('/rss.xml')}" rel="self" type="application/rss+xml"/>`,
    ...(sorted.length ? [`<lastBuildDate>${sorted[0]!.data.pubDate.toUTCString()}</lastBuildDate>`] : []),
    ...items,
    '</channel>',
    '</rss>',
    '',
  ].join('\n');
}

export function sitemapXml(site: URL, articles: readonly Pick<FeedArticle, 'id' | 'data'>[]): string {
  const sorted = [...articles].sort(newestFirst);
  const newest = sorted[0] ? isoDate(sorted[0].data.pubDate) : undefined;
  const entry = (path: string, lastmod?: string) =>
    `<url><loc>${xmlText(new URL(path, site).href)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entry('/', newest),
    entry('/notes/', newest),
    ...sorted.map(article => entry(articleHref(article.id), isoDate(article.data.pubDate))),
    '</urlset>',
    '',
  ].join('\n');
}

export function robotsTxt(site: URL): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${new URL('/sitemap.xml', site).href}\n`;
}
