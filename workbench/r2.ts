import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';

/**
 * Minimal S3-compatible client for one R2 bucket: HEAD and PUT only. Bucket-scoped R2 tokens work only with
 * the S3 API, which authenticates with AWS Signature Version 4; this signs requests without an SDK.
 */
export const r2CredentialSchema = z.strictObject({
  accountId: z.string().regex(/^[a-f0-9]{32}$/), bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  accessKeyId: z.string().regex(/^[A-Za-z0-9]{16,128}$/), secretAccessKey: z.string().regex(/^[A-Za-z0-9/+=]{16,128}$/),
});
export type R2Credential = z.infer<typeof r2CredentialSchema>;
export interface ImageUploader { head(key: string): Promise<boolean>; put(key: string, bytes: Buffer, type: string): Promise<void> }

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
const encode = (segment: string) => encodeURIComponent(segment).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Returns the request headers plus Authorization. `date` is the ISO basic form, e.g. 20130524T000000Z. */
export function signV4(input: { method: string; url: string; headers: Record<string, string>; payloadHash: string;
  accessKeyId: string; secretAccessKey: string; region: string; service: string; date: string }): Record<string, string> {
  const url = new URL(input.url);
  const headers: Record<string, string> = { ...input.headers, host: url.host, 'x-amz-content-sha256': input.payloadHash, 'x-amz-date': input.date };
  const names = Object.keys(headers).map(name => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')]));
  const signedHeaders = names.join(';');
  const canonicalRequest = [input.method, url.pathname.split('/').map(segment => encode(decodeURIComponent(segment))).join('/'), '',
    names.map(name => `${name}:${lower[name]}\n`).join(''), signedHeaders, input.payloadHash].join('\n');
  const scope = `${input.date.slice(0, 8)}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.date, scope, sha256(canonicalRequest)].join('\n');
  let key = hmac('AWS4' + input.secretAccessKey, input.date.slice(0, 8));
  for (const part of [input.region, input.service, 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

export function r2Uploader(credential: R2Credential, transport: typeof fetch = fetch, clock = () => new Date()): ImageUploader {
  const { accountId, bucket, accessKeyId, secretAccessKey } = r2CredentialSchema.parse(credential);
  const request = async (method: 'HEAD' | 'PUT', key: string, body?: Buffer, type?: string) => {
    if (!/^[a-z0-9.-]+$/.test(key)) throw new Error('Invalid object key.');
    const url = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;
    const date = clock().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    // Content-addressed objects never change, so they may be cached for a year.
    const extra: Record<string, string> = body ? { 'content-type': type!, 'cache-control': 'public, max-age=31536000, immutable' } : {};
    const headers = signV4({ method, url, headers: extra, payloadHash: sha256(body ?? ''), accessKeyId, secretAccessKey, region: 'auto', service: 's3', date });
    const { host: _host, ...sent } = headers;
    return transport(url, { method, headers: sent, body: body ? new Uint8Array(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(body ? 120_000 : 15_000) });
  };
  return {
    async head(key) {
      const response = await request('HEAD', key);
      if (response.status === 404) return false;
      if (response.status !== 200) throw new Error(`R2 HEAD ${response.status}`);
      return true;
    },
    async put(key, bytes, type) {
      const response = await request('PUT', key, bytes, type);
      if (response.status !== 200) throw new Error(`R2 PUT ${response.status}`);
    },
  };
}
