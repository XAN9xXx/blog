import type { APIRoute } from 'astro';
import { robotsTxt } from '../lib/feeds';

export const GET: APIRoute = ({ site }) => {
  if (!site) throw new Error('astro.config.mjs must set site for robots.txt.');
  return new Response(robotsTxt(site), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
