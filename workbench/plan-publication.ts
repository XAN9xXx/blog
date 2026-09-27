import { isUtf8 } from 'node:buffer';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbenchError } from './model';
import { assertRealPath } from './store';
import { createPublicationPlan, publicationPlanSummary, MAX_PLAN_BYTES, type RepositoryVisibility } from './publication-plan';
import { readPublicationBaseline } from './publication-git';

const usage = `只读离线发布计划（不联网、不写工作区、不提交、不推送）
用法：npm run workbench:plan -- --snapshot <私有快照.json> --content-repo <本地内容仓库> --base-commit <完整40位SHA> [--visibility private|public|unknown]
必须先核实导入基线。仓库和所有镜像的可见性默认为 unknown；private 只是操作者声明，不代表已查询远端。
输出仅含摘要，不含 Markdown 正文，但草稿标题、文件名和目录信息仍属于私有数据。\n`;
export function runPublicationPlan(args: string[]): string {
  if (args.length === 1 && args[0] === '--help') return usage;
  const flags = new Map<string, string>(); const allowed = new Set(['--snapshot', '--content-repo', '--base-commit', '--visibility']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (!allowed.has(key) || flags.has(key) || !value || value.startsWith('--')) throw new WorkbenchError('参数无效、重复或缺少值。使用 --help 查看用法。');
    flags.set(key, value);
  }
  if (!flags.has('--snapshot') || !flags.has('--content-repo') || !flags.has('--base-commit')) throw new WorkbenchError('必须指定快照、本地内容仓库和完整基线 SHA。');
  const visibility = flags.get('--visibility') ?? 'unknown';
  if (!['private', 'public', 'unknown'].includes(visibility)) throw new WorkbenchError('可见性必须为 private、public 或 unknown。');
  const file = path.resolve(flags.get('--snapshot')!); assertRealPath(file);
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > MAX_PLAN_BYTES) throw new WorkbenchError('快照必须是最多 16 MiB 的普通文件。');
  const raw = readFileSync(file);
  if (raw.length > MAX_PLAN_BYTES || !isUtf8(raw)) throw new WorkbenchError('快照过大或不是有效 UTF-8。');
  const snapshot: unknown = JSON.parse(raw.toString('utf8'));
  const baseline = readPublicationBaseline(flags.get('--content-repo')!, flags.get('--base-commit')!);
  const plan = createPublicationPlan(snapshot, baseline, { visibility: visibility as RepositoryVisibility });
  return JSON.stringify(publicationPlanSummary(plan), null, 2) + '\n';
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(runPublicationPlan(process.argv.slice(2))); }
  catch (error) {
    const message = error instanceof WorkbenchError ? error.message : error instanceof SyntaxError ? '快照或基线 JSON 无效。' : '读取或校验失败；请核对本地文件、内容契约和文件权限。';
    process.stderr.write('无法生成发布计划：' + message + '\n'); process.exitCode = 1;
  }
}
