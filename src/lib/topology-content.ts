import { z } from 'zod';
import { parseTopology, type TopologyDocument, type TopologyNode } from '@xan9x/topology/schema';

export const contentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const articleSchema = z.object({
  id: contentId,
  title: z.string().trim().min(1),
  description: z.string(),
  pubDate: z.coerce.date(),
  draft: z.boolean().default(false),
  topics: z.array(contentId).default([]),
});
export type ArticleData = z.infer<typeof articleSchema>;
export interface ArticleRecord { id: string; data: ArticleData }
export interface TopologySource {
  document: TopologyDocument;
  articleRefs: Record<string, string>;
}
const sourceSchema = z.strictObject({
  document: z.unknown(),
  articleRefs: z.record(contentId, contentId),
});
export function parseTopologySource(input: unknown): TopologySource {
  const source = sourceSchema.parse(input);
  return { document: parseTopology(source.document), articleRefs: source.articleRefs };
}
export function articleHref(id: string): string {
  return '/notes/' + encodeURIComponent(contentId.parse(id)) + '/';
}

/** Validate the entire authoring graph first, then project only publishable data. */
export function compilePublicTopology(input: unknown, articles: readonly ArticleRecord[]): TopologySource {
  const source = parseTopologySource(input);
  const nodes = new Map<string, TopologyNode>();
  const visit = (node: TopologyNode) => { nodes.set(node.id, node); node.children?.forEach(visit); };
  visit(source.document.root);
  const catalog = new Map<string, ArticleData>();
  for (const article of articles) {
    const data = articleSchema.parse(article.data);
    if (article.id !== data.id) throw new Error('Article ID mismatch: ' + article.id);
    if (catalog.has(article.id)) throw new Error('Duplicate article ID: ' + article.id);
    catalog.set(article.id, data);
    for (const topic of data.topics) {
      if (!['topic', 'index'].includes(nodes.get(topic)?.type ?? '')) {
        throw new Error('Unknown topic ' + topic + ' in article ' + article.id);
      }
    }
  }
  for (const [nodeId, articleId] of Object.entries(source.articleRefs)) {
    if (nodes.get(nodeId)?.type !== 'article') throw new Error('Article reference must target an article node: ' + nodeId);
    if (!catalog.has(articleId)) throw new Error('Unknown article: ' + articleId + ' (node ' + nodeId + ')');
  }
  for (const node of nodes.values()) {
    if (node.href !== undefined) throw new Error('Authored href is not allowed; links come from content references: ' + node.id);
    if (node.type === 'project') throw new Error('Project content references are not implemented yet: ' + node.id);
    if (node.type === 'article' && !Object.hasOwn(source.articleRefs, node.id)) {
      throw new Error('Missing article reference: ' + node.id);
    }
  }
  const visible = new Set<string>();
  const articleRefs: Record<string, string> = {};
  const project = (node: TopologyNode): TopologyNode | undefined => {
    if (node.type === 'article') {
      const articleId = source.articleRefs[node.id]!;
      const data = catalog.get(articleId)!;
      if (data.draft) return undefined;
      visible.add(node.id);
      articleRefs[node.id] = articleId;
      return { id: node.id, type: 'article', label: data.title, description: data.description,
        meta: data.pubDate.toISOString().slice(0, 10), href: articleHref(articleId) };
    }
    visible.add(node.id);
    const children = node.children?.map(project).filter((child): child is TopologyNode => child !== undefined);
    return { ...node, ...(children ? { children } : {}) };
  };
  const root = project(source.document.root)!;
  const document = parseTopology({ version: 1, root,
    relations: source.document.relations.filter(([a, b]) => visible.has(a) && visible.has(b)) });
  return { document, articleRefs };
}

/** A publishable authoring file: links will be regenerated at the next build. */
export function publicAuthoringSource(compiled: TopologySource): TopologySource {
  const source = structuredClone(compiled);
  const strip = (node: TopologyNode) => { delete node.href; node.children?.forEach(strip); };
  strip(source.document.root);
  return source;
}

/** Reader-only projection. Keep the complete directory taxonomy for authoring and topic validation. */
export function publicDirectoryDocument(document: TopologyDocument): TopologyDocument {
  const visible = new Set<string>();
  const visit = (node: TopologyNode): TopologyNode | undefined => {
    if (node.type === 'article') {
      visible.add(node.id);
      return { ...node };
    }
    const children = (node.children ?? []).map(visit).filter((child): child is TopologyNode => child !== undefined);
    if (node.type !== 'root' && children.length === 0) return undefined;
    visible.add(node.id);
    return { ...node, children };
  };
  const root = visit(document.root)!;
  return parseTopology({ version: 1, root,
    relations: document.relations.filter(([a, b]) => visible.has(a) && visible.has(b)) });
}
