import { request } from 'node:http';
import path from 'node:path';
import type { WorkspaceStore } from './store';
import { WorkbenchError } from './model';
import { MAX_PLAN_BYTES } from './publication-plan';
import { confirmationSchema, jobSummarySchema, PublicationJournal, publicationSettled, sameJob, type PublicationConfirmation, type PublicationProgress } from './publication-state';
import type { PublicationReviewSummary, PublicationReviewProvider } from './publication-review';
export class PublisherReview implements PublicationReviewProvider {
  private busy = false;
  constructor(private readonly socket: string, private readonly options: { allowConfirmation?: boolean } = {}) { if (!path.isAbsolute(socket)) throw new Error('执行器 socket 必须是绝对路径。'); }
  readonly status = { configured: true, canPublish: false, transport: 'isolated-worker', visibilityDeclaration: 'private', remoteChecked: false };
  private async call(route: string, value?: unknown): Promise<any> {
    const payload = value === undefined ? undefined : JSON.stringify(value);
    if (payload && Buffer.byteLength(payload) > MAX_PLAN_BYTES) throw new WorkbenchError('私有快照超过 16 MiB 限制。', 413);
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socket, path: route, method: payload === undefined ? 'GET' : 'POST', headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => {
        let size = 0; const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_PLAN_BYTES) req.destroy(new Error('response too large')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (response.statusCode !== 200) throw new WorkbenchError(result.error === '远端内容基线缺少 topology.json，尚未完成内容格式迁移；未提交或推送。' ? result.error : '执行器请求未完成，请查询作业状态并核对；不会自动重推。', response.statusCode ?? 503);
            resolve(result);
          } catch (error) { reject(error); }
        });
      });
      const timer = setTimeout(() => req.destroy(new Error('publisher timeout')), 180_000);
      req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(payload);
    }).catch(error => { if (error instanceof WorkbenchError) throw error; throw new WorkbenchError('独立执行器暂不可用；若已确认发布，结果待查询，切勿重新推送。', 503); });
  }
  async availability() {
    const value = await this.call('/status');
    return { ...this.status, canPublish: this.options.allowConfirmation === true && value.canPublish === true };
  }
  progress(store: WorkspaceStore) { return new PublicationJournal(store.directory).read(); }
  private async locked<T>(store: WorkspaceStore, run: (journal: PublicationJournal) => Promise<T>) {
    if (this.busy) throw new WorkbenchError('已有核对或发布请求正在进行，请稍后查询。', 429);
    this.busy = true; const journal = new PublicationJournal(store.directory);
    try { return await journal.locked(() => run(journal)); } finally { this.busy = false; }
  }
  async create(store: WorkspaceStore, revision: string): Promise<PublicationReviewSummary> {
    return this.locked(store, async journal => {
      const previous = journal.read();
      if (previous && !publicationSettled(previous)) throw new WorkbenchError('已有发布结果待核对，请先查询该作业，不能创建新发布。', 409);
      const snapshot = store.get();
      if (snapshot.revision !== revision) throw new WorkbenchError('已保存内容发生变化，请重新读取后再核对。', 409);
      const plan = await this.call('/prepare', { version: snapshot.version, baseRevision: snapshot.baseRevision, workspace: snapshot.workspace, revision });
      if (plan.canPublish !== false || plan.mode !== 'offline-review' || 'snapshot' in plan) throw new WorkbenchError('无效的执行器核对结果。', 503);
      const execution = jobSummarySchema.parse(plan.execution);
      if (store.get().revision !== revision || plan.revision !== revision || execution.revision !== revision) throw new WorkbenchError('核对期间内容发生变化，结果已丢弃；请重新核对。', 409);
      return { ...plan, execution: { ...execution, publishEnabled: this.options.allowConfirmation === true && execution.publishEnabled } };
    });
  }
  private acceptResult(store: WorkspaceStore, journal: PublicationJournal, previous: PublicationProgress, value: unknown): PublicationProgress {
    const job = jobSummarySchema.parse(value);
    if (!sameJob(previous.job, job)) throw new WorkbenchError('执行器返回了不同作业，拒绝修改工作区基线。', 409);
    const next: PublicationProgress = { ...previous, job };
    if (next.baseline === 'pending' && ['pushed', 'no-changes'].includes(job.phase)) {
      try { store.advancePublicationBase(job.baseRevision, job.candidateDigest); next.baseline = 'advanced'; }
      catch { next.baseline = 'conflict'; } // Git success is retained even if the private baseline cannot advance.
    }
    journal.write(next); return next;
  }
  async confirm(store: WorkspaceStore, input: PublicationConfirmation): Promise<PublicationProgress> {
    confirmationSchema.parse(input);
    if (!this.options.allowConfirmation) throw new WorkbenchError('生产首次真实发布尚未开放。', 403);
    return this.locked(store, async journal => {
      const previous = journal.read();
      if (previous?.job.id === input.id) {
        if (previous.job.planId !== input.planId || previous.job.revision !== input.revision || previous.job.baseCommit !== input.baseCommit) throw new WorkbenchError('确认与原作业不一致。', 409);
        // Duplicate requests only observe. Even a prepared receipt must never send /confirm again.
        return this.acceptResult(store, journal, previous, await this.call('/reconcile', { id: input.id }));
      }
      if (previous && !publicationSettled(previous)) throw new WorkbenchError('已有发布结果待核对，禁止创建另一个发布。', 409);
      const job = jobSummarySchema.parse(await this.call('/jobs/' + input.id));
      if (!job.publishEnabled || !(await this.availability()).canPublish) throw new WorkbenchError('执行器未开放真实推送。', 403);
      if (job.phase !== 'prepared' || job.planId !== input.planId || job.revision !== input.revision || job.baseCommit !== input.baseCommit) throw new WorkbenchError('确认与冻结作业不一致，请重新核对。', 409);
      const current = store.get();
      if (current.revision !== input.revision || current.baseRevision !== job.baseRevision || Date.now() >= Date.parse(job.expiresAt)) throw new WorkbenchError('已保存版本或基线已变化，或计划已过期，请重新核对。', 409);
      const accepted: PublicationProgress = { version: 1, job, baseline: 'pending' };
      journal.write(accepted); // Durable before IPC: losing the response cannot authorize a replay.
      try { return this.acceptResult(store, journal, accepted, await this.call('/confirm', input)); }
      catch { throw new WorkbenchError('确认请求已记录，但执行结果待查询；不要重复发布。请点击“查询作业状态”。', 503); }
    });
  }
  async reconcile(store: WorkspaceStore): Promise<PublicationProgress | null> {
    return this.locked(store, async journal => {
      const current = journal.read(); if (!current) return null;
      return this.acceptResult(store, journal, current, await this.call('/reconcile', { id: current.job.id }));
    });
  }
}
