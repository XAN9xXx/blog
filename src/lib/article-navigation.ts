import type { TopologyDocument, TopologyNode } from '@xan9x/topology/schema';
import { articleHref } from './topology-content';

export interface MapPlacement {
  /** Directory labels from the first level below the root down to the article's parent. */
  labels: string[];
  /** Homepage deep link that focuses the article's parent directory. */
  href: string;
  /** Branch colour of the top-level topic (a validated hex or CSS variable). */
  color?: string;
}

/** Every public map entry of an article, in map order. Pass the reader projection, never the authoring tree. */
export function articlePlacements(document: TopologyDocument, articleId: string): MapPlacement[] {
  const target = articleHref(articleId);
  const placements: MapPlacement[] = [];
  const visit = (node: TopologyNode, trail: TopologyNode[]) => {
    if (node.type === 'article') {
      if (node.href !== target) return;
      // Node IDs are restricted to [A-Za-z0-9._-], so the path needs no escaping.
      placements.push(trail.length
        ? { labels: trail.map(item => item.label), href: '/#topic=' + trail.map(item => item.id).join('/'), color: trail[0]!.color }
        : { labels: [document.root.label], href: '/#map' });
      return;
    }
    const next = node.type === 'root' ? trail : [...trail, node];
    node.children?.forEach(child => visit(child, next));
  };
  visit(document.root, []);
  return placements;
}

interface Dated { id: string; data: { pubDate: Date } }
/** The one reading order used by the list, previous/next links and the feed. */
export const newestFirst = (a: Dated, b: Dated) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf() || a.id.localeCompare(b.id);

/** Published articles in reading order: previous is the next older one, next the next newer one. */
export function adjacentArticles<T extends Dated>(articles: readonly T[], id: string): { previous?: T; next?: T } {
  const sorted = [...articles].sort(newestFirst);
  const index = sorted.findIndex(article => article.id === id);
  if (index < 0) return {};
  return { previous: sorted[index + 1], next: sorted[index - 1] };
}

/** Newest first, grouped by the UTC year used everywhere dates are shown. */
export function groupByYear<T extends Dated>(articles: readonly T[]): { year: string; articles: T[] }[] {
  const groups: { year: string; articles: T[] }[] = [];
  for (const article of [...articles].sort(newestFirst)) {
    const year = isoDate(article.data.pubDate).slice(0, 4);
    if (groups.at(-1)?.year !== year) groups.push({ year, articles: [] });
    groups.at(-1)!.articles.push(article);
  }
  return groups;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
