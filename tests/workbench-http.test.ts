import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../workbench/store';
import { Auth, passwordHash } from '../workbench/auth';
import { createWorkbenchServer, originConfig } from '../workbench/http';
import { renderMarkdown } from '../workbench/markdown';
const password = 'test-only-workbench-password';
const hash = passwordHash(password);
async function fixture(t: { after(fn: () => unknown): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-http-'));
  const content = path.join(root, 'content'); cpSync(path.resolve(import.meta.dirname, '../../xan9x-blog-content'), content, { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Login only</title>');
  const store = new WorkspaceStore(content, path.join(root, 'private'));
  const server = createWorkbenchServer({ store, origin: 'https://editor.example', passwordHash: await hash, assets: root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = ''; let csrf = '';
  const request = (route: string, value?: unknown, headers: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
    const payload = value === undefined ? undefined : JSON.stringify(value);
    const req = httpRequest(base + route, { method: payload === undefined ? 'GET' : 'POST', headers: {
      Host: 'editor.example', Cookie: cookie, ...(payload === undefined ? {} : { Origin: 'https://editor.example', 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)), 'X-CSRF-Token': csrf }), ...headers,
    } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { const result = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) result.set(key, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: result })); });
    }); req.on('error', reject); req.end(payload);
  });
  const login = async () => { const response = await request('/api/login', { password }); assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie')!.split(';')[0]!; csrf = (await response.json()).csrf; return response; };
  return { request, login, store };
}
test('auth requires configured hash, throttles guesses, expires sessions and revokes logout', async () => {
  assert.throws(() => new Auth(''), /PASSWORD_HASH/); let now = 0; const auth = new Auth(await hash, () => now);
  const session = await auth.login(password); const cookie = 'workbench_session=' + session.id;
  assert.equal(auth.session(cookie).csrf, session.csrf);
  now = 61 * 60_000; assert.throws(() => auth.session(cookie), /登录/);
  const fresh = await auth.login(password); auth.logout(fresh.id); assert.throws(() => auth.session('workbench_session=' + fresh.id));
  for (let i = 0; i < 9; i++) await assert.rejects(auth.login(null), /密码错误/);
  await assert.rejects(auth.login(password), /尝试过多/);
});
test('origin configuration disallows insecure remote origins, paths and URL credentials', () => {
  for (const origin of ['http://editor.example', 'https://editor.example/path', 'https://user@editor.example', 'null']) assert.throws(() => originConfig(origin));
  assert.equal(originConfig('http://127.0.0.1:4325').hostname, '127.0.0.1');
  assert.equal(originConfig('https://editor.example').protocol, 'https:');
});
test('unauthenticated access reveals neither drafts nor exports, and login requires exact origin/host', async t => {
  const f = await fixture(t);
  for (const route of ['/api/workspace', '/api/export', '/.workbench/workspace.json']) assert.equal((await f.request(route)).status, 401);
  assert.equal((await f.request('/api/login', { password }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/login', { password }, { Host: 'evil.example' })).status, 403);
  assert.equal((await f.request('/api/login', { password }, { Origin: '' })).status, 403);
  const login = await f.login();
  assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict;.*Secure/);
  const workspace = await f.request('/api/workspace'); assert.equal(workspace.headers.get('cache-control'), 'no-store');
  assert.match(workspace.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal((await f.request('/api/logout', {}, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.request('/api/logout', {})).status, 200);
  assert.equal((await f.request('/api/workspace')).status, 401);
});
test('authenticated commands require CSRF, validate input and reject stale saves', async t => {
  const f = await fixture(t); await f.login(); const initial = await (await f.request('/api/workspace')).json();
  const command = { type: 'addDirectory', id: 'http-topic', parentId: 'root', label: 'HTTP test', kind: 'topic' };
  assert.equal((await f.request('/api/command', { revision: initial.revision, command }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.request('/api/command', { revision: initial.revision, command }, { 'Content-Type': 'text/plain' })).status, 415);
  const results = await Promise.all([f.request('/api/command', { revision: initial.revision, command }), f.request('/api/command', { revision: initial.revision, command })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const next = f.store.get();
  assert.equal((await f.request('/api/command', { revision: next.revision, command: { type: 'bindArticle', nodeId: 'broken', parentId: 'root', articleId: 'missing' } })).status, 400);
  assert.equal(f.store.get().revision, next.revision);
  assert.equal((await f.request('/api/preview', { revision: initial.revision, mode: 'public' })).status, 409);
  const preview = await (await f.request('/api/preview', { revision: next.revision, mode: 'public' })).json();
  assert.ok(!JSON.stringify(preview).includes('http-topic'));
  assert.equal((await f.request('/api/publish', {})).status, 404, 'there must be no accidental publishing endpoint');
  const exported = await f.request('/api/export'); assert.match(exported.headers.get('content-disposition')!, /attachment/);
  assert.equal((await exported.json()).revision, next.revision);
  assert.equal((await f.request('/api/markdown', { body: 'x'.repeat(1_000_001) })).status, 413);
});
test('Markdown preview cannot execute raw HTML, scripts or load tracking images', () => {
  const result = renderMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![tracker](https://evil.example/secret)\n\n# Heading\n\n**Bold**');
  assert.ok(!result.includes('<script>')); assert.ok(!result.includes('href="javascript:')); assert.ok(!result.includes('<img'));
  assert.match(result, /<h1>Heading<\/h1>/); assert.match(result, /<strong>Bold<\/strong>/);
});

test('parallel login attempts cannot multiply scrypt memory consumption', async () => {
  const auth = new Auth(await hash);
  const first = auth.login(password);
  await assert.rejects(auth.login(password), /正在验证/);
  const session = await first;
  assert.ok(auth.session('workbench_session=' + session.id));
});
