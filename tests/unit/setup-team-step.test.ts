// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StepMeetTeam } from '@/components/setup/StepMeetTeam';

let container: HTMLDivElement;
let root: Root;

const agents = [
  { name: 'Jack', roleSlug: 'team-lead', summary: 'Team lead.', firstMessage: 'Hello Jack.', default: true },
  { name: 'Builder', roleSlug: 'backend-dev', summary: 'Backend developer.', firstMessage: 'Hello Builder.', default: true },
  { name: 'Heimdall', roleSlug: 'researcher', summary: 'Researcher.', firstMessage: 'Hello Heimdall.', default: true },
  { name: 'Architect', roleSlug: 'architect', summary: 'Architect.', firstMessage: 'Hello Architect.', default: false },
  { name: 'Developer', roleSlug: 'frontend-dev', summary: 'Frontend developer.', firstMessage: 'Hello Developer.', default: false },
];

async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      success: true, agents, defaultWorkingDirectory: '/home/user/devflow-projects/first-project',
      runtimes: { claude: { installed: true }, antigravity: { installed: false, install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' } },
    }),
  })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const boxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
const ticked = () => boxes().filter((b) => b.checked).map((b) => b.closest('label')?.textContent?.split(/[A-Z][a-z]+\s/)[0] ?? '');

it('offers the whole starter team, with only the default agents ticked', async () => {
  await act(async () => root.render(createElement(StepMeetTeam, { onFinish: () => {} })));
  await flush();
  const text = container.textContent ?? '';
  for (const name of ['Jack', 'Builder', 'Heimdall', 'Architect', 'Developer']) expect(text).toContain(name);
  expect(text).not.toContain('Scout');
  expect(boxes()).toHaveLength(5);
  const byName = (name: string) => boxes().find((b) => (b.closest('label')?.textContent ?? '').includes(name))!;
  expect([byName('Jack').checked, byName('Builder').checked, byName('Heimdall').checked]).toEqual([true, true, true]);
  expect([byName('Architect').checked, byName('Developer').checked]).toEqual([false, false]);
  expect(text).toContain('You can rename them and change their personalities later');
});

it('an agent with no default flag is ticked (older example files)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, agents: [{ name: 'Old', roleSlug: 'researcher', summary: 's', firstMessage: 'm' }], runtimes: {}, defaultWorkingDirectory: '/x' }) })));
  await act(async () => root.render(createElement(StepMeetTeam, { onFinish: () => {} })));
  await flush();
  expect(boxes().map((b) => b.checked)).toEqual([true]);
});

it('offers Gemini (Antigravity) and not the old Gemini entry in the AI list', async () => {
  await act(async () => root.render(createElement(StepMeetTeam, { onFinish: () => {} })));
  await flush();
  const trigger = container.querySelector<HTMLElement>('#team-runtime');
  expect(trigger).toBeTruthy();
  await act(async () => { trigger!.click(); });
  await flush();
  const options = Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim());
  expect(options).toContain('Gemini (Antigravity)');
  expect(options).not.toContain('Gemini');
});

async function startTeamAndGetBody(props: { useDeepSeek?: boolean }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const base = globalThis.fetch as unknown as (u: string, i?: { body?: string }) => Promise<unknown>;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST' && String(url).includes('/api/setup/first-team')) {
      calls.push({ url: String(url), body: JSON.parse(init.body ?? '{}') });
      return { ok: true, json: async () => ({ success: true, channelId: 'c1', agents: [], firstMessages: {} }) };
    }
    return base(String(url), init);
  }));
  await act(async () => root.render(createElement(StepMeetTeam, { onFinish: () => {}, ...props })));
  await flush();
  const start = Array.from(container.querySelectorAll('button')).find((b) => /start/i.test(b.textContent ?? ''));
  await act(async () => { start?.click(); });
  await flush();
  return calls[0]?.body;
}

it('with only a DeepSeek key the team is started on the Claude wrapper with the deepseek-flash model', async () => {
  const body = await startTeamAndGetBody({ useDeepSeek: true });
  expect(body).toMatchObject({ agentType: 'claude', model: 'deepseek-flash' });
});

it('without it no model is forced', async () => {
  const body = await startTeamAndGetBody({});
  expect(body?.agentType).toBe('claude');
  expect(body?.model).toBeUndefined();
});

it('when Jack was started in the Setup channel, he is greeted there and the wizard finishes into that channel', async () => {
  const posts: Record<string, unknown>[] = [];
  const base = globalThis.fetch as unknown as (u: string, i?: unknown) => Promise<unknown>;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST' && String(url).includes('/api/setup/first-team')) {
      return { ok: true, json: async () => ({
        success: true, channelId: 'team-1', agents: [{ name: 'Lead', started: true }], firstMessages: { Lead: 'hi lead' },
        setupChannel: { status: 'created', channelId: 'setup-1', guideStarted: true, firstMessage: 'Say hello as Jack.' },
      }) };
    }
    if (init?.method === 'POST' && String(url) === '/api/collab') { posts.push(JSON.parse(init.body ?? '{}')); return { ok: true, json: async () => ({ success: true }) }; }
    return base(String(url), init);
  }));
  const onFinish = vi.fn();
  await act(async () => root.render(createElement(StepMeetTeam, { onFinish })));
  await flush();
  await act(async () => { Array.from(container.querySelectorAll('button')).find((b) => /start/i.test(b.textContent ?? ''))?.click(); });
  await flush();
  expect(posts.some((p) => p.action === 'message' && p.channelId === 'setup-1' && p.content === '@Jack Say hello as Jack.' && p.isHidden === true)).toBe(true);
  await act(async () => { Array.from(container.querySelectorAll('button')).find((b) => /finish|continue/i.test(b.textContent ?? ''))?.click(); });
  expect(onFinish).toHaveBeenCalledWith('team-1', 'setup-1');
});

it('without a Setup channel nothing is sent to one and no assistant channel is passed on', async () => {
  const posts: Record<string, unknown>[] = [];
  const base = globalThis.fetch as unknown as (u: string, i?: unknown) => Promise<unknown>;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST' && String(url).includes('/api/setup/first-team')) {
      return { ok: true, json: async () => ({ success: true, channelId: 'team-1', agents: [{ name: 'Lead', started: true }], firstMessages: { Lead: 'hi lead' }, setupChannel: { status: 'exists' } }) };
    }
    if (init?.method === 'POST' && String(url) === '/api/collab') { posts.push(JSON.parse(init.body ?? '{}')); return { ok: true, json: async () => ({ success: true }) }; }
    return base(String(url), init);
  }));
  const onFinish = vi.fn();
  await act(async () => root.render(createElement(StepMeetTeam, { onFinish })));
  await flush();
  await act(async () => { Array.from(container.querySelectorAll('button')).find((b) => /start/i.test(b.textContent ?? ''))?.click(); });
  await flush();
  expect(posts.every((p) => p.channelId === 'team-1')).toBe(true);
  await act(async () => { Array.from(container.querySelectorAll('button')).find((b) => /finish|continue/i.test(b.textContent ?? ''))?.click(); });
  expect(onFinish).toHaveBeenCalledWith('team-1', null);
});

it('after 45 seconds with no reply it says no AI is probably connected, instead of staying on "starting up"', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  try {
    const base = globalThis.fetch as unknown as (u: string, i?: unknown) => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST' && String(url).includes('/api/setup/first-team')) {
        return { ok: true, json: async () => ({ success: true, channelId: 'team-1', agents: [{ name: 'Lead', started: true }], firstMessages: { Lead: 'hi lead' } }) };
      }
      if (String(url).startsWith('/api/collab?channelId=')) return { ok: true, json: async () => ({ channels: [{ messages: [] }] }) };
      if (init?.method === 'POST' && String(url) === '/api/collab') return { ok: true, json: async () => ({ success: true }) };
      return base(String(url), init);
    }));
    await act(async () => root.render(createElement(StepMeetTeam, { onFinish: () => {} })));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { Array.from(container.querySelectorAll('button')).find((b) => /start/i.test(b.textContent ?? ''))?.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(container.querySelector('[data-testid="slow-hint"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    expect(container.querySelector('[data-testid="slow-hint"]')?.textContent).toContain('no AI is connected');
  } finally {
    vi.useRealTimers();
  }
});
