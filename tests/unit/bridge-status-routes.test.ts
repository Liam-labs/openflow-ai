// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BridgesStatusWidget } from '@/components/systems/BridgesStatusWidget';

it('shows Slack and Teams connection state from their shipped status APIs', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.endsWith('/status')
      ? { configured: true, connected: true }
      : { config: { enabled: false } },
  }));
  vi.stubGlobal('fetch', fetchMock);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(BridgesStatusWidget)));
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/bridges/whatsapp', '/api/bridges/slack/status', '/api/bridges/teams/status',
    ]);
    for (const label of ['Slack', 'Microsoft Teams']) {
      const row = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes(label));
      expect(row?.textContent).toContain('Connected');
    }
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
