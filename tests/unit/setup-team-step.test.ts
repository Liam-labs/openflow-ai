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
