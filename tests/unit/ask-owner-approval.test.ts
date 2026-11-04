// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AskOwnerCard, describeApproval } from '@/components/AskOwnerCard';
import { formatAnswerForAgent } from '@/lib/ask-owner/route';
import type { StructuredQuestion } from '@/lib/ask-owner/types';

let container: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const question: StructuredQuestion = {
  id: 'q1', questionText: 'Test your DeepSeek key with DeepSeek?', allowOther: true, multiSelect: false,
  options: [
    { id: 'yes', label: 'Yes, test it', approval: { action: 'test-key', args: { id: 'deepseek' }, secretNames: ['DEEPSEEK_API_KEY'] } },
    { id: 'no', label: 'No' },
  ],
  askedBy: { participantId: 'p-jack', name: 'Jack' }, channelId: 'c1', status: 'pending', answer: null, createdAt: '2026-11-04T10:00:00Z',
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const click = async (text: string) => {
  const b = Array.from(container.querySelectorAll('button')).find((x) => x.textContent?.includes(text));
  await act(async () => { b?.click(); });
  await flush();
};

it('shows the owner exactly what a Yes approves, from the approval and not from the agent\'s words', async () => {
  await act(async () => root.render(createElement(AskOwnerCard, { question, currentParticipantId: 'me', onAnswer: vi.fn() })));
  expect(container.querySelector('[data-testid="approval-line"]')?.textContent).toBe(describeApproval(question.options[0].approval!));
  expect(describeApproval(question.options[0].approval!)).toContain('test-key using DEEPSEEK_API_KEY');
  expect(describeApproval(question.options[0].approval!)).toContain('once');
});

it('Yes asks the server for a one-use approval and hands its id to the agent in the answer', async () => {
  const onAnswer = vi.fn();
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, approvalId: 'appr-1', expiresAt: '2026-11-04T10:10:00Z' }) }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => root.render(createElement(AskOwnerCard, { question, currentParticipantId: 'me', onAnswer })));
  await click('Yes, test it');
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
  expect(url).toBe('/api/broker/approvals');
  expect(JSON.parse(init.body)).toEqual({ action: 'test-key', args: { id: 'deepseek' }, secretNames: ['DEEPSEEK_API_KEY'] });
  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect(onAnswer.mock.calls[0][0]).toMatchObject({ selectedOptionIds: ['yes'], approval: { id: 'appr-1', expiresAt: '2026-11-04T10:10:00Z' } });
  expect(container.textContent).toContain('Approved once');
});

it('when the approval cannot be created nothing is answered, so the agent is never told yes without one', async () => {
  const onAnswer = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ success: false, error: 'Only the signed-in owner can approve this.' }) })));
  await act(async () => root.render(createElement(AskOwnerCard, { question, currentParticipantId: 'me', onAnswer })));
  await click('Yes, test it');
  expect(onAnswer).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('signed-in owner');
});

it('No creates no approval and answers as before', async () => {
  const onAnswer = vi.fn();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => root.render(createElement(AskOwnerCard, { question, currentParticipantId: 'me', onAnswer })));
  await click('No');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(onAnswer.mock.calls[0][0]).toMatchObject({ selectedOptionIds: ['no'] });
  expect(onAnswer.mock.calls[0][0].approval).toBeUndefined();
});

it('the answer line to the agent carries the approval id, and an answer without one is unchanged', () => {
  const base = { questionId: 'q1', selectedOptionIds: ['yes'], selectedLabels: ['Yes, test it'], answeredBy: 'me', answeredAt: 'x' };
  const withApproval = formatAnswerForAgent(question, { ...base, approval: { id: 'appr-1', expiresAt: '2026-11-04T10:10:00Z' } });
  expect(withApproval).toContain('Approval: appr-1');
  expect(withApproval).toContain('one use');
  expect(formatAnswerForAgent(question, base)).not.toContain('Approval:');
});
