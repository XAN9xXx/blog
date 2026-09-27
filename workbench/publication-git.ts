import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { statSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { assertRealPath } from './store';
import { WorkbenchError } from './model';
import { MAX_PLAN_BYTES, type PublicationBaseline } from './publication-plan';

/** Read immutable local Git objects only: no fetch, checkout, index writes or hooks. */
export function readPublicationBaseline(repository: string, commit: string): PublicationBaseline {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new WorkbenchError('基线必须是完整的 40 位小写 Git commit SHA，不接受分支名或表达式。');
  const root = path.resolve(repository); assertRealPath(root);
  if (!statSync(root).isDirectory()) throw new WorkbenchError('内容仓库必须是本地工作副本目录。');
  const env = { ...process.env };
  // Do not let inherited repository overrides redirect inspection to another checkout.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  const git = (...args: string[]) => {
    try { return execFileSync('git', ['--no-replace-objects', '--no-lazy-fetch', '-c', 'core.fsmonitor=false', '-C', root, ...args], { env, maxBuffer: MAX_PLAN_BYTES, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new WorkbenchError('无法读取本地 Git 基线；请核对仓库路径、提交是否存在及对象完整性。'); }
  };
  const actualRoot = git('rev-parse', '--show-toplevel').toString('utf8').trim();
  if (path.resolve(actualRoot) !== root) throw new WorkbenchError('请传入内容仓库根目录，而不是其子目录。');
  if (git('cat-file', '-t', commit).toString('utf8').trim() !== 'commit') throw new WorkbenchError('指定 SHA 不是 commit 对象。');
  const headCommit = git('rev-parse', '--verify', 'HEAD').toString('utf8').trim();
  if (headCommit !== commit) throw new WorkbenchError('本地仓库 HEAD 已偏离指定基线，需要重新核对。', 409);
  const listing = git('ls-tree', '-r', '-z', '--full-tree', commit);
  if (!isUtf8(listing)) throw new WorkbenchError('Git 路径必须是有效 UTF-8。');
  const entries = listing.toString('utf8').split('\0').filter(Boolean);
  if (entries.length > 10_000) throw new WorkbenchError('离线计划暂不接受超过 10000 个文件的仓库。');
  const files: Record<string, string> = {}; let total = 0; let preservedFileCount = 0;
  for (const entry of entries) {
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new WorkbenchError('无法解析 Git 文件清单。');
    const mode = match[1]!; const type = match[2]!; const oid = match[3]!; const name = match[4]!;
    const inArticles = name === 'articles' || name.startsWith('articles/');
    if ((inArticles || name === 'topology.json') && (type !== 'blob' || !['100644', '100755'].includes(mode))) throw new WorkbenchError('内容基线不接受符号链接或子模块。');
    const managed = name === 'topology.json' || name.startsWith('articles/') && name.endsWith('.md');
    if (!managed) { preservedFileCount++; continue; }
    if (Object.keys(files).length >= 1001) throw new WorkbenchError('离线计划最多接受 1000 篇文章。');
    const size = Number(git('cat-file', '-s', oid).toString('utf8').trim());
    if (!Number.isSafeInteger(size) || size < 0 || total + size > MAX_PLAN_BYTES) throw new WorkbenchError('离线计划基线超过 16 MiB 限制。');
    const bytes = git('cat-file', 'blob', oid); total += size;
    if (bytes.length !== size || !isUtf8(bytes)) throw new WorkbenchError('内容文件大小不一致或不是有效 UTF-8。');
    files[name] = bytes.toString('utf8');
  }
  // Detect a branch changing while the individual immutable objects were read.
  if (git('rev-parse', '--verify', 'HEAD').toString('utf8').trim() !== headCommit) throw new WorkbenchError('读取期间本地 HEAD 已变化，请重试。', 409);
  return { commit, headCommit, files, preservedFileCount };
}
