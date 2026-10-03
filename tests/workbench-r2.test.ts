import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { r2CredentialSchema, r2Uploader, signV4 } from '../workbench/r2';

test('SigV4 matches the published AWS example (GET object with Range)', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Example: GET Object".
  const headers = signV4({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' },
    payloadHash: createHash('sha256').update('').digest('hex'), accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3', date: '20130524T000000Z' });
  assert.equal(headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
    + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('the R2 client signs HEAD and PUT for one bucket and maps statuses', async () => {
  const credential = { accountId: 'a'.repeat(32), bucket: 'xan9x-blog-images', accessKeyId: 'K'.repeat(32), secretAccessKey: 's'.repeat(43) };
  const calls: { url: string; init: RequestInit }[] = []; let status = 404;
  const transport = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status }); }) as typeof fetch;
  const r2 = r2Uploader(credential, transport, () => new Date('2026-10-03T08:00:00.123Z'));
  const key = 'b'.repeat(32) + '-1x1.png';
  assert.equal(await r2.head(key), false); status = 200; assert.equal(await r2.head(key), true);
  await r2.put(key, Buffer.from('png'), 'image/png');
  const put = calls[2]!; const headers = put.init.headers as Record<string, string>;
  assert.equal(put.url, `https://${'a'.repeat(32)}.r2.cloudflarestorage.com/xan9x-blog-images/${key}`);
  assert.equal(put.init.method, 'PUT'); assert.equal(put.init.redirect, 'error');
  assert.equal(headers['x-amz-date'], '20261003T080000Z');
  assert.equal(headers['x-amz-content-sha256'], createHash('sha256').update('png').digest('hex'));
  assert.equal(headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.match(headers.authorization!, /^AWS4-HMAC-SHA256 Credential=K{32}\/20261003\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
  assert.equal('host' in headers, false, 'fetch sets Host itself');
  status = 403; await assert.rejects(r2.head(key), /403/); await assert.rejects(r2.put(key, Buffer.from('x'), 'image/png'), /403/);
  await assert.rejects(r2.head('../other'), /Invalid object key/);
  for (const change of [{ accountId: 'x' }, { bucket: 'Bad_Bucket' }, { secretAccessKey: 'has space in it!!!!!' }]) {
    assert.equal(r2CredentialSchema.safeParse({ ...credential, ...change }).success, false);
  }
});
