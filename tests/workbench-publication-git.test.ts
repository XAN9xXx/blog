import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../workbench/store';
import { readPublicationBaseline } from '../workbench/publication-git';
import { createPublicationPlan } from '../workbench/publication-plan';
import { runPublicationPlan } from '../workbench/plan-publication';

function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'publication-git-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = path.join(root, 'content'); mkdirSync(path.join(repository, 'articles/a'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=' + devNull, '-c', 'commit.gpgSign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('-c', 'init.templateDir=', 'init', '--initial-branch=main');
  for (const [file, id] of [['a.md', 'flat'], ['a/b.md', 'nested'], ['hello.md', 'hello']]) writeFileSync(path.join(repository, 'articles', file!), `---\nid: ${id}\ntitle: ${id}\ndescription: ''\npubDate: 2026-09-27\ndraft: false\n---\nPRIVATE_BODY_SENTINEL ${id}\n`);
  writeFileSync(path.join(repository, 'topology.json'), JSON.stringify({ document: { version: 1, root: { id: 'root', type: 'root', label: 'Root', children: [] }, relations: [] }, articleRefs: {} }) + '\n');
  writeFileSync(path.join(repository, 'music.mp3'), 'unchanged audio');
  mkdirSync(path.join(repository, '.github/workflows'), { recursive: true }); writeFileSync(path.join(repository, '.github/workflows/trigger.yml'), '# preserved');
  git('add', '.'); git('commit', '-m', 'initial fixture'); const commit = git('rev-parse', 'HEAD');
  const store = new WorkspaceStore(repository, path.join(root, 'private'));
  const snapshotPath = path.join(root, 'snapshot.json'); writeFileSync(snapshotPath, JSON.stringify(store.get()));
  return { root, repository, git, commit, store, snapshotPath };
}
function fingerprint(root: string) {
  const entries: [string, string][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name); const stat = lstatSync(file);
      if (stat.isSymbolicLink()) entries.push([path.relative(root, file), 'link:' + readlinkSync(file)]);
      else if (stat.isDirectory()) walk(file);
      else entries.push([path.relative(root, file), createHash('sha256').update(readFileSync(file)).digest('hex')]);
    }
  }; walk(root); return JSON.stringify(entries);
}
function args(f: ReturnType<typeof setup>) { return ['--snapshot', f.snapshotPath, '--content-repo', f.repository, '--base-commit', f.commit]; }

test('Git baseline and CLI preserve the entire fixture, match store traversal and omit raw Markdown', t => {
  const f = setup(t); const before = fingerprint(f.root);
  const baseline = readPublicationBaseline(f.repository, f.commit);
  assert.equal(baseline.preservedFileCount, 2);
  const plan = createPublicationPlan(f.store.get(), baseline);
  assert.equal(plan.noChanges, true); assert.equal(plan.canPublish, false);
  assert.equal(plan.checks.importCommitProvenanceVerified, false);
  assert.deepEqual(plan.snapshot.workspace.articles.map(file => file.path), ['articles/a/b.md', 'articles/a.md', 'articles/hello.md']);
  const output = runPublicationPlan(args(f)); const summary = JSON.parse(output);
  assert.equal(summary.noChanges, true); assert.equal(summary.checks.visibilityDeclaration, 'unknown');
  assert.doesNotMatch(output, /PRIVATE_BODY_SENTINEL/); assert.equal('snapshot' in summary, false);
  assert.equal(fingerprint(f.root), before);
});
test('committed objects are inspected instead of dirty working-tree Markdown and config', t => {
  const f = setup(t);
  writeFileSync(path.join(f.repository, 'articles/hello.md'), 'not even valid frontmatter');
  writeFileSync(path.join(f.repository, '.github/workflows/trigger.yml'), '# local unfinished work');
  const before = fingerprint(f.root);
  const result = JSON.parse(runPublicationPlan([...args(f), '--visibility', 'private']));
  assert.equal(result.noChanges, true); assert.equal(result.checks.workingTreeUsed, false);
  assert.equal(fingerprint(f.root), before);
});
test('branch advancement, invalid commit expressions, repository subpaths and missing objects are rejected', t => {
  const f = setup(t);
  assert.throws(() => readPublicationBaseline(f.repository, 'main'), /40 位/);
  assert.throws(() => readPublicationBaseline(f.repository, 'HEAD^{commit}'), /40 位/);
  assert.throws(() => readPublicationBaseline(path.join(f.repository, 'articles'), f.commit), /根目录/);
  assert.throws(() => readPublicationBaseline(f.repository, '0'.repeat(40)), /无法读取/);
  writeFileSync(path.join(f.repository, 'music.mp3'), 'next version'); f.git('add', '.'); f.git('commit', '-m', 'advanced');
  assert.throws(() => readPublicationBaseline(f.repository, f.commit), /HEAD/);
});
test('inherited GIT_DIR does not redirect inspection and replacement objects are ignored', t => {
  const f = setup(t); const old = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(f.root, 'nonexistent');
  try { assert.equal(readPublicationBaseline(f.repository, f.commit).commit, f.commit); }
  finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
  writeFileSync(path.join(f.repository, 'articles/hello.md'), 'hostile replacement'); f.git('add', '.'); f.git('commit', '-m', 'replacement');
  const replacement = f.git('rev-parse', 'HEAD'); f.git('reset', '--hard', f.commit);
  f.git('replace', f.commit, replacement);
  const baseline = readPublicationBaseline(f.repository, f.commit);
  assert.match(baseline.files['articles/hello.md']!, /PRIVATE_BODY_SENTINEL/);
});
test('tracked symlinks, submodules and invalid UTF-8 inside managed content fail closed', { skip: process.platform === 'win32' }, t => {
  const f = setup(t);
  symlinkSync('../music.mp3', path.join(f.repository, 'articles/link.md')); f.git('add', '.'); f.git('commit', '-m', 'symlink');
  assert.throws(() => readPublicationBaseline(f.repository, f.git('rev-parse', 'HEAD')), /符号链接/);
  f.git('reset', '--hard', f.commit);
  f.git('update-index', '--add', '--cacheinfo', '160000,' + f.commit + ',articles/sub'); f.git('commit', '-m', 'gitlink');
  assert.throws(() => readPublicationBaseline(f.repository, f.git('rev-parse', 'HEAD')), /子模块/);
  f.git('reset', '--hard', f.commit);
  writeFileSync(path.join(f.repository, 'articles/bad.md'), Buffer.from([0xff, 0xfe])); f.git('add', '.'); f.git('commit', '-m', 'invalid utf8');
  assert.throws(() => readPublicationBaseline(f.repository, f.git('rev-parse', 'HEAD')), /UTF-8/);
});
test('CLI rejects duplicate flags, invalid visibility, symlink snapshots and forged import baselines', t => {
  const f = setup(t);
  assert.throws(() => runPublicationPlan([...args(f), '--snapshot', f.snapshotPath]), /重复/);
  assert.throws(() => runPublicationPlan([...args(f), '--visibility', 'yes']), /可见性/);
  assert.throws(() => runPublicationPlan(['--snapshot']), /缺少/);
  assert.match(runPublicationPlan(['--help']), /不提交、不推送/);
  if (process.platform !== 'win32') {
    const alias = path.join(f.root, 'alias.json'); symlinkSync(f.snapshotPath, alias);
    assert.throws(() => runPublicationPlan(['--snapshot', alias, '--content-repo', f.repository, '--base-commit', f.commit]), /符号链接/);
  }
  const snapshot = f.store.get(); snapshot.baseRevision = 'a'.repeat(64); delete (snapshot as Partial<typeof snapshot>).revision;
  writeFileSync(f.snapshotPath, JSON.stringify(snapshot));
  assert.throws(() => runPublicationPlan(args(f)), /导入基线/);
});
test('standalone CLI exits without executing malformed snapshot content or logging raw payloads', t => {
  const f = setup(t); const cli = path.resolve(import.meta.dirname, '../workbench/plan-publication.ts');
  const success = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args(f)], { encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr); assert.equal(JSON.parse(success.stdout).canPublish, false);
  writeFileSync(f.snapshotPath, '{PRIVATE_BODY_SENTINEL');
  const failure = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args(f)], { encoding: 'utf8' });
  assert.equal(failure.status, 1); assert.match(failure.stderr, /JSON 无效/); assert.doesNotMatch(failure.stderr, /PRIVATE_BODY_SENTINEL/);
});


test('missing promisor objects fail without attempting an SSH transport or changing repository files', { skip: process.platform === 'win32' }, t => {
  const f = setup(t); const marker = path.join(f.root, 'transport-attempted'); const spy = path.join(f.root, 'ssh-spy.py');
  writeFileSync(spy, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('attempted')\nraise SystemExit(1)\n`);
  const oid = f.git('rev-parse', 'HEAD:articles/hello.md'); assert.match(oid, /^[a-f0-9]{40}$/);
  f.git('config', 'core.repositoryformatversion', '1'); f.git('config', 'extensions.partialClone', 'origin');
  f.git('config', 'remote.origin.promisor', 'true'); f.git('config', 'remote.origin.url', 'ssh://offline-test.invalid/content');
  f.git('config', 'core.sshCommand', 'python3 ' + spy);
  rmSync(path.join(f.repository, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  // Demonstrate that the fixture would try fetching without the no-lazy-fetch guard.
  assert.throws(() => f.git('cat-file', 'blob', oid)); assert.ok(existsSync(marker)); rmSync(marker);
  const before = fingerprint(f.root);
  assert.throws(() => readPublicationBaseline(f.repository, f.commit), /无法读取/);
  assert.equal(existsSync(marker), false); assert.equal(fingerprint(f.root), before);
});
