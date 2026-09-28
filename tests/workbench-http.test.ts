import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../workbench/store';
import { Auth, Sessions, passwordHash } from '../workbench/auth';
import { createWorkbenchServer, originConfig, authModeConfig } from '../workbench/http';
import { renderMarkdown } from '../workbench/markdown';
import { createPublicationPlan, publicationPlanSummary } from '../workbench/publication-plan';
const password = 'test-only-workbench-password';
const hash = passwordHash(password);
async function fixture(t: { after(fn: () => unknown): void }, origin = 'https://editor.example', authMode: 'password' | 'ssh' = 'password', bind = '127.0.0.1', publicationReview?: Parameters<typeof createWorkbenchServer>[0]['publicationReview']) {
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-http-'));
  const content = path.join(root, 'content'); cpSync(path.resolve(import.meta.dirname, '../../xan9x-blog-content'), content, { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Login only</title>');
  const store = new WorkspaceStore(content, path.join(root, 'private'));
  const server = createWorkbenchServer({ store, origin, authMode, publicationReview, passwordHash: authMode === 'password' ? await hash : undefined, assets: root });
  await new Promise<void>(resolve => server.listen(0, bind, resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://${bind}:${address.port}`;
  let cookie = ''; let csrf = '';
  const request = (route: string, value?: unknown, headers: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
    const payload = value === undefined ? undefined : JSON.stringify(value);
    const req = httpRequest(base + route, { method: payload === undefined ? 'GET' : 'POST', headers: {
      Host: new URL(origin).host, Cookie: cookie, ...(payload === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)), 'X-CSRF-Token': csrf }), ...headers,
    } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { const result = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) result.set(key, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: result })); });
    }); req.on('error', reject); req.end(payload);
  });
  const login = async () => { const response = authMode === 'ssh' ? await request('/api/session') : await request('/api/login', { password }); assert.equal(response.status, 200);
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
  for (const route of ['/api/workspace', '/api/export', '/api/publication', '/api/publication/plan', '/api/publication/job', '/api/publication/confirm', '/api/publication/reconcile', '/.workbench/workspace.json']) assert.equal((await f.request(route)).status, 401);
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

test('loopback browser origin supports a distinct forwarded port without bypassing authentication or CSRF', async t => {
  // The TCP destination is the random backend port; HTTP Host/Origin stay at the browser-facing port.
  // This models the application side of local forwarding, not an actual SSH server.
  const f = await fixture(t, 'http://127.0.0.1:14325');
  assert.equal((await f.request('/api/workspace')).status, 401);
  const login = await f.login();
  assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(login.headers.get('set-cookie')!, /; Secure/);
  const state = await (await f.request('/api/workspace')).json();
  const command = { type: 'addDirectory', id: 'tunnel-test', parentId: 'root', label: 'Tunnel test', kind: 'topic' };
  assert.equal((await f.request('/api/command', { revision: state.revision, command }, { Origin: 'http://127.0.0.1:4325' })).status, 403);
  assert.equal((await f.request('/api/command', { revision: state.revision, command }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.request('/api/workspace', undefined, { Host: 'localhost:14325' })).status, 403);
  assert.equal((await f.request('/api/command', { revision: state.revision, command })).status, 200);
  assert.equal((await f.request('/api/logout', {})).status, 200);
  assert.equal((await f.request('/api/workspace')).status, 401);
});

test('SSH mode must be explicitly selected and refuses public or ambiguous origins', () => {
  assert.equal(authModeConfig(undefined, originConfig('https://editor.example')), 'password');
  assert.equal(authModeConfig('ssh', originConfig('http://127.0.0.1:14325')), 'ssh');
  for (const origin of ['https://editor.example', 'https://127.0.0.1:4325', 'http://localhost:4325', 'http://[::1]:4325']) {
    assert.throws(() => authModeConfig('ssh', originConfig(origin)), /SSH/);
  }
  for (const value of ['none', '', 'SSH', 'false']) assert.throws(() => authModeConfig(value, originConfig('http://127.0.0.1:4325')), /AUTH_MODE/);
  assert.throws(() => createWorkbenchServer({ store: {} as WorkspaceStore, origin: 'http://127.0.0.1:4325', assets: '/tmp' }), /PASSWORD_HASH/);
});
test('SSH auto-session keeps cookies, CSRF, origin checks, revisions and logout protections', async t => {
  const f = await fixture(t, 'http://127.0.0.1:14325', 'ssh');
  assert.equal((await f.request('/api/workspace')).status, 401);
  assert.equal((await f.request('/api/export')).status, 401);
  assert.equal((await f.request('/api/login', { password })).status, 404);
  for (const headers of [{ Origin: 'https://evil.example' }, { Host: 'evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }] as Record<string, string>[]) {
    assert.equal((await f.request('/api/session', undefined, headers)).status, 403);
  }
  const response = await f.login(); assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(response.headers.get('set-cookie')!, /; Secure/);
  const sessionResponse = await f.request('/api/session'); const session = await sessionResponse.json();
  assert.equal(session.authMode, 'ssh'); assert.match(session.csrf, /^[a-f0-9]{64}$/);
  assert.equal(sessionResponse.headers.get('set-cookie'), null, 'valid sessions must not be replaced on every request');
  const before = await (await f.request('/api/workspace')).json();
  const command = { type: 'addDirectory', id: 'ssh-mode-test', parentId: 'root', kind: 'topic', label: 'SSH test' };
  for (const headers of [{ 'X-CSRF-Token': '' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) {
    assert.equal((await f.request('/api/command', { revision: before.revision, command }, headers)).status, 403);
  }
  assert.equal(f.store.get().revision, before.revision);
  assert.equal((await f.request('/api/command', { revision: before.revision, command })).status, 200);
  assert.equal((await f.request('/api/command', { revision: before.revision, command })).status, 409);
  assert.equal((await f.request('/api/publish', {})).status, 404);
  assert.equal((await f.request('/api/logout', {})).status, 200);
  assert.equal((await f.request('/api/workspace')).status, 401);
  await f.login(); const renewed = await (await f.request('/api/session')).json();
  assert.notEqual(renewed.csrf, session.csrf);
});
test('SSH mode rejects connections arriving on another local address even with an allowed Host', async t => {
  const f = await fixture(t, 'http://127.0.0.1:4325', 'ssh', '127.0.0.2');
  assert.equal((await f.request('/api/session')).status, 403);
  assert.equal((await f.request('/')).status, 403);
});
test('automatic sessions retain expiry, revocation and a bounded session count', () => {
  let now = 0; const sessions = new Sessions(() => now);
  const first = sessions.createSession();
  for (let i = 0; i < 16; i++) sessions.createSession();
  assert.throws(() => sessions.session('workbench_session=' + first.id));
  const last = sessions.createSession(); now = 61 * 60_000;
  assert.throws(() => sessions.session('workbench_session=' + last.id));
  const active = sessions.createSession(); sessions.logout(active.id);
  assert.throws(() => sessions.session('workbench_session=' + active.id));
});

test('publication review stays authenticated, CSRF-protected, server-configured and read-only', async t => {
  const disabled = await fixture(t); await disabled.login();
  assert.deepEqual(await (await disabled.request('/api/publication')).json(), { configured: false, canPublish: false, remoteChecked: false });
  assert.equal((await disabled.request('/api/publication/plan', { revision: disabled.store.get().revision })).status, 503);
  let calls = 0;
  const f = await fixture(t, 'https://editor.example', 'password', '127.0.0.1', {
    status: { configured: true, canPublish: false, baseCommit: 'a'.repeat(40), visibilityDeclaration: 'private', remoteChecked: false },
    async create(store) {
      calls++; const snapshot = store.get();
      return publicationPlanSummary(createPublicationPlan(snapshot, { commit: 'a'.repeat(40), headCommit: 'a'.repeat(40), preservedFileCount: 0,
        files: { 'topology.json': JSON.stringify(snapshot.workspace.topology), ...Object.fromEntries(snapshot.workspace.articles.map(article => [article.path, article.raw])) } }, { visibility: 'private' }));
    },
  });
  await f.login(); const before = f.store.get();
  assert.equal((await f.request('/api/publication/plan', { revision: before.revision }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.request('/api/publication/plan', { revision: before.revision, repository: '/tmp/evil' })).status, 400);
  assert.equal(calls, 0);
  const response = await f.request('/api/publication/plan', { revision: before.revision }); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.canPublish, false); assert.equal(result.snapshot, undefined); assert.equal(result.noChanges, true);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(f.store.get().revision, before.revision);
  assert.equal((await f.request('/api/publish', {})).status, 404);
});

test('publication confirmation and recovery require authentication, CSRF, exact frozen identity and explicit acknowledgement', async t => {
  let confirms = 0; let reconciles = 0;
  const provider: NonNullable<Parameters<typeof createWorkbenchServer>[0]['publicationReview']> = {
    status: { configured: true, canPublish: false, remoteChecked: false },
    async create() { throw new Error('unused'); },
    async confirm() { confirms++; throw new Error('test-only confirmed'); },
    async reconcile() { reconciles++; return null; }, progress() { return null; },
  };
  const f = await fixture(t, 'https://editor.example', 'password', '127.0.0.1', provider);
  const value = { id: '11111111-1111-4111-8111-111111111111', planId: 'a'.repeat(64), revision: 'b'.repeat(64), baseCommit: 'c'.repeat(40), acknowledgePrivateSnapshot: true };
  assert.equal((await f.request('/api/publication/confirm', value)).status, 401); await f.login();
  assert.equal((await f.request('/api/publication/confirm', value, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.request('/api/publication/confirm', value, { Origin: 'https://attacker.invalid' })).status, 403);
  for (const invalid of [{ ...value, acknowledgePrivateSnapshot: false }, { ...value, remote: 'other' }, { ...value, revision: 'main' }]) assert.equal((await f.request('/api/publication/confirm', invalid)).status, 400);
  assert.equal(confirms, 0); await f.request('/api/publication/confirm', value); assert.equal(confirms, 1);
  assert.equal((await f.request('/api/publication/reconcile', {}, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.request('/api/publication/reconcile', { id: value.id })).status, 400);
  assert.equal((await f.request('/api/publication/reconcile', {})).status, 200); assert.equal(reconciles, 1);
  assert.deepEqual(await (await f.request('/api/publication/job')).json(), { progress: null });
});
