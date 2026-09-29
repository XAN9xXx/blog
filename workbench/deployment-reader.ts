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
// The Git-integrated Pages project must still build XAN9xXx/site main; deployments must come from that integration, not ad-hoc uploads.
const projectSchema = z.object({ name: z.literal('site'), production_branch: z.literal('main'),
  source: z.object({ type: z.literal('github'), config: z.object({ owner: z.literal('XAN9xXx'), repo_name: z.literal('site') }) }),
  canonical_deployment: z.object({ id: z.uuid() }).nullish() });
const pagesDeploymentSchema = z.object({ id: z.uuid(), project_name: z.literal('site'), environment: z.literal('production'),
  created_on: z.string().refine(value => Number.isFinite(Date.parse(value))), is_skipped: z.boolean().optional(),
  deployment_trigger: z.object({ type: z.literal('github:push'), metadata: z.object({ branch: z.literal('main'), commit_hash: sha }) }),
  latest_stage: z.object({ name: z.string(), status: z.string() }) });
export const cloudflareCredentialSchema = z.strictObject({ accountId: z.string().regex(/^[a-f0-9]{32}$/), token: z.string().regex(/^[A-Za-z0-9_-]{20,512}$/) });
export type GitHubLookup = (path: string) => Promise<unknown | null>;
/** Paths are relative to the fixed `site` project of one account. */
export interface CloudflareLookup { accountId: string; get(path: string): Promise<unknown> }
export interface DeploymentSources { github: GitHubLookup; cloudflare?: CloudflareLookup }
function request(transport: typeof fetch, url: string, token: string, accept: string) {
  return transport(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: accept, Authorization: `Bearer ${token}` } });
}
async function boundedJson(response: Response, service: string): Promise<unknown> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`${service} read unavailable.`); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) throw new Error(`${service} response too large.`); chunks.push(value); } }
  finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** Every request is GET to fixed repositories. null means an actual HTTP 404, not an authentication failure. */
export function githubLookup(token: string, transport: typeof fetch = fetch): GitHubLookup {
  if (!token || /\s/.test(token)) throw new Error('Invalid read credential.');
  return async path => {
    if (!/^\/repos\/XAN9xXx\/(blog|blog-content|site)(?:\/|$)/.test(path) || path.includes('..')) throw new Error('Invalid query target.');
    const response = await request(transport, 'https://api.github.com' + path, token, 'application/vnd.github+json');
    if (response.status === 404) { await response.body?.cancel(); return null; }
    return boundedJson(response, 'GitHub');
  };
}
/** GET-only Pages API reads. A 404 or an unsuccessful envelope is an error, never evidence of absence. */
export function cloudflareLookup(credential: z.infer<typeof cloudflareCredentialSchema>, transport: typeof fetch = fetch): CloudflareLookup {
  const { accountId, token } = cloudflareCredentialSchema.parse(credential);
  return { accountId, async get(path) {
    if (!/^(?:\/deployments(?:\?[A-Za-z0-9=&_]*)?)?$/.test(path)) throw new Error('Invalid query target.');
    const response = await request(transport, `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/site${path}`, token, 'application/json');
    return z.object({ success: z.literal(true), result: z.unknown() }).parse(await boundedJson(response, 'Cloudflare')).result;
  } };
}
/** Evidence-based, bounded lookup. Production is verified only when the matching Pages deployment is the project's canonical one. */
export async function readDeployment(commit: string, sources: DeploymentSources): Promise<DeploymentReport> {
  sha.parse(commit); const result = deploymentReport(commit, 'unmatched'); let requests = 0; const deadline = Date.now() + 35_000;
  const budget = <T>(call: () => Promise<T>) => { if (++requests > 20 || Date.now() > deadline) throw new Error('Lookup budget exhausted.'); return call(); };
  const get: GitHubLookup = path => budget(() => sources.github(path));
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
    // Fine-grained GitHub tokens cannot read check runs, so deployment evidence comes from the Pages API itself.
    const cloudflare = sources.cloudflare; if (!cloudflare) return { ...result, state: 'deployment-unconfigured' };
    const project = projectSchema.parse(await budget(() => cloudflare.get('')));
    const listed = z.array(z.unknown()).max(100).parse(await budget(() => cloudflare.get('/deployments?env=production&page=1&per_page=25')));
    // The newest deployment of this site commit decides: a later failure or retry is never hidden by an earlier success.
    const deployment = listed.flatMap(raw => {
      const parsed = pagesDeploymentSchema.safeParse(raw);
      return parsed.success && parsed.data.deployment_trigger.metadata.commit_hash === siteCommit ? [parsed.data] : [];
    }).sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
    if (!deployment) return { ...result, state: 'awaiting-deployment' };
    result.deployment = { id: deployment.id, url: `https://dash.cloudflare.com/?to=${encodeURIComponent(`/${cloudflare.accountId}/pages/view/site/${deployment.id}`)}` };
    const stage = deployment.latest_stage;
    if (deployment.is_skipped || ['failure', 'canceled', 'skipped'].includes(stage.status)) return { ...result, state: 'deployment-failed' };
    if (stage.name !== 'deploy' || stage.status !== 'success') return { ...result, state: 'deploying' };
    return project.canonical_deployment?.id === deployment.id ? { ...result, state: 'live', productionVerified: true } : { ...result, state: 'deployment-succeeded' };
  } catch { return deploymentReport(commit, 'unavailable'); } // No raw API response, private body or credentials cross IPC.
}
export class DeploymentReader {
  private cached?: { commit: string; report: DeploymentReport; until: number };
  private pending?: { commit: string; promise: Promise<DeploymentReport> };
  constructor(private readonly sources?: DeploymentSources) {}
  async query(commit: string): Promise<DeploymentReport> {
    sha.parse(commit);
    if (!this.sources) return deploymentReport(commit, 'unconfigured');
    if (this.cached?.commit === commit && Date.now() < this.cached.until) return this.cached.report;
    if (this.pending) return this.pending.commit === commit ? this.pending.promise : deploymentReport(commit, 'unavailable');
    const promise = readDeployment(commit, this.sources); this.pending = { commit, promise };
    try { const report = await promise; this.cached = { commit, report, until: Date.now() + 30_000 }; return report; }
    finally { this.pending = undefined; }
  }
}
