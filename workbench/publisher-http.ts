import { createServer, type IncomingMessage } from 'node:http';
import { z, ZodError } from 'zod';
import { MAX_IMAGE_BYTES } from '../src/lib/images';
import { PublicationExecutor } from './publication-executor';
import { MAX_PLAN_BYTES, parsePublicationSnapshot } from './publication-plan';
import { confirmationSchema, jobId } from './publication-state';
import { WorkbenchError } from './model';
import { DeploymentReader } from './deployment-reader';
// Base64 grows a byte stream by 4/3; one 8 MiB image plus its JSON envelope fits.
const MAX_STAGE_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4096;
const imageKeysSchema = z.strictObject({ keys: z.array(z.string().max(80)).max(1000) });
const stagedImageSchema = z.strictObject({ key: z.string().max(80), data: z.string().max(MAX_STAGE_BYTES).regex(/^[A-Za-z0-9+/]*={0,2}$/) });
async function body(request: IncomingMessage, max: number) {
  if (request.headers['content-type'] !== 'application/json') throw new WorkbenchError('仅接受 JSON。', 415);
  if (Number(request.headers['content-length'] ?? 0) > max) throw new WorkbenchError('请求过大。', 413);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { size += chunk.length; if (size > max) throw new WorkbenchError('请求过大。', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new WorkbenchError('无效的 JSON。'); }
}
/** Unix permissions are the IPC trust boundary. Confirmation stays off unless the caller opts in explicitly. */
export function createPublisherServer(executor: Pick<PublicationExecutor, 'prepare' | 'get' | 'confirm' | 'reconcile' | 'publishEnabled' | 'missingImages' | 'stageImage' | 'imagesReady'>, options: { allowConfirmation?: boolean; deployment?: DeploymentReader } = {}) {
  const deployment = options.deployment ?? new DeploymentReader();
  const canPublish = options.allowConfirmation === true && executor.publishEnabled;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
    const json = (value: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    const preparing = request.method === 'POST' && request.url === '/prepare';
    try {
      if (request.method === 'GET' && request.url === '/status') { json({ configured: true, canPublish, transport: 'isolated-worker', remoteChecked: false }); return; }
      if (request.method === 'POST' && request.url === '/deployment') {
        const value = await body(request, 4096);
        if (!value || Object.keys(value).length !== 1) throw new WorkbenchError('仅接受作业 ID。');
        const job = executor.get(jobId.parse(value.id));
        if (!job.commit || !['pushed', 'no-changes'].includes(job.phase)) throw new WorkbenchError('尚无已证实推送的提交。', 409);
        json(await deployment.query(job.commit)); return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/jobs/')) { json(executor.get(jobId.parse(request.url.slice(6)))); return; }
      if (request.method === 'POST' && request.url === '/images/missing') {
        const value = imageKeysSchema.parse(await body(request, 128 * 1024));
        json({ missing: await executor.missingImages(value.keys) }); return;
      }
      if (request.method === 'POST' && request.url === '/images/stage') {
        const value = stagedImageSchema.parse(await body(request, MAX_STAGE_BYTES));
        executor.stageImage(value.key, Buffer.from(value.data, 'base64')); json({ staged: value.key }); return;
      }
      if (preparing) {
        let snapshot;
        try { snapshot = parsePublicationSnapshot(await body(request, MAX_PLAN_BYTES)); }
        catch (error) { if (error instanceof WorkbenchError && [413,415].includes(error.status)) throw error; throw new WorkbenchError('无效的私有工作区快照。'); }
        const plan = executor.prepare(snapshot);
        json({ ...plan, execution: { ...plan.execution, publishEnabled: canPublish && executor.imagesReady(plan.imageStatus) } }); return;
      }
      if (request.method === 'POST' && request.url === '/reconcile') {
        const value = await body(request, 4096);
        if (!value || Object.keys(value).length !== 1) throw new WorkbenchError('仅接受作业 ID。');
        json(executor.reconcile(jobId.parse(value.id))); return;
      }
      if (request.method === 'POST' && request.url === '/confirm' && canPublish) {
        const input = confirmationSchema.parse(await body(request, 4096)); const job = executor.get(input.id);
        if (job.planId !== input.planId || job.revision !== input.revision || job.baseCommit !== input.baseCommit) throw new WorkbenchError('确认与冻结作业不一致。', 409);
        json(await executor.confirm(input.id, input.revision)); return;
      }
      json({ error: '执行器未开放此接口。' }, 404);
    } catch (error) {
      const status = error instanceof ZodError ? 400 : error instanceof WorkbenchError ? error.status : 409;
      // Never send raw Git stderr, filesystem paths or content-validation values to the web process.
      const message = preparing && error instanceof WorkbenchError && error.message.includes('基线缺少 topology.json')
        ? '远端内容基线缺少 topology.json，尚未完成内容格式迁移；未提交或推送。'
        : preparing ? '远端基线核对失败：请检查内容格式、导入版本及受限连接。未提交或推送。'
        : '无法完成作业请求，请查询状态并人工核对；不会自动重推。';
      json({ error: message }, status);
    }
  });
  // Confirmations may upload images over a 3 Mbps link before pushing; let them run up to ten minutes.
  server.requestTimeout = 20_000; server.headersTimeout = 10_000; server.timeout = 600_000; server.maxHeadersCount = 20;
  return server;
}
