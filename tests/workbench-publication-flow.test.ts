import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PublicationExecutor } from '../workbench/publication-executor';
import { createPublisherServer } from '../workbench/publisher-http';
import { PublisherReview } from '../workbench/publisher-client';
import { PublicationJournal, confirmationSchema } from '../workbench/publication-state';
import { WorkspaceStore } from '../workbench/store';
import type { PublicationReviewSummary } from '../workbench/publication-review';
async function fixture(t: { after(fn: () => unknown): void }, enabled = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'publication-flow-'));
  const source = path.resolve(import.meta.dirname, '../../xan9x-blog-content'); const content = path.join(root, 'content');
  cpSync(source, content, { recursive: true, filter: file => !path.relative(source, file).split(path.sep).some(part => part.startsWith('.')) });
  const git = (where: string, ...args: string[]) => execFileSync('git', ['-C', where, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git(content, 'init', '--initial-branch=main'); git(content, 'add', '.'); git(content, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline');
  const remote = path.join(root, 'remote.git'); git(root, 'clone', '--bare', content, remote);
  const store = new WorkspaceStore(content, path.join(root, 'private')); const directory = path.join(root, 'worker');
  const executor = new PublicationExecutor({ directory, remote, publishEnabled: enabled });
  let confirmations = 0; let beforeConfirm = () => {}; let loseResponse = false;
  const service = { publishEnabled: executor.publishEnabled, prepare: executor.prepare.bind(executor), get: executor.get.bind(executor), reconcile: executor.reconcile.bind(executor),
    confirm(id: string, revision: string) { confirmations++; beforeConfirm(); const result = executor.confirm(id, revision); if (loseResponse) throw new Error('Simulated lost response'); return result; } };
  const socket = path.join(root, 'review.sock'); const server = createPublisherServer(service, { allowConfirmation: enabled });
  server.listen(socket); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  const client = new PublisherReview(socket, { allowConfirmation: enabled });
  const change = () => store.save(store.get().revision, { type: 'addDirectory', parentId: 'root', id: 'new-topic', label: 'Frozen R', kind: 'topic' });
  const head = () => git(remote, 'rev-parse', 'main');
  return { root, content, directory, remote, socket, store, executor, client, change, head, git,
    count: () => confirmations, before(fn: () => void) { beforeConfirm = fn; }, lose() { loseResponse = true; } };
}
function confirmation(plan: PublicationReviewSummary) { return { id: plan.execution!.id, planId: plan.planId, revision: plan.revision, baseCommit: plan.baseCommit, acknowledgePrivateSnapshot: true as const }; }
test('full IPC flow advances only baseline, retains R2, and prepares the next delta', async t => {
  const f = await fixture(t); f.change(); const plan = await f.client.create(f.store, f.store.get().revision);
  let r2: unknown;
  f.before(() => { f.store.save(f.store.get().revision, { type: 'editDirectory', id: 'new-topic', label: 'Later R2', description: '' }); r2 = f.store.get().workspace; });
  const progress = await f.client.confirm(f.store, confirmation(plan));
  assert.equal(progress.job.phase, 'pushed'); assert.equal(progress.job.deployed, false); assert.equal(progress.baseline, 'advanced');
  assert.equal(f.store.get().baseRevision, plan.candidateDigest); assert.deepEqual(f.store.get().workspace, r2);
  assert.doesNotMatch(f.git(f.remote, 'show', 'main:topology.json'), /Later R2/);
  const next = await f.client.create(f.store, f.store.get().revision); assert.equal(next.noChanges, false); assert.equal(next.directories.modified[0]!.after.label, 'Later R2');
  const repeated = await f.client.confirm(f.store, confirmation(plan)); assert.equal(repeated.job.commit, progress.job.commit); assert.equal(f.count(), 1);
});
test('lost success response and restarted web client recover by observation, never replay confirmation', async t => {
  const f = await fixture(t); f.change(); const plan = await f.client.create(f.store, f.store.get().revision); f.lose();
  await assert.rejects(f.client.confirm(f.store, confirmation(plan)), /执行结果待查询/); const pushed = f.head();
  const restarted = new PublisherReview(f.socket, { allowConfirmation: true });
  assert.equal(restarted.progress(f.store)!.baseline, 'pending');
  const progress = await restarted.reconcile(f.store); assert.equal(progress!.job.commit, pushed); assert.equal(progress!.baseline, 'advanced');
  await restarted.confirm(f.store, confirmation(plan)); assert.equal(f.count(), 1); assert.equal(f.head(), pushed);
});
test('newer save before confirmation, mismatched plan and unacknowledged drafts cannot push', async t => {
  const f = await fixture(t); f.change(); const plan = await f.client.create(f.store, f.store.get().revision); const before = f.head();
  assert.throws(() => confirmationSchema.parse({ ...confirmation(plan), acknowledgePrivateSnapshot: false }));
  await assert.rejects(f.client.confirm(f.store, { ...confirmation(plan), planId: '0'.repeat(64) }), /不一致/);
  f.store.save(f.store.get().revision, { type: 'editDirectory', id: 'new-topic', label: 'R2 before accept', description: '' });
  await assert.rejects(f.client.confirm(f.store, confirmation(plan)), /已变化/);
  assert.equal(f.count(), 0); assert.equal(f.head(), before); assert.equal(f.client.progress(f.store), null);
});
test('remote conflict is terminal, creates no new commit, and never advances the private baseline', async t => {
  const f = await fixture(t); f.change(); const beforeBase = f.store.get().baseRevision; const plan = await f.client.create(f.store, f.store.get().revision);
  f.git(f.content, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'other publisher'); f.git(f.content, 'push', f.remote, 'main'); const head = f.head();
  const progress = await f.client.confirm(f.store, confirmation(plan)); assert.equal(progress.job.phase, 'conflict'); assert.equal(f.head(), head); assert.equal(f.store.get().baseRevision, beforeBase);
});
test('successful Git result is not relabeled failure when local baseline advancement conflicts', async t => {
  const f = await fixture(t); f.change(); const plan = await f.client.create(f.store, f.store.get().revision);
  f.before(() => f.store.advancePublicationBase(plan.baseRevision, 'f'.repeat(64)));
  const progress = await f.client.confirm(f.store, confirmation(plan));
  assert.equal(progress.job.phase, 'pushed'); assert.equal(progress.baseline, 'conflict'); assert.equal(f.store.get().baseRevision, 'f'.repeat(64));
  await assert.rejects(f.client.create(f.store, f.store.get().revision), /待核对/);
  assert.equal((await f.client.reconcile(f.store))!.baseline, 'conflict'); assert.equal(f.count(), 1);
});
test('rejected push remains unknown, blocks new jobs, and observation never retries it', async t => {
  const f = await fixture(t); f.change(); const plan = await f.client.create(f.store, f.store.get().revision); const head = f.head();
  const hook = path.join(f.remote, 'hooks/pre-receive'); writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
  const progress = await f.client.confirm(f.store, confirmation(plan)); assert.equal(progress.job.phase, 'unknown'); assert.equal(progress.baseline, 'pending');
  rmSync(hook); await f.client.reconcile(f.store); await f.client.confirm(f.store, confirmation(plan));
  await assert.rejects(f.client.create(f.store, f.store.get().revision), /待核对/);
  assert.equal(f.head(), head); assert.equal(f.count(), 1);
});
test('receipt written before interrupted IPC blocks new confirmation and can only be observed', async t => {
  const f = await fixture(t); f.change(); const plan = await f.client.create(f.store, f.store.get().revision); const head = f.head();
  new PublicationJournal(f.store.directory).write({ version: 1, job: plan.execution!, baseline: 'pending' });
  const progress = await f.client.confirm(f.store, confirmation(plan)); assert.equal(progress.job.phase, 'prepared'); assert.equal(f.count(), 0);
  await assert.rejects(f.client.create(f.store, f.store.get().revision), /待核对/); assert.equal(f.head(), head);
});
test('no-op confirmation and repeat queries leave workspace bytes and Git unchanged', async t => {
  const f = await fixture(t); const before = readFileSync(path.join(f.store.directory, 'workspace.json')); const head = f.head(); const plan = await f.client.create(f.store, f.store.get().revision);
  const progress = await f.client.confirm(f.store, confirmation(plan)); assert.equal(progress.job.phase, 'no-changes'); assert.equal(progress.baseline, 'advanced');
  await f.client.reconcile(f.store); assert.deepEqual(readFileSync(path.join(f.store.directory, 'workspace.json')), before); assert.equal(f.head(), head);
});
test('stale old receipts cannot roll a newer publication baseline backwards', async t => {
  const f = await fixture(t); f.change(); const first = await f.client.create(f.store, f.store.get().revision); await f.client.confirm(f.store, confirmation(first));
  f.store.save(f.store.get().revision, { type: 'editDirectory', id: 'new-topic', label: 'Second publish', description: '' });
  const second = await f.client.create(f.store, f.store.get().revision); await f.client.confirm(f.store, confirmation(second)); const base = f.store.get().baseRevision;
  await assert.rejects(f.client.confirm(f.store, confirmation(first)), /不一致/); assert.equal(f.store.get().baseRevision, base); assert.equal(f.count(), 2);
});
test('disabled production defaults cannot be bypassed by a client confirmation', async t => {
  const f = await fixture(t, false); const plan = await f.client.create(f.store, f.store.get().revision);
  assert.equal((await f.client.availability()).canPublish, false); assert.equal(plan.execution!.publishEnabled, false);
  await assert.rejects(f.client.confirm(f.store, confirmation(plan)), /尚未开放/); assert.equal(f.count(), 0);
  const rogue = new PublisherReview(f.socket, { allowConfirmation: true }); await assert.rejects(rogue.confirm(f.store, confirmation(plan)), /未开放/); assert.equal(f.count(), 0);
});
test('expired plans, corrupt journals and persistent locks fail closed', async t => {
  const f = await fixture(t); const plan = await f.client.create(f.store, f.store.get().revision); const input = confirmation(plan);
  const file = path.join(f.directory, 'jobs', input.id + '.json'); const job = JSON.parse(readFileSync(file, 'utf8')); job.plan.expiresAt = new Date(0).toISOString(); writeFileSync(file, JSON.stringify(job));
  await assert.rejects(f.client.confirm(f.store, input), /过期/); assert.equal(f.count(), 0);
  writeFileSync(path.join(f.store.directory, 'publication.json'), '{}'); assert.throws(() => f.client.progress(f.store), /损坏/);
  rmSync(path.join(f.store.directory, 'publication.json')); writeFileSync(path.join(f.store.directory, 'publication.lock'), '');
  await assert.rejects(f.client.create(f.store, f.store.get().revision), /中断锁/);
});

test('baseline write before receipt completion is idempotent after restart and preserves newer edits', async t => {
  const f = await fixture(t); f.change(); const plan = await f.client.create(f.store, f.store.get().revision); f.lose();
  await assert.rejects(f.client.confirm(f.store, confirmation(plan)));
  f.store.advancePublicationBase(plan.baseRevision, plan.candidateDigest);
  f.store.save(f.store.get().revision, { type: 'editDirectory', id: 'new-topic', label: 'After baseline write', description: '' });
  const before = readFileSync(path.join(f.store.directory, 'workspace.json'));
  const restarted = new PublisherReview(f.socket, { allowConfirmation: true });
  assert.equal((await restarted.reconcile(f.store))!.baseline, 'advanced');
  assert.deepEqual(readFileSync(path.join(f.store.directory, 'workspace.json')), before); assert.equal(f.count(), 1);
});
test('mismatched worker job identity cannot advance a saved acceptance receipt', async t => {
  const f = await fixture(t); f.change(); const plan = await f.client.create(f.store, f.store.get().revision); f.lose();
  await assert.rejects(f.client.confirm(f.store, confirmation(plan)));
  const before = f.store.get().baseRevision;
  const file = path.join(f.directory, 'jobs', plan.execution!.id + '.json'); const job = JSON.parse(readFileSync(file, 'utf8')); job.plan.candidateDigest = 'f'.repeat(64); writeFileSync(file, JSON.stringify(job));
  await assert.rejects(f.client.reconcile(f.store), /不同作业/); assert.equal(f.store.get().baseRevision, before); assert.equal(f.count(), 1);
});
test('executor expiration is terminal and does not push even after a confirmed attempt', async t => {
  const f = await fixture(t); f.change(); const plan = await f.client.create(f.store, f.store.get().revision); const head = f.head();
  const now = Date.now;
  try {
    Date.now = () => Date.parse(plan.expiresAt) + 1;
    const result = f.executor.confirm(plan.execution!.id, plan.revision); assert.equal(result.phase, 'expired');
  } finally { Date.now = now; }
  assert.equal(f.head(), head);
});

test('deployment status remains read-only and unconfigured after a successful isolated publish', async t => {
  const f=await fixture(t);f.change();const plan=await f.client.create(f.store,f.store.get().revision);await f.client.confirm(f.store,confirmation(plan));
  const before=f.store.get(),receipt=f.client.progress(f.store),head=f.head(),count=f.count();
  const report=await f.client.deployment(f.store);assert.equal(report?.contentCommit,head);assert.equal(report?.state,'unconfigured');assert.equal(report?.productionVerified,false);
  assert.deepEqual(f.store.get(),before);assert.deepEqual(f.client.progress(f.store),receipt);assert.equal(f.head(),head);assert.equal(f.count(),count);
});
