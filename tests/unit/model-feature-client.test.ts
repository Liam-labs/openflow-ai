import { describe, it, expect } from 'vitest';
import {
  featureFromServer,
  makeHttpClient,
  optionsFromModels,
  requestToServer,
  resultFromResponse,
  returnToFor,
  type ServerFeature,
  type ServerList,
  type ServerProvider,
} from '@/lib/model-feature-client';

const REC = { provider: 'deepseek', model: 'deepseek-chat', reason: 'Lowest cost.' };

const server = (over: Partial<ServerFeature> = {}): ServerFeature => ({
  id: 'knowledge-update',
  name: 'Automatic knowledge-base updates',
  ready: true,
  enabled: false,
  active: null,
  mode: null,
  modes: null,
  recommended: REC,
  dataSent: ['Your notes.'],
  keyConfigured: null,
  ...over,
});

const PROVIDERS: ServerProvider[] = [
  { id: 'deepseek', label: 'DeepSeek', local: false, linked: false },
  { id: 'anthropic', label: 'Anthropic', local: false, linked: true },
  { id: 'ollama', label: 'Local model (Ollama)', local: true, linked: true },
];

describe('featureFromServer', () => {
  it('renames id to model and keeps a feature with no modes free of levels', () => {
    const f = featureFromServer(server({ enabled: true, active: { provider: 'anthropic', id: 'claude-x' }, keyConfigured: true }));
    expect(f.active).toEqual({ provider: 'anthropic', model: 'claude-x' });
    expect(f.enabled).toBe(true);
    expect(f.keyConfigured).toBe(true);
    expect(f.levels).toBeUndefined();
    expect('level' in f).toBe(false);
  });
  it('treats a null key flag as not configured', () => {
    expect(featureFromServer(server({ keyConfigured: null })).keyConfigured).toBe(false);
    expect(featureFromServer(server({ keyConfigured: false })).keyConfigured).toBe(false);
  });
  it('turns modes into levels, in order, and carries the chosen mode', () => {
    const f = featureFromServer(
      server({
        modes: [
          { id: 'suggest', label: 'Suggest only' },
          { id: 'automatic', label: 'Automatic, with Undo' },
        ],
        mode: 'automatic',
      }),
    );
    expect(f.levels?.map((l) => l.id)).toEqual(['suggest', 'automatic']);
    expect(f.level).toBe('automatic');
  });
  it('keeps the ready flag', () => {
    expect(featureFromServer(server({ ready: false })).ready).toBe(false);
    expect(featureFromServer(server({ ready: true })).ready).toBe(true);
  });
  it('treats an empty mode list as no levels', () => {
    expect(featureFromServer(server({ modes: [] })).levels).toBeUndefined();
  });
});

describe('optionsFromModels', () => {
  const models = [
    { id: 'deepseek-chat', provider: 'deepseek', label: 'DeepSeek Chat' },
    { id: 'gem-1', provider: 'google', label: 'Gemini' },
    { id: 'llama', provider: 'ollama' },
  ];

  it('keeps only models of providers the server knows, and marks local ones', () => {
    const o = optionsFromModels(models, PROVIDERS, REC);
    expect(o.map((x) => x.model)).toEqual(['deepseek-chat', 'llama']);
    expect(o.find((x) => x.model === 'llama')?.local).toBe(true);
    expect(o.find((x) => x.model === 'deepseek-chat')?.local).toBeUndefined();
  });
  it('adds the recommended model when the registry does not hold it', () => {
    const o = optionsFromModels([], PROVIDERS, REC);
    expect(o).toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }]);
  });
  it('does not add it twice', () => {
    expect(optionsFromModels(models, PROVIDERS, REC).filter((x) => x.model === 'deepseek-chat')).toHaveLength(1);
  });
  it('adds the recommended model when only another provider holds a model with the same id', () => {
    const o = optionsFromModels([{ id: 'deepseek-chat', provider: 'anthropic' }], PROVIDERS, REC);
    expect(o.map((x) => `${x.provider}/${x.model}`)).toEqual(['anthropic/deepseek-chat', 'deepseek/deepseek-chat']);
  });
  it('does not add a recommendation for a provider the server does not know', () => {
    expect(optionsFromModels([], PROVIDERS, { ...REC, provider: 'mystery' })).toEqual([]);
  });
  it('marks a local recommendation as local', () => {
    expect(optionsFromModels([], PROVIDERS, { provider: 'ollama', model: 'tiny', reason: 'r' })).toEqual([
      { provider: 'ollama', model: 'tiny', local: true },
    ]);
  });
});

describe('returnToFor', () => {
  it('keeps the page and drops the markers the key page adds', () => {
    expect(returnToFor({ pathname: '/admin/automation', search: '?resume=knowledge-update&returnTo=%2Fx&provider=deepseek' })).toBe('/admin/automation');
  });
  it('keeps other query parts', () => {
    expect(returnToFor({ pathname: '/p', search: '?tab=2&resume=a' })).toBe('/p?tab=2');
  });
  it('works with no query', () => {
    expect(returnToFor({ pathname: '/p', search: '' })).toBe('/p');
  });
});

describe('requestToServer', () => {
  it('names the model with id and sends the mode and return page', () => {
    expect(requestToServer({ enabled: true, provider: 'deepseek', model: 'deepseek-chat', level: 'suggest' }, '/p')).toEqual({
      enabled: true,
      model: { provider: 'deepseek', id: 'deepseek-chat' },
      mode: 'suggest',
      returnTo: '/p',
    });
  });
  it('sends no model when the provider is given without a model name', () => {
    expect(requestToServer({ enabled: false, provider: 'deepseek' }, null).model).toBeNull();
  });
  it('sends no model when none is given, and leaves out an empty mode and return page', () => {
    expect(requestToServer({ enabled: false }, null)).toStrictEqual({ enabled: false, model: null });
  });
});

describe('resultFromResponse', () => {
  const reload = async () => featureFromServer(server({ enabled: true }));
  it('reads the feature again after a successful save', async () => {
    const r = await resultFromResponse(200, {}, reload);
    expect(r.ok).toBe(true);
  });
  it('says so when it saved but could not read it back', async () => {
    const r = await resultFromResponse(200, {}, async () => {
      throw new Error('x');
    });
    expect(r).toMatchObject({ ok: false, code: 'ERROR' });
  });
  it('passes on the missing key and the link', async () => {
    expect(await resultFromResponse(409, { code: 'KEY_MISSING', provider: 'deepseek', linkUrl: '/operations?x#systems/connections' }, reload)).toEqual({
      ok: false,
      code: 'KEY_MISSING',
      provider: 'deepseek',
      linkUrl: '/operations?x#systems/connections',
    });
  });
  it('does not accept a missing-key answer without a link', async () => {
    expect(await resultFromResponse(409, { code: 'KEY_MISSING', provider: 'deepseek' }, reload)).toMatchObject({ ok: false, code: 'ERROR' });
  });
  it('maps a feature that is not ready', async () => {
    expect(await resultFromResponse(409, { code: 'FEATURE_NOT_READY' }, reload)).toEqual({ ok: false, code: 'NOT_READY' });
  });
  it('shows the server sentence for any other refusal', async () => {
    expect(await resultFromResponse(400, { error: 'Choose a model first.', code: 'NO_MODEL' }, reload)).toEqual({
      ok: false,
      code: 'ERROR',
      message: 'Choose a model first.',
    });
    expect(await resultFromResponse(500, {}, reload)).toEqual({ ok: false, code: 'ERROR', message: 'The server refused it.' });
  });
  it('does not treat a missing-key code on another status as a missing key', async () => {
    expect(await resultFromResponse(400, { code: 'KEY_MISSING', provider: 'p', linkUrl: '/x' }, reload)).toMatchObject({ code: 'ERROR' });
  });
});

describe('makeHttpClient', () => {
  const list = (over: Partial<ServerFeature> = {}): ServerList => ({ features: [server(over)], providers: PROVIDERS });
  const respond = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

  it('loads a feature with its options and linked providers', async () => {
    const client = makeHttpClient(
      (async (url: string) => (url === '/api/model-features' ? respond(list()) : respond({ models: [{ id: 'llama', provider: 'ollama' }] }))) as unknown as typeof fetch,
      () => null,
    );
    const d = await client.load('knowledge-update');
    expect(d.feature.id).toBe('knowledge-update');
    expect(d.linkedProviders).toEqual(['anthropic', 'ollama']);
    expect(d.options.map((o) => o.model)).toEqual(['llama', 'deepseek-chat']);
  });
  it('still loads when the model list fails', async () => {
    const client = makeHttpClient(
      (async (url: string) => {
        if (url === '/api/model-features') return respond(list());
        throw new Error('down');
      }) as unknown as typeof fetch,
      () => null,
    );
    const d = await client.load('knowledge-update');
    expect(d.options).toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }]);
  });
  it('fails when the feature does not exist', async () => {
    const client = makeHttpClient((async () => respond(list())) as unknown as typeof fetch, () => null);
    await expect(client.load('nope')).rejects.toThrow();
  });
  it('ignores a model list that came with an error status', async () => {
    const client = makeHttpClient(
      (async (url: string) =>
        url === '/api/model-features' ? respond(list()) : respond({ models: [{ id: 'llama', provider: 'ollama' }] }, 500)) as unknown as typeof fetch,
      () => null,
    );
    expect((await client.load('knowledge-update')).options).toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }]);
  });
  it('fails on an error status even when the body looks like a list', async () => {
    const client = makeHttpClient((async () => respond(list(), 500)) as unknown as typeof fetch, () => null);
    await expect(client.load('knowledge-update')).rejects.toThrow();
  });
  it('fails when the list cannot be read', async () => {
    const client = makeHttpClient((async () => respond({}, 500)) as unknown as typeof fetch, () => null);
    await expect(client.load('knowledge-update')).rejects.toThrow();
  });
  it('sends the PUT with the page to return to, then reads the feature again', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let enabled = false;
    const client = makeHttpClient(
      (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (init?.method === 'PUT') {
          enabled = true;
          return respond({ id: 'knowledge-update', enabled: true });
        }
        if (url === '/api/model-features') return respond(list({ enabled, active: enabled ? { provider: 'deepseek', id: 'deepseek-chat' } : null }));
        return respond({ models: [] });
      }) as unknown as typeof fetch,
      () => ({ pathname: '/admin/automation', search: '?resume=knowledge-update' }),
    );
    const r = await client.update('knowledge-update', { enabled: true, provider: 'deepseek', model: 'deepseek-chat' });
    const put = calls.find((c) => c.init?.method === 'PUT');
    expect(put?.url).toBe('/api/model-features/knowledge-update');
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      enabled: true,
      model: { provider: 'deepseek', id: 'deepseek-chat' },
      returnTo: '/admin/automation',
    });
    expect(r.ok && r.feature.enabled).toBe(true);
  });
  it('passes a 409 missing key through', async () => {
    const client = makeHttpClient(
      (async (_u: string, init?: RequestInit) =>
        init?.method === 'PUT' ? respond({ code: 'KEY_MISSING', provider: 'deepseek', linkUrl: '/operations#systems/connections' }, 409) : respond(list())) as unknown as typeof fetch,
      () => null,
    );
    expect(await client.update('knowledge-update', { enabled: true, provider: 'deepseek', model: 'm' })).toMatchObject({ ok: false, code: 'KEY_MISSING' });
  });
});
