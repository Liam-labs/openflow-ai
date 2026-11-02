// @vitest-environment jsdom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WizardShellContext } from '@/components/wizards/WizardShell';
import { SignInWizard } from '@/components/wizards/SignInWizard';

// "Make a strong password for me": one click saves a made password, tests it, and shows it where the person can copy it,
// including on the Test step the dialog jumps to.
describe('SignInWizard: make a password', () => {
  let container: HTMLDivElement;
  let body: HTMLDivElement;
  let root: Root;
  let calls: Array<Record<string, unknown>>;
  let setResult: { success: boolean; error?: string };

  const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
  const mount = async (inDialog: boolean) => {
    const el = React.createElement(SignInWizard);
    await act(async () => {
      root.render(inDialog
        ? React.createElement(WizardShellContext.Provider, { value: { cardStatusEl: null, modalStatusEl: null, bodyEl: body, setTone: () => undefined } }, el)
        : el);
    });
    await flush();
  };
  const buttonByText = (t: string, scope: ParentNode = document.body) => Array.from(scope.querySelectorAll('button')).find(b => b.textContent?.trim() === t) as HTMLButtonElement | undefined;
  const made = (scope: ParentNode = document.body) => Array.from(scope.querySelectorAll('[data-testid="made-password"]')).map(e => e.textContent);

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    calls = []; setResult = { success: true };
    container = document.createElement('div'); body = document.createElement('div');
    document.body.append(container, body);
    root = createRoot(container);
    globalThis.fetch = vi.fn(async (_u: string, init?: { body?: string }) => {
      const b = init?.body ? JSON.parse(init.body) as Record<string, unknown> : null;
      if (b) calls.push(b);
      if (!b) return { json: async () => ({ success: true, passwordSet: calls.some(c => c.action === 'set'), setAt: null, signedInBrowsers: 0, exposures: [] }) };
      if (b.action === 'set') return { json: async () => setResult };
      if (b.action === 'prove') return { json: async () => ({ success: true, steps: [{ name: 'Signed in with the new password', ok: true, detail: 'ok' }] }) };
      return { json: async () => ({ success: true }) };
    }) as unknown as typeof fetch;
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); body.remove(); });

  it('saves a made password in the right shape, tests that same password, and shows it once to copy', async () => {
    await mount(false);
    await act(async () => { buttonByText('Make a strong password for me')!.click(); });
    await flush();
    const set = calls.find(c => c.action === 'set')!;
    expect(String(set.password)).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    const prove = calls.find(c => c.action === 'prove')!;
    expect(prove.password).toBe(set.password);
    expect(made()[0]).toBe(set.password);
    expect(document.body.textContent).toContain('Copy this password now');
  });

  it('shows it on the Test step too, where the dialog moves to after the test', async () => {
    await mount(true);
    await act(async () => { buttonByText('Make a strong password for me', body)!.click(); });
    await flush(); await flush();
    expect(body.querySelector('h3.sc-step-h')?.textContent).toBe('Check that it works');
    expect(made(body)).toHaveLength(1);
    expect(body.textContent).toContain('Signed in with the new password');
  });

  it('does not show a password when the save fails, and says why', async () => {
    setResult = { success: false, error: 'Too short.' };
    await mount(false);
    await act(async () => { buttonByText('Make a strong password for me')!.click(); });
    await flush();
    expect(made()).toEqual([]);
    expect(document.body.textContent).toContain('Too short.');
    expect(calls.some(c => c.action === 'prove')).toBe(false);
  });

  it('hides it again after "I have saved it"', async () => {
    await mount(false);
    await act(async () => { buttonByText('Make a strong password for me')!.click(); });
    await flush();
    expect(made().length).toBeGreaterThan(0);
    await act(async () => { buttonByText('I have saved it')!.click(); });
    expect(made()).toEqual([]);
  });

  it('keeps the own-password route inside "Or choose your own"', async () => {
    await mount(false);
    const d = document.body.querySelector('details');
    expect(d?.textContent).toContain('Or choose your own');
    expect(d?.querySelectorAll('input[type="password"]')).toHaveLength(2);
  });
});
