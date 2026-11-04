// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SilentAgentNotice } from '@/components/collab/SilentAgentNotice';

let container: HTMLDivElement;
let root: Root;
const base = Date.parse('2026-11-04T10:00:00Z');
const roster = [{ name: 'Lead', participantId: 'a1', tmuxSessionName: 'collab-lead-1', status: 'running' }];
const messages = [{ id: 'm1', from: { id: 'u', type: 'user' }, content: '@Lead hello', timestamp: new Date(base).toISOString() }];

let command = 'tmux attach -t collab-lead-1';
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  command = 'tmux attach -t collab-lead-1';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('/api/collab/attach-command')
    ? { ok: true, json: async () => ({ success: true, command }) }
    : { ok: false, json: async () => ({}) })));
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  vi.setSystemTime(base + 1_000);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('stays quiet at first, then after 45 seconds says the agent has not answered and shows the command with a copy button', async () => {
  await act(async () => root.render(createElement(SilentAgentNotice, { messages, roster, participants: [] })));
  expect(container.querySelector('[data-testid="silent-agents"]')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(46_000); });
  const text = container.querySelector('[data-testid="silent-agents"]')?.textContent ?? '';
  expect(text).toContain('Lead has not answered in 45 seconds');
  expect(text).toContain('tmux attach -t collab-lead-1');
  expect(text).toContain('sign-in');
  expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('Copy'))).toBe(true);
});

it('copies the command, can be dismissed, and offers no command for an agent without a tmux session', async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await act(async () => root.render(createElement(SilentAgentNotice, { messages, roster, participants: [] })));
  await act(async () => { await vi.advanceTimersByTimeAsync(46_000); });
  await act(async () => { Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Copy'))?.click(); });
  expect(writeText).toHaveBeenCalledWith('tmux attach -t collab-lead-1');
  expect(container.textContent).toContain('Copied');
  await act(async () => { (container.querySelector('button[aria-label^="Dismiss"]') as HTMLButtonElement).click(); });
  expect(container.querySelector('[data-testid="silent-agents"]')).toBeNull();

  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(createElement(SilentAgentNotice, { messages, roster: [{ name: 'Lead', participantId: 'a1', status: 'running' }], participants: [] })));
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  const text = container.querySelector('[data-testid="silent-agents"]')?.textContent ?? '';
  expect(text).toContain('installed and signed in');
  expect(text).not.toContain('tmux attach');
});

it('shows the command the server gives, so a container install gets the docker compose form', async () => {
  command = 'docker compose exec -it openflow tmux attach -t collab-lead-1';
  await act(async () => root.render(createElement(SilentAgentNotice, { messages, roster, participants: [] })));
  await act(async () => { await vi.advanceTimersByTimeAsync(46_000); });
  expect(container.querySelector('code')?.textContent).toBe('docker compose exec -it openflow tmux attach -t collab-lead-1');
});

it('falls back to the plain command when the server cannot be asked', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  await act(async () => root.render(createElement(SilentAgentNotice, { messages, roster, participants: [] })));
  await act(async () => { await vi.advanceTimersByTimeAsync(46_000); });
  expect(container.querySelector('code')?.textContent).toBe('tmux attach -t collab-lead-1');
});
