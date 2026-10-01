import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { sitemapXml } from '../lib/feeds';

export const GET: APIRoute = async ({ site }) => {
  if (!site) throw new Error('astro.config.mjs must set site for the sitemap.');
  const articles = await getCollection('articles', ({ data }) => !data.draft);
  return new Response(sitemapXml(site, articles), { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
