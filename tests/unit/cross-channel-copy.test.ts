import { describe, it, expect, vi, beforeEach } from 'vitest';

const agentMessage = vi.fn();
vi.mock('@/app/api/agent/actions/collab', () => ({ message: (...args: unknown[]) => agentMessage(...args) }));

import { sendCrossChannelCopy } from '@/app/api/collab/_handlers/cross-channel-copy';
import type { CollabChannelsData } from '@/lib/types';

const data = {
  channels: [
    { id: 'signal', name: 'Signal', participants: [{ id: 'browser-user-1', name: 'Owner', type: 'user' }] },
    { id: 'acm', name: 'ACME Portal', participants: [{ id: 'jack-acm', name: 'Dave', type: 'claude' }] },
  ],
} as unknown as CollabChannelsData;

const body = (content: string, target = { channelId: 'acm', participantId: 'jack-acm' }) => ({
  action: 'message' as const, channelId: 'signal', participantId: 'browser-user-1', content, crossChannelTarget: target,
});

describe('sendCrossChannelCopy', () => {
  beforeEach(() => { agentMessage.mockReset(); agentMessage.mockResolvedValue({ messageId: 'm', sent: true }); });

  it('delivers through the cross-channel action to the exact agent and adds the @mention', async () => {
    const result = await sendCrossChannelCopy(body('please check the invoice'), data);
    expect(result).toEqual({ channelId: 'acm', channelName: 'ACME Portal', participantName: 'Dave', ok: true });
    expect(agentMessage.mock.calls[0][0]).toMatchObject({
      action: 'collab.cross_channel_message', sourceChannelId: 'signal', sourceParticipantId: 'browser-user-1',
      targetChannelId: 'acm', targetParticipantId: 'jack-acm', content: '@Dave please check the invoice',
    });
  });

  it('does not add a second @mention', async () => {
    await sendCrossChannelCopy(body('@Dave and @Sam, check this'), data);
    expect(agentMessage.mock.calls[0][0].content).toBe('@Dave and @Sam, check this');
  });

  it('reports a delivery failure instead of throwing', async () => {
    agentMessage.mockRejectedValue(new Error('Not sent: no addressed agent is online'));
    const result = await sendCrossChannelCopy(body('hello'), data);
    expect(result).toMatchObject({ ok: false, error: 'Not sent: no addressed agent is online' });
  });

  it('rejects an unknown or same-channel target without sending', async () => {
    expect(await sendCrossChannelCopy(body('x', { channelId: 'signal', participantId: 'browser-user-1' }), data)).toHaveProperty('invalid');
    expect(await sendCrossChannelCopy(body('x', { channelId: 'acm', participantId: 'nobody' }), data)).toHaveProperty('invalid');
    expect(agentMessage).not.toHaveBeenCalled();
  });
});
