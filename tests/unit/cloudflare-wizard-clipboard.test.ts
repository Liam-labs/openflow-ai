// @vitest-environment jsdom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareWizard } from '@/components/wizards/CloudflareWizard';
import { tokenLink } from '@/lib/wizards/cloudflare-token-link';
import { WizardShellContext } from '@/components/wizards/WizardShell';

const TOKEN = 'A'.repeat(20) + 'b'.repeat(19) + '9';

describe('CloudflareWizard: pre-filled link, clipboard token, email', () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Array<Record<string, unknown>>;
  let clipboard: string;
  let tokenSaved: boolean;
  let saveReply: Record<string, unknown>;

  const state = () => ({
    success: true, passwordSet: true, tokenSaved, url: null,
    record: { enabled: false, stage: 'none', known: tokenSaved ? { accountId: 'acc', zones: [{ id: 'z1', name: 'example.com', accountId: 'acc' }] } : undefined },
    connector: { installed: true, version: '2026.9.3', running: false },
    permissions: [{ scope: 'Account', name: 'Cloudflare Tunnel', level: 'Edit', key: 'argotunnel', type: 'edit' }],
    tokenLink: tokenLink('OpenFlow test'), tokenName: 'OpenFlow test', defaultEmail: 'me@example.com',
  });
  const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
  const mount = async () => { await act(async () => { root.render(React.createElement(CloudflareWizard)); }); await flush(); await flush(); };
  const link = () => Array.from(document.body.querySelectorAll('a')).find(a => a.textContent?.includes('Open Cloudflare with the permissions filled in')) as HTMLAnchorElement;
  const comeBack = () => act(async () => { window.dispatchEvent(new Event('focus')); await new Promise(r => setTimeout(r, 0)); });

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    calls = []; clipboard = TOKEN; tokenSaved = false; saveReply = { success: true };
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: vi.fn(async () => clipboard), writeText: vi.fn(async () => undefined) } });
    globalThis.fetch = vi.fn(async (_u: string, init?: { body?: string }) => {
      const b = init?.body ? JSON.parse(init.body) as Record<string, unknown> : null;
      if (b) calls.push(b);
      if (b?.action === 'save-token') { if (saveReply.success) tokenSaved = true; return { json: async () => ({ ...state(), ...saveReply }) }; }
      return { json: async () => state() };
    }) as unknown as typeof fetch;
    window.open = vi.fn() as never;
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('shows the pre-filled link as a button that opens in a new tab, with the four-rows check and the Zone Resources step', async () => {
    await mount();
    expect(link().href).toBe(tokenLink('OpenFlow test'));
    expect(link().target).toBe('_blank');
    expect(document.body.textContent).toContain('check that all four permissions are listed');
    expect(document.body.textContent).toContain('Zone Resources');
    expect(document.body.textContent).toContain('named "OpenFlow test"');
  });

  it('reads nothing from the clipboard until the person has opened Cloudflare', async () => {
    await mount();
    await comeBack();
    expect((navigator.clipboard.readText as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('after opening Cloudflare, a token on the clipboard is checked when the person comes back', async () => {
    await mount();
    await act(async () => { link().click(); });
    await comeBack(); await flush();
    expect(calls).toEqual([{ action: 'save-token', token: TOKEN }]);
    expect(document.body.textContent).toContain('Token checked');
  });

  it('ignores clipboard text that is not a token, and never sends it anywhere', async () => {
    clipboard = 'just some copied sentence, not a token';
    await mount();
    await act(async () => { link().click(); });
    await comeBack(); await flush();
    expect(calls).toEqual([]);
  });

  it('checks the token once, not again on every focus', async () => {
    await mount();
    await act(async () => { link().click(); });
    await comeBack(); await flush();
    await comeBack(); await flush();
    expect(calls.filter(c => c.action === 'save-token')).toHaveLength(1);
  });

  it('when the check fails, shows why and offers to open Cloudflare again', async () => {
    saveReply = { success: false, problems: ['The token is missing: Zone: DNS: Edit.'] };
    await mount();
    await act(async () => { link().click(); });
    await comeBack(); await flush();
    expect(document.body.textContent).toContain('The token is missing: Zone: DNS: Edit.');
    expect(Array.from(document.body.querySelectorAll('a')).some(a => a.textContent === 'Open Cloudflare again')).toBe(true);
  });

  it('stops reading the clipboard once a token is saved by pasting it', async () => {
    await mount();
    await act(async () => { link().click(); });
    const box = document.body.querySelector('input[aria-label="Cloudflare API token"]') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, 'pasted-token-value'); box.dispatchEvent(new Event('input', { bubbles: true })); });
    const check = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent === 'Check token') as HTMLButtonElement;
    await act(async () => { check.click(); });
    await flush();
    expect(calls).toEqual([{ action: 'save-token', token: 'pasted-token-value' }]);
    (navigator.clipboard.readText as ReturnType<typeof vi.fn>).mockClear();
    await comeBack(); await flush();
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  });

  it('a token that fails the check is not checked again on every return; opening Cloudflare again re-arms it', async () => {
    saveReply = { success: false, problems: ['Bad token.'] };
    await mount();
    await act(async () => { link().click(); });
    await comeBack(); await flush();
    await comeBack(); await flush();
    expect(calls.filter(c => c.action === 'save-token')).toHaveLength(1);
    clipboard = 'B'.repeat(40);
    await act(async () => { (Array.from(document.body.querySelectorAll('a')).find(a => a.textContent === 'Open Cloudflare again') as HTMLAnchorElement).click(); });
    await comeBack(); await flush();
    expect(calls.filter(c => c.action === 'save-token').map(c => c.token)).toEqual([TOKEN, 'B'.repeat(40)]);
  });

  it('does not check the old token again when the person returns before copying the new one', async () => {
    saveReply = { success: false, problems: ['The token covers 13 domains.'] };
    await mount();
    await act(async () => { link().click(); });
    await comeBack(); await flush();
    const again = () => Array.from(document.body.querySelectorAll('a')).find(a => a.textContent === 'Open Cloudflare again') as HTMLAnchorElement;
    await act(async () => { again().click(); });
    await comeBack(); await flush();
    expect(calls.filter(c => c.action === 'save-token').map(c => c.token)).toEqual([TOKEN]);
    clipboard = 'C'.repeat(40);
    await comeBack(); await flush();
    expect(calls.filter(c => c.action === 'save-token').map(c => c.token)).toEqual([TOKEN, 'C'.repeat(40)]);
  });

  it('in the dialog, Continue stays off until the token passes and the wizard is switched on, and says what to do', async () => {
    const body = document.createElement('div'); document.body.appendChild(body);
    const mountShell = async () => { await act(async () => { root.render(React.createElement(WizardShellContext.Provider, { value: { cardStatusEl: null, modalStatusEl: null, bodyEl: body, setTone: () => undefined } }, React.createElement(CloudflareWizard))); }); await flush(); await flush(); };
    const go = () => Array.from(body.querySelectorAll('button')).find(b => b.textContent?.includes('Continue')) as HTMLButtonElement;
    await mountShell();
    expect(go().disabled).toBe(true);
    expect(body.textContent).toContain('let the wizard check it first');
    act(() => root.unmount()); root = createRoot(container); tokenSaved = true;
    await mountShell();
    expect(go().disabled).toBe(true);
    expect(body.textContent).toContain('Press Switch on first');
    expect(body.querySelector('select[aria-label="Domain"]')).not.toBeNull();
    expect(Array.from(body.querySelectorAll('button')).some(b => b.textContent === 'Switch on')).toBe(true);
    body.remove();
  });

  it('keeps an email the person typed instead of putting the default back', async () => {
    tokenSaved = true;
    await mount();
    const email = document.body.querySelector('input[aria-label="Allowed email addresses"]') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(email, 'other@example.com'); email.dispatchEvent(new Event('input', { bubbles: true })); });
    await flush();
    expect((document.body.querySelector('input[aria-label="Allowed email addresses"]') as HTMLInputElement).value).toBe('other@example.com');
  });

  it('survives a browser that refuses clipboard reads: the paste box still works', async () => {
    (navigator.clipboard.readText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('denied'));
    await mount();
    await act(async () => { link().click(); });
    await comeBack(); await flush();
    expect(calls).toEqual([]);
    expect(document.body.querySelector('input[aria-label="Cloudflare API token"]')).not.toBeNull();
  });

  it('offers the default email as the address allowed to sign in once a token is saved', async () => {
    tokenSaved = true;
    await mount();
    const email = document.body.querySelector('input[aria-label="Allowed email addresses"]') as HTMLInputElement;
    expect(email.value).toBe('me@example.com');
  });
});
