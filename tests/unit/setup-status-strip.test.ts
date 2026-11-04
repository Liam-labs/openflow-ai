// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SetupStatusStrip } from '@/components/setup/SetupStatusStrip';

let container: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const summary = {
  success: true, setupChannelId: 'setup-1',
  items: [
    { id: 'password', label: 'Owner password', state: 'on' },
    { id: 'phone-access', label: 'Open it from your phone', state: 'off' },
    { id: 'memory', label: 'Shared memory', state: 'skipped' },
  ],
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('shows what is set up in the Setup channel, with plain words for each state', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => summary })));
  await act(async () => root.render(createElement(SetupStatusStrip, { channelId: 'setup-1' })));
  await flush();
  const text = container.querySelector('[data-testid="setup-status-strip"]')?.textContent ?? '';
  expect(text).toContain('Owner password: On');
  expect(text).toContain('Open it from your phone: Not set up');
  expect(text).toContain('Shared memory: Skipped');
});

it('draws nothing in any other channel', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => summary })));
  await act(async () => root.render(createElement(SetupStatusStrip, { channelId: 'team-1' })));
  await flush();
  expect(container.querySelector('[data-testid="setup-status-strip"]')).toBeNull();
});

it('draws nothing when the summary cannot be read, and reads again when the tab regains focus', async () => {
  const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({ success: false }) }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => root.render(createElement(SetupStatusStrip, { channelId: 'setup-1' })));
  await flush();
  expect(container.querySelector('[data-testid="setup-status-strip"]')).toBeNull();
  fetchMock.mockImplementation(async () => ({ ok: true, json: async () => summary }) as never);
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await flush();
  expect(container.querySelector('[data-testid="setup-status-strip"]')).not.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('offers three quick questions that send an ordinary message to Jack from the person', async () => {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(init.body ?? '{}')); return { ok: true, json: async () => ({ success: true }) }; }
    return { ok: true, json: async () => summary };
  }));
  await act(async () => root.render(createElement(SetupStatusStrip, { channelId: 'setup-1', participantId: 'p-1' })));
  await flush();
  const buttons = Array.from(container.querySelectorAll('[data-testid="quick-starts"] button'));
  expect(buttons.map((b) => b.textContent)).toEqual(['What can OpenFlow connect to?', 'What is already set up?', 'Help me set up shared memory']);
  await act(async () => { (buttons[2] as HTMLButtonElement).click(); });
  await flush();
  expect(posts).toEqual([{ action: 'message', channelId: 'setup-1', participantId: 'p-1', content: '@Jack Help me set up shared memory' }]);
  expect(container.textContent).toContain('Sent.');
});

it('says so when a quick question did not send, and shows no buttons without a participant', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: { method?: string }) => init?.method === 'POST'
    ? { ok: false, json: async () => ({ success: false }) }
    : { ok: true, json: async () => summary }));
  await act(async () => root.render(createElement(SetupStatusStrip, { channelId: 'setup-1', participantId: 'p-1' })));
  await flush();
  await act(async () => { (container.querySelector('[data-testid="quick-starts"] button') as HTMLButtonElement).click(); });
  await flush();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('did not send');
  await act(async () => root.render(createElement(SetupStatusStrip, { channelId: 'setup-1', participantId: null })));
  await flush();
  expect(container.querySelector('[data-testid="quick-starts"]')).toBeNull();
});
