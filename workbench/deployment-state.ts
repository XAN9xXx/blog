import { z } from 'zod';
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const deploymentReportSchema = z.strictObject({
  contentCommit: sha, checkedAt: z.iso.datetime(),
  state: z.enum(['unconfigured', 'unavailable', 'waiting-mirror', 'unmatched', 'building', 'build-failed', 'cancelled', 'awaiting-deployment', 'deploying', 'deployment-failed', 'deployment-check-passed']),
  productionVerified: z.literal(false),
  run: z.strictObject({ id, attempt: id, blogCommit: sha }).nullable(),
  site: z.strictObject({ commit: sha, current: z.boolean(), topologyCommit: sha }).nullable(),
  check: z.strictObject({ id, deploymentId: z.uuid(), url: z.url().refine(value => {
    const url = new URL(value); return url.origin === 'https://dash.cloudflare.com' && !url.username && !url.password && url.pathname === '/';
  }) }).nullable(),
});
export type DeploymentReport = z.infer<typeof deploymentReportSchema>;
export function deploymentReport(contentCommit: string, state: DeploymentReport['state'], now = Date.now()): DeploymentReport {
  return deploymentReportSchema.parse({ contentCommit, state, checkedAt: new Date(now).toISOString(), productionVerified: false, run: null, site: null, check: null });
}
export function deploymentMessage(report: DeploymentReport): string {
  const labels: Record<DeploymentReport['state'], string> = {
    unconfigured: '尚未配置 GitHub 只读查询凭据', unavailable: '查询暂不可用：请检查网络、读取权限或返回证据；不会重推',
    'waiting-mirror': 'GitHub 镜像尚未出现此提交', unmatched: '在本次有限查询范围内未找到可核验的构建关联', building: '匹配的组装任务正在等待或构建',
    'build-failed': '匹配的组装任务未通过', cancelled: '匹配的组装任务已取消；不能据此认定由哪个版本取代',
    'awaiting-deployment': '构建产物已核验，尚未发现可核验的 Cloudflare 检查', deploying: '对应 site 提交的 Cloudflare 检查进行中',
    'deployment-failed': '对应 site 提交的 Cloudflare 检查未通过', 'deployment-check-passed': '对应 site 提交的 Cloudflare 检查通过；生产版本尚未核验',
  };
  return labels[report.state] + (report.site?.current === false ? '。这是历史 site 提交的结果，不代表当前线上版本' : '');
}
