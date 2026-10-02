import { generateKeyPairSync, sign } from 'node:crypto';
import type { AccessConfig } from '../workbench/access';

// Test-only Cloudflare Access issuer: freshly generated keys, a fake team domain and AUD tag.
export const accessConfigForTests: AccessConfig = { teamDomain: 'test-team.cloudflareaccess.com', audience: 'a'.repeat(64), emails: ['owner@example.test'] };
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function accessFixture(now = () => Date.now()) {
  const pairs = new Map<string, { publicKey: object; privateKey: string }>();
  const addKey = (kid: string) => pairs.set(kid, generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { format: 'jwk' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }));
  addKey('key-1');
  let published = ['key-1']; let failing = false; const requests: string[] = [];
  const fetchKeys = async (url: string) => {
    requests.push(url);
    if (failing) throw new Error('offline');
    return { ok: true, json: async () => ({ keys: published.map(kid => ({ ...pairs.get(kid)!.publicKey, kid, alg: 'RS256', use: 'sig' })) }) };
  };
  const token = (claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => {
    const kid = (header.kid as string | undefined) ?? 'key-1';
    const seconds = Math.floor(now() / 1000);
    const head = part({ alg: 'RS256', kid, typ: 'JWT', ...header });
    const body = part({ iss: 'https://' + accessConfigForTests.teamDomain, aud: [accessConfigForTests.audience], type: 'app',
      email: 'owner@example.test', iat: seconds, nbf: seconds, exp: seconds + 3600, sub: 'user-id', ...claims });
    const key = pairs.get(kid)?.privateKey ?? pairs.get('key-1')!.privateKey;
    return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
  };
  return {
    token, fetchKeys, requests,
    rotate(kid: string) { addKey(kid); published = [...published, kid]; },
    setFailing(value: boolean) { failing = value; },
  };
}
