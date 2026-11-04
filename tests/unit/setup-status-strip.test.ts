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
