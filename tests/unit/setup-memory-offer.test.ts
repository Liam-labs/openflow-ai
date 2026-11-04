// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { StepComplete } from '@/components/setup/StepComplete';

it('the last wizard screen offers shared memory, says what it keeps, and links to the Connections page without installing anything', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(StepComplete, { onGoToDashboard: () => {}, hasChannel: true })); });
  const offer = container.querySelector('[data-testid="memory-offer"]')!;
  expect(offer.textContent).toContain('Give your team a memory');
  expect(offer.textContent).toContain('never your files');
  expect(offer.textContent).toContain('stays on this computer');
  expect(offer.querySelector('a')?.getAttribute('href')).toBe('/operations#systems/connections');
  expect(container.textContent).not.toContain('browser, memory)');
  await act(async () => { root.unmount(); });
});

it('the starter team no longer has a Jack, because the setup assistant is Jack', () => {
  const data = JSON.parse(readFileSync('data/examples/agents.json', 'utf-8')) as { agents: { name: string; roleSlug: string }[] };
  expect(data.agents.map((a) => a.name)).not.toContain('Jack');
  expect(data.agents.find((a) => a.roleSlug === 'team-lead')?.name).toBe('Lead');
});
