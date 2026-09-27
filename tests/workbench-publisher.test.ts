import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPublisherServer } from '../workbench/publisher-http';
import { PublisherReview } from '../workbench/publisher-client';
import { PublicationExecutor } from '../workbench/publication-executor';
import { WorkspaceStore } from '../workbench/store';
import { MAX_PLAN_BYTES } from '../workbench/publication-plan';
async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'publisher-ipc-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.resolve(import.meta.dirname, '../../xan9x-blog-content'); const content = path.join(root, 'content');
  cpSync(source, content, { recursive: true, filter: file => !path.relative(source, file).split(path.sep).some(part => part.startsWith('.')) });
  const git = (...args: string[]) => execFileSync('git', ['-C', content, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const store = new WorkspaceStore(content, path.join(root, 'private'));
  const executor = new PublicationExecutor({ directory: path.join(root, 'worker'), remote: content, publishEnabled: false });
  const socket = path.join(root, 'review.sock'); const server = createPublisherServer(executor);
  server.listen(socket); await once(server, 'listening'); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const client = new PublisherReview(socket);
  const call = (method: string, url: string, value?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = value === undefined ? undefined : JSON.stringify(value);
    const req = request({ socketPath: socket, path: url, method, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(payload);
  });
  return { root, content, executor, store, server, client, call, git };
}
test('Unix IPC prepares summaries and never exposes push or frozen Markdown', async t => {
  const f = await fixture(t); const head = f.git('rev-parse', 'HEAD');
  const plan = await f.client.create(f.store, f.store.get().revision);
  assert.equal(plan.noChanges, true); assert.equal(plan.canPublish, false); assert.equal('snapshot' in plan, false);
  assert.equal((await f.call('GET', '/status')).body.canPublish, false);
  for (const route of ['/confirm', '/push', '/publish']) assert.equal((await f.call('POST', route, {})).status, 404);
  assert.equal(f.git('rev-parse', 'HEAD'), head); assert.equal(f.git('status', '--porcelain'), '');
});
test('IPC validates snapshot, content type and size before contacting Git', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('POST', '/prepare', {})).status, 400);
  assert.equal((await f.call('POST', '/prepare', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.call('POST', '/prepare', {}, { 'content-length': String(MAX_PLAN_BYTES + 1) })).status, 413);
  await assert.rejects(f.client.create(f.store, '0'.repeat(64)), /发生变化/);
});
test('client rejects concurrent reviews and discards result after saved edits', async t => {
  const f = await fixture(t); const revision = f.store.get().revision;
  const pending = f.client.create(f.store, revision);
  await assert.rejects(f.client.create(f.store, revision), /已有核对/);
  f.store.save(revision, { type: 'addDirectory', parentId: 'root', id: 'new-topic', label: 'Later', kind: 'topic' });
  await assert.rejects(pending, /核对期间内容发生变化/);
});
test('unavailable service and invalid remote baselines do not leak private paths', async t => {
  const f = await fixture(t); const client = new PublisherReview(path.join(f.root, 'absent.sock'));
  await assert.rejects(client.create(f.store, f.store.get().revision), /暂不可用/);
  f.git('rm', 'topology.json'); f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'old format');
  await assert.rejects(f.client.create(f.store, f.store.get().revision), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /尚未完成内容格式迁移/); assert.ok(!error.message.includes(f.root)); return true;
  });
});
