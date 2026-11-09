import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// The pattern in docs/model-features.md: off by default, never gated on one provider, a missing key is refused by the server, no silent fallback.
let dir: string;
vi.mock('@/lib/data-paths', async () => ({ DataPaths: { get dashboardAuth() { return path.join(dir, 'dashboard-auth.json'); }, get apiTokens() { return path.join(dir, 'api-tokens.json'); }, get remoteAccess() { return path.join(dir, 'remote-access.json'); } } }));
// Both catalog entries are marked ready here so the switch-on paths can be tested. A test below checks the real catalog is not ready.
vi.mock('@/lib/model-features/registry', async (orig) => {
  const real = await orig<typeof import('@/lib/model-features/registry')>();
  const features = real.FEATURES.map((f) => ({ ...f }));
  return { ...real, FEATURES: features, __real: real.FEATURES, featureById: (id: string) => features.find((f) => f.id === id) };
});

const STAMP = Symbol.for('openflow.peerStampActive');
const KEY = ['sk', 'test', '0123456789abcdef', 'must-never-appear'].join('-');

function req(url: string, init: { method?: string; body?: unknown; peer?: string } = {}) {
  const peer = init.peer ?? '127.0.0.1';
  const headers: Record<string, string> = { host: 'localhost:3000', 'content-type': 'application/json', 'x-openflow-peer': peer, 'x-openflow-http-version': '1.1' };
  if (peer !== '127.0.0.1') headers['x-forwarded-for'] = peer;
  return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function put(id: string, body: unknown, peer?: string) {
  const { PUT } = await import('@/app/api/model-features/[id]/route');
  const res = await PUT(req(`/api/model-features/${id}`, { method: 'PUT', body, peer }), ctx(id));
  return { status: res.status, json: await res.json() };
}
async function list() {
  const { GET } = await import('@/app/api/model-features/route');
  return (await GET(req('/api/model-features'))).json();
}
async function makeReady() {
  const reg = await import('@/lib/model-features/registry');
  for (const f of reg.FEATURES) f.ready = true;
}

beforeEach(async () => {
  vi.resetModules();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelfeatures-'));
  for (const name of ['DEVFLOW_BIND_HOST', 'DEVFLOW_REQUIRE_TOKEN', 'DEVFLOW_ORIGIN_CHECK', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'OPENAI_API_KEY']) vi.stubEnv(name, '');
  vi.stubEnv('DEVFLOW_SECRET_STORE', 'env');
  (globalThis as Record<symbol, unknown>)[STAMP] = true;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[STAMP];
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the catalog', () => {
  it('has no bad entry: every one names what it sends, gives a reason and a known provider', async () => {
    const reg = await import('@/lib/model-features/registry');
    const real = (reg as unknown as { __real: typeof reg.FEATURES }).__real;
    expect(reg.validateRegistry(real)).toEqual([]);
  });
  it('refuses an entry with empty dataSent, no reason, an unknown provider or a mode called off', async () => {
    const reg = await import('@/lib/model-features/registry');
    const bad = { id: 'x-feature', name: 'X', dataSent: [], recommended: { provider: 'nobody', model: 'm', reason: ' ' }, ready: true, modes: [{ id: 'off', label: 'Off' }] };
    const problems = reg.validateRegistry([bad]).join(' | ');
    expect(problems).toMatch(/dataSent is empty/);
    expect(problems).toMatch(/no reason/);
    expect(problems).toMatch(/not a known provider/);
    expect(problems).toMatch(/"off" is the switch/);
  });
  it('does not let the first features be switched on before their owner has checked what they send', async () => {
    const reg = await import('@/lib/model-features/registry');
    const real = (reg as unknown as { __real: typeof reg.FEATURES }).__real;
    expect(real.every((f) => f.ready === false)).toBe(true);
  });
  it('requires no provider: no feature names one as required, and every provider is optional', async () => {
    const reg = await import('@/lib/model-features/registry');
    expect(reg.PROVIDERS.length).toBeGreaterThan(3);
    expect(reg.PROVIDERS.some((p) => p.secretName === null)).toBe(true);        // a local model is first-class
  });
});

describe('GET /api/model-features', () => {
  it('starts with everything off and no model chosen, and shows the recommendation without applying it', async () => {
    const { features } = await list();
    expect(features.length).toBeGreaterThan(0);
    for (const f of features) {
      expect(f.enabled).toBe(false);
      expect(f.active).toBeNull();
      expect(f.recommended.reason).toBeTruthy();
      expect(f.dataSent.length).toBeGreaterThan(0);
    }
  });
  it('shows which providers are linked and never a key', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', KEY);
    const body = JSON.stringify(await list());
    expect(body).not.toContain(KEY);
    const { providers } = JSON.parse(body);
    expect(providers.find((p: { id: string }) => p.id === 'deepseek').linked).toBe(true);
    expect(providers.find((p: { id: string }) => p.id === 'openai').linked).toBe(false);
    expect(providers.find((p: { id: string }) => p.id === 'ollama').linked).toBe(true);     // local: needs no key
  });
  it('is refused for a caller from another computer with no token', async () => {
    const { GET } = await import('@/app/api/model-features/route');
    expect((await GET(req('/api/model-features', { peer: '203.0.113.9' }))).status).toBe(401);
  });
});

describe('PUT /api/model-features/<id>', () => {
  it('refuses to switch on a feature whose data line has not been checked, and changes nothing', async () => {
    const r = await put('knowledge-update', { enabled: true, model: { provider: 'ollama', id: 'llama3' } });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('FEATURE_NOT_READY');
    expect((await list()).features.find((f: { id: string }) => f.id === 'knowledge-update').enabled).toBe(false);
  });
  it('answers KEY_MISSING with a link, and saves nothing, when the chosen provider has no key', async () => {
    await makeReady();
    const r = await put('knowledge-update', { enabled: true, model: { provider: 'deepseek', id: 'deepseek-chat' }, returnTo: '/operations?tab=kb' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('KEY_MISSING');
    expect(r.json.provider).toBe('deepseek');
    expect(r.json.error).toBe('This feature needs an API key for DeepSeek.');
    const link = new URL(r.json.linkUrl, 'http://x');
    expect(link.searchParams.get('provider')).toBe('deepseek');
    expect(link.searchParams.get('resume')).toBe('knowledge-update');
    expect(link.searchParams.get('returnTo')).toBe('/operations?tab=kb');
    expect(link.pathname).toBe('/operations');
    expect(link.hash).toBe('#systems/connections');
    await expect(fs.access(path.join(dir, 'model-features.json'))).rejects.toThrow();
  });
  it('drops a returnTo that points anywhere but a path on this site', async () => {
    await makeReady();
    for (const bad of ['//evil.example', 'https://evil.example/x', 'javascript:alert(1)', '/\\evil.example', 42]) {
      const r = await put('knowledge-update', { enabled: true, model: { provider: 'deepseek', id: 'm' }, returnTo: bad });
      expect(new URL(r.json.linkUrl, 'http://x').searchParams.has('returnTo')).toBe(false);
    }
  });
  it('switches on once the key exists, and the feature then resolves to exactly the chosen model', async () => {
    await makeReady();
    vi.stubEnv('DEEPSEEK_API_KEY', KEY);
    const r = await put('knowledge-update', { enabled: true, model: { provider: 'deepseek', id: 'deepseek-chat' } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain(KEY);
    const { resolveFeatureModel } = await import('@/lib/model-features/resolve');
    expect(await resolveFeatureModel('knowledge-update')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    const shown = (await list()).features.find((f: { id: string }) => f.id === 'knowledge-update');
    expect(shown.enabled).toBe(true);
    expect(shown.active).toEqual({ provider: 'deepseek', id: 'deepseek-chat' });
    expect(shown.keyConfigured).toBe(true);
  });
  it('never falls back to another provider: remove the key and the feature does nothing, even with another key linked', async () => {
    await makeReady();
    vi.stubEnv('DEEPSEEK_API_KEY', KEY);
    await put('knowledge-update', { enabled: true, model: { provider: 'deepseek', id: 'deepseek-chat' } });
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', KEY);
    const { resolveFeatureModel, KeyMissing } = await import('@/lib/model-features/resolve');
    await expect(resolveFeatureModel('knowledge-update')).rejects.toBeInstanceOf(KeyMissing);
  });
  it('works with a local model and no key at all', async () => {
    await makeReady();
    const r = await put('knowledge-update', { enabled: true, model: { provider: 'ollama', id: 'llama3' } });
    expect(r.status).toBe(200);
  });
  it('always lets a feature be switched off, with no key and no model', async () => {
    await makeReady();
    vi.stubEnv('DEEPSEEK_API_KEY', KEY);
    await put('knowledge-update', { enabled: true, model: { provider: 'deepseek', id: 'm' } });
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const r = await put('knowledge-update', { enabled: false, model: null });
    expect(r.status).toBe(200);
    const { resolveFeatureModel, FeatureOff } = await import('@/lib/model-features/resolve');
    await expect(resolveFeatureModel('knowledge-update')).rejects.toBeInstanceOf(FeatureOff);
  });
  it('refuses a switch-on with no model, an unknown provider, an unknown feature and bad input', async () => {
    await makeReady();
    expect((await put('knowledge-update', { enabled: true, model: null })).json.code).toBe('NO_MODEL');
    expect((await put('knowledge-update', { enabled: true, model: { provider: 'acme', id: 'm' } })).json.code).toBe('BAD_MODEL');
    expect((await put('nope', { enabled: true })).status).toBe(404);
    expect((await put('knowledge-update', { enabled: 'yes' })).json.code).toBe('BAD_REQUEST');
  });
  it('is refused for a caller from another computer with no token', async () => {
    const r = await put('knowledge-update', { enabled: false, model: null }, '203.0.113.9');
    expect(r.status).toBe(401);
  });
  it('keeps a feature mode: only suggest exists for now, "off" is the switch and any other word, automatic included, is refused', async () => {
    await makeReady();
    vi.stubEnv('DEEPSEEK_API_KEY', KEY);
    const ok = await put('overwatch', { enabled: true, model: { provider: 'deepseek', id: 'm' }, mode: 'suggest' });
    expect(ok.status).toBe(200);
    expect(ok.json.mode).toBe('suggest');
    expect((await put('overwatch', { enabled: true, model: { provider: 'deepseek', id: 'm' }, mode: 'off' })).json.code).toBe('BAD_MODE');
    expect((await put('overwatch', { enabled: true, model: { provider: 'deepseek', id: 'm' }, mode: 'yolo' })).json.code).toBe('BAD_MODE');
    expect((await put('overwatch', { enabled: true, model: { provider: 'deepseek', id: 'm' }, mode: 'automatic' })).json.code).toBe('BAD_MODE');   // not offered until a backtest record exists
    expect((await put('knowledge-update', { enabled: false, model: null, mode: 'suggest' })).json.code).toBe('BAD_MODE');   // this feature has no modes
  });
  it('does not lose a change when two features are saved at the same moment', async () => {
    await makeReady();
    vi.stubEnv('DEEPSEEK_API_KEY', KEY);
    await Promise.all([
      put('knowledge-update', { enabled: true, model: { provider: 'deepseek', id: 'a' } }),
      put('overwatch', { enabled: true, model: { provider: 'deepseek', id: 'b' }, mode: 'suggest' }),
    ]);
    const { features } = await list();
    expect(features.find((f: { id: string }) => f.id === 'knowledge-update').enabled).toBe(true);
    expect(features.find((f: { id: string }) => f.id === 'overwatch').enabled).toBe(true);
  });
});

describe('GET /api/model-features/<id>/key-check', () => {
  it('says whether a key exists and never returns it', async () => {
    const { GET } = await import('@/app/api/model-features/[id]/key-check/route');
    const ask = async (provider: string) => GET(req(`/api/model-features/knowledge-update/key-check?provider=${provider}`), ctx('knowledge-update'));
    vi.stubEnv('DEEPSEEK_API_KEY', KEY);
    const yes = await (await ask('deepseek')).text();
    expect(JSON.parse(yes)).toEqual({ configured: true, provider: 'deepseek', secretName: 'DEEPSEEK_API_KEY' });
    expect(yes).not.toContain(KEY);
    expect((await (await ask('openai')).json()).configured).toBe(false);
    expect((await ask('acme')).status).toBe(400);
  });

  it('recommends deepseek-flash for knowledge updates, with a dated cost reason, and keeps every real feature unavailable', async () => {
    const FEATURES = ((await import('@/lib/model-features/registry')) as unknown as { __real: import('@/lib/model-features/registry').ModelFeature[] }).__real;
    const k = FEATURES.find((f) => f.id === 'knowledge-update')!;
    expect(k.recommended).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash' });
    expect(k.recommended.reason).toMatch(/\d{1,2} [A-Z][a-z]+ 20\d\d/);
    expect(FEATURES.every((f) => f.ready === false)).toBe(true);
    expect(FEATURES.find((f) => f.id === 'overwatch')!.modes!.map((m) => m.id)).toEqual(['suggest']);
  });
});
