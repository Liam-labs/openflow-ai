// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AskJackLink, askJackDraft } from '@/components/setup/AskJackLink';

let container: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  localStorage.clear();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('draws nothing until the Setup channel exists', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, items: [], setupChannelId: null }) })));
  await act(async () => root.render(createElement(AskJackLink, { topic: 'Shared memory for your team' })));
  await flush();
  expect(container.querySelector('a')).toBeNull();
});

it('links to the Setup channel and leaves a question about the card in its message box', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, items: [], setupChannelId: 'setup-1' }) })));
  await act(async () => root.render(createElement(AskJackLink, { topic: 'Shared memory for your team' })));
  await flush();
  const a = container.querySelector('a')!;
  expect(a.textContent).toContain('Ask Jack about this');
  expect(a.getAttribute('href')).toBe('/?channel=setup-1');
  // jsdom cannot navigate, so only the draft is checked.
  const assign = vi.fn();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
  await act(async () => { a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
  expect(localStorage.getItem('devflow-draft-setup-1')).toBe(askJackDraft('Shared memory for your team'));
  expect(assign).toHaveBeenCalledWith('/?channel=setup-1');
  expect(askJackDraft('X')).toContain('@Jack');
});
