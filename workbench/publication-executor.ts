import { execFileSync } from 'node:child_process';
import { jobSummarySchema, type PublicationJob } from './publication-state';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { assertRealPath } from './store';
import { WorkbenchError } from './model';
import { assertPublicationPlanCurrent, createPublicationPlan, parsePublicationSnapshot, publicationPlanSummary, type PublicationPlan } from './publication-plan';
import { readPublicationBaseline } from './publication-git';
import { verifyImage } from './images';
import type { ImageUploader } from './r2';
import { parseImageKey } from '../src/lib/images';

type Phase = 'prepared' | 'committing' | 'committed' | 'pushing' | 'pushed' | 'no-changes' | 'conflict' | 'unknown' | 'expired' | 'failed';
interface Job { version: 1; id: string; phase: Phase; plan: PublicationPlan; commit?: string }
export interface ExecutorConfig { directory: string; remote: string; sshCommand?: string; publishEnabled: boolean; images?: ImageUploader }
export interface ImageStatus { referenced: number; upload: string[]; missing: string[]; invalid: number; uploaderConfigured: boolean }
/** Dedicated worker only. Fixed administrator config, private objects/indexes, no working-tree checkout or hooks. */
export class PublicationExecutor {
  private readonly repository: string;
  private readonly jobs: string;
  private readonly published: string;
  private readonly staged: string;
  private readonly env: NodeJS.ProcessEnv;
  constructor(private readonly config: ExecutorConfig) {
    assertRealPath(config.directory); mkdirSync(config.directory, { recursive: true, mode: 0o700 });
    this.repository = path.join(config.directory, 'repository'); this.jobs = path.join(config.directory, 'jobs');
    assertRealPath(this.repository); assertRealPath(this.jobs); mkdirSync(this.jobs, { mode: 0o700, recursive: true });
    // Images: empty markers for keys known to be in the bucket, and verified uploads waiting for a confirmation.
    this.published = path.join(config.directory, 'images', 'published'); this.staged = path.join(config.directory, 'images', 'staged');
    for (const directory of [this.published, this.staged]) { assertRealPath(directory); mkdirSync(directory, { mode: 0o700, recursive: true }); }
    this.env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: config.sshCommand, GIT_SSH_VARIANT: 'ssh' };
    if (!existsSync(this.repository)) {
      mkdirSync(this.repository, { mode: 0o700 }); this.git('init', '--initial-branch=main');
    }
  }
  private git(...args: string[]): string { return this.command(args); }
  private command(args: string[], input?: string, extra?: NodeJS.ProcessEnv): string {
    return execFileSync('git', ['--no-replace-objects', '--no-lazy-fetch', '-c', 'core.hooksPath=' + devNull, '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-C', this.repository, ...args], {
      env: { ...this.env, ...extra }, input, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }
  private remoteHead(): string {
    const value = this.git('ls-remote', '--refs', this.config.remote, 'refs/heads/main');
    if (!/^[a-f0-9]{40}\trefs\/heads\/main$/.test(value)) throw new WorkbenchError('无法确定固定内容仓库的 main 提交。', 409);
    return value.slice(0, 40);
  }
  private baseline() {
    const commit = this.remoteHead();
    this.git('fetch', '--no-tags', this.config.remote, commit);
    if (this.remoteHead() !== commit) throw new WorkbenchError('获取期间远端已变化，请重新核对。', 409);
    this.git('update-ref', 'refs/heads/main', commit);
    return readPublicationBaseline(this.repository, commit);
  }
  private file(id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new WorkbenchError('无效作业 ID。');
    const file = path.join(this.jobs, id + '.json'); assertRealPath(file); return file;
  }
  private save(job: Job) {
    const file = this.file(job.id); const temporary = file + '.' + randomUUID() + '.tmp';
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(job) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, file); const directory = openSync(this.jobs, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private load(id: string): Job {
    const job = JSON.parse(readFileSync(this.file(id), 'utf8')) as Job;
    if (job.version !== 1 || job.id !== id || !['prepared','committing','committed','pushing','pushed','no-changes','conflict','unknown','expired','failed'].includes(job.phase)) throw new WorkbenchError('发布作业损坏，拒绝继续。', 409);
    return job;
  }
  get publishEnabled() { return this.config.publishEnabled; }
  private summary(job: Job): PublicationJob {
    return jobSummarySchema.parse({ id: job.id, planId: job.plan.planId, expiresAt: job.plan.expiresAt, phase: job.phase, commit: job.commit ?? null, revision: job.plan.revision,
      baseRevision: job.plan.baseRevision, candidateDigest: job.plan.candidateDigest, baseCommit: job.plan.baseCommit,
      publishEnabled: this.config.publishEnabled, deployed: false as const });
  }
  private locked<T>(run: () => T): T {
    const file = path.join(this.config.directory, 'execution.lock'); let fd: number;
    try { fd = openSync(file, 'wx', 0o600); } catch { throw new WorkbenchError('执行器忙碌或保留了中断锁；不会自动重试推送。', 409); }
    try { return run(); } finally { closeSync(fd); unlinkSync(file); }
  }
  private async lockedAsync<T>(run: () => Promise<T>): Promise<T> {
    const file = path.join(this.config.directory, 'execution.lock'); let fd: number;
    try { fd = openSync(file, 'wx', 0o600); } catch { throw new WorkbenchError('执行器忙碌或保留了中断锁；不会自动重试推送。', 409); }
    try { return await run(); } finally { closeSync(fd); unlinkSync(file); }
  }
  private imageFile(directory: string, key: string) {
    if (!parseImageKey(key)) throw new WorkbenchError('无效的图片名称。');
    const file = path.join(directory, key); assertRealPath(file); return file;
  }
  private isPublished(key: string) { return existsSync(this.imageFile(this.published, key)); }
  private markPublished(key: string) { closeSync(openSync(this.imageFile(this.published, key), 'a', 0o600)); }
  /** Keys not yet in the bucket. Unknown keys are checked once with HEAD, then remembered. */
  async missingImages(keys: string[]) {
    if (keys.length > 1000) throw new WorkbenchError('单次发布最多引用 1000 张图片。');
    const missing: string[] = [];
    for (const key of [...new Set(keys)].sort()) {
      if (this.isPublished(key)) continue;
      if (this.config.images && await this.config.images.head(key)) { this.markPublished(key); continue; }
      missing.push(key);
    }
    return missing;
  }
  /** Hold a verified, metadata-free image privately until a confirmation uploads it. */
  stageImage(key: string, bytes: Buffer) {
    verifyImage(key, bytes);
    const file = this.imageFile(this.staged, key);
    if (existsSync(file)) return;
    if (readdirSync(this.staged).length >= 200) throw new WorkbenchError('待上传图片过多，请先完成或清理之前的发布。', 409);
    const temporary = path.join(this.staged, '.' + randomUUID() + '.tmp'); const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, file); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  imageStatus(plan: PublicationPlan): ImageStatus {
    const pending = plan.images.referenced.filter(key => !this.isPublished(key));
    const staged = (key: string) => existsSync(this.imageFile(this.staged, key));
    return { referenced: plan.images.referenced.length, upload: pending.filter(staged), missing: pending.filter(key => !staged(key)),
      invalid: plan.images.invalid.length, uploaderConfigured: Boolean(this.config.images) };
  }
  /** True when a confirmation could publish every referenced image. */
  imagesReady(status: ImageStatus) { return !status.missing.length && !status.invalid && (!status.upload.length || status.uploaderConfigured); }
  /** Upload before any Git write: a failure leaves the content repository untouched. */
  private async uploadImages(plan: PublicationPlan) {
    const status = this.imageStatus(plan);
    if (!this.imagesReady(status)) return false;
    for (const key of status.upload) {
      const file = this.imageFile(this.staged, key); const bytes = readFileSync(file);
      const image = verifyImage(key, bytes);
      await this.config.images!.put(key, bytes, image.type);
      if (!await this.config.images!.head(key)) return false;
      this.markPublished(key); unlinkSync(file);
    }
    return true;
  }
  prepare(snapshot: unknown) {
    const parsed = parsePublicationSnapshot(snapshot);
    return this.locked(() => {
      if (readdirSync(this.jobs).filter(name => name.endsWith('.json')).length >= 100) throw new WorkbenchError('发布作业数量达到上限，请先人工清理已审阅的历史。', 409);
      const plan = createPublicationPlan(parsed, this.baseline(), { visibility: 'private' });
      const job: Job = { version: 1, id: randomUUID(), phase: 'prepared', plan }; this.save(job);
      return { ...publicationPlanSummary(plan), imageStatus: this.imageStatus(plan), execution: this.summary(job) };
    });
  }
  get(id: string) { return this.summary(this.load(id)); }
  /** Observe an interrupted attempt, never repeat a commit or push. A crash lock still requires manual recovery. */
  reconcile(id: string) {
    return this.locked(() => {
      const job = this.load(id);
      if (['committing', 'committed', 'pushing', 'unknown'].includes(job.phase)) {
        try { job.phase = job.commit && this.remoteHead() === job.commit ? 'pushed' : 'unknown'; }
        catch { job.phase = 'unknown'; }
        this.save(job);
      }
      return this.summary(job);
    });
  }
  confirm(id: string, revision: string) {
    return this.lockedAsync(async () => {
      const job = this.load(id);
      if (job.plan.revision !== revision) throw new WorkbenchError('确认版本与冻结作业不一致。', 409);
      if (['pushed','no-changes','conflict','unknown','expired'].includes(job.phase)) return this.summary(job);
      if (job.phase !== 'prepared') {
        // A restart may have interrupted a push. Observe only; never repeat it.
        try { job.phase = job.commit && this.remoteHead() === job.commit ? 'pushed' : 'unknown'; }
        catch { job.phase = 'unknown'; }
        this.save(job); return this.summary(job);
      }
      if (!this.config.publishEnabled) throw new WorkbenchError('首次真实发布尚未获准；执行器保持只读核对，未提交或推送。', 403);
      const baseline = this.baseline();
      if (baseline.commit !== job.plan.baseCommit) { job.phase = 'conflict'; this.save(job); return this.summary(job); }
      if (Date.now() >= Date.parse(job.plan.expiresAt)) { job.phase = 'expired'; this.save(job); return this.summary(job); }
      assertPublicationPlanCurrent(job.plan, job.plan.snapshot, baseline, 'private');
      let uploaded = false;
      try { uploaded = await this.uploadImages(job.plan); } catch { uploaded = false; }
      if (!uploaded) { job.phase = 'failed'; this.save(job); return this.summary(job); }
      // Uploading takes time; the remote must still be the reviewed baseline before writing anything.
      if (this.remoteHead() !== baseline.commit) { job.phase = 'conflict'; this.save(job); return this.summary(job); }
      if (job.plan.noChanges) { job.phase = 'no-changes'; job.commit = baseline.commit; this.save(job); return this.summary(job); }
      job.phase = 'committing'; this.save(job);
      const index = path.join(this.jobs, job.id + '.index'); assertRealPath(index);
      if (existsSync(index)) throw new WorkbenchError('候选索引已存在，需要人工核对。', 409);
      const env = { GIT_INDEX_FILE: index };
      this.command(['read-tree', baseline.commit], undefined, env);
      const snapshot = job.plan.snapshot.workspace;
      const candidate = Object.fromEntries(snapshot.articles.map(file => [file.path, file.raw]));
      candidate['topology.json'] = job.plan.files.some(file => file.path === 'topology.json') ? JSON.stringify(snapshot.topology, null, 2) + '\n' : baseline.files['topology.json']!;
      for (const file of job.plan.files) {
        if (file.kind === 'deleted') this.command(['update-index', '--force-remove', '--', file.path], undefined, env);
        else {
          const blob = this.command(['hash-object', '-w', '--stdin'], candidate[file.path]!);
          const existing = this.git('ls-tree', baseline.commit, '--', file.path);
          const mode = existing.startsWith('100755 ') ? '100755' : '100644';
          this.command(['update-index', '--add', '--cacheinfo', `${mode},${blob},${file.path}`], undefined, env);
        }
      }
      const tree = this.command(['write-tree'], undefined, env);
      const date = `${Math.floor(Date.parse(job.plan.createdAt) / 1000)} +0000`;
      job.commit = this.command(['commit-tree', tree, '-p', baseline.commit, '-m', `Publish workbench ${revision.slice(0, 12)}`], undefined, {
        GIT_AUTHOR_NAME: 'XAN9x Workbench', GIT_AUTHOR_EMAIL: 'workbench@localhost', GIT_COMMITTER_NAME: 'XAN9x Workbench', GIT_COMMITTER_EMAIL: 'workbench@localhost', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
      });
      this.git('update-ref', 'refs/workbench/' + job.id, job.commit);
      job.phase = 'committed'; this.save(job); unlinkSync(index);
      if (this.remoteHead() !== baseline.commit) { job.phase = 'conflict'; this.save(job); return this.summary(job); }
      job.phase = 'pushing'; this.save(job);
      try {
        // Plain fast-forward push only. No force, rebase, reset, or automatic replay.
        this.git('push', '--porcelain', this.config.remote, `${job.commit}:refs/heads/main`);
        job.phase = 'pushed';
      } catch {
        try { job.phase = this.remoteHead() === job.commit ? 'pushed' : 'unknown'; } catch { job.phase = 'unknown'; }
      }
      this.save(job); return this.summary(job);
    });
  }
}
