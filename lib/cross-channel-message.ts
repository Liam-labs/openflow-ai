import type { CollabParticipant } from '@/lib/types';

import { getDevflowHome } from '@/lib/home-dir';
import { PRODUCT_NAME } from '@/lib/brand';
interface ChannelIdentity {
  id: string;
  name: string;
}

export interface CrossChannelPromptInput {
  content: string;
  sourceChannel: ChannelIdentity;
  deliveryChannel: ChannelIdentity;
  sender: Pick<CollabParticipant, 'id' | 'name' | 'type'> &
    Partial<Pick<CollabParticipant, 'source' | 'pid' | 'projectPath'>>;
  recipientId?: string;
}

/**
 * Build the prompt envelope delivered to an agent for an explicit cross-channel
 * message. It contains enough durable identity and routing data for the receiver
 * to answer the originating agent without accidentally posting in its local
 * channel or inheriting the Agent API token's display name.
 */
export function buildCrossChannelPrompt(input: CrossChannelPromptInput): string {
  const { content, sourceChannel, deliveryChannel, sender, recipientId } = input;
  const senderDetails = [
    `type: \`${sender.type}\``,
    sender.source ? `source: \`${sender.source}\`` : undefined,
    typeof sender.pid === 'number' ? `PID: \`${sender.pid}\`` : undefined,
    sender.projectPath ? `Project: \`${sender.projectPath}\`` : undefined,
  ].filter((value): value is string => Boolean(value));

  const sourceParticipantRoute = recipientId
    ? `\`${recipientId}\``
    : `your participant ID in \`${deliveryChannel.id}\``;

  return [
    `[Cross-channel delivery via the ${PRODUCT_NAME} Cross-Channel API]`,
    '',
    `Source channel: ${sourceChannel.name} (\`${sourceChannel.id}\`)`,
    `Sender: ${sender.name} (\`${sender.id}\`) — ${senderDetails.join(', ')}`,
    `Delivered into: ${deliveryChannel.name} (\`${deliveryChannel.id}\`)`,
    '',
    'Reply routing: use the shell-safe helper with the originating channel ID. It automatically invokes `collab.cross_channel_message` and preserves your identity:',
    `\`CLAUDE_PID=\${COLLAB_WRAPPER_PID:-\$PPID} python3 ${getDevflowHome()}/scripts/collab_helper.py --channel ${sourceChannel.id} --stdin <<'DEVFLOW_MESSAGE'\``,
    'Put the complete reply in a single-quoted `DEVFLOW_MESSAGE` heredoc and mention the sender.',
    'Do not use `collab_helper.py` without `--channel`, `collab.message`, or join the other channel.',
    'Underlying Agent API route (for non-shell clients):',
    `- sourceChannelId: \`${deliveryChannel.id}\``,
    `- sourceParticipantId: ${sourceParticipantRoute}`,
    `- targetChannelId: \`${sourceChannel.id}\``,
    `- targetParticipantId: \`${sender.id}\``,
    `- Mention \`@${sender.name}\` in the reply content.`,
    '',
    'Original cross-channel message:',
    content,
  ].join('\n');
}
