// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SubscriptionSignIn } from '@/components/setup/SubscriptionSignIn';

type Json = Record<string, unknown>;
let container: HTMLDivElement;
let root: Root;
let claudeState: 'needs_login' | 'ok';
let agyState: 'needs_login' | 'ok' | 'unknown';
let calls: Array<{ path: string; body: Json }>;

const credential = (harness: 'claude' | 'codex', state: string, extra: Json = {}) => ({
  id: `${harness}@desktop`, harness, host: 'desktop', label: harness, state, detail: state === 'ok' ? 'Signed in' : 'Not signed in',
  checkedAt: new Date().toISOString(), signIn: null, agents: [], ...extra,
});
const reply = (body: Json, status = 200) => ({ ok: status < 400, status, json: async () => body });

async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function click(el: Element | null | undefined) {
  if (!el) throw new Error('element not found');
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
}
const button = (text: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes(text));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  claudeState = 'needs_login';
  agyState = 'needs_login';
  calls = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { body?: string }) => {
    const body: Json = init?.body ? JSON.parse(init.body) : {};
    if (path.startsWith('/api/system/harness-auth') && !init?.body) {
      return reply({ credentials: [
        credential('claude', claudeState, claudeState === 'ok' ? { account: 'user@example.com', plan: 'max' } : {}),
        credential('codex', 'needs_login'),
        { ...credential('antigravity' as 'claude', agyState, agyState === 'ok' ? { account: 'gemini@example.com' } : { detail: agyState === 'unknown' ? 'Antigravity is not installed on this machine' : 'Not signed in' }), id: 'antigravity@desktop', harness: 'antigravity' },
      ] });
    }
    calls.push({ path, body });
    if (path === '/api/system/harness-auth/sign-in') {
      return reply({ signIn: { id: 'abcd1234', kind: 'paste-code', state: 'waiting', url: 'https://claude.com/cai/oauth/authorize?x=1' } });
    }
    if (path === '/api/system/harness-auth/sign-in/code') {
      // the credential list still says needs_login for a moment after the sign-in finishes, as in real use
      return reply({ signIn: { id: 'abcd1234', kind: 'paste-code', state: 'done' } });
    }
    return reply({ error: 'unexpected' }, 404);
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('offers both programs with the Anthropic-safe wording and shows signed-in state', async () => {
  await act(async () => root.render(createElement(SubscriptionSignIn)));
  await flush();
  expect(button('Sign in to Claude Code')).toBeTruthy();
  expect(button('Sign in to Codex')).toBeTruthy();
  expect(container.textContent).not.toContain('Sign in with Claude');

  claudeState = 'ok';
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await flush();
  expect(container.textContent).toContain('Signed in · user@example.com · max');
  expect(button('Sign in to Claude Code')).toBeUndefined();
  expect(button('Sign in to Codex')).toBeTruthy();
});

it('offers Antigravity (Gemini) too: sign in when needed, signed-in state, or an install hint when the program is missing', async () => {
  await act(async () => root.render(createElement(SubscriptionSignIn)));
  await flush();
  expect(button('Sign in to Antigravity')).toBeTruthy();

  agyState = 'ok';
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await flush();
  expect(container.textContent).toContain('Signed in · gemini@example.com');
  expect(button('Sign in to Antigravity')).toBeUndefined();

  agyState = 'unknown';
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await flush();
  expect(button('Sign in to Antigravity')).toBeUndefined();
  expect(container.textContent).toContain('curl -fsSL https://antigravity.google/cli/install.sh | bash');
  expect(button('Sign in to Claude Code')).toBeTruthy();                      // the other programs are unaffected
});

it('starts the sign-in by itself, shows the link, passes the pasted code on and ends signed in', async () => {
  await act(async () => root.render(createElement(SubscriptionSignIn)));
  await flush();
  await click(button('Sign in to Claude Code'));

  const start = calls.filter(c => c.path === '/api/system/harness-auth/sign-in');
  expect(start).toHaveLength(1);
  expect(start[0].body).toEqual({ credentialId: 'claude@desktop' });
  const link = document.querySelector<HTMLAnchorElement>('a[href^="https://claude.com/"]');
  expect(link).toBeTruthy();
  expect(link!.rel).toContain('noopener');
  expect(document.body.textContent).not.toContain('Restart blocked agents');

  const input = document.querySelector<HTMLInputElement>('input[aria-label="Sign-in code"]')!;
  expect(input.type).toBe('password');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input, 'CODE-from-the-login-page'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await click(document.querySelector('form button[type="submit"]'));

  const sent = calls.filter(c => c.path === '/api/system/harness-auth/sign-in/code');
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toEqual({ signInId: 'abcd1234', code: 'CODE-from-the-login-page' });
  expect(document.body.textContent).toContain('Signed in.');
  expect(document.body.textContent).not.toContain('Restart blocked agents');
  expect(input.value).toBe('');                       // the code is not kept in the box after sending
  const dialog = document.querySelector('[role=dialog]')!;
  expect(Array.from(dialog.querySelectorAll('button')).some(b => b.textContent?.trim() === 'Sign in')).toBe(false);   // no stray start button beside "Signed in"
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1700)); });
  expect(document.querySelector('[role=dialog]')).toBeNull();                                                          // the box closes by itself
});
