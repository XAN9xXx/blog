import { createHash } from 'node:crypto';
import { z } from 'zod';
import { flatten, parseArticle, preview, validateWorkspace, WorkbenchError, type Workspace } from './model';

export const PLAN_TTL_MS = 15 * 60_000;
export const MAX_PLAN_BYTES = 16 * 1024 * 1024;
export type RepositoryVisibility = 'private' | 'public' | 'unknown';
export interface PublicationBaseline {
  commit: string;
  headCommit: string;
  /** Managed blobs read from the specified commit, never from the working tree. */
  files: Record<string, string>;
  preservedFileCount: number;
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
// Match WorkspaceStore's version-1 digest exactly; this is not a Git object ID.
const digest = (value: unknown) => sha(JSON.stringify(value));
const visibilitySchema = z.enum(['private', 'public', 'unknown']);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const snapshotSchema = z.object({ version: z.literal(1), baseRevision: z.string().regex(/^[a-f0-9]{64}$/), workspace: z.unknown(), revision: z.string().optional() });
export function parsePublicationSnapshot(input: unknown) {
  const value = snapshotSchema.parse(input);
  const snapshot = { version: 1 as const, baseRevision: value.baseRevision, workspace: validateWorkspace(value.workspace) };
  if (value.revision !== undefined && value.revision !== digest(snapshot)) throw new WorkbenchError('快照版本与内容不一致。', 409);
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_PLAN_BYTES) throw new WorkbenchError('离线计划快照超过 16 MiB 限制。');
  return snapshot;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
/** Match loadContentCatalog's sorted depth-first traversal, including a/ before a.md. */
export function compareArticlePaths(a: string, b: string): number {
  const left = a.split('/'); const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  return left.length - right.length;
}
function baselineWorkspace(baseline: PublicationBaseline) {
  commitSchema.parse(baseline.commit); commitSchema.parse(baseline.headCommit);
  if (baseline.commit !== baseline.headCommit) throw new WorkbenchError('本地仓库 HEAD 已偏离指定基线，需要重新核对。', 409);
  z.number().int().nonnegative().parse(baseline.preservedFileCount);
  const files = Object.entries(baseline.files);
  if (!Object.hasOwn(baseline.files, 'topology.json')) throw new WorkbenchError('基线缺少 topology.json。');
  if (files.some(([name, raw]) => typeof raw !== 'string' || name !== 'topology.json' && !(name.startsWith('articles/') && name.endsWith('.md')))) throw new WorkbenchError('计划只能管理 articles/**/*.md 和 topology.json。');
  if (files.reduce((sum, [, raw]) => sum + Buffer.byteLength(raw), 0) > MAX_PLAN_BYTES) throw new WorkbenchError('离线计划基线超过 16 MiB 限制。');
  return validateWorkspace({ version: 1, topology: JSON.parse(baseline.files['topology.json']!), articles: files.filter(([name]) => name !== 'topology.json').sort(([a], [b]) => compareArticlePaths(a, b)).map(([path, raw]) => ({ path, raw })) });
}
function articleSummary(file: Workspace['articles'][number]) {
  const article = parseArticle(file);
  return { id: article.id, title: article.data.title, path: article.path, draft: article.data.draft };
}
function directoryEntries(workspace: Workspace) {
  return new Map(flatten(workspace.topology.document.root).map(({ node, parent }) => {
    const { children: _children, ...metadata } = node;
    return [node.id, { ...metadata, parentId: parent?.id ?? null, position: parent?.children?.findIndex(child => child.id === node.id) ?? 0, articleId: workspace.topology.articleRefs[node.id] ?? null }];
  }));
}
function directoryChanges(before: Workspace, after: Workspace) {
  const left = directoryEntries(before); const right = directoryEntries(after);
  const added = [...right.values()].filter(node => !left.has(node.id));
  const removed = [...left.values()].filter(node => !right.has(node.id));
  const modified = [...right.values()].filter(node => left.has(node.id) && canonical(node) !== canonical(left.get(node.id))).map(node => ({ id: node.id, before: left.get(node.id)!, after: node }));
  const relations = (workspace: Workspace) => new Map(workspace.topology.document.relations.map(edge => [canonical(edge), edge]));
  const oldRelations = relations(before); const newRelations = relations(after);
  return { added, removed, modified, relationsAdded: [...newRelations].filter(([key]) => !oldRelations.has(key)).map(([, edge]) => edge), relationsRemoved: [...oldRelations].filter(([key]) => !newRelations.has(key)).map(([, edge]) => edge) };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Pure, offline preparation. It never writes files, calls Git, or authorizes publication. */
export function createPublicationPlan(input: unknown, baseline: PublicationBaseline, options: { visibility?: RepositoryVisibility; now?: number } = {}) {
  const snapshot = parsePublicationSnapshot(input);
  const before = baselineWorkspace(baseline);
  if (digest(before) !== snapshot.baseRevision) throw new WorkbenchError('快照的导入基线与指定 Git 提交不一致，不能覆盖；请先核对来源。', 409);
  const visibility = visibilitySchema.parse(options.visibility ?? 'unknown');
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - PLAN_TTL_MS) throw new WorkbenchError('无效的计划时间。');
  const after = snapshot.workspace;
  // Avoid rewriting topology formatting merely because a plan was generated.
  const topology = canonical(before.topology) === canonical(after.topology) ? baseline.files['topology.json']! : JSON.stringify(after.topology, null, 2) + '\n';
  const candidateFiles = Object.fromEntries([...after.articles.map(file => [file.path, file.raw] as const), ['topology.json', topology]]);
  const paths = [...new Set([...Object.keys(baseline.files), ...Object.keys(candidateFiles)])].sort();
  const files = paths.filter(path => baseline.files[path] !== candidateFiles[path]).map(path => ({
    path, kind: !Object.hasOwn(baseline.files, path) ? 'added' as const : !Object.hasOwn(candidateFiles, path) ? 'deleted' as const : 'modified' as const,
    beforeHash: Object.hasOwn(baseline.files, path) ? sha(baseline.files[path]!) : null,
    afterHash: Object.hasOwn(candidateFiles, path) ? sha(candidateFiles[path]!) : null,
  }));
  const previousArticles = new Map(before.articles.map(file => [parseArticle(file).id, file]));
  const nextArticles = new Map(after.articles.map(file => [parseArticle(file).id, file]));
  const articles = [...new Set([...previousArticles.keys(), ...nextArticles.keys()])].sort().flatMap(id => {
    const old = previousArticles.get(id); const next = nextArticles.get(id);
    if (old && next && old.path === next.path && old.raw === next.raw) return [];
    return [{ id, kind: !old ? 'added' as const : !next ? 'deleted' as const : old.path !== next.path ? 'moved' as const : 'modified' as const,
      contentChanged: Boolean(old && next && old.raw !== next.raw), before: old ? articleSummary(old) : null, after: next ? articleSummary(next) : null }];
  });
  const drafts = after.articles.filter(file => parseArticle(file).data.draft).map(articleSummary);
  const publicArticles = after.articles.filter(file => !parseArticle(file).data.draft).map(articleSummary);
  const issues: { code: string; message: string }[] = [];
  if (visibility === 'unknown') issues.push({ code: 'visibility-unconfirmed', message: '尚未确认 content 仓库及所有镜像的可见性。' });
  if (drafts.length && visibility !== 'private') issues.push({ code: 'draft-privacy', message: '完整快照含草稿；禁止向公开或可见性未知的仓库上传此快照。' });
  const payload = { version: 1 as const, mode: 'offline-review' as const, canPublish: false as const,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PLAN_TTL_MS).toISOString(),
    baseCommit: baseline.commit, baseRevision: snapshot.baseRevision, revision: digest(snapshot), candidateDigest: digest(after),
    checks: { localBaselineContentMatches: true as const, importCommitProvenanceVerified: false as const, remoteChecked: false as const, workingTreeUsed: false as const, visibilityDeclaration: visibility },
    noChanges: files.length === 0, files, articles, directories: directoryChanges(before, after),
    disclosure: { drafts, publicArticles, publicMapEntries: flatten(preview(after, 'public').root).filter(({ node }) => node.type === 'article').length, preservedFileCount: baseline.preservedFileCount },
    issues, snapshot,
  };
  return freeze({ planId: sha(canonical(payload)), ...payload });
}
export type PublicationPlan = ReturnType<typeof createPublicationPlan>;
/** CLI-safe summary omits frozen Markdown, but titles and filenames are still private. */
export function publicationPlanSummary(plan: PublicationPlan) {
  const { snapshot: _snapshot, ...summary } = plan;
  return summary;
}
/** Recheck an in-memory plan for review only; even a current plan cannot publish. */
export function assertPublicationPlanCurrent(plan: PublicationPlan, input: unknown, baseline: PublicationBaseline, visibility: RepositoryVisibility, now = Date.now()): void {
  const created = Date.parse(plan.createdAt);
  if (!Number.isSafeInteger(now) || !Number.isFinite(created) || created > now || now >= created + PLAN_TTL_MS) throw new WorkbenchError('发布计划已过期或时间无效，请重新生成。', 409);
  const expected = createPublicationPlan(input, baseline, { visibility, now: created });
  if (canonical(expected) !== canonical(plan)) throw new WorkbenchError('快照、基线或计划内容已变化，请重新生成。', 409);
}
