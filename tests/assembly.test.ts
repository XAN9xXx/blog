import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const blog = fileURLToPath(new URL('../', import.meta.url));
function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'xan9x-assembly-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const content = path.join(root, 'content');
  cpSync(path.join(blog, 'tests/fixtures/content'), content, { recursive: true });
  // Assembly records content provenance, so the frozen fixture becomes its own one-commit repository.
  const git = (...args: string[]) => execFileSync('git', ['-C', content, ...args], { stdio: 'ignore' });
  git('init', '--initial-branch=main'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const site = path.join(root, 'site');
  const run = (target = site, extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/assemble.ts'], {
    cwd: blog, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', BLOG_CONTENT_SOURCE: content, SITE_DIR: target, ...extra },
  });
  return { root, content, site, run };
}
test('isolated assembly includes pinned archive, excludes drafts and credentials, and rebuilds', t => {
  const f = setup(t);
  writeFileSync(path.join(f.content, 'articles/secret.md'), '---\nid: secret\ntitle: PRIVATE_TITLE_SENTINEL\ndescription: secret\npubDate: 2026-09-26\ndraft: true\n---\nPRIVATE_BODY_SENTINEL');
  writeFileSync(path.join(f.content, '.env'), 'PRIVATE_TOKEN_SENTINEL');
  const graphFile = path.join(f.content, 'topology.json');
  const graph = JSON.parse(readFileSync(graphFile, 'utf8'));
  graph.document.root.children.push({ id: 'secret-node', type: 'article', label: 'PRIVATE_NODE_SENTINEL' });
  graph.articleRefs['secret-node'] = 'secret'; graph.document.relations.push(['software', 'secret-node']);
  writeFileSync(graphFile, JSON.stringify(graph));
  const result = f.run(); assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(existsSync(path.join(f.site, '.topology-package/topology.tgz')));
  assert.ok(existsSync(path.join(f.site, 'content/articles/hello.md')));
  assert.ok(!existsSync(path.join(f.site, 'content/articles/secret.md')));
  assert.ok(!existsSync(path.join(f.site, 'content/.env')));
  assert.ok(!existsSync(path.join(f.site, 'content/.git')));
  assert.ok(!existsSync(path.join(f.site, 'workbench')));
  assert.ok(!existsSync(path.join(f.site, 'tests/workbench-store.test.ts')));
  assert.ok(!existsSync(path.join(f.site, 'tests/workbench-publication-plan.test.ts')));
  assert.ok(!existsSync(path.join(f.site, 'tests/workbench-publication-git.test.ts')));
  assert.ok(!existsSync(path.join(f.site, 'tests/workbench-publication-review.test.ts')));
  assert.ok(!existsSync(path.join(f.site, 'tests/workbench-publication-executor.test.ts')));
  assert.ok(!existsSync(path.join(f.site, 'tests/workbench-publisher.test.ts')));
  assert.ok(!existsSync(path.join(f.site, 'tests/workbench-publication-flow.test.ts')));
  assert.ok(!existsSync(path.join(f.site, '.workbench')));
  assert.ok(!readFileSync(path.join(f.site, 'content/topology.json'), 'utf8').includes('secret'));
  assert.ok(!readFileSync(path.join(f.site, '.gitignore'), 'utf8').includes('\n.topology-package/\n'));
  assert.equal(f.run().status, 0);
});
test('invalid content fails before touching an existing target', t => {
  const f = setup(t); mkdirSync(f.site); writeFileSync(path.join(f.site, '.site-build.json'), JSON.stringify({ blog: { commit: 'old' }, content: { commit: 'old' } }));
  writeFileSync(path.join(f.site, 'keep.txt'), 'keep'); writeFileSync(path.join(f.content, 'topology.json'), '{}');
  assert.notEqual(f.run().status, 0); assert.equal(readFileSync(path.join(f.site, 'keep.txt'), 'utf8'), 'keep');
});
test('refuses nonempty unrecognized destinations', t => {
  const f = setup(t); mkdirSync(f.site); writeFileSync(path.join(f.site, 'keep.txt'), 'keep');
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /nonempty directory/);
  assert.equal(readFileSync(path.join(f.site, 'keep.txt'), 'utf8'), 'keep');
});
test('refuses source overlap and source aliases before deletion', t => {
  const f = setup(t);
  for (const target of [f.content, path.join(f.content, 'nested'), f.root, blog]) {
    const result = f.run(target); assert.notEqual(result.status, 0); assert.match(result.stderr, /overlap a source/);
  }
  if (process.platform !== 'win32') {
    const alias = path.join(f.root, 'alias'); symlinkSync(f.content, alias);
    assert.match(f.run(alias).stderr, /overlap a source/);
  }
});
test('duplicate article IDs cannot be silently overwritten by Astro', t => {
  const f = setup(t); cpSync(path.join(f.content, 'articles/hello.md'), path.join(f.content, 'articles/duplicate.md'));
  assert.match(f.run().stderr, /Duplicate article ID/); assert.ok(!existsSync(f.site));
});
test('rejects asset symlinks before touching target', { skip: process.platform === 'win32' }, t => {
  const f = setup(t); symlinkSync(path.join(f.content, 'articles/hello.md'), path.join(f.content, 'assets/link.md'));
  assert.match(f.run().stderr, /Symlinks are not copied/); assert.ok(!existsSync(f.site));
});

test('executable frontmatter languages are rejected before parsing', t => {
  const f = setup(t);
  writeFileSync(path.join(f.content, 'articles/evil.md'), '---javascript\n({ id: "evil" })\n---\ntext');
  assert.match(f.run().stderr, /require fenced YAML/); assert.ok(!existsSync(f.site));
});
test('missing content inputs are hard failures, not an empty successful site', t => {
  const f = setup(t); rmSync(path.join(f.content, 'topology.json'));
  assert.notEqual(f.run().status, 0); assert.ok(!existsSync(f.site));
});

test('invalid music fails before replacing target; a valid playlist travels with content', t => {
  const f = setup(t); mkdirSync(f.site); writeFileSync(path.join(f.site, '.site-build.json'), JSON.stringify({ blog: { commit: 'old' }, content: { commit: 'old' } }));
  writeFileSync(path.join(f.site, 'keep.txt'), 'keep');
  const manifest = path.join(f.content, 'music/playlist.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, tracks: [{ id: 'test', title: 'Test only', file: 'fixture.wav' }] }));
  assert.match(f.run().stderr, /Missing music file/); assert.equal(readFileSync(path.join(f.site, 'keep.txt'), 'utf8'), 'keep');
  writeFileSync(path.join(f.content, 'music/fixture.wav'), 'test bytes');
  assert.equal(f.run().status, 0);
  assert.ok(existsSync(path.join(f.site, 'content/music/playlist.json')));
  assert.equal(readFileSync(path.join(f.site, 'content/music/fixture.wav'), 'utf8'), 'test bytes');
});

test('CI content mismatch fails before replacing a generated target', t => {
  const f = setup(t); mkdirSync(f.site);
  writeFileSync(path.join(f.site, '.site-build.json'), JSON.stringify({ blog: { commit: 'old' }, content: { commit: 'old' } }));
  writeFileSync(path.join(f.site, 'keep.txt'), 'keep');
  const result = f.run(f.site, { ASSEMBLY_CONTENT_COMMIT: '0'.repeat(40), ASSEMBLY_REPOSITORY: 'XAN9xXx/blog', ASSEMBLY_RUN_ID: '123', ASSEMBLY_RUN_ATTEMPT: '1' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /exact pinned content commit/);
  assert.equal(readFileSync(path.join(f.site, 'keep.txt'), 'utf8'), 'keep');
});
