// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, createSign, type KeyObject } from 'crypto';
import { NextRequest } from 'next/server';
import { accessConfigFromEnv, verifyAccessJwt, clearAccessKeyCache, type AccessConfig, type FetchKeys } from '@/lib/cf-access-jwt';

const TEAM = 'acme.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const config: AccessConfig = { teamDomain: TEAM, audiences: [AUD] };
const NOW = 1_800_000_000_000;
const nowMs = () => NOW;

const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, jwk: { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' } };
}
function sign(privateKey: KeyObject, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}
const good = (extra: Record<string, unknown> = {}) => ({ email: 'owner@example.com', iss: `https://${TEAM}`, aud: [AUD], exp: NOW / 1000 + 600, iat: NOW / 1000 - 10, ...extra });

let key = makeKey();
let calls: string[];
let fetchKeys: FetchKeys;
beforeEach(() => {
  clearAccessKeyCache();
  key = makeKey();
  calls = [];
  fetchKeys = async (url) => { calls.push(url); return { keys: [key.jwk as never] }; };
});
const verify = (token: string, deps = {}) => verifyAccessJwt(token, config, { fetchKeys, nowMs, ...deps });

describe('accessConfigFromEnv', () => {
  it('needs a Cloudflare team domain and at least one audience', () => {
    expect(accessConfigFromEnv({ WEBGATE_ACCESS_TEAM_DOMAIN: 'Acme.CloudflareAccess.com', WEBGATE_ACCESS_AUD: 'x, y' })).toEqual({ teamDomain: TEAM, audiences: ['x', 'y'] });
    expect(accessConfigFromEnv({ WEBGATE_ACCESS_TEAM_DOMAIN: TEAM })).toBeNull();
    expect(accessConfigFromEnv({ WEBGATE_ACCESS_AUD: 'x' })).toBeNull();
    expect(accessConfigFromEnv({})).toBeNull();
  });
  it('refuses a team domain that is not a Cloudflare Access address, so the key download can only go there', () => {
    for (const bad of ['evil.example', 'acme.cloudflareaccess.com.evil.example', 'x/acme.cloudflareaccess.com', 'cloudflareaccess.com', '127.0.0.1', 'acme.cloudflareaccess.com:8080']) {
      expect(accessConfigFromEnv({ WEBGATE_ACCESS_TEAM_DOMAIN: bad, WEBGATE_ACCESS_AUD: 'x' })).toBeNull();
    }
  });
});

describe('verifyAccessJwt', () => {
  it('accepts a token Cloudflare signed for our application and returns its claims', async () => {
    const claims = await verify(sign(key.privateKey, good()));
    expect(claims?.email).toBe('owner@example.com');
    expect(calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });
  it('accepts an audience given as a plain string and one of several configured audiences', async () => {
    expect(await verify(sign(key.privateKey, good({ aud: AUD })))).not.toBeNull();
    expect(await verifyAccessJwt(sign(key.privateKey, good({ aud: 'other-app' })), { teamDomain: TEAM, audiences: ['x', 'other-app'] }, { fetchKeys, nowMs })).not.toBeNull();
  });
  it('refuses a token signed by a different key (a forged email)', async () => {
    const other = makeKey();
    expect(await verify(sign(other.privateKey, good({ email: 'admin@example.com' })))).toBeNull();
  });
  it('refuses a token whose body was changed after signing', async () => {
    const [h, , s] = sign(key.privateKey, good()).split('.');
    expect(await verify(`${h}.${b64(good({ email: 'admin@example.com' }))}.${s}`)).toBeNull();
  });
  it('refuses alg none, HS256 and a missing kid, even though the body looks right', async () => {
    expect(await verify(`${b64({ alg: 'none', kid: 'k1' })}.${b64(good())}.`)).toBeNull();
    expect(await verify(sign(key.privateKey, good(), { alg: 'HS256', kid: 'k1' }))).toBeNull();
    expect(await verify(sign(key.privateKey, good(), { alg: 'RS256' }))).toBeNull();
    expect(await verify(sign(key.privateKey, good(), { alg: 'RS256', kid: 'unknown' }))).toBeNull();
  });
  it('refuses another issuer, another application and no audience', async () => {
    expect(await verify(sign(key.privateKey, good({ iss: 'https://evil.cloudflareaccess.com' })))).toBeNull();
    expect(await verify(sign(key.privateKey, good({ aud: ['someone-elses-app'] })))).toBeNull();
    expect(await verify(sign(key.privateKey, good({ aud: undefined })))).toBeNull();
    expect(await verify(sign(key.privateKey, good({ iss: undefined })))).toBeNull();
  });
  it('refuses an expired token (beyond one minute of clock difference), a missing expiry and a token not yet valid', async () => {
    expect(await verify(sign(key.privateKey, good({ exp: NOW / 1000 - 120 })))).toBeNull();
    expect(await verify(sign(key.privateKey, good({ exp: NOW / 1000 - 30 })))).not.toBeNull();
    expect(await verify(sign(key.privateKey, good({ exp: undefined })))).toBeNull();
    expect(await verify(sign(key.privateKey, good({ nbf: NOW / 1000 + 300 })))).toBeNull();
  });
  it('refuses junk and oversize input without throwing, and never downloads keys for it', async () => {
    for (const bad of ['', 'a.b', 'a.b.c.d', '!!.!!.!!', 'x'.repeat(9000)]) expect(await verify(bad)).toBeNull();
    expect(calls).toEqual([]);
  });
  it('refuses a token with a fourth part or more, even if the first two parts are validly signed', async () => {
    expect(await verify(sign(key.privateKey, good()) + '.extra')).toBeNull();
  });
  it('refuses a validly signed token that is too large to be one of Cloudflare\'s, without downloading keys', async () => {
    const huge = sign(key.privateKey, good({ padding: 'x'.repeat(9000) }));
    expect(huge.length).toBeGreaterThan(8192);
    expect(await verify(huge)).toBeNull();
    expect(calls).toEqual([]);
  });
  it('does not download keys for a token that names no key', async () => {
    expect(await verify(sign(key.privateKey, good(), { alg: 'RS256' }))).toBeNull();
    expect(calls).toEqual([]);
  });
  it('is off without configuration', async () => {
    expect(await verifyAccessJwt(sign(key.privateKey, good()), null, { fetchKeys, nowMs })).toBeNull();
  });
  it('fails closed when the key download fails or answers nonsense', async () => {
    expect(await verify(sign(key.privateKey, good()), { fetchKeys: async () => { throw new Error('offline'); } })).toBeNull();
    clearAccessKeyCache();
    expect(await verify(sign(key.privateKey, good()), { fetchKeys: async () => ({ keys: [{ kid: 'k1', kty: 'oct' }] }) })).toBeNull();
  });
  it('downloads keys once for many tokens, and again only for an unknown key after a minute (rotation)', async () => {
    await verify(sign(key.privateKey, good()));
    await verify(sign(key.privateKey, good()));
    expect(calls).toHaveLength(1);
    await verifyAccessJwt(sign(key.privateKey, good({ exp: NOW / 1000 + 100_000 })), config, { fetchKeys, nowMs: () => NOW + 120_000 });   // a known key later in the hour: still no download
    expect(calls).toHaveLength(1);
    const rotated = makeKey();
    const token = sign(rotated.privateKey, good(), { alg: 'RS256', kid: 'k2' });
    fetchKeys = async (url) => { calls.push(url); return { keys: [key.jwk as never, { ...(rotated.jwk as object), kid: 'k2' } as never] }; };
    expect(await verify(token)).toBeNull();                       // within the minute: no new download, key unknown
    expect(calls).toHaveLength(1);
    expect(await verifyAccessJwt(token, config, { fetchKeys, nowMs: () => NOW + 61_000 })).not.toBeNull();
    expect(calls).toHaveLength(2);
  });
});

describe('resolveWebGateIdentity', () => {
  beforeEach(() => { vi.resetModules(); });
  const request = (jwt: string | null, secret = 's3cret') => new NextRequest('http://localhost:3000/api/collab', { headers: { ...(secret ? { 'x-tunnel-auth': secret } : {}), ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}) } });
  async function load(env: Record<string, string>) {
    for (const [k, v] of Object.entries({ WEBGATE_TUNNEL_SECRET: 's3cret', WEBGATE_ACCESS_TEAM_DOMAIN: '', WEBGATE_ACCESS_AUD: '', ...env })) vi.stubEnv(k, v);
    vi.doMock('@/lib/cf-access-jwt', async (original) => {
      const real = await original<typeof import('@/lib/cf-access-jwt')>();
      return { ...real, verifyAccessJwt: (t: string, c: AccessConfig | null) => real.verifyAccessJwt(t, c, { fetchKeys, nowMs }) };
    });
    return (await import('@/lib/webgate-identity')).resolveWebGateIdentity;
  }
  it('takes the email from a verified token that came through the tunnel', async () => {
    const resolve = await load({ WEBGATE_ACCESS_TEAM_DOMAIN: TEAM, WEBGATE_ACCESS_AUD: AUD });
    const id = await resolve(request(sign(key.privateKey, good())));
    expect(id?.email).toBe('owner@example.com');
    expect(id?.canonicalParticipantId).toBe('user-owner');
  });
  it('gives no identity for a forged token, even with the right tunnel secret', async () => {
    const resolve = await load({ WEBGATE_ACCESS_TEAM_DOMAIN: TEAM, WEBGATE_ACCESS_AUD: AUD });
    const forged = `${b64({ alg: 'none' })}.${b64(good({ email: 'admin@example.com' }))}.`;
    expect(await resolve(request(forged))).toBeNull();
    expect(await resolve(request(sign(makeKey().privateKey, good())))).toBeNull();
  });
  it('gives no identity when Access is not configured, however good the token looks', async () => {
    const resolve = await load({});
    expect(await resolve(request(sign(key.privateKey, good())))).toBeNull();
  });
  it('gives no identity without the tunnel secret', async () => {
    const resolve = await load({ WEBGATE_ACCESS_TEAM_DOMAIN: TEAM, WEBGATE_ACCESS_AUD: AUD });
    expect(await resolve(request(sign(key.privateKey, good()), ''))).toBeNull();
    expect(await resolve(request(sign(key.privateKey, good()), 'wrong'))).toBeNull();
  });
});
