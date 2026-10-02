import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessVerifier, accessConfig } from '../workbench/access';
import { accessConfigForTests, accessFixture } from './access-tokens';

const status = (status: number) => (error: unknown) => (error as { status?: number }).status === status;

test('Access configuration names the team domain, the AUD tag and the allowed emails', () => {
  const env = { WORKBENCH_ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', WORKBENCH_ACCESS_AUD: 'a'.repeat(64), WORKBENCH_ACCESS_EMAILS: ' Owner@Example.test , second@example.test ' };
  assert.deepEqual(accessConfig(env), { teamDomain: 'test-team.cloudflareaccess.com', audience: 'a'.repeat(64), emails: ['owner@example.test', 'second@example.test'] });
  for (const change of [{ WORKBENCH_ACCESS_TEAM_DOMAIN: 'https://test-team.cloudflareaccess.com' }, { WORKBENCH_ACCESS_TEAM_DOMAIN: 'evil.example' },
    { WORKBENCH_ACCESS_AUD: 'short' }, { WORKBENCH_ACCESS_EMAILS: '' }, { WORKBENCH_ACCESS_EMAILS: 'not-an-email' }, { WORKBENCH_ACCESS_AUD: undefined }]) {
    assert.throws(() => accessConfig({ ...env, ...change }), /WORKBENCH_ACCESS_/);
  }
});

test('a valid assertion yields its email; anything forged, foreign, stale or for someone else is refused', async () => {
  let now = Date.UTC(2026, 9, 3); const f = accessFixture(() => now);
  const verifier = new AccessVerifier(accessConfigForTests, f.fetchKeys, () => now);
  assert.equal(await verifier.verify(f.token({ email: 'OWNER@example.test' })), 'owner@example.test');
  assert.equal(await verifier.verify(f.token({ aud: accessConfigForTests.audience })), 'owner@example.test', 'a single-string aud is accepted');
  const valid = f.token(); const [head, body] = valid.split('.');
  const unsigned = (header: object) => `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${body}.`;
  for (const token of [
    undefined, '', 'a.b', ['x', 'y'], valid + 'x', `${head}.${body}.${'A'.repeat(342)}`, `${head}.${Buffer.from('{}').toString('base64url')}.${valid.split('.')[2]}`,
    unsigned({ alg: 'none', kid: 'key-1' }), unsigned({ alg: 'HS256', kid: 'key-1' }), 'x'.repeat(9000),
    f.token({ iss: 'https://other-team.cloudflareaccess.com' }), f.token({ aud: ['b'.repeat(64)] }), f.token({ type: 'org' }),
    f.token({ email: 'someone@example.test' }), f.token({ email: undefined }), f.token({ exp: undefined }),
    f.token({ exp: Math.floor(now / 1000) - 61 }), f.token({ nbf: Math.floor(now / 1000) + 120 }),
  ]) await assert.rejects(verifier.verify(token), status(403), String(token).slice(0, 60));
  assert.equal(await verifier.verify(f.token({ exp: Math.floor(now / 1000) - 30 })), 'owner@example.test', 'small clock skew is tolerated');
  assert.equal(f.requests.length, 1, 'keys are fetched once and cached');
  assert.equal(f.requests[0], 'https://test-team.cloudflareaccess.com/cdn-cgi/access/certs');
});

test('key rotation refetches on an unknown key ID, throttled, and fetch failures fail closed', async () => {
  let now = Date.UTC(2026, 9, 3); const f = accessFixture(() => now);
  const verifier = new AccessVerifier(accessConfigForTests, f.fetchKeys, () => now);
  f.setFailing(true);
  await assert.rejects(verifier.verify(f.token()), status(503), 'no keys yet: unavailable, not a silent pass');
  await assert.rejects(verifier.verify(f.token()), status(503), 'throttled while still without keys');
  assert.equal(f.requests.length, 1);
  f.setFailing(false); now += 31_000;
  assert.equal(await verifier.verify(f.token()), 'owner@example.test');
  f.rotate('key-2'); now += 31_000;
  assert.equal(await verifier.verify(f.token({}, { kid: 'key-2' })), 'owner@example.test', 'a new signing key is picked up');
  assert.equal(f.requests.length, 3);
  await assert.rejects(verifier.verify(f.token({}, { kid: 'unknown' })), status(403));
  await assert.rejects(verifier.verify(f.token({}, { kid: 'unknown-2' })), status(403));
  assert.equal(f.requests.length, 3, 'unknown key IDs cannot make every request fetch');
  f.setFailing(true); now += 61 * 60_000;
  assert.equal(await verifier.verify(f.token()), 'owner@example.test', 'a failed hourly refresh keeps known keys');
  assert.equal(f.requests.length, 4);
});
