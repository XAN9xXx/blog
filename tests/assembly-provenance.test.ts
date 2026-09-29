import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { assemblyRun, resolveContentCommit } from '../scripts/assembly-provenance';
const commit = 'a'.repeat(40);
const clean = { blog: { dirty: false }, content: { commit, dirty: false } };
const env = { ASSEMBLY_CONTENT_COMMIT: commit, ASSEMBLY_REPOSITORY: 'XAN9xXx/blog', ASSEMBLY_RUN_ID: '123', ASSEMBLY_RUN_ATTEMPT: '2' };

test('content input accepts only immutable SHAs and never looks up main for explicit input', async () => {
  const forbidden = async () => { throw new Error('unexpected lookup'); };
  assert.equal(await resolveContentCommit(commit, forbidden), commit);
  for (const value of ['main', 'abc123', 'A'.repeat(40), commit + '\n', '$(touch anything)']) await assert.rejects(resolveContentCommit(value, forbidden), /full lowercase/);
});
test('missing content input resolves main once and validates the API result', async () => {
  let calls = 0;
  assert.equal(await resolveContentCommit('', async () => { calls++; return { object: { type: 'commit', sha: commit } }; }), commit);
  assert.equal(calls, 1);
  for (const value of [null, {}, { object: { type: 'tag', sha: commit } }, { object: { type: 'commit', sha: 'main' } }]) await assert.rejects(resolveContentCommit('', async () => value));
  await assert.rejects(resolveContentCommit('', async () => { throw new Error('unavailable'); }), /unavailable/);
});
test('assembly run metadata is optional locally and strict in CI', () => {
  assert.equal(assemblyRun({}, clean), undefined);
  assert.deepEqual(assemblyRun(env, clean), { repository: 'XAN9xXx/blog', runId: '123', runAttempt: '2', url: 'https://github.com/XAN9xXx/blog/actions/runs/123/attempts/2' });
  for (const changed of [{ ASSEMBLY_RUN_ID: '123' }, { ...env, ASSEMBLY_RUN_ATTEMPT: '' }, { ...env, ASSEMBLY_RUN_ID: '../bad' }, { ...env, ASSEMBLY_REPOSITORY: 'someone/else' }, { ...env, ASSEMBLY_CONTENT_COMMIT: 'b'.repeat(40) }]) assert.throws(() => assemblyRun(changed, clean));
  assert.throws(() => assemblyRun(env, { ...clean, blog: { dirty: true } }), /clean sources/);
  assert.throws(() => assemblyRun(env, { ...clean, content: { commit, dirty: true } }), /clean sources/);
});
test('resolver runs with native Node TypeScript before npm install and emits safe output', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'assembly-input-'));t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'output');
  const result = spawnSync(process.execPath, ['scripts/assembly-provenance.ts'], { cwd: new URL('../', import.meta.url), encoding: 'utf8', env: { ...process.env, REQUESTED_CONTENT_COMMIT: commit, CONTENT_READ_TOKEN: '', GITHUB_OUTPUT: output } });
  assert.equal(result.status, 0, result.stderr);assert.equal(readFileSync(output, 'utf8'), `commit=${commit}\n`);
});
test('workflow pins the resolved content and passes provenance only to the assembly step', () => {
  const yaml = createRequire(import.meta.url)('js-yaml');
  const workflow = yaml.load(readFileSync(new URL('../.github/workflows/assemble.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.on.workflow_dispatch.inputs.content_commit.type, 'string');
  const steps = workflow.jobs.assemble.steps;
  const resolve = steps.find((s: any) => s.id === 'content');
  assert.equal(resolve.env.REQUESTED_CONTENT_COMMIT, '${{ inputs.content_commit }}');
  const checkout = steps.find((s: any) => s.name === 'Checkout Blog-Content');
  assert.equal(checkout.with.ref, '${{ steps.content.outputs.commit }}');assert.equal(checkout.with['persist-credentials'], false);
  const assemble = steps.find((s: any) => s.name === 'Assemble Site');
  assert.equal(assemble.env.ASSEMBLY_CONTENT_COMMIT, checkout.with.ref);
  assert.equal(assemble.env.ASSEMBLY_RUN_ID, '${{ github.run_id }}');
  assert.equal(assemble.env.ASSEMBLY_RUN_ATTEMPT, '${{ github.run_attempt }}');
  assert.ok(steps.findIndex((s: any) => s.name === 'Setup Node.js') < steps.indexOf(resolve));
  assert.ok(steps.findIndex((s: any) => s.name === 'Build generated Site') < steps.findIndex((s: any) => s.id === 'site'));
});
