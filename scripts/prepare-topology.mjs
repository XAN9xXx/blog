import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const blog = fileURLToPath(new URL('../', import.meta.url));
const updateLock = process.argv.includes('--update-lock');
if (updateLock && process.env.CI) throw new Error('CI cannot update dependency locks.');
const sourceIndex = process.argv.indexOf('--source');
const source = path.resolve(sourceIndex >= 0 ? process.argv[sourceIndex + 1] : path.join(blog, '../xan9x-blog-topology'));
const config = JSON.parse(readFileSync(path.join(blog, 'topology-source.json'), 'utf8'));
if (config.commit !== null) {
  if (!/^[a-f0-9]{40}$/.test(config.commit)) throw new Error('Topology commit must be a full commit SHA.');
  const head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== config.commit) throw new Error('Topology checkout does not match topology-source.json.');
  const dirty = execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) throw new Error('Commit topology changes before preparing a pinned package.');
} else {
  if (process.env.CI) throw new Error('Set topology-source.json commit after the first approved topology push.');
  console.warn('Local bootstrap: topology has not been committed/pushed; CI remains gated.');
}
const temporary = mkdtempSync(path.join(tmpdir(), 'xan9x-topology-pack-'));
try {
  const npm = process.env.npm_execpath;
  const result = npm
    ? execFileSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', temporary], { cwd: source, encoding: 'utf8' })
    : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--json', '--pack-destination', temporary], { cwd: source, encoding: 'utf8' });
  const pack = JSON.parse(result)[0];
  if (pack.name !== '@xan9x/topology') throw new Error('Unexpected topology package name.');
  const archive = path.join(temporary, pack.filename);
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64');
  const lockPath = path.join(blog, 'package-lock.json');
  const expected = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')).packages?.['node_modules/@xan9x/topology']?.integrity : undefined;
  if (expected && integrity !== expected && !updateLock) {
    throw new Error('Topology package differs from package-lock.json. Update the dependency lock explicitly before building.');
  }
  mkdirSync(path.join(blog, '.topology-package'), { recursive: true });
  copyFileSync(archive, path.join(blog, '.topology-package/topology.tgz'));
  if (updateLock) {
    const command = ['install', '@xan9x/topology@file:.topology-package/topology.tgz', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'];
    if (npm) execFileSync(process.execPath, [npm, ...command], { cwd: blog, stdio: 'inherit' });
    else execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', command, { cwd: blog, stdio: 'inherit' });
    const updated = JSON.parse(readFileSync(lockPath, 'utf8')).packages?.['node_modules/@xan9x/topology']?.integrity;
    if (updated !== integrity) throw new Error('Dependency lock did not refresh to the new topology archive.');
  }
  console.log('Prepared @xan9x/topology ' + pack.version + ' (' + integrity + ')');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
