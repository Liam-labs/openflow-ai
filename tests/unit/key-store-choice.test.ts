// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsSync from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import { NextRequest } from 'next/server';
import { KeyStorePanel } from '@/components/setup/KeyStorePanel';
import { KEY_STORE_OPTIONS, isAvailableChoice, readKeyStoreChoice, saveKeyStoreChoice } from '@/lib/key-store-choice';

const dir = vi.hoisted(() => ({ path: '' }));
const storeKind = vi.hoisted(() => ({ kind: 'file' }));
vi.mock('@/lib/data-paths', () => ({ DataPaths: { user: { get profile() { return dir.path + '/user-profile.json'; } } } }));
vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: vi.fn(async () => null) }));
vi.mock('@/lib/api-tracking', () => ({ tracked: (_n: string, h: unknown) => h }));
vi.mock('@/lib/secret-store', () => ({ resolveSecretStore: () => ({ kind: storeKind.kind }) }));

beforeEach(() => { dir.path = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'key-store-')); storeKind.kind = 'file'; });

describe('the key store choice', () => {
  it('offers this computer (working) and a password manager (shown, not yet available)', () => {
    expect(KEY_STORE_OPTIONS.map((o) => [o.id, o.available])).toEqual([['server', true], ['password-manager', false]]);
    expect(KEY_STORE_OPTIONS[1].note).toContain('Not available yet');
  });

  it('only an available choice can be saved; the default is this computer', async () => {
    expect(isAvailableChoice('server')).toBe(true);
    expect(isAvailableChoice('password-manager')).toBe(false);
    expect(isAvailableChoice('anything')).toBe(false);
    expect(await readKeyStoreChoice()).toBe('server');
    await saveKeyStoreChoice('server');
    expect(JSON.parse(fsSync.readFileSync(nodePath.join(dir.path, 'key-store.json'), 'utf-8'))).toMatchObject({ store: 'server' });
    fsSync.writeFileSync(nodePath.join(dir.path, 'key-store.json'), JSON.stringify({ store: 'password-manager' }));
    expect(await readKeyStoreChoice()).toBe('server');
  });
});

describe('/api/setup/key-store', () => {
  it('GET reports the choice, what is really in use and the options; POST saves an available choice and refuses the rest', async () => {
    const { GET, POST } = await import('@/app/api/setup/key-store/route');
    const got = await (await GET(new NextRequest('http://localhost/api/setup/key-store'))).json();
    expect(got).toMatchObject({ success: true, choice: 'server', active: { kind: 'file', encrypted: true } });
    expect(got.options).toHaveLength(2);
    const post = (store: unknown) => POST(new NextRequest('http://localhost/api/setup/key-store', { method: 'POST', body: JSON.stringify({ store }) }));
    expect((await post('server')).status).toBe(200);
    expect((await post('password-manager')).status).toBe(400);
    expect((await POST(new NextRequest('http://localhost/api/setup/key-store', { method: 'POST', body: 'nope' }))).status).toBe(400);
  });

  it('GET says so when the app was started with its own key source', async () => {
    storeKind.kind = 'env';
    const { GET } = await import('@/app/api/setup/key-store/route');
    expect((await (await GET(new NextRequest('http://localhost/api/setup/key-store'))).json()).active).toEqual({ kind: 'env', encrypted: false });
  });
});

describe('KeyStorePanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  const api = (active = { kind: 'file', encrypted: true }) => {
    const posts: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(init.body ?? '{}')); return { ok: true, json: async () => ({ success: true }) }; }
      return { ok: true, json: async () => ({ success: true, choice: 'server', active, options: KEY_STORE_OPTIONS }) };
    }));
    return posts;
  };

  it('says where keys are kept, saves the default by itself, and lists the choices when asked', async () => {
    const posts = api();
    await act(async () => root.render(createElement(KeyStorePanel)));
    await flush();
    const text = container.querySelector('[data-testid="key-store-panel"]')?.textContent ?? '';
    expect(text).toContain('encrypted');
    expect(text).toContain('Saved.');
    expect(posts).toEqual([{ store: 'server' }]);
    await act(async () => { (Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('See the choices')) as HTMLButtonElement).click(); });
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map((r) => [r.value, r.checked, r.disabled])).toEqual([['server', true, false], ['password-manager', false, true]]);
    expect(container.textContent).toContain('Not available yet');
  });

  it('says so, and offers no choice, when the install reads keys from the environment', async () => {
    api({ kind: 'env', encrypted: false });
    await act(async () => root.render(createElement(KeyStorePanel)));
    await flush();
    expect(container.textContent).toContain('reads your keys from the environment');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('See the choices'))).toBe(false);
  });

  it('draws nothing when the server cannot be asked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await act(async () => root.render(createElement(KeyStorePanel)));
    await flush();
    expect(container.querySelector('[data-testid="key-store-panel"]')).toBeNull();
  });
});
