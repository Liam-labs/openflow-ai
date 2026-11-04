/**
 * After a restart the agent is told to resume. That is an instruction for the agent, so it must be hidden from the chat feed
 * (fresh-user test, 4 Nov: the Setup chat opened on a long "You were restarted..." block) but still addressed to the agent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent = vi.hoisted(() => ({ message: undefined as undefined | Record<string, unknown> }));
vi.mock('@/lib/data-paths', () => ({ DataPaths: { collabChannels: '/unused' } }));
vi.mock('@/lib/data-io', () => ({
  readJsonFile: async () => ({
    channels: [{
      id: 'c1', name: 'Setup',
      participants: [{ id: 'p-jack', type: 'claude-terminal', name: 'Jack' }],
      roster: { agents: [{ id: 'a1', name: 'Jack', participantId: 'p-jack' }] },
    }],
    lastUpdated: '',
  }),
}));
vi.mock('@/lib/collab-message-io', () => ({
  readChannelMessages: async () => ({ messages: [] }),
  appendMessageIfAbsent: async (_id: string, message: Record<string, unknown>) => { sent.message = message; return { message, appended: true }; },
}));
vi.mock('@/lib/event-bus', () => ({ eventBus: { emitEvent: vi.fn() } }));
vi.mock('@/lib/collab-delivery', () => ({ deliverMessage: vi.fn() }));
vi.mock('@/lib/collab-delivery-ledger', () => ({ enqueueDurableDeliveries: vi.fn(async () => undefined) }));

import { sendRestartResumeNotice } from '@/lib/agent-restart-notice';

beforeEach(() => { sent.message = undefined; });

describe('restart resume notice', () => {
  it('is delivered to the agent but hidden from the feed', async () => {
    const id = await sendRestartResumeNotice({ channelId: 'c1', agentId: 'a1', shutdownAt: '2026-11-04T10:00:00Z' });
    expect(id).toMatch(/^restart-resume-/);
    const m = sent.message as { content: string; recipients: string[]; metadata: { isHidden?: boolean; deliveryMode?: string; client: { kind: string } } };
    expect(m.content).toContain('You were restarted');
    expect(m.recipients).toEqual(['p-jack']);
    expect(m.metadata).toMatchObject({ isHidden: true, deliveryMode: 'targeted', client: { kind: 'devflow.restart-resume' } });
  });

  it('does nothing when the agent is no longer on the roster', async () => {
    expect(await sendRestartResumeNotice({ channelId: 'c1', agentId: 'gone', shutdownAt: 'x' })).toBeNull();
    expect(sent.message).toBeUndefined();
  });
});
