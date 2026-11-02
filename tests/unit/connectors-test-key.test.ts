import { describe, expect, it } from 'vitest';
import { PROBES, testKey } from '@/lib/connectors/test-key';
import { KEY_TESTS } from '@/lib/connectors/catalog';

const KEY = 'sk-test-SECRET-1234567890';  // gitleaks:allow
type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body = '{}', calls: Call[] = []) {
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('testKey', () => {
  it('has a fixed https address for every test the catalog can name', () => {
    for (const id of KEY_TESTS) expect(PROBES[id].url).toMatch(/^https:\/\//);
  });

  it('sends the key only in the header, as a bearer token (or bare for Pexels), to the provider address', async () => {
    for (const id of KEY_TESTS) {
      const { f, calls } = fakeFetch(200);
      const r = await testKey(id, KEY, f);
      expect(r.ok, id).toBe(true);
      expect(calls[0].url, id).toBe(PROBES[id].url);
      expect(calls[0].url, id).not.toContain(KEY);
      const auth = (calls[0].init.headers as Record<string, string>).Authorization;
      expect(auth, id).toBe(id === 'pexels' ? KEY : `Bearer ${KEY}`);
      expect(calls[0].init.method).toBe('GET');
      expect(calls[0].init.body).toBeUndefined();
      expect(calls[0].init.redirect).toBe('error');
    }
  });

  it('rejects a key the provider refuses, in plain words, without echoing it', async () => {
    for (const status of [401, 403]) {
      const r = await testKey('openrouter', KEY, fakeFetch(status).f);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/did not accept/);
      expect(r.message).not.toContain(KEY);
    }
  });

  it('treats a rate limit as a recognised key, and other errors as a retry later', async () => {
    expect((await testKey('xai', KEY, fakeFetch(429).f)).ok).toBe(true);
    const r = await testKey('xai', KEY, fakeFetch(500).f);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/500/);
  });

  it('accepts a send-only Resend key, but not any other 401 from Resend', async () => {
    expect((await testKey('resend', KEY, fakeFetch(401, '{"name":"restricted_api_key"}').f)).ok).toBe(true);
    expect((await testKey('resend', KEY, fakeFetch(401, '{"name":"invalid_api_key"}').f)).ok).toBe(false);
    expect((await testKey('openai', KEY, fakeFetch(401, '{"name":"restricted_api_key"}').f)).ok).toBe(false);
  });

  it('reports a network failure without the key or the raw error', async () => {
    const boom = (async () => { throw new Error(`connect ECONNREFUSED ${KEY}`); }) as unknown as typeof fetch;
    const r = await testKey('replicate', KEY, boom);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(KEY);
    expect(r.message).not.toContain('ECONNREFUSED');
  });
});
