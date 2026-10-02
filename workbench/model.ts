import { z } from 'zod';
import matter from 'gray-matter';
import { articleSchema, contentId, compilePublicTopology, parseTopologySource, publicDirectoryDocument, type TopologySource } from '../src/lib/topology-content';
import { DEFAULT_LANG } from '../src/lib/i18n';
import type { TopologyNode } from '@xan9x/topology/schema';

export class WorkbenchError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const articlePath = z.string().max(300).regex(/^articles\/(?:[A-Za-z0-9][A-Za-z0-9_-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/);
const fileSchema = z.strictObject({ path: articlePath, raw: z.string().max(512_000) });
const workspaceSchema = z.strictObject({ version: z.literal(1), topology: z.unknown(), articles: z.array(fileSchema).max(1000) });
export interface Workspace { version: 1; topology: TopologySource; articles: z.infer<typeof fileSchema>[] }
export function parseArticle(file: Workspace['articles'][number]) {
  if (!/^\uFEFF?---[ \t]*\r?\n/.test(file.raw) || !/\r?\n---[ \t]*(?:\r?\n|$)/.test(file.raw)) {
    throw new WorkbenchError('文章必须使用 YAML frontmatter，不能包含可执行 frontmatter。');
  }
  const parsed = matter(file.raw, { language: 'yaml' });
  const data = articleSchema.parse(parsed.data);
  return { id: data.id, path: file.path, data, body: parsed.content, metadata: parsed.data };
}
export function validateWorkspace(input: unknown): Workspace {
  const parsed = workspaceSchema.parse(input);
  const topology = parseTopologySource(parsed.topology);
  const paths = new Set<string>();
  for (const file of parsed.articles) {
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw new WorkbenchError('文章路径重复：' + file.path);
    paths.add(key);
  }
  compilePublicTopology(topology, parsed.articles.map(parseArticle));
  return { ...parsed, topology };
}
export function flatten(root: TopologyNode): { node: TopologyNode; parent?: TopologyNode }[] {
  const result: { node: TopologyNode; parent?: TopologyNode }[] = [];
  const visit = (node: TopologyNode, parent?: TopologyNode) => { result.push({ node, parent }); node.children?.forEach(child => visit(child, node)); };
  visit(root); return result;
}
export function preview(workspace: Workspace, mode: 'editing' | 'public') {
  const articles = workspace.articles.map(parseArticle);
  const records = mode === 'editing' ? articles.map(a => ({ ...a, data: { ...a.data, draft: false } })) : articles;
  const document = compilePublicTopology(workspace.topology, records).document;
  return mode === 'public' ? publicDirectoryDocument(document) : document;
}
const label = z.string().trim().min(1).max(240);
export const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('saveArticle'), create: z.boolean(), path: articlePath, data: articleSchema, body: z.string().max(480_000) }),
  z.strictObject({ type: z.literal('deleteArticle'), id: contentId, confirm: z.literal(true) }),
  z.strictObject({ type: z.literal('addDirectory'), id: contentId, parentId: contentId, kind: z.enum(['topic', 'index']), label }),
  z.strictObject({ type: z.literal('editDirectory'), id: contentId, label, description: z.string().max(10000) }),
  z.strictObject({ type: z.literal('moveNode'), id: contentId, parentId: contentId, index: z.number().int().min(0).max(2000) }),
  z.strictObject({ type: z.literal('removeNode'), id: contentId, confirm: z.literal(true) }),
  z.strictObject({ type: z.literal('bindArticle'), nodeId: contentId, parentId: contentId, articleId: contentId }),
  z.strictObject({ type: z.literal('rebindArticle'), nodeId: contentId, articleId: contentId }),
]);
export type Command = z.input<typeof commandSchema>;
export function applyCommand(current: Workspace, input: unknown): Workspace {
  const command = commandSchema.parse(input);
  const workspace = structuredClone(current);
  const entries = flatten(workspace.topology.document.root);
  const entry = (id: string) => {
    const found = entries.find(e => e.node.id === id);
    if (!found) throw new WorkbenchError('找不到目录节点：' + id); return found;
  };
  const directory = (id: string) => {
    const node = entry(id).node;
    if (!['root', 'topic', 'index'].includes(node.type)) throw new WorkbenchError('文章节点不能作为父目录。');
    node.children ??= []; return node;
  };
  const newId = (id: string) => { if (entries.some(e => e.node.id === id)) throw new WorkbenchError('节点 ID 已存在：' + id); };
  const articles = workspace.articles.map(parseArticle);
  switch (command.type) {
    case 'saveArticle': {
      const index = articles.findIndex(a => a.id === command.data.id);
      if (command.create ? index !== -1 : index === -1) throw new WorkbenchError('文章已存在或已被删除，请重新加载。', 409);
      const metadata = index < 0 ? {} : articles[index]!.metadata;
      const fields: Record<string, unknown> = { ...metadata, ...command.data };
      // The default language stays implicit: files gain no field, and switching back removes an old one.
      if ((command.data.lang ?? DEFAULT_LANG) === DEFAULT_LANG) delete fields.lang;
      const raw = matter.stringify(command.body, fields, { language: 'yaml' });
      const file = { path: command.path, raw };
      if (index < 0) workspace.articles.push(file); else workspace.articles[index] = file;
      break;
    }
    case 'deleteArticle': {
      const refs = Object.entries(workspace.topology.articleRefs).filter(([, id]) => id === command.id).map(([id]) => id);
      if (refs.length) throw new WorkbenchError('请先移除或重新绑定这些文章入口：' + refs.join('、'), 409);
      const index = articles.findIndex(a => a.id === command.id);
      if (index < 0) throw new WorkbenchError('文章不存在。');
      workspace.articles.splice(index, 1); break;
    }
    case 'addDirectory':
      newId(command.id);
      directory(command.parentId).children!.push({ id: command.id, type: command.kind, label: command.label, children: [] }); break;
    case 'editDirectory': {
      const node = directory(command.id); node.label = command.label; node.description = command.description; break;
    }
    case 'bindArticle':
      newId(command.nodeId);
      directory(command.parentId).children!.push({ id: command.nodeId, type: 'article', label: '文章' });
      workspace.topology.articleRefs[command.nodeId] = command.articleId; break;
    case 'rebindArticle':
      if (entry(command.nodeId).node.type !== 'article') throw new WorkbenchError('只能重新绑定文章节点。');
      workspace.topology.articleRefs[command.nodeId] = command.articleId; break;
    case 'moveNode': {
      const { node, parent } = entry(command.id);
      if (!parent) throw new WorkbenchError('不能移动根节点。');
      if (flatten(node).some(e => e.node.id === command.parentId)) throw new WorkbenchError('不能把节点移入自己的子树。');
      const target = directory(command.parentId);
      parent.children!.splice(parent.children!.indexOf(node), 1);
      target.children!.splice(Math.min(command.index, target.children!.length), 0, node); break;
    }
    case 'removeNode': {
      const { node, parent } = entry(command.id);
      if (!parent) throw new WorkbenchError('不能移除根节点。');
      const removed = new Set(flatten(node).map(e => e.node.id));
      const references = articles.filter(a => a.data.topics.some(topic => removed.has(topic)));
      if (references.length) throw new WorkbenchError('请先修改这些文章的主题分类：' + references.map(a => a.id).join('、'), 409);
      parent.children!.splice(parent.children!.indexOf(node), 1);
      for (const id of removed) delete workspace.topology.articleRefs[id];
      workspace.topology.document.relations = workspace.topology.document.relations.filter(([a,b]) => !removed.has(a) && !removed.has(b));
      break;
    }
  }
  return validateWorkspace(workspace);
}
