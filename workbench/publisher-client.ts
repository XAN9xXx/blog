import { request } from 'node:http';
import path from 'node:path';
import type { WorkspaceStore } from './store';
import { WorkbenchError } from './model';
import { MAX_PLAN_BYTES } from './publication-plan';
import type { PublicationReviewSummary, PublicationReviewProvider } from './publication-review';
export class PublisherReview implements PublicationReviewProvider {
  private busy = false;
  constructor(private readonly socket: string) { if (!path.isAbsolute(socket)) throw new Error('执行器 socket 必须是绝对路径。'); }
  readonly status = { configured: true, canPublish: false, transport: 'isolated-worker', visibilityDeclaration: 'private', remoteChecked: false };
  async create(store: WorkspaceStore, revision: string): Promise<PublicationReviewSummary> {
    if (this.busy) throw new WorkbenchError('已有核对正在进行，请稍后重试。', 429);
    const snapshot = store.get();
    if (snapshot.revision !== revision) throw new WorkbenchError('已保存内容发生变化，请重新读取后再核对。', 409);
    const payload = JSON.stringify({ version: snapshot.version, baseRevision: snapshot.baseRevision, workspace: snapshot.workspace, revision });
    if (Buffer.byteLength(payload) > MAX_PLAN_BYTES) throw new WorkbenchError('私有快照超过 16 MiB 限制。', 413);
    this.busy = true;
    try {
      const plan = await new Promise<PublicationReviewSummary>((resolve, reject) => {
        const req = request({ socketPath: this.socket, path: '/prepare', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => {
          let size = 0; const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_PLAN_BYTES) req.destroy(new Error('response too large')); else chunks.push(chunk); });
          response.on('error', reject);
          response.on('end', () => {
            try {
              const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (response.statusCode !== 200) throw new WorkbenchError(result.error === '远端内容基线缺少 topology.json，尚未完成内容格式迁移；未提交或推送。' ? result.error : '独立执行器无法核对远端基线；请检查格式、导入版本及连接。未提交或推送。', 409);
              if (result.canPublish !== false || result.mode !== 'offline-review' || 'snapshot' in result) throw new Error('invalid summary');
              resolve(result);
            } catch (error) { reject(error); }
          });
        });
        const timer = setTimeout(() => req.destroy(new Error('publisher timeout')), 180_000);
        req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(payload);
      });
      if (store.get().revision !== revision || plan.revision !== revision) throw new WorkbenchError('核对期间内容发生变化，结果已丢弃；请重新核对。', 409);
      return plan;
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError('独立核对执行器暂不可用；未提交或推送。', 503);
    } finally { this.busy = false; }
  }
}
