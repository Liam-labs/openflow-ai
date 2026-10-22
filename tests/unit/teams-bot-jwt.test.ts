import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { generateKeyPairSync, createSign, createHmac, type KeyObject } from 'crypto';
import { verifyBotJwt, keySetForIssuer, resetBotKeyCacheForTests, BOT_FRAMEWORK_KEYS, ENTRA_KEYS } from '@/teams-integration/lib/bot-jwt';

const APP = '11111111-2222-3333-4444-555555555555';
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOW = 1_800_000_000_000;
const b64 = (v: object | Buffer) => (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');

function makeKey(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return { kid, privateKey, jwk: { kty: 'RSA', kid, use: 'sig', n: jwk.n, e: jwk.e } };
}
function sign(key: { kid: string; privateKey: KeyObject }, claims: object, header: object = {}) {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header });
  const body = b64(claims);
  const sig = createSign('RSA-SHA256').update(head + '.' + body).sign(key.privateKey);
  return head + '.' + body + '.' + b64(sig);
}
const good = (over: object = {}) => ({ iss: 'https://api.botframework.com', aud: APP, exp: NOW / 1000 + 600, nbf: NOW / 1000 - 60, ...over });

describe('verifyBotJwt', () => {
  const key = makeKey('k1');
  const other = makeKey('k1');                         // same kid, different key: a forger who copies the kid
  let fetched: string[];
  const fetchJson = async (url: string) => { fetched.push(url); return { keys: [key.jwk] }; };
  const run = (token: string, extra: object = {}) => verifyBotJwt(token, { audiences: [APP], entraTenants: [TENANT], fetchJson, nowMs: NOW, ...extra });
  beforeEach(() => { resetBotKeyCacheForTests(); fetched = []; });

  it('accepts a correctly signed Bot Framework token and uses the Bot Framework key set', async () => {
    expect((await run(sign(key, good()))).ok).toBe(true);
    expect(fetched).toEqual([BOT_FRAMEWORK_KEYS]);
  });
  it('accepts an Entra v2 and an sts.windows.net issuer, with the Entra key set', async () => {
    expect((await run(sign(key, good({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0` })))).ok).toBe(true);
    expect((await run(sign(key, good({ iss: `https://sts.windows.net/${TENANT}/` })))).ok).toBe(true);
    expect(fetched).toEqual([ENTRA_KEYS]);
  });
  it('accepts an Entra token only from a configured tenant', async () => {
    const entra = sign(key, good({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0` }));
    expect((await run(entra, { entraTenants: [] })).ok).toBe(false);
    expect((await run(entra, { entraTenants: undefined })).ok).toBe(false);
    expect((await run(entra, { entraTenants: ['11111111-0000-0000-0000-000000000000'] })).reason).toMatch(/issuer/);
    expect((await run(entra, { entraTenants: ['', TENANT.toUpperCase()] })).ok).toBe(true);
    expect((await run(sign(key, good()), { entraTenants: [] })).ok).toBe(true);        // the Bot Framework itself needs no tenant
    expect(keySetForIssuer(`https://sts.windows.net/${TENANT}/`, [TENANT])).toBe(ENTRA_KEYS);
    expect(keySetForIssuer(`https://sts.windows.net/${TENANT}/`, [])).toBeNull();
  });
  it('downloads each key set once for a burst of tokens, and backs off for 30 s after a failure', async () => {
    let calls = 0;
    const slow: typeof fetchJson = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { keys: [key.jwk] }; };
    const t = sign(key, good());
    const results = await Promise.all(Array.from({ length: 25 }, () => verifyBotJwt(t, { audiences: [APP], fetchJson: slow, nowMs: NOW })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls).toBe(1);
    resetBotKeyCacheForTests();
    let failing = 0;
    const down: typeof fetchJson = async () => { failing++; throw new Error('offline'); };
    for (let i = 0; i < 10; i++) await verifyBotJwt(t, { audiences: [APP], fetchJson: down, nowMs: NOW + i * 1000 });
    expect(failing).toBe(1);
    await verifyBotJwt(t, { audiences: [APP], fetchJson: down, nowMs: NOW + 31_000 });
    expect(failing).toBe(2);
  });
  it('refuses a token signed with a different key under the same kid', async () => {
    const r = await run(sign(other, good()));
    expect(r.ok).toBe(false); expect(r.reason).toMatch(/signature/);
  });
  it('refuses an unsigned token, alg none, and an HMAC token signed with the public key', async () => {
    const claims = good();
    expect((await run(b64({ alg: 'none', kid: 'k1' }) + '.' + b64(claims) + '.')).ok).toBe(false);
    expect((await run(b64({ alg: 'none', kid: 'k1' }) + '.' + b64(claims) + '.AAAA')).ok).toBe(false);
    const head = b64({ alg: 'HS256', kid: 'k1' }); const body = b64(claims);
    const mac = createHmac('sha256', key.jwk.n).update(head + '.' + body).digest();
    expect((await run(head + '.' + body + '.' + b64(mac))).ok).toBe(false);
    expect((await run(b64({ alg: 'RS256', kid: 'k1' }) + '.' + b64(claims) + '.AAAA')).ok).toBe(false);   // right claims, junk signature
  });
  it('refuses a header that names another algorithm even when the signature is a valid RS256 one, and a token with extra parts', async () => {
    expect((await run(sign(key, good(), { alg: 'RS384' }))).reason).toMatch(/algorithm/);
    expect((await run(sign(key, good()) + '.extra')).ok).toBe(false);
  });
  it('refuses wrong audience, expired, missing expiry, not-yet-valid', async () => {
    expect((await run(sign(key, good({ aud: 'someone-else' })))).reason).toMatch(/audience/);
    expect((await run(sign(key, good({ exp: NOW / 1000 - 1 })))).reason).toMatch(/expired/);
    expect((await run(sign(key, good({ exp: undefined })))).reason).toMatch(/expir/);
    expect((await run(sign(key, good({ nbf: NOW / 1000 + 3600 })))).reason).toMatch(/not valid yet/);
    expect((await run(sign(key, good({ aud: [APP, 'x'] })))).ok).toBe(true);
  });
  it('refuses issuers that are not Microsoft, including look-alikes', async () => {
    for (const iss of ['https://evil.example', 'https://api.botframework.com.evil.example', 'https://login.microsoftonline.com.evil.example/' + TENANT + '/v2.0', 'https://login.microsoftonline.com/not-a-guid/v2.0', 'x' + 'https://login.microsoftonline.com/' + TENANT + '/v2.0', 'x' + 'https://sts.windows.net/' + TENANT + '/', '', 'https://sts.windows.net/' + TENANT + '/x']) {
      expect((await run(sign(key, good({ iss })))).ok, iss).toBe(false);
    }
    expect(keySetForIssuer('https://api.botframework.com')).toBe(BOT_FRAMEWORK_KEYS);
    expect(keySetForIssuer('https://evil.example')).toBeNull();
  });
  it('fails closed with no configured app id, junk tokens, a missing kid and an unreachable key set', async () => {
    expect((await verifyBotJwt(sign(key, good()), { audiences: [''], fetchJson, nowMs: NOW })).ok).toBe(false);
    expect((await verifyBotJwt(sign(key, good()), { audiences: [], fetchJson, nowMs: NOW })).ok).toBe(false);
    for (const t of ['', 'a.b', 'a.b.c.d', 'not a jwt', '..']) expect((await run(t)).ok).toBe(false);
    expect((await run(sign(key, good(), { kid: undefined }))).reason).toMatch(/key id/);
    const down = await verifyBotJwt(sign(key, good()), { audiences: [APP], nowMs: NOW, fetchJson: async () => { throw new Error('offline'); } });
    expect(down.ok).toBe(false); expect(down.reason).toMatch(/signing keys/);
    resetBotKeyCacheForTests();
    expect((await verifyBotJwt(sign(key, good()), { audiences: [APP], nowMs: NOW, fetchJson: async () => ({ keys: [] }) })).ok).toBe(false);
  });
  it('caches keys, and refetches at most every 5 minutes for an unknown kid', async () => {
    const t = sign(key, good());
    await run(t); await run(t); await run(t);
    expect(fetched).toHaveLength(1);
    const unknown = sign(makeKey('rotated'), good());
    expect((await run(unknown)).reason).toMatch(/unknown signing key/);
    expect(fetched).toHaveLength(1);                                            // inside 5 minutes: no flood of downloads
    expect((await run(unknown, { nowMs: NOW + 6 * 60 * 1000 })).ok).toBe(false);
    expect(fetched).toHaveLength(2);
  });
  it('refuses a token whose serviceurl differs from the message', async () => {
    const t = sign(key, good({ serviceurl: 'https://smba.trafficmanager.net/uk/' }));
    expect((await run(t, { serviceUrl: 'https://smba.trafficmanager.net/uk' })).ok).toBe(true);
    expect((await run(t, { serviceUrl: 'https://smba.trafficmanager.net/emea/' })).reason).toMatch(/serviceUrl/);
  });
});

describe('verifyBotJwt default key download', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetBotKeyCacheForTests(); });
  const key = makeKey('big');
  const token = () => sign(key, { iss: 'https://api.botframework.com', aud: APP, exp: NOW / 1000 + 600 });
  const filler = Array.from({ length: 1200 }, (_, i) => ({ kty: 'RSA', kid: 'pad' + i, n: 'x'.repeat(700), e: 'AQAB' }));

  it('accepts the real-sized Bot Framework key set (about 0.9 MB) and refuses an absurdly large one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [...filler.slice(0, 1200), key.jwk] }))));
    resetBotKeyCacheForTests();
    expect((await verifyBotJwt(token(), { audiences: [APP], nowMs: NOW })).ok).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(5_000_000))));
    resetBotKeyCacheForTests();
    expect((await verifyBotJwt(token(), { audiences: [APP], nowMs: NOW })).reason).toMatch(/too large/);
  });
  it('does not follow redirects and refuses an error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    resetBotKeyCacheForTests();
    expect((await verifyBotJwt(token(), { audiences: [APP], nowMs: NOW })).reason).toMatch(/503/);
  });
});
