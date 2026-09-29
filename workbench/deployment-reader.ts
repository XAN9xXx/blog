import { z } from 'zod';
import { deploymentReport, type DeploymentReport } from './deployment-state';
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const refSchema = z.object({ object: z.object({ type: z.literal('commit'), sha }) });
const runSchema = z.object({ id, run_attempt: id, head_sha: sha, path: z.literal('.github/workflows/assemble.yml'),
  repository: z.object({ full_name: z.literal('XAN9xXx/blog') }), status: z.string(), conclusion: z.string().nullable(), display_title: z.string().optional() });
const manifestSchema = z.object({ blog: z.object({ commit: sha, dirty: z.literal(false) }), content: z.object({ commit: sha, dirty: z.literal(false) }),
  topology: z.object({ repository: z.literal('XAN9xXx/blog-topology'), commit: sha }),
  assembly: z.object({ repository: z.literal('XAN9xXx/blog'), runId: z.string().regex(/^[1-9][0-9]*$/), runAttempt: z.string().regex(/^[1-9][0-9]*$/) }) });
export type GitHubLookup = (path: string) => Promise<unknown | null>;
/** Every request is GET to fixed repositories. null means an actual HTTP 404, not an authentication failure. */
export function githubLookup(token: string, transport: typeof fetch = fetch): GitHubLookup {
  if (!token || /\s/.test(token)) throw new Error('Invalid read credential.');
  return async path => {
    if (!/^\/repos\/XAN9xXx\/(blog|blog-content|site)(?:\/|$)/.test(path) || path.includes('..')) throw new Error('Invalid query target.');
    const response = await transport('https://api.github.com' + path, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` } });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('GitHub read unavailable.'); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) throw new Error('GitHub response too large.'); chunks.push(value); } }
    finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
}
/** Evidence-based, bounded lookup. A Cloudflare GitHub check never proves the current production version. */
export async function readDeployment(commit: string, lookup: GitHubLookup): Promise<DeploymentReport> {
  sha.parse(commit); const result = deploymentReport(commit, 'unmatched'); let requests = 0; const deadline = Date.now() + 35_000;
  const get: GitHubLookup = async path => { if (++requests > 20 || Date.now() > deadline) throw new Error('Lookup budget exhausted.'); return lookup(path); };
  try {
    // Verify access first: GitHub conceals inaccessible private repositories with 404.
    for (const repo of ['blog-content', 'site']) {
      const metadata = z.object({ full_name: z.literal('XAN9xXx/' + repo), private: z.literal(true) }).parse(await get(`/repos/XAN9xXx/${repo}`));
      if (!metadata.private) throw new Error('Private mirror required.');
    }
    const mirrored = await get(`/repos/XAN9xXx/blog-content/git/commits/${commit}`);
    if (mirrored === null) return { ...result, state: 'waiting-mirror' };
    if (z.object({ sha }).parse(mirrored).sha !== commit) throw new Error('Mirror commit mismatch.');
    const head = refSchema.parse(await get('/repos/XAN9xXx/site/git/ref/heads/main')).object.sha;
    const inspect = async (siteCommit: string) => {
      const file = await get(`/repos/XAN9xXx/site/contents/.site-build.json?ref=${siteCommit}`);
      if (file === null) return null;
      const data = z.object({ encoding: z.literal('base64'), content: z.string().max(200_000) }).parse(file);
      const parsed = manifestSchema.safeParse(JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')));
      return parsed.success && parsed.data.content.commit === commit ? { siteCommit, manifest: parsed.data } : null;
    };
    let match = await inspect(head);
    if (!match) {
      const history = z.array(z.object({ sha })).max(10).parse(await get(`/repos/XAN9xXx/site/commits?sha=${head}&path=.site-build.json&per_page=10`));
      for (const entry of history) { if (entry.sha !== head) { match = await inspect(entry.sha); if (match) break; } }
    }
    if (!match) {
      const runs = z.object({ workflow_runs: z.array(z.unknown()).max(50) }).parse(await get('/repos/XAN9xXx/blog/actions/workflows/assemble.yml/runs?event=workflow_dispatch&per_page=50'));
      for (const raw of runs.workflow_runs) {
        const parsed = runSchema.safeParse(raw); if (!parsed.success || parsed.data.display_title !== `Assemble content ${commit}`) continue;
        const run = parsed.data; result.run = { id: run.id, attempt: run.run_attempt, blogCommit: run.head_sha };
        result.state = run.status !== 'completed' ? 'building' : run.conclusion === 'cancelled' ? 'cancelled' : run.conclusion === 'success' ? 'unmatched' : 'build-failed';
        return result; // A title is only a run candidate; success requires the output manifest too.
      }
      return result;
    }
    const { siteCommit, manifest } = match;
    const runId = Number(manifest.assembly.runId), attempt = Number(manifest.assembly.runAttempt); id.parse(runId); id.parse(attempt);
    const run = runSchema.parse(await get(`/repos/XAN9xXx/blog/actions/runs/${runId}/attempts/${attempt}`));
    if (run.id !== runId || run.run_attempt !== attempt || run.head_sha !== manifest.blog.commit) throw new Error('Run provenance mismatch.');
    result.run = { id: runId, attempt, blogCommit: run.head_sha };
    result.site = { commit: siteCommit, current: siteCommit === head, topologyCommit: manifest.topology.commit };
    if (run.status !== 'completed') return { ...result, state: 'building' };
    if (run.conclusion !== 'success') return { ...result, state: run.conclusion === 'cancelled' ? 'cancelled' : 'build-failed' };
    const checks = z.object({ check_runs: z.array(z.unknown()).max(100) }).parse(await get(`/repos/XAN9xXx/site/commits/${siteCommit}/check-runs?filter=latest&per_page=100`));
    const schema = z.object({ id, name: z.literal('Cloudflare Pages'), head_sha: z.literal(siteCommit),
      app: z.object({ id: z.literal(85455), slug: z.literal('cloudflare-workers-and-pages') }), status: z.string(), conclusion: z.string().nullable(), details_url: z.string() });
    const candidates = checks.check_runs.flatMap(raw => {
      const parsed = schema.safeParse(raw); if (!parsed.success) return [];
      try {
        const url = new URL(parsed.data.details_url);
        const deploymentId = /^\/[a-f0-9]{32}\/pages\/view\/site\/([a-f0-9-]{36})$/.exec(url.searchParams.get('to') ?? '')?.[1];
        if (url.origin !== 'https://dash.cloudflare.com' || url.username || url.password || url.pathname !== '/' || !z.uuid().safeParse(deploymentId).success) return [];
        return [{ ...parsed.data, deploymentId: deploymentId!, url: `https://dash.cloudflare.com/?to=${encodeURIComponent(url.searchParams.get('to')!)}` }];
      } catch { return []; }
    }).sort((a, b) => b.id - a.id);
    const check = candidates[0]; if (!check) return { ...result, state: 'awaiting-deployment' };
    result.check = { id: check.id, deploymentId: check.deploymentId, url: check.url };
    result.state = check.status !== 'completed' ? 'deploying' : check.conclusion === 'success' ? 'deployment-check-passed' : 'deployment-failed';
    return result;
  } catch { return deploymentReport(commit, 'unavailable'); } // No raw API response, private body or credentials cross IPC.
}
export class DeploymentReader {
  private cached?: { commit: string; report: DeploymentReport; until: number };
  private pending?: { commit: string; promise: Promise<DeploymentReport> };
  constructor(private readonly lookup?: GitHubLookup) {}
  async query(commit: string): Promise<DeploymentReport> {
    sha.parse(commit);
    if (!this.lookup) return deploymentReport(commit, 'unconfigured');
    if (this.cached?.commit === commit && Date.now() < this.cached.until) return this.cached.report;
    if (this.pending) return this.pending.commit === commit ? this.pending.promise : deploymentReport(commit, 'unavailable');
    const promise = readDeployment(commit, this.lookup); this.pending = { commit, promise };
    try { const report = await promise; this.cached = { commit, report, until: Date.now() + 30_000 }; return report; }
    finally { this.pending = undefined; }
  }
}
