// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InstallAddress } from '@/components/setup/InstallAddress';
import { installedAddressUrl, parseInstallAddressResult } from '@/lib/setup/install-address';

const fetchMock = vi.fn();
let host: HTMLDivElement;
let root: Root;
const response = (address: unknown, serverMode = true) => ({ ok: true, json: async () => ({ serverMode, address }) });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(createElement(InstallAddress)));

it('shows the installer-selected address without a choice or claim request', async () => {
  fetchMock.mockResolvedValue(response({ url: 'https://random-name.example.test', state: 'ready', source: 'managed' }));
  await render();
  expect(host.querySelector('a')?.href).toBe('https://random-name.example.test/');
  expect(host.querySelectorAll('button,input,select')).toHaveLength(0);
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/setup/address');
  expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
});

it('waits for the certificate before linking, then stops refreshing', async () => {
  fetchMock.mockResolvedValueOnce(response({ url: 'https://chosen.example.test', state: 'certificate', source: 'managed' }))
    .mockResolvedValue(response({ url: 'https://chosen.example.test', state: 'ready', source: 'managed' }));
  await render();
  expect(host.textContent).toContain('securing your address');
  expect(host.querySelector('a')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.querySelector('a')).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('labels the actual unreachable-service fallback without inventing HTTPS', async () => {
  fetchMock.mockResolvedValue(response({ url: 'http://203.0.113.8', state: 'ready', source: 'fallback', reason: 'unreachable' }));
  await render();
  expect(host.textContent).toContain('names service could not be reached');
  expect(host.textContent).toContain('does not have HTTPS yet');
  expect(host.querySelector('a')?.href).toBe('http://203.0.113.8/');
});

it('retries a failed status read without claiming another name', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false }).mockResolvedValue(response({ url: 'https://same-name.example.test', state: 'ready', source: 'managed' }));
  await render();
  await act(async () => host.querySelector('button')!.click());
  expect(host.querySelector('a')?.hostname).toBe('same-name.example.test');
  expect(fetchMock.mock.calls.every(([url, init]) => url === '/api/setup/address' && !init.method)).toBe(true);
});

it('does not add an address panel to a local installation', async () => {
  fetchMock.mockResolvedValue(response(null, false));
  await render();
  expect(host.textContent).toBe('');
});

it.each(['javascript:alert(1)', 'https://owner:password@example.test', 'https://example.test/?token=secret', 'https://example.test/#secret'])('refuses unsafe installer address %s', value => {
  expect(installedAddressUrl(value)).toBeNull();
});

it('does not treat an insecure managed name as ready', () => {
  expect(() => parseInstallAddressResult({ serverMode: true, address: { url: 'http://chosen.example.test', state: 'ready', source: 'managed' } })).toThrow();
});
