// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ServiceLauncher } from '@/components/systems/connections/ServiceLauncher';
import { SERVICE_CATALOG } from '@/components/systems/connections/service-catalog';
import { useServiceStatuses } from '@/components/systems/connections/useServiceStatuses';
let host: HTMLDivElement; let root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('lists every service on a fresh install, with working Connect actions', async () => {
  const connect = vi.fn();
  await act(async () => root.render(createElement(ServiceLauncher, { statuses: {}, onConnect: connect, onRefresh: vi.fn() })));
  expect(host.querySelectorAll('article')).toHaveLength(SERVICE_CATALOG.length);
  for (const service of SERVICE_CATALOG) {
    const button = host.querySelector(`button[aria-label="Connect ${service.name}"]`) as HTMLButtonElement;
    expect(button).not.toBeNull();
    await act(async () => button.click());
    expect(connect).toHaveBeenLastCalledWith(service.id);
  }
  expect(host.textContent).toContain('Status unavailable');
  expect(host.textContent).not.toContain('Connected');
});

function StatusHarness() {
  const { statuses, refresh } = useServiceStatuses();
  return createElement(ServiceLauncher, { statuses, onConnect: () => {}, onRefresh: () => void refresh() });
}
it('keeps the launcher visible after API failures, retries on request, and never polls', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockRejectedValue(new Error('offline')); vi.stubGlobal('fetch', fetcher);
  await act(async () => root.render(createElement(StatusHarness)));
  const initialCalls = fetcher.mock.calls.length;
  expect(host.querySelectorAll('article')).toHaveLength(SERVICE_CATALOG.length);
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(fetcher).toHaveBeenCalledTimes(initialCalls);
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
  expect(fetcher).toHaveBeenCalledTimes(initialCalls * 2);
});
it('separates saved credentials from a verified live connection', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => {
    if (url.includes('sync-secrets')) return { success: true, envVars: ['OPENAI_API_KEY'] };
    if (url.includes('harness-auth')) return { credentials: [{ id: 'codex@desktop', state: 'ok' }] };
    if (url.includes('instances')) return { success: true, data: { instances: [] } };
    if (url.includes('wizards')) return { success: true, active: { url: 'https://private.test' }, record: { stage: 'live' } };
    return { configured: false, connected: false };
  } })));
  await act(async () => root.render(createElement(StatusHarness)));
  expect(host.querySelector('[aria-label="OpenAI"]')?.textContent).toContain('Key saved — not tested');
  expect(host.querySelector('[aria-label="Codex subscription"]')?.textContent).toContain('Signed in');
  expect(host.querySelector('[aria-label="Cloudflare"]')?.textContent).toContain('Configured — not verified');
  expect(host.querySelector('[aria-label="Supabase"]')?.textContent).toContain('Not connected');
});
