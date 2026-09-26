import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { Auth, Sessions } from './auth';
import { WorkspaceStore } from './store';
import { parseArticle, preview, WorkbenchError } from './model';
import { renderMarkdown } from './markdown';

export function originConfig(value: string) {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('WORKBENCH_ORIGIN 必须是无路径的完整来源地址。');
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('远程工作台必须使用 HTTPS。');
  return url;
}
export function authModeConfig(value: string | undefined, origin: URL): 'password' | 'ssh' {
  const mode = value ?? 'password';
  if (mode !== 'password' && mode !== 'ssh') throw new Error('WORKBENCH_AUTH_MODE 必须是 password 或 ssh。');
  if (mode === 'ssh' && (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1')) throw new Error('SSH 免密模式仅支持 http://127.0.0.1 的本地转发来源；不能用于公开域名或反向代理。');
  return mode;
}
async function body(request: IncomingMessage, max = 1_000_000): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new WorkbenchError('仅接受 application/json。', 415);
  if (Number(request.headers['content-length'] ?? 0) > max) throw new WorkbenchError('请求过大。', 413);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length; if (size > max) throw new WorkbenchError('请求过大。', 413); chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new WorkbenchError('请求必须是 JSON 对象。'); }
}
export function createWorkbenchServer(options: { store: WorkspaceStore; origin: string; passwordHash?: string; authMode?: string; assets: string }) {
  const origin = originConfig(options.origin);
  const mode = authModeConfig(options.authMode, origin);
  const passwordAuth = mode === 'password' ? new Auth(options.passwordHash ?? '') : undefined;
  const auth = passwordAuth ?? new Sessions();
  const cookie = (id: string, maxAge: number) => `workbench_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.protocol === 'https:' ? '; Secure' : ''}`;
  const view = () => { const current = options.store.get(); return { ...current, articles: current.workspace.articles.map(parseArticle) }; };
  const assets = new Map<string, { type: string; file: string }>([
    ['/', { type: 'text/html; charset=utf-8', file: 'index.html' }],
    ['/app.js', { type: 'text/javascript; charset=utf-8', file: 'app.js' }],
    ['/app.css', { type: 'text/css; charset=utf-8', file: 'app.css' }],
  ]);
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (data: unknown, status = 200) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(data)); };
    try {
      if (request.headers.host !== origin.host) throw new WorkbenchError('来源主机不匹配。', 403);
      if (mode === 'ssh' && (request.socket.localAddress !== '127.0.0.1' || request.socket.remoteAddress !== '127.0.0.1')) throw new WorkbenchError('SSH 免密模式只接受回环连接。', 403);
      const route = new URL(request.url ?? '/', origin).pathname;
      const method = request.method;
      if (method !== 'GET' && method !== 'POST') throw new WorkbenchError('不支持此方法。', 405);
      if (method === 'POST' && (request.headers.origin !== origin.origin || request.headers['sec-fetch-site'] === 'cross-site')) throw new WorkbenchError('拒绝跨站请求。', 403);
      if (mode === 'ssh' && route.startsWith('/api/') && ((request.headers.origin !== undefined && request.headers.origin !== origin.origin) || (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))))) throw new WorkbenchError('拒绝其他来源访问工作台接口。', 403);
      if (method === 'GET' && assets.has(route)) {
        const asset = assets.get(route)!;
        response.setHeader('Content-Type', asset.type); response.end(readFileSync(path.join(options.assets, asset.file))); return;
      }
      if (method === 'POST' && route === '/api/login') {
        if (!passwordAuth) throw new WorkbenchError('当前使用 SSH 免密模式，不提供密码登录。', 404);
        const value = await body(request, 4096); const session = await passwordAuth.login(value.password);
        response.setHeader('Set-Cookie', cookie(session.id, 8 * 60 * 60)); json({ csrf: session.csrf, authMode: mode }); return;
      }
      if (method === 'GET' && route === '/api/session' && mode === 'ssh') {
        let session;
        try { session = auth.session(request.headers.cookie); }
        catch (error) {
          if (!(error instanceof WorkbenchError && error.status === 401)) throw error;
          session = auth.createSession(); response.setHeader('Set-Cookie', cookie(session.id, 8 * 60 * 60));
        }
        json({ csrf: session.csrf, authMode: mode }); return;
      }
      const session = auth.session(request.headers.cookie);
      if (method === 'POST' && request.headers['x-csrf-token'] !== session.csrf) throw new WorkbenchError('请求校验失败，请重新登录。', 403);
      if (method === 'GET' && route === '/api/session') { json({ csrf: session.csrf, authMode: mode }); return; }
      if (method === 'POST' && route === '/api/logout') {
        auth.logout(session.id); response.setHeader('Set-Cookie', cookie('', 0)); json({ ok: true }); return;
      }
      if (method === 'GET' && route === '/api/workspace') { json(view()); return; }
      if (method === 'POST' && route === '/api/command') {
        const value = await body(request);
        if (typeof value.revision !== 'string') throw new WorkbenchError('缺少工作区版本。');
        options.store.save(value.revision, value.command); json(view()); return;
      }
      if (method === 'POST' && route === '/api/preview') {
        const value = await body(request); const current = options.store.get();
        if (value.revision !== current.revision) throw new WorkbenchError('预览版本已过期，请重新加载。', 409);
        if (value.mode !== 'editing' && value.mode !== 'public') throw new WorkbenchError('无效预览模式。');
        json({ document: preview(current.workspace, value.mode), revision: current.revision }); return;
      }
      if (method === 'POST' && route === '/api/markdown') {
        const value = await body(request);
        if (typeof value.body !== 'string' || value.body.length > 480_000) throw new WorkbenchError('正文过长或无效。');
        json({ html: renderMarkdown(value.body) }); return;
      }
      if (method === 'GET' && route === '/api/export') {
        const current = options.store.get();
        response.setHeader('Content-Disposition', 'attachment; filename="workbench-private-snapshot.json"');
        json(current); return;
      }
      throw new WorkbenchError('接口不存在。', 404);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof WorkbenchError) json({ error: error.message }, error.status);
      else if (error instanceof ZodError) json({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 3000) }, 400);
      // Content validator errors are safe to report, but avoid leaking local filesystem paths.
      else if (error instanceof Error && !('code' in error)) json({ error: error.message.slice(0, 3000) }, 400);
      else json({ error: '工作区读写失败，未发布任何内容。请检查服务端文件权限及日志。' }, 500);
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.timeout = 20_000; server.maxHeadersCount = 40;
  return server;
}
