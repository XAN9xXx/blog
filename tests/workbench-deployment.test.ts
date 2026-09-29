import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflareLookup, DeploymentReader, githubLookup, readDeployment, type DeploymentSources, type GitHubLookup } from '../workbench/deployment-reader';
import { deploymentMessage, deploymentReportSchema } from '../workbench/deployment-state';
const content = 'a'.repeat(40), site = 'b'.repeat(40), blog = 'c'.repeat(40), topology = 'd'.repeat(40), newer = 'e'.repeat(40), account = 'f'.repeat(32);
const run = { id: 123, run_attempt: 2, head_sha: blog, path: '.github/workflows/assemble.yml', repository: { full_name: 'XAN9xXx/blog' }, status: 'completed', conclusion: 'success', display_title: `Assemble content ${content}` };
const manifest = { blog: { commit: blog, dirty: false }, content: { commit: content, dirty: false }, topology: { repository: 'XAN9xXx/blog-topology', commit: topology }, assembly: { repository: 'XAN9xXx/blog', runId: '123', runAttempt: '2' } };
const deployed = { id: 'a2e67767-f1cc-454c-a9a9-8c419b20e2ad', project_name: 'site', environment: 'production', created_on: '2026-09-29T09:19:00.000000Z',
  deployment_trigger: { type: 'github:push', metadata: { branch: 'main', commit_hash: site } }, latest_stage: { name: 'deploy', status: 'success' } };
const other = 'b3c1d2e4-5f60-4a7b-8c9d-0e1f2a3b4c5d';
const project = { name: 'site', production_branch: 'main', source: { type: 'github', config: { owner: 'XAN9xXx', repo_name: 'site' } }, canonical_deployment: { id: deployed.id } };
const listing = '/deployments?env=production&page=1&per_page=25';
const encoded = (value: unknown) => ({ encoding: 'base64', content: Buffer.from(JSON.stringify(value)).toString('base64') });
function fixture() {
  const data = new Map<string, unknown>([
    ['/repos/XAN9xXx/blog-content', { full_name: 'XAN9xXx/blog-content', private: true }],
    ['/repos/XAN9xXx/site', { full_name: 'XAN9xXx/site', private: true }],
    [`/repos/XAN9xXx/blog-content/git/commits/${content}`, { sha: content }],
    ['/repos/XAN9xXx/site/git/ref/heads/main', { object: { type: 'commit', sha: site } }],
    [`/repos/XAN9xXx/site/contents/.site-build.json?ref=${site}`, encoded(manifest)],
    ['/repos/XAN9xXx/blog/actions/runs/123/attempts/2', structuredClone(run)],
  ]);
  const pages = new Map<string, unknown>([['', structuredClone(project)], [listing, [structuredClone(deployed)]]]);
  const calls: string[] = [];
  const lookup: GitHubLookup = async path => { calls.push(path); if (!data.has(path)) throw new Error('Unexpected request: ' + path); return data.get(path); };
  const sources: DeploymentSources = { github: lookup, cloudflare: { accountId: account, get: async path => { calls.push('pages:' + path); if (!pages.has(path)) throw new Error('Unexpected request: ' + path); return pages.get(path); } } };
  return { data, pages, calls, lookup, sources, query: () => readDeployment(content, sources) };
}
test('exact manifest, run attempt and the canonical Pages deployment verify production', async () => {
  const f = fixture(); const result = await f.query();
  assert.equal(result.state, 'live'); assert.equal(result.productionVerified, true);
  assert.deepEqual(result.run, { id: 123, attempt: 2, blogCommit: blog }); assert.deepEqual(result.site, { commit: site, current: true, topologyCommit: topology });
  assert.equal(result.deployment?.id, deployed.id); assert.equal(result.deployment?.url, `https://dash.cloudflare.com/?to=${encodeURIComponent(`/${account}/pages/view/site/${deployed.id}`)}`);
  deploymentReportSchema.parse(result); assert.match(deploymentMessage(result), /已上线/); assert.equal(f.calls.length, 8);
});
test('a successful deployment that is not the canonical one is never reported as live', async () => {
  for (const canonical of [{ id: other }, null, undefined]) {
    const f = fixture(); f.pages.set('', { ...project, canonical_deployment: canonical }); const result = await f.query();
    assert.equal(result.state, 'deployment-succeeded'); assert.equal(result.productionVerified, false); assert.match(deploymentMessage(result), /已不是它/);
  }
  assert.throws(() => deploymentReportSchema.parse({ contentCommit: content, checkedAt: new Date().toISOString(), state: 'deployment-succeeded', productionVerified: true, run: null, site: null, deployment: null }));
});
test('missing mirror differs from missing credentials or changed repository visibility', async () => {
  const absent = fixture(); absent.data.set(`/repos/XAN9xXx/blog-content/git/commits/${content}`, null); assert.equal((await absent.query()).state, 'waiting-mirror');
  for (const metadata of [null, { full_name: 'XAN9xXx/blog-content', private: false }]) { const f = fixture(); f.data.set('/repos/XAN9xXx/blog-content', metadata); assert.equal((await f.query()).state, 'unavailable'); }
});
test('provenance mismatches never become deployment success', async () => {
  for (const replacement of [{ ...run, head_sha: newer }, { ...run, run_attempt: 3 }, { ...run, id: 999 }, { ...run, path: '.github/workflows/other.yml' }, { ...run, repository: { full_name: 'someone/else' } }]) {
    const f = fixture(); f.data.set('/repos/XAN9xXx/blog/actions/runs/123/attempts/2', replacement); const result = await f.query(); assert.equal(result.state, 'unavailable'); assert.equal(result.deployment, null);
  }
});
test('in-progress, failed and cancelled builds remain distinct even when a manifest exists', async () => {
  for (const [status, conclusion, expected] of [['in_progress', null, 'building'], ['completed', 'failure', 'build-failed'], ['completed', 'cancelled', 'cancelled']] as const) {
    const f = fixture(); f.data.set('/repos/XAN9xXx/blog/actions/runs/123/attempts/2', { ...run, status, conclusion }); assert.equal((await f.query()).state, expected); assert.ok(!f.calls.some(p => p.startsWith('pages:')));
  }
});
test('without a Cloudflare credential the lookup stops at verified build evidence', async () => {
  const f = fixture(); const result = await readDeployment(content, { github: f.lookup });
  assert.equal(result.state, 'deployment-unconfigured'); assert.equal(result.productionVerified, false); assert.equal(result.run?.id, 123); assert.equal(result.site?.commit, site);
  assert.ok(!f.calls.some(p => p.startsWith('pages:'))); assert.match(deploymentMessage(result), /Cloudflare 只读凭据/);
});
test('Pages project identity is required before any deployment is trusted', async () => {
  for (const changed of [{ ...project, name: 'other' }, { ...project, production_branch: 'preview' }, { ...project, source: { type: 'gitlab', config: project.source.config } },
    { ...project, source: { type: 'github', config: { owner: 'someone', repo_name: 'site' } } }, { ...project, source: { type: 'github', config: { owner: 'XAN9xXx', repo_name: 'blog' } } }]) {
    const f = fixture(); f.pages.set('', changed); const result = await f.query(); assert.equal(result.state, 'unavailable'); assert.equal(result.deployment, null);
  }
});
test('deployment trigger, branch, environment and site SHA are required, not just a successful stage', async () => {
  for (const changed of [{ ...deployed, environment: 'preview' }, { ...deployed, project_name: 'other' }, { ...deployed, deployment_trigger: { type: 'ad_hoc', metadata: deployed.deployment_trigger.metadata } },
    { ...deployed, deployment_trigger: { type: 'github:push', metadata: { branch: 'feature', commit_hash: site } } }, { ...deployed, deployment_trigger: { type: 'github:push', metadata: { branch: 'main', commit_hash: newer } } }]) {
    const f = fixture(); f.pages.set(listing, [changed]); const result = await f.query(); assert.equal(result.state, 'awaiting-deployment'); assert.equal(result.productionVerified, false);
  }
});
test('the newest deployment of the commit decides; pending, skipped or cancelled is not success', async () => {
  const retry = (latest_stage: object, extra: object = {}) => [deployed, { ...deployed, id: other, created_on: '2026-09-29T09:30:00Z', latest_stage, ...extra }];
  for (const [list, expected] of [[retry({ name: 'deploy', status: 'failure' }), 'deployment-failed'], [retry({ name: 'build', status: 'active' }), 'deploying'],
    [retry({ name: 'deploy', status: 'success' }, { is_skipped: true }), 'deployment-failed'], [retry({ name: 'build', status: 'canceled' }), 'deployment-failed'],
    [[{ ...deployed, latest_stage: { name: 'deploy', status: 'active' } }], 'deploying']] as const) {
    const f = fixture(); f.pages.set(listing, list); const result = await f.query(); assert.equal(result.state, expected); assert.equal(result.productionVerified, false);
  }
});
test('bounded history marks earlier site output as historical rather than currently deployed', async () => {
  const f = fixture(); f.data.set('/repos/XAN9xXx/site/git/ref/heads/main', { object: { type: 'commit', sha: newer } });
  f.data.set(`/repos/XAN9xXx/site/contents/.site-build.json?ref=${newer}`, encoded({ ...manifest, content: { commit: newer, dirty: false } }));
  f.data.set(`/repos/XAN9xXx/site/commits?sha=${newer}&path=.site-build.json&per_page=10`, [{ sha: newer }, { sha: site }]);
  f.pages.set('', { ...project, canonical_deployment: { id: other } });
  const result = await f.query(); assert.equal(result.state, 'deployment-succeeded'); assert.equal(result.site?.current, false); assert.match(deploymentMessage(result), /历史 site/);
});
test('a run title alone can report waiting or failure but never successful deployment', async () => {
  for (const [status, conclusion, expected] of [['queued', null, 'building'], ['completed', 'failure', 'build-failed'], ['completed', 'success', 'unmatched']] as const) {
    const f = fixture(); f.data.set(`/repos/XAN9xXx/site/contents/.site-build.json?ref=${site}`, encoded({}));
    f.data.set(`/repos/XAN9xXx/site/commits?sha=${site}&path=.site-build.json&per_page=10`, []);
    f.data.set('/repos/XAN9xXx/blog/actions/workflows/assemble.yml/runs?event=workflow_dispatch&per_page=50', { workflow_runs: [{ ...run, status, conclusion }] });
    const result = await f.query(); assert.equal(result.state, expected); assert.equal(result.site, null); assert.equal(result.deployment, null);
  }
});
test('errors are redacted and unconfigured querying does not perform requests', async () => {
  const result = await readDeployment(content, { github: async () => { throw new Error('PRIVATE_TOKEN_SENTINEL'); } });
  assert.equal(result.state, 'unavailable'); assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
  const f = fixture(); f.sources.cloudflare!.get = async () => { throw new Error('PRIVATE_TOKEN_SENTINEL'); };
  const pages = await f.query(); assert.equal(pages.state, 'unavailable'); assert.ok(!JSON.stringify(pages).includes('PRIVATE_TOKEN'));
  assert.equal((await new DeploymentReader().query(content)).state, 'unconfigured');
  await assert.rejects(new DeploymentReader().query('main'));
});
test('concurrent and repeated queries share a bounded cache', async () => {
  const f = fixture(); const reader = new DeploymentReader(f.sources); const values = await Promise.all([reader.query(content), reader.query(content)]);
  assert.deepEqual(values[0], values[1]); const count = f.calls.length; await reader.query(content); assert.equal(f.calls.length, count);
});
test('HTTP adapter sends only GET to GitHub, refuses redirects and limits response size', async () => {
  let seen = 0;
  const transport = (async (url: string | URL | Request, options?: RequestInit) => {seen++;assert.equal(url, 'https://api.github.com/repos/XAN9xXx/site');assert.equal(options?.method,'GET');assert.equal(options?.redirect,'error');return new Response('{"private":true}');}) as typeof fetch;
  const get = githubLookup('TEST_ONLY', transport);assert.deepEqual(await get('/repos/XAN9xXx/site'), { private:true });
  await assert.rejects(get('https://evil.example'));assert.equal(seen,1);
  const big=githubLookup('TEST_ONLY',async()=>new Response('x'.repeat(2*1024*1024+1)));await assert.rejects(big('/repos/XAN9xXx/site'),/too large/);
  const denied=githubLookup('TEST_ONLY',async()=>new Response('SECRET',{status:403}));await assert.rejects(denied('/repos/XAN9xXx/site'),/read unavailable/);
});
test('Pages adapter reads only the fixed project with GET, no redirects, bounded size and a successful envelope', async () => {
  const token = 'T'.repeat(40), urls: string[] = [];
  const transport = (async (url: string | URL | Request, options?: RequestInit) => {
    urls.push(String(url)); assert.equal(options?.method, 'GET'); assert.equal(options?.redirect, 'error'); assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${token}`);
    return Response.json({ success: true, errors: [], result: { name: 'site' } });
  }) as typeof fetch;
  const pages = cloudflareLookup({ accountId: account, token }, transport);
  assert.deepEqual(await pages.get(''), { name: 'site' }); await pages.get(listing);
  assert.deepEqual(urls, [`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/site`, `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/site${listing}`]);
  for (const path of ['/../other', '/deployments/../../other', 'https://evil.example', '/domains', '?x=1']) await assert.rejects(pages.get(path), /Invalid query target/);
  assert.equal(urls.length, 2);
  await assert.rejects(cloudflareLookup({ accountId: account, token }, async () => Response.json({ success: false, errors: [{ message: 'SECRET' }] })).get(''));
  await assert.rejects(cloudflareLookup({ accountId: account, token }, async () => new Response('SECRET', { status: 403 })).get(''), /read unavailable/);
  await assert.rejects(cloudflareLookup({ accountId: account, token }, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))).get(''), /too large/);
  for (const credential of [{ accountId: 'F'.repeat(32), token }, { accountId: account, token: 'has space ' + token }, { accountId: account, token: 'short' }]) assert.throws(() => cloudflareLookup(credential));
});
