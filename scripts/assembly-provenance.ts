import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sha = /^[a-f0-9]{40}$/;
export function contentCommit(value: unknown): string {
  if (typeof value !== 'string' || !sha.test(value)) throw new Error('Content revision must be a full lowercase commit SHA.');
  return value;
}
/** Resolve main once; subsequent checkout and assembly use only this immutable value. */
export async function resolveContentCommit(requested: string, lookup: () => Promise<unknown>): Promise<string> {
  if (requested) return contentCommit(requested);
  const value = await lookup() as { object?: { type?: string; sha?: unknown } } | null;
  if (value?.object?.type !== 'commit') throw new Error('Content main did not resolve to a commit.');
  return contentCommit(value.object.sha);
}
export function assemblyRun(env: NodeJS.ProcessEnv, sources: { blog: { dirty: boolean }; content: { commit: string; dirty: boolean } }) {
  const keys = ['ASSEMBLY_CONTENT_COMMIT', 'ASSEMBLY_RUN_ID', 'ASSEMBLY_RUN_ATTEMPT', 'ASSEMBLY_REPOSITORY'] as const;
  if (keys.every(key => !env[key])) return undefined;
  const expected = contentCommit(env.ASSEMBLY_CONTENT_COMMIT);
  if (expected !== sources.content.commit || sources.content.dirty || sources.blog.dirty) throw new Error('CI assembly requires clean sources and the exact pinned content commit.');
  if (env.ASSEMBLY_REPOSITORY !== 'XAN9xXx/blog' || !/^[1-9][0-9]*$/.test(env.ASSEMBLY_RUN_ID ?? '') || !/^[1-9][0-9]*$/.test(env.ASSEMBLY_RUN_ATTEMPT ?? '')) throw new Error('Incomplete or invalid assembly run identity.');
  return { repository: env.ASSEMBLY_REPOSITORY, runId: env.ASSEMBLY_RUN_ID!, runAttempt: env.ASSEMBLY_RUN_ATTEMPT!,
    url: `https://github.com/${env.ASSEMBLY_REPOSITORY}/actions/runs/${env.ASSEMBLY_RUN_ID}/attempts/${env.ASSEMBLY_RUN_ATTEMPT}` };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const commit = await resolveContentCommit(process.env.REQUESTED_CONTENT_COMMIT ?? '', async () => {
    if (!process.env.CONTENT_READ_TOKEN) throw new Error('Missing content read credential.');
    const response = await fetch('https://api.github.com/repos/XAN9xXx/blog-content/git/ref/heads/main', {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.CONTENT_READ_TOKEN}` },
      signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Cannot resolve content main (HTTP ${response.status}).`);
    return response.json();
  });
  if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GitHub step output path.');
  appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\n`);
  console.log(`Pinned content: ${commit}`);
}
