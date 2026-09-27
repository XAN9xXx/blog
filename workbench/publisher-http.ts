import { createServer } from 'node:http';
import { PublicationExecutor } from './publication-executor';
import { MAX_PLAN_BYTES, parsePublicationSnapshot } from './publication-plan';
import { WorkbenchError } from './model';
/** Unix socket permissions are the trust boundary. This release exposes review only, never confirm/push. */
export function createPublisherServer(executor: Pick<PublicationExecutor, 'prepare'>) {
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
    const json = (value: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    try {
      if (request.method === 'GET' && request.url === '/status') { json({ configured: true, canPublish: false, transport: 'isolated-worker', remoteChecked: false }); return; }
      if (request.method !== 'POST' || request.url !== '/prepare') { json({ error: '执行器仅开放核对，未开放发布。' }, 404); return; }
      if (request.headers['content-type'] !== 'application/json') { json({ error: '仅接受 JSON。' }, 415); return; }
      if (Number(request.headers['content-length'] ?? 0) > MAX_PLAN_BYTES) { json({ error: '请求过大。' }, 413); return; }
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { size += chunk.length; if (size > MAX_PLAN_BYTES) { json({ error: '请求过大。' }, 413); return; } chunks.push(chunk); }
      let snapshot;
      try { snapshot = parsePublicationSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { json({ error: '无效的私有工作区快照。' }, 400); return; }
      json(executor.prepare(snapshot));
    } catch (error) {
      // Neither raw Git stderr, server paths nor content-validation values cross IPC.
      json({ error: error instanceof WorkbenchError && error.message.includes('基线缺少 topology.json')
        ? '远端内容基线缺少 topology.json，尚未完成内容格式迁移；未提交或推送。'
        : '远端基线核对失败：请检查内容格式、导入版本及受限连接。未提交或推送。' }, 409);
    }
  });
  server.requestTimeout = 20_000; server.headersTimeout = 10_000; server.timeout = 180_000; server.maxHeadersCount = 20;
  return server;
}
