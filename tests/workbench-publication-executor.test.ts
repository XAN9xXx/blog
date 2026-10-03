import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PublicationExecutor } from '../workbench/publication-executor';
import { WorkspaceStore } from '../workbench/store';
import { parseArticle } from '../workbench/model';
import { createPublicationPlan } from '../workbench/publication-plan';
import { readPublicationBaseline } from '../workbench/publication-git';
import { processImage } from '../workbench/images';
import { imageUrl } from '../src/lib/images';
function fixture(t: { after(fn: () => void): void }, enabled = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'publication-executor-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.resolve(import.meta.dirname, 'fixtures/content'); const content = path.join(root, 'content');
  cpSync(source, content, { recursive: true, filter: file => !path.relative(source, file).split(path.sep).some(part => part.startsWith('.')) });
  const git = (where: string, ...args: string[]) => execFileSync('git', ['-C', where, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  writeFileSync(path.join(content, 'preserved.txt'), 'Unmanaged asset\n');
  git(content, 'init', '--initial-branch=main'); git(content, 'add', '.'); git(content, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const remote = path.join(root, 'remote.git'); git(root, 'clone', '--bare', content, remote);
  const store = new WorkspaceStore(content, path.join(root, 'private')); const directory = path.join(root, 'worker');
  const executor = new PublicationExecutor({ directory, remote, publishEnabled: enabled });
  const head = () => git(remote, 'rev-parse', 'main');
  const change = () => store.save(store.get().revision, { type: 'addDirectory', parentId: 'root', id: 'new-topic', label: 'New', kind: 'topic' });
  return { root, content, remote, directory, executor, store, git, head, change };
}
test('disabled execution creates a private review but never commits or pushes', async t => {
  const f = fixture(t, false); f.change(); const before = f.head(); const plan = f.executor.prepare(f.store.get());
  assert.equal('snapshot' in plan, false); assert.equal(plan.execution.publishEnabled, false);
  await assert.rejects(f.executor.confirm(plan.execution.id, plan.revision), /尚未获准/);
  assert.equal(f.head(), before); assert.equal(f.executor.get(plan.execution.id).phase, 'prepared');
});
test('temporary bare remote: one fast-forward commit, preserved assets, immutable plan and idempotent confirmation', async t => {
  const f = fixture(t); const before = f.head(); f.change(); const plan = f.executor.prepare(f.store.get());
  f.store.save(f.store.get().revision, { type: 'editDirectory', id: 'new-topic', label: 'Later unsent edit', description: '' });
  const later = readFileSync(path.join(f.store.directory, 'workspace.json'));
  const result = await f.executor.confirm(plan.execution.id, plan.revision);
  assert.equal(result.phase, 'pushed'); assert.equal(result.deployed, false); assert.equal(f.head(), result.commit);
  assert.equal(f.git(f.remote, 'rev-parse', 'main^'), before);
  assert.equal(f.git(f.remote, 'show', 'main:preserved.txt'), 'Unmanaged asset');
  assert.doesNotMatch(f.git(f.remote, 'show', 'main:topology.json'), /Later unsent edit/);
  assert.deepEqual(readFileSync(path.join(f.store.directory, 'workspace.json')), later);
  assert.deepEqual(await f.executor.confirm(plan.execution.id, plan.revision), result); assert.equal(f.head(), result.commit);
});
test('no-op does not create a commit and invalid IDs/revisions are rejected', async t => {
  const f = fixture(t); const before = f.head(); const plan = f.executor.prepare(f.store.get());
  assert.throws(() => f.executor.get('../escape'));
  await assert.rejects(f.executor.confirm(plan.execution.id, '0'.repeat(64)), /不一致/);
  assert.equal((await f.executor.confirm(plan.execution.id, plan.revision)).phase, 'no-changes'); assert.equal(f.head(), before);
});
test('remote advances after review: fail closed without overwriting its history', async t => {
  const f = fixture(t); f.change(); const plan = f.executor.prepare(f.store.get());
  f.git(f.content, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'other publisher');
  f.git(f.content, 'push', f.remote, 'main'); const before = f.head();
  assert.equal((await f.executor.confirm(plan.execution.id, plan.revision)).phase, 'conflict'); assert.equal(f.head(), before);
});
test('rejected push is unknown and must not be replayed automatically', async t => {
  const f = fixture(t); f.change(); const plan = f.executor.prepare(f.store.get()); const before = f.head();
  const hook = path.join(f.remote, 'hooks/pre-receive'); writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
  assert.equal((await f.executor.confirm(plan.execution.id, plan.revision)).phase, 'unknown'); assert.equal(f.head(), before);
  rmSync(hook); assert.equal((await f.executor.confirm(plan.execution.id, plan.revision)).phase, 'unknown'); assert.equal(f.head(), before);
});
test('interrupted committed state is observed only, and persistent locks require manual recovery', async t => {
  const f = fixture(t); f.change(); const plan = f.executor.prepare(f.store.get()); const before = f.head();
  const file = path.join(f.directory, 'jobs', plan.execution.id + '.json'); const job = JSON.parse(readFileSync(file, 'utf8'));
  job.phase = 'committing'; writeFileSync(file, JSON.stringify(job));
  assert.equal((await f.executor.confirm(plan.execution.id, plan.revision)).phase, 'unknown'); assert.equal(f.head(), before);
  writeFileSync(path.join(f.directory, 'execution.lock'), ''); assert.throws(() => f.executor.prepare(f.store.get()), /中断锁/);
});
test('expired and tampered plans cannot create commits', async t => {
  for (const expired of [true, false]) {
    const f = fixture(t); f.change(); const plan = f.executor.prepare(f.store.get()); const before = f.head();
    const file = path.join(f.directory, 'jobs', plan.execution.id + '.json'); const job = JSON.parse(readFileSync(file, 'utf8'));
    if (expired) job.plan.createdAt = new Date(0).toISOString(); else job.plan.candidateDigest = '0'.repeat(64);
    writeFileSync(file, JSON.stringify(job)); await assert.rejects(f.executor.confirm(plan.execution.id, plan.revision)); assert.equal(f.head(), before);
  }
});
test('private drafts are preserved and sorted candidate digest matches a subsequent Git import', async t => {
  const f = fixture(t); const article = parseArticle(f.store.get().workspace.articles[0]!);
  f.store.save(f.store.get().revision, { type: 'saveArticle', create: true, path: 'articles/aaa-new.md', data: { ...article.data, id: 'draft-test', title: 'Private draft', draft: true }, body: 'NEVER PUBLIC' });
  const plan = f.executor.prepare(f.store.get()); assert.equal(plan.disclosure.drafts.length, 1);
  const result = await f.executor.confirm(plan.execution.id, plan.revision); assert.equal(result.phase, 'pushed');
  assert.match(f.git(f.remote, 'show', 'main:articles/aaa-new.md'), /NEVER PUBLIC/);
  const imported = path.join(f.root, 'imported'); f.git(f.root, 'clone', f.remote, imported);
  const store = new WorkspaceStore(imported, path.join(f.root, 'next-private'));
  assert.equal(store.get().baseRevision, plan.candidateDigest);
  assert.equal(createPublicationPlan(store.get(), readPublicationBaseline(imported, f.head()), { visibility: 'private' }).noChanges, true);
});

// Images: a fake bucket stands in for R2; the content repository is the same temporary bare remote.
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
function bucket(fail = false) {
  const objects = new Map<string, { bytes: Buffer; type: string }>(); let heads = 0;
  return { objects, heads: () => heads, uploader: {
    async head(key: string) { heads++; return objects.has(key); },
    async put(key: string, bytes: Buffer, type: string) { if (fail) throw new Error('offline'); objects.set(key, { bytes, type }); },
  } };
}
function withImage(f: ReturnType<typeof fixture>, draft = false, source?: string) {
  const image = processImage(PNG_1X1); const article = parseArticle(f.store.get().workspace.articles[0]!);
  f.store.save(f.store.get().revision, { type: 'saveArticle', create: true, path: 'articles/with-image.md',
    data: { ...article.data, id: 'with-image', title: 'With image', draft }, body: `![diagram](${source ?? imageUrl(image.key)})\n` });
  return image;
}
test('a confirmed publication uploads its staged images before the fast-forward push', async t => {
  const f = fixture(t); const r2 = bucket(); const image = withImage(f); const before = f.head();
  const executor = new PublicationExecutor({ directory: path.join(f.root, 'images-worker'), remote: f.remote, publishEnabled: true, images: r2.uploader });
  assert.deepEqual(await executor.missingImages([image.key]), [image.key]);
  assert.throws(() => executor.stageImage(image.key, Buffer.concat([image.bytes, Buffer.from('x')])), /不一致/);
  executor.stageImage(image.key, image.bytes);
  const plan = executor.prepare(f.store.get());
  assert.deepEqual(plan.images.referenced, [image.key]);
  assert.deepEqual(plan.imageStatus, { referenced: 1, upload: [image.key], missing: [], invalid: 0, uploaderConfigured: true });
  const result = await executor.confirm(plan.execution.id, plan.revision);
  assert.equal(result.phase, 'pushed'); assert.equal(f.git(f.remote, 'rev-parse', 'main^'), before);
  assert.deepEqual(r2.objects.get(image.key), { bytes: image.bytes, type: 'image/png' });
  assert.match(f.git(f.remote, 'show', 'main:articles/with-image.md'), new RegExp(image.key));
  assert.equal(f.git(f.remote, 'ls-tree', '-r', '--name-only', 'main').includes('.png'), false, 'images never enter Git');
  const heads = r2.heads(); assert.deepEqual(await executor.missingImages([image.key]), []); assert.equal(r2.heads(), heads, 'published keys are remembered');
});
test('missing, unconfigured or failing image uploads end the job before any Git write', async t => {
  for (const scenario of ['missing', 'unconfigured', 'offline', 'external'] as const) {
    const f = fixture(t); const r2 = bucket(scenario === 'offline');
    const image = withImage(f, false, scenario === 'external' ? 'https://evil.example/x.png' : undefined); const before = f.head();
    const executor = new PublicationExecutor({ directory: path.join(f.root, 'images-worker'), remote: f.remote, publishEnabled: true, images: scenario === 'unconfigured' ? undefined : r2.uploader });
    if (scenario !== 'missing' && scenario !== 'external') executor.stageImage(image.key, image.bytes);
    const plan = executor.prepare(f.store.get());
    assert.equal(executor.imagesReady(plan.imageStatus), scenario === 'offline', scenario); // Offline only shows at upload time.
    if (scenario === 'external') assert.ok(plan.issues.some(issue => issue.code === 'image-source'));
    assert.equal((await executor.confirm(plan.execution.id, plan.revision)).phase, 'failed', scenario);
    assert.equal(f.head(), before, scenario); assert.equal(r2.objects.size, 0, scenario);
  }
});
test('draft-only images stay private: they are neither listed nor uploaded', async t => {
  const f = fixture(t); const r2 = bucket(); withImage(f, true);
  const executor = new PublicationExecutor({ directory: path.join(f.root, 'images-worker'), remote: f.remote, publishEnabled: true, images: r2.uploader });
  const plan = executor.prepare(f.store.get());
  assert.deepEqual(plan.images, { referenced: [], invalid: [] });
  assert.equal((await executor.confirm(plan.execution.id, plan.revision)).phase, 'pushed'); assert.equal(r2.objects.size, 0);
});
