/** Acknowledged Claude handoff using the existing hostd inbox operation. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DataPaths } from '@/lib/data-paths';
import { withFileLock, writeJsonFile } from '@/lib/data-io';
import { appendMessageIfAbsent } from '@/lib/collab-message-io';
import { participantPresence } from '@/lib/collab-presence';
import { eventBus } from '@/lib/event-bus';
import { hostCall } from '@/lib/host-executor';
import { getHostInfo, hostIds } from '@/lib/host-registry';
import type { AgentRosterEntry, CollabChannel, CollabMessage } from '@/lib/types';
import type { ScheduledAgentReminderResult } from '@/lib/scheduled-agent-reminder';

interface HandoffReceipt {
  requestHash: string;
  result?: ScheduledAgentReminderResult;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function sendScheduledClaudeReminder(
  message: CollabMessage,
  channel: CollabChannel,
  agent: AgentRosterEntry,
): Promise<ScheduledAgentReminderResult> {
  // This is an idempotency receipt, not another delivery queue. Keep the claim
  // independently of rotating channel/inbox history. An ambiguous handoff is
  // never automatically retried, including after a server restart.
  const directory = path.join(DataPaths.cronLogs, 'scheduled-reminder-receipts');
  const receiptPath = path.join(directory, `${digest(message.id)}.json`);
  const requestHash = digest(JSON.stringify([
    message.channelId, message.recipients, message.content, message.metadata?.client?.jobId,
  ]));
  return withFileLock(receiptPath, async () => {
    await fs.mkdir(directory, { recursive: true });
    let prior: HandoffReceipt | undefined;
    try {
      prior = JSON.parse(await fs.readFile(receiptPath, 'utf8')) as HandoffReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (prior) {
      if (prior.requestHash !== requestHash) throw new Error(`Scheduled reminder execution ID reused: ${message.id}`);
      if (prior.result) return prior.result;
      throw new Error(`Scheduled reminder ${message.id} handoff is unconfirmed; refusing duplicate dispatch`);
    }

    const participant = channel.participants.find(item => item.id === agent.participantId);
    const workspace = agent.effectiveWorkingDirectory || agent.workingDirectory;
    const session = participant?.host?.tmuxSession;
    if (agent.status !== 'running' || !participant || !agent.useCollabWrapper
      || !['claude', 'claude-terminal'].includes(participant.type)
      || participant.status === 'away' || participant.status === 'offline'
      || participantPresence(participant, channel) !== 'online'
      || !workspace || participant.projectPath !== workspace || participant.host?.cwd !== workspace
      || !session || session !== agent.tmuxSessionName) {
      throw new Error(`Scheduled reminder Claude target ${agent.participantId} is unavailable; no verified wrapper inbox`);
    }
    const owners = hostIds().filter(id => {
      const host = getHostInfo(id);
      return host?.fresh && host.sessions.includes(session);
    });
    if (owners.length !== 1) {
      throw new Error(`Scheduled reminder Claude target ${agent.participantId} has no unique live host; inbox acceptance unconfirmed`);
    }

    // Exclusive creation also fails closed if another server process claimed
    // this execution. Flush before any channel persistence or remote dispatch.
    const claim = await fs.open(receiptPath, 'wx', 0o600);
    try {
      await claim.writeFile(JSON.stringify({ requestHash } satisfies HandoffReceipt));
      await claim.sync();
    } finally {
      await claim.close();
    }
    const canonical = await appendMessageIfAbsent(channel.id, message);
    if (!canonical.appended) {
      throw new Error(`Scheduled reminder ${message.id} already exists but its handoff is unconfirmed; refusing duplicate dispatch`);
    }
    let acknowledgement: { appended?: unknown; duplicate?: unknown } | null;
    try {
      acknowledgement = await hostCall(owners[0], 'inbox-append', {
        dir: workspace,
        participantId: participant.id,
        entry: {
          id: message.id, type: 'collab_channel', from: `${message.from.name} (${channel.name})`,
          senderId: message.from.id, content: message.content, timestamp: message.timestamp,
          channelId: channel.id, channelName: channel.name,
          mentions: message.mentions, recipients: message.recipients, metadata: message.metadata,
        },
      }, 20_000);
    } catch (error) {
      throw new Error(`Scheduled reminder ${message.id} host inbox handoff unconfirmed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (acknowledgement?.appended !== true && acknowledgement?.duplicate !== true) {
      throw new Error(`Scheduled reminder ${message.id} host inbox acceptance unconfirmed`);
    }
    const result: ScheduledAgentReminderResult = {
      messageId: message.id, channelId: channel.id, participantId: participant.id,
      recipientName: participant.name, deliveryState: 'queued', deliveryTransport: 'host-inbox',
      deliveryHost: owners[0], queuedAt: new Date().toISOString(),
      runtimeState: participant.status || agent.status, queuedWhileStopped: false,
    };
    await writeJsonFile(receiptPath, { requestHash, result } satisfies HandoffReceipt);
    // SSE may wake the wrapper too; its existing message-ID deduplication joins
    // these delivery legs. Do not also fire-and-forget a server-local inbox.
    eventBus.emitEvent('collab:message', { channelId: channel.id, message: canonical.message });
    return result;
  });
}
