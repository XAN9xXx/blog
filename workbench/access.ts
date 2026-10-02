import { createPublicKey, verify, type JsonWebKeyInput, type KeyObject } from 'node:crypto';
import { WorkbenchError } from './model';

/** Cloudflare Access in front of a public hostname; the workbench re-checks every request's signed assertion. */
export type AccessConfig = { teamDomain: string; audience: string; emails: string[] };
type FetchKeys = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function accessConfig(env: Record<string, string | undefined>): AccessConfig {
  const teamDomain = env.WORKBENCH_ACCESS_TEAM_DOMAIN ?? '';
  const audience = env.WORKBENCH_ACCESS_AUD ?? '';
  const emails = (env.WORKBENCH_ACCESS_EMAILS ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) throw new Error('WORKBENCH_ACCESS_TEAM_DOMAIN 必须是 <team>.cloudflareaccess.com。');
  if (!/^[a-f0-9]{64}$/.test(audience)) throw new Error('WORKBENCH_ACCESS_AUD 必须是 Access 应用的 64 位 AUD 标签。');
  if (!emails.length || emails.some(email => !/^[^\s@,]+@[^\s@,]+$/.test(email))) throw new Error('WORKBENCH_ACCESS_EMAILS 必须列出允许的邮箱，用逗号分隔。');
  return { teamDomain, audience, emails };
}

const denied = () => new WorkbenchError('需要经 Cloudflare Access 登录后访问。', 403);
const unavailable = () => new WorkbenchError('暂时无法获取 Cloudflare Access 公钥，请稍后重试。', 503);
const decode = (part: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw denied();
};

export class AccessVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = -Infinity;
  private refreshing?: Promise<void>;
  constructor(private config: AccessConfig,
    private fetchKeys: FetchKeys = url => fetch(url, { signal: AbortSignal.timeout(5_000) }),
    private clock = () => Date.now()) {}

  /** Resolves to the verified email; rejects with 403, or 503 when the signing keys cannot be obtained. */
  async verify(token: unknown) {
    if (typeof token !== 'string' || token.length > 8192) throw denied();
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw denied();
    const header = decode(parts[0]!);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw denied();
    const key = await this.key(header.kid);
    if (!verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2]!, 'base64url'))) throw denied();
    const claims = decode(parts[1]!); const now = this.clock() / 1000; const skew = 60;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== 'https://' + this.config.teamDomain || !audience.includes(this.config.audience) || claims.type !== 'app') throw denied();
    if (typeof claims.exp !== 'number' || claims.exp + skew <= now) throw denied();
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - skew > now)) throw denied();
    if (typeof claims.email !== 'string' || !this.config.emails.includes(claims.email.toLowerCase())) throw denied();
    return claims.email.toLowerCase();
  }

  private async key(kid: string) {
    // Unknown key IDs (rotation) and hourly expiry trigger a refresh, at most one fetch per 30 seconds.
    if (!this.keys.has(kid) || this.clock() - this.fetchedAt > 60 * 60_000) {
      try { await this.refresh(); } catch (error) { if (!this.keys.has(kid)) throw error; }
    }
    const key = this.keys.get(kid); if (!key) throw denied(); return key;
  }
  private refresh() {
    if (this.refreshing) return this.refreshing;
    if (this.clock() - this.fetchedAt < 30_000) return this.keys.size ? Promise.resolve() : Promise.reject(unavailable());
    this.fetchedAt = this.clock();
    this.refreshing = (async () => {
      let body: unknown;
      try {
        const response = await this.fetchKeys(`https://${this.config.teamDomain}/cdn-cgi/access/certs`);
        if (!response.ok) throw unavailable(); body = await response.json();
      } catch { throw unavailable(); }
      const list = (body as { keys?: unknown })?.keys;
      if (!Array.isArray(list)) throw unavailable();
      const keys = new Map<string, KeyObject>();
      for (const jwk of list as (JsonWebKeyInput['key'] & { kid?: unknown })[]) {
        if (typeof jwk?.kid !== 'string' || jwk.kty !== 'RSA') continue;
        try { keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' })); } catch {}
      }
      if (!keys.size) throw unavailable();
      this.keys = keys;
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
}
