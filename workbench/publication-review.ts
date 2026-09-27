import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { WorkbenchError } from './model';
import type { WorkspaceStore } from './store';
import { MAX_PLAN_BYTES, type RepositoryVisibility, type publicationPlanSummary } from './publication-plan';

export type PublicationReviewSummary = ReturnType<typeof publicationPlanSummary>;
export interface PublicationReviewConfig { repository: string; baseCommit: string; visibility: RepositoryVisibility }
export function publicationReviewConfig(env: NodeJS.ProcessEnv): PublicationReviewConfig | undefined {
  const repository = env.WORKBENCH_REVIEW_REPOSITORY; const baseCommit = env.WORKBENCH_REVIEW_BASE_COMMIT;
  const visibility = env.WORKBENCH_REVIEW_VISIBILITY ?? 'unknown';
  if (!repository && !baseCommit && env.WORKBENCH_REVIEW_VISIBILITY === undefined) return;
  if (!repository || !path.isAbsolute(repository) || !/^[a-f0-9]{40}$/.test(baseCommit ?? '') || !['private', 'public', 'unknown'].includes(visibility)) {
    throw new Error('发布核对需要本地仓库绝对路径、完整基线 SHA 和有效可见性声明。');
  }
  return { repository, baseCommit: baseCommit!, visibility: visibility as RepositoryVisibility };
}
/** Runs the existing read-only CLI off the HTTP event loop. Never accepts Git targets from the browser. */
export class PublicationReview {
  private busy = false;
  constructor(private readonly config: PublicationReviewConfig) {}
  get status() { return { configured: true, canPublish: false, baseCommit: this.config.baseCommit, visibilityDeclaration: this.config.visibility, remoteChecked: false }; }
  async create(store: WorkspaceStore, revision: string): Promise<PublicationReviewSummary> {
    if (this.busy) throw new WorkbenchError('已有核对正在进行，请稍后重试。', 429);
    if (store.get().revision !== revision) throw new WorkbenchError('已保存内容发生变化，请重新读取后再核对。', 409);
    this.busy = true;
    try {
      const blog = path.resolve(import.meta.dirname, '..');
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'workbench/plan-publication.ts',
        '--snapshot', path.join(store.directory, 'workspace.json'), '--content-repo', this.config.repository,
        '--base-commit', this.config.baseCommit, '--visibility', this.config.visibility], {
        cwd: blog, env, encoding: 'utf8', maxBuffer: MAX_PLAN_BYTES, timeout: 60_000, killSignal: 'SIGKILL', windowsHide: true,
      });
      const summary = JSON.parse(stdout) as PublicationReviewSummary;
      if (summary.canPublish !== false || summary.mode !== 'offline-review' || 'snapshot' in summary) throw new Error('Invalid review output');
      if (summary.revision !== revision || store.get().revision !== revision) throw new WorkbenchError('核对期间内容发生变化，结果已丢弃；请重新读取后再核对。', 409);
      return summary;
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      // CLI diagnostics and process errors may contain private paths; never send raw stderr to the browser.
      throw new WorkbenchError('无法核对本地基线：请检查导入版本、Git 提交、内容契约及读取权限；未提交或推送任何内容。', 409);
    } finally { this.busy = false; }
  }
}
