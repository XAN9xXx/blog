import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContentCatalog } from '../src/lib/content-files';
import { publicAuthoringSource } from '../src/lib/topology-content';

const blogDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = path.resolve(process.env.BLOG_CONTENT_SOURCE ?? path.join(blogDir, '../xan9x-blog-content'));
const siteDir = path.resolve(process.env.SITE_DIR ?? path.join(blogDir, '../xan9x-site'));
const archive = path.join(blogDir, '.topology-package/topology.tgz');
const excludedBlogEntries = new Set(['.git', '.github', '.astro', 'dist', 'node_modules', 'docs',
  '.topology-package', 'test-results', 'playwright-report']);
const assetDirectories = ['assets', 'music', 'topics', 'projects'];

function runGit(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
}
function provenance(repository: string) {
  if (runGit(repository, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new Error('Not a Git working tree: ' + repository);
  }
  return { commit: runGit(repository, ['rev-parse', 'HEAD']), dirty: runGit(repository, ['status', '--porcelain']).length > 0 };
}
function canonical(target: string): string {
  if (existsSync(target)) return realpathSync(target);
  return path.join(canonical(path.dirname(target)), path.basename(target));
}
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function checkDestination(): void {
  // Resolve parent symlinks as well as lexical paths before any recursive deletion.
  const target = canonical(siteDir);
  for (const source of [blogDir, contentDir, path.resolve(process.env.TOPOLOGY_SOURCE_DIR ?? path.join(blogDir, '../xan9x-blog-topology'))]) {
    const resolved = canonical(source);
    if (contains(resolved, target) || contains(target, resolved)) {
      throw new Error('Site must not overlap a source directory: ' + target);
    }
  }
  if (existsSync(siteDir)) {
    if (lstatSync(siteDir).isSymbolicLink() || !lstatSync(siteDir).isDirectory()) throw new Error('Site must be a real directory.');
    const entries = readdirSync(siteDir).filter(entry => entry !== '.git');
    if (entries.length && !existsSync(path.join(siteDir, '.site-build.json'))) {
      throw new Error('Refusing to replace a nonempty directory without .site-build.json: ' + siteDir);
    }
    if (entries.length) {
      const marker = JSON.parse(readFileSync(path.join(siteDir, '.site-build.json'), 'utf8'));
      if (typeof marker.blog?.commit !== 'string' || typeof marker.content?.commit !== 'string') {
        throw new Error('Invalid generated-site provenance marker.');
      }
    }
  }
}
function assertNoSymlinks(directory: string): void {
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Symlinks are not copied: ' + directory);
  if (lstatSync(directory).isDirectory()) {
    for (const name of readdirSync(directory)) {
      if (!name.startsWith('.')) assertNoSymlinks(path.join(directory, name));
    }
  }
}

function assemble(): void {
  console.log('Running preflight checks...');
  checkDestination();
  const sources = { blog: provenance(blogDir), content: provenance(contentDir) };
  const catalog = loadContentCatalog(contentDir); // Includes drafts: broken references must fail too.
  for (const name of assetDirectories) {
    const directory = path.join(contentDir, name);
    if (existsSync(directory)) assertNoSymlinks(directory);
  }
  if (lstatSync(archive).isSymbolicLink()) throw new Error('Topology archive must not be a symlink.');
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64');
  const lock = JSON.parse(readFileSync(path.join(blogDir, 'package-lock.json'), 'utf8'));
  if (integrity !== lock.packages?.['node_modules/@xan9x/topology']?.integrity) {
    throw new Error('Topology archive does not match package-lock.json.');
  }
  const topologySource = JSON.parse(readFileSync(path.join(blogDir, 'topology-source.json'), 'utf8'));
  const build = { ...sources, topology: { ...topologySource, integrity } };

  console.log('Preflight passed; assembling ' + siteDir);
  mkdirSync(siteDir, { recursive: true });
  for (const entry of readdirSync(siteDir)) {
    if (entry !== '.git') rmSync(path.join(siteDir, entry), { recursive: true, force: true });
  }
  cpSync(blogDir, siteDir, { recursive: true, filter(source) {
    const relative = path.relative(blogDir, source);
    const first = relative.split(path.sep)[0]!;
    return !relative || (!excludedBlogEntries.has(first) && !first.startsWith('.env'));
  } });
  mkdirSync(path.join(siteDir, '.topology-package'), { recursive: true });
  cpSync(archive, path.join(siteDir, '.topology-package/topology.tgz'));
  const ignore = path.join(siteDir, '.gitignore');
  // The archive is ignored in the engine, but intentionally tracked in generated site.
  writeFileSync(ignore, readFileSync(ignore, 'utf8').replace(/^\.topology-package\/\r?\n/gm, ''));
  const destination = path.join(siteDir, 'content');
  mkdirSync(path.join(destination, 'articles'), { recursive: true });
  for (const article of catalog.articles.filter(article => !article.data.draft)) {
    const output = path.join(destination, article.relativePath);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, article.raw);
  }
  writeFileSync(path.join(destination, 'topology.json'), JSON.stringify(publicAuthoringSource(catalog.topology), null, 2) + '\n');
  for (const name of assetDirectories) {
    const source = path.join(contentDir, name);
    if (existsSync(source)) cpSync(source, path.join(destination, name), { recursive: true,
      filter(file) { return !path.relative(source, file).split(path.sep).some(part => part.startsWith('.')); } });
  }
  writeFileSync(path.join(siteDir, '.site-build.json'), JSON.stringify(build, null, 2) + '\n');
  console.log('Site assembled successfully. Public articles: ' + catalog.articles.filter(a => !a.data.draft).length);
  console.log('Topology: ' + (topologySource.commit ?? 'local/unpublished') + '; ' + integrity);
  if (sources.blog.dirty || sources.content.dirty) console.warn('Source repositories contain uncommitted changes.');
}
assemble();
