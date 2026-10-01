import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { rssXml } from '../lib/feeds';

export const GET: APIRoute = async ({ site }) => {
  if (!site) throw new Error('astro.config.mjs must set site for the feed.');
  const articles = await getCollection('articles', ({ data }) => !data.draft);
  const feed = rssXml(site, articles.map(article => ({ id: article.id, data: article.data, html: article.rendered?.html ?? '' })));
  return new Response(feed, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
};
