import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertRealPath } from './store';
import { WorkbenchError } from './model';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
export const jobId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
export const jobSummarySchema = z.strictObject({
  id: jobId, planId: digest, expiresAt: z.iso.datetime(),
  phase: z.enum(['prepared', 'committing', 'committed', 'pushing', 'pushed', 'no-changes', 'conflict', 'unknown', 'expired']),
  commit: commit.nullable(), revision: digest, baseRevision: digest, candidateDigest: digest, baseCommit: commit,
  publishEnabled: z.boolean(), deployed: z.literal(false),
}).refine(job => !['pushed', 'no-changes'].includes(job.phase) || job.commit !== null, 'Successful jobs require a commit');
export type PublicationJob = z.infer<typeof jobSummarySchema>;
export const confirmationSchema = z.strictObject({ id: jobId, planId: digest, revision: digest, baseCommit: commit, acknowledgePrivateSnapshot: z.literal(true) });
export type PublicationConfirmation = z.infer<typeof confirmationSchema>;
const progressSchema = z.strictObject({ version: z.literal(1), job: jobSummarySchema, baseline: z.enum(['pending', 'advanced', 'conflict']) });
export type PublicationProgress = z.infer<typeof progressSchema>;
export function sameJob(left: PublicationJob, right: PublicationJob) {
  return (['id', 'planId', 'revision', 'baseRevision', 'candidateDigest', 'baseCommit', 'expiresAt'] as const).every(key => left[key] === right[key]);
}
export function publicationSettled(progress: PublicationProgress) {
  return progress.baseline === 'advanced' || ['conflict', 'expired'].includes(progress.job.phase);
}
/** Private acceptance receipt, written BEFORE IPC confirmation. Never stores Markdown or credentials. */
export class PublicationJournal {
  private readonly file: string;
  constructor(private readonly directory: string) { this.file = path.join(directory, 'publication.json'); assertRealPath(this.file); }
  read(): PublicationProgress | null {
    assertRealPath(this.file); if (!existsSync(this.file)) return null;
    try { return progressSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); }
    catch { throw new WorkbenchError('发布记录损坏，拒绝重新发布；请人工核对。', 409); }
  }
  write(progress: PublicationProgress) {
    progressSchema.parse(progress); assertRealPath(this.file);
    const temporary = this.file + '.' + randomUUID() + '.tmp'; const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(progress) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      renameSync(temporary, this.file);
      if (process.platform !== 'win32') { const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  async locked<T>(action: () => Promise<T>): Promise<T> {
    const file = path.join(this.directory, 'publication.lock'); let fd: number;
    try { fd = openSync(file, 'wx', 0o600); } catch { throw new WorkbenchError('发布核对正在进行或保留了中断锁，请查询状态并人工核对；不会重推。', 409); }
    try { return await action(); } finally { closeSync(fd); unlinkSync(file); }
  }
}
