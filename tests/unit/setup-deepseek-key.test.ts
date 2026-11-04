// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { StepCredentials } from '@/components/setup/StepCredentials';

afterEach(() => { vi.unstubAllGlobals(); });

it('the credentials screen suggests DeepSeek first, with the how-to, a rough cost, the price page and a Test that checks DeepSeek', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const data = { anthropicKey: '', openrouterKey: '', grokKey: '', deepseekKey: 'sk-test', ollamaUrl: '' };
  await act(async () => { root.render(createElement(StepCredentials, { data, update: () => {} } as never)); });
  const block = container.querySelector('[data-testid="deepseek-key"]')!;
  expect(block.textContent).toContain('under $1 for every 1,000 messages');
  expect(block.textContent).toContain('sent to DeepSeek');
  expect([...block.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
    'https://platform.deepseek.com/api_keys', 'https://api-docs.deepseek.com/quick_start/pricing',
  ]);
  expect(container.querySelector('#cred-deepseek')).not.toBeNull();
  // Suggested first: it comes before the Anthropic field.
  expect(container.innerHTML.indexOf('cred-deepseek')).toBeLessThan(container.innerHTML.indexOf('cred-anthropic'));
  const test = [...block.querySelectorAll('button')].find((b) => b.textContent?.includes('Test'))!;
  await act(async () => { test.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('test-key'))!;
  expect(JSON.parse((call[1] as { body: string }).body)).toEqual({ provider: 'deepseek', key: 'sk-test' });
  await act(async () => { root.unmount(); });
});

it('the Connections store accepts the key name the wizard saves it under, and the catalog declares that name', async () => {
  const { promises: fs } = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const { saveConnectorKey, readConnectorEnv } = await import('@/lib/connectors/secrets');
  const raw = JSON.parse(await fs.readFile('data/connectors-catalog.json', 'utf-8')) as { connectors: { id: string; keys?: { env?: string }[]; env?: string[] }[] };
  expect(JSON.stringify(raw.connectors.find((c) => c.id === 'deepseek'))).toContain('DEEPSEEK_API_KEY');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-key-'));
  const file = path.join(dir, 'connectors.env');
  await saveConnectorKey('DEEPSEEK_API_KEY', 'sk-test-123', new Set(['DEEPSEEK_API_KEY']), file);
  expect((await readConnectorEnv(file)).DEEPSEEK_API_KEY).toBe('sk-test-123');
  await fs.rm(dir, { recursive: true, force: true });
});
