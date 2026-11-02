// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useWizardRefresh } from '@/components/wizards/useWizardRefresh';
const stream = vi.hoisted(() => ({ data: undefined as undefined | { wizard: string }, isConnected: false }));
vi.mock('@/lib/contexts/EventStreamContext', () => ({ useEventStream: (type: string, options: unknown) => { expect(type).toBe('wizard:changed'); expect(options).toBeUndefined(); return stream; } }));
afterEach(() => { vi.useRealTimers(); stream.data = undefined; stream.isConnected = false; });
it('reads initially, on matching events and reconnect, without periodic reads', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const refresh = vi.fn(async () => {});
  const host = document.createElement('div'); const root = createRoot(host);
  function Screen() { useWizardRefresh('tailscale', refresh); return null; }
  const render = () => act(async () => { root.render(createElement(Screen)); });
  await render(); expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(60000); }); expect(refresh).toHaveBeenCalledTimes(1);
  stream.data = { wizard: 'cloudflare' }; await render(); expect(refresh).toHaveBeenCalledTimes(1);
  stream.data = { wizard: 'tailscale' }; await render(); expect(refresh).toHaveBeenCalledTimes(2);
  stream.isConnected = true; await render(); expect(refresh).toHaveBeenCalledTimes(3);
  await render(); expect(refresh).toHaveBeenCalledTimes(3);
  stream.isConnected = false; await render(); expect(refresh).toHaveBeenCalledTimes(3);
  stream.isConnected = true; await render(); expect(refresh).toHaveBeenCalledTimes(4);
  await act(async () => root.unmount());
});
