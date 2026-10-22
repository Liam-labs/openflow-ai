import { describe, expect, it } from 'vitest';
import { buildCrossChannelPrompt } from '@/lib/cross-channel-message';

describe('buildCrossChannelPrompt', () => {
  it('injects authoritative sender identity and an exact cross-channel reply route', () => {
    const prompt = buildCrossChannelPrompt({
      content: '@CJack please check the Graph setup',
      sourceChannel: { id: 'channel-email', name: "Email's and Marketing" },
      deliveryChannel: { id: 'channel-devflow', name: 'DevFlow' },
      sender: {
        id: 'roster-jack',
        name: 'Jack',
        type: 'claude-terminal',
        source: 'collab-claude wrapper',
        pid: 71799,
        projectPath: '/home/user/Emails-and-Marketing/Team/Jack',
      },
      recipientId: 'roster-cjack',
    });

    expect(prompt).toContain('DevFlow Cross-Channel API');
    expect(prompt).toContain("Email's and Marketing (`channel-email`)");
    expect(prompt).toContain('Jack (`roster-jack`)');
    expect(prompt).toContain('PID: `71799`');
    expect(prompt).toContain('Project: `/home/user/Emails-and-Marketing/Team/Jack`');
    expect(prompt).toContain('`collab.cross_channel_message`');
    expect(prompt).toContain('collab_helper.py --channel channel-email --stdin');
    expect(prompt).toContain("<<'DEVFLOW_MESSAGE'");
    expect(prompt).toContain('sourceChannelId: `channel-devflow`');
    expect(prompt).toContain('sourceParticipantId: `roster-cjack`');
    expect(prompt).toContain('targetChannelId: `channel-email`');
    expect(prompt).toContain('targetParticipantId: `roster-jack`');
    expect(prompt).toContain('Do not use `collab_helper.py` without `--channel`');
    expect(prompt).toContain('@CJack please check the Graph setup');
  });

  it('omits unavailable optional identity fields without printing undefined', () => {
    const prompt = buildCrossChannelPrompt({
      content: 'hello',
      sourceChannel: { id: 'source', name: 'Source' },
      deliveryChannel: { id: 'target', name: 'Target' },
      sender: { id: 'sender', name: 'Sender', type: 'claude' },
    });

    expect(prompt).not.toContain('undefined');
    expect(prompt).toContain('sourceParticipantId: your participant ID in `target`');
  });
});
