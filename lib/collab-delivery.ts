/**
 * Collab Delivery Helpers
 *
 * Shared utilities for message delivery: inbox writes, PTY routing,
 * Gemini bridge writes, and recipient computation.
 *
 * Used by:
 *   - app/api/collab/route.ts  (POST /api/collab)
 *   - app/api/agent/actions/collab.ts  (collab.message action)
 */

import { promises as fs } from 'fs';
import path from 'path';
import { emitCollabError, eventBus } from '@/lib/event-bus';
import { withFileLock } from '@/lib/data-io';
import { logEvent } from '@/lib/log-writer';
import { parseAtMentions } from '@/lib/collab-utils';
import { sendToPty, isPtySessionActive } from '@/lib/collab-pty';
import { buildCrossChannelPrompt } from '@/lib/cross-channel-message';
import { formatReplyContext } from '@/lib/reply-context';
import type {
  CollabChannel,
  CollabMessage,
  CollabParticipant,
  AgentRole,
} from '@/lib/types';
import { appPath } from '@/lib/app-paths';
import { getHomeDir, getWindowsHome } from '@/lib/home-dir';

// ─── Constants ────────────────────────────────────────────────────────────────

export const BRIDGE_COLLAB_PATH = `${getWindowsHome()}/devflow-bridge/collab`;
const ROLES_JSON_PATH = appPath('data', 'roles', 'roles.json');

// ─── Inbox helpers ────────────────────────────────────────────────────────────

/** Inbox filename includes participantId to avoid shared inbox conflicts */
export function getInboxFilename(participantId: string): string {
  const safeId = participantId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
  return `.claude/inbox-${safeId}.json`;
}

/**
 * Whether a participant has a Claude wrapper that reads an `.claude/inbox-*.json`
 * file at its projectPath. Both the legacy `'claude-terminal'` type and the
 * modern roster-prefix `'claude'` type use the same inbox-file pattern — the
 * type string just diverged between registration paths over time. 2026-05-22
 * fix: was checking only 'claude-terminal', so every modern-type roster claude
 * participant (e.g. BnG CRM Jack with id=roster-fc0cf8b3, type='claude')
 * silently failed all targeted-delivery legs while channel-UI / SSE viewers
 * still saw the message.
 */
function isInboxConsumer(p: { type?: string; projectPath?: string }): boolean {
  return (p.type === 'claude-terminal' || p.type === 'claude') && !!p.projectPath;
}

function isLedgerCodexRecipient(participant: CollabParticipant, channel: CollabChannel): boolean {
  if (participant.type !== 'codex') return false;
  if (participant.deliveryProtocol === 'ledger-v1') return true;
  return (channel.roster?.agents || []).some(agent =>
    agent.participantId === participant.id
    && agent.agentType === 'codex'
    && agent.deliveryProtocol === 'ledger-v1'
  );
}

/** Write collab message to a terminal participant's inbox file */
export async function writeToParticipantInbox(
  participant: CollabParticipant,
  message: CollabMessage,
  channelName: string
): Promise<void> {
  if (!isInboxConsumer(participant) || !participant.projectPath) return;

  // Path traversal guard — projectPath must be under HOME
  const HOME = getHomeDir();
  const resolvedProject = path.resolve(participant.projectPath);
  if (!resolvedProject.startsWith(HOME + path.sep)) return;

  const inboxPath = path.join(resolvedProject, getInboxFilename(participant.id));

  try {
    const claudeDir = path.dirname(inboxPath);
    await fs.mkdir(claudeDir, { recursive: true });

    await withFileLock(inboxPath, async () => {
      interface InboxData {
        sessionId: string;
        messages: Array<{
          id: string;
          type: string;
          from: string;
          senderId?: string;
          content: string;
          timestamp: string;
          read: boolean;
          channelId?: string;
          channelName?: string;
          replyTo?: { id: string; from: string; content: string };
          mentions?: string[];
          recipients?: string[];
          metadata?: CollabMessage['metadata'];
        }>;
        lastUpdated: string;
      }

      let inbox: InboxData;
      try {
        const data = await fs.readFile(inboxPath, 'utf-8');
        inbox = JSON.parse(data);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          console.warn(`[Collab] Inbox read/parse failed for ${participant.name} (${code || err}), creating fresh inbox`);
        }
        inbox = { sessionId: participant.id, messages: [], lastUpdated: new Date().toISOString() };
      }

      const imageUrls = message.metadata?.imageUrls;
      const rawContentWithImages = imageUrls && imageUrls.length > 0
        ? `${message.content}\n${imageUrls.map(url => `[Image: ${url}]`).join('\n')}`
        : message.content;
      const contentWithImages = message.metadata?.crossChannel || !participant.awayInChannelId
        ? rawContentWithImages
        : buildCrossChannelPrompt({
            content: rawContentWithImages,
            sourceChannel: { id: message.channelId, name: channelName },
            deliveryChannel: {
              id: participant.awayInChannelId,
              name: participant.awayInChannelName || participant.awayInChannelId,
            },
            sender: message.from,
            recipientId: participant.id,
          });

      inbox.messages.push({
        id: message.id,
        type: 'collab_channel',
        from: `${message.from.name} (${channelName})`,
        senderId: message.from.id,
        content: contentWithImages,
        timestamp: message.timestamp,
        read: false,
        channelId: message.channelId,
        channelName,
        mentions: message.mentions,
        recipients: message.recipients,
        metadata: message.metadata,
        replyTo: message.replyTo ? {
          id: message.replyTo.id,
          from: message.replyTo.from?.name || 'Unknown',
          content: message.replyTo.content?.slice(0, 100) || '',
        } : undefined,
      });
      inbox.lastUpdated = new Date().toISOString();

      if (inbox.messages.length > 50) inbox.messages = inbox.messages.slice(-50);

      await fs.writeFile(inboxPath, JSON.stringify(inbox, null, 2));
    });
    console.log(`[Collab] Wrote inbox notification for ${participant.name} at ${participant.projectPath}`);
  } catch (error) {
    const errorType = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.constructor.name : 'unknown');
    console.error(`[Collab] Failed to write inbox for ${participant.name}:`, error);
    emitCollabError(error, 'lib/collab-delivery', { severity: 'high', context: { participant: participant.name, op: 'inbox-write' } });
    logEvent('error', 'high', `Inbox write failed for ${participant.name}`, {
      participantName: participant.name,
      channelId: message.channelId,
      messageId: message.id,
      errorType,
    }).catch(() => {});
  }
}

/** Write collab message to bridge for Gemini/PowerShell participants */
export async function writeToGeminiBridge(
  participant: CollabParticipant,
  message: CollabMessage,
  channelName: string
): Promise<void> {
  const isGemini = participant.type === 'gemini' || participant.type === 'gemini-powershell';
  if (!isGemini || !participant.pid) return;

  const inboxPath = path.join(BRIDGE_COLLAB_PATH, `inbox-${participant.pid}.json`);

  try {
    await fs.mkdir(BRIDGE_COLLAB_PATH, { recursive: true });

    await withFileLock(inboxPath, async () => {
      interface GeminiInboxData {
        pid: number;
        participantId: string;
        channelId: string;
        channelName: string;
        messages: Array<{ id: string; from: string; content: string; timestamp: string; read: boolean }>;
        lastUpdated: string;
      }

      let inbox: GeminiInboxData;
      try {
        const data = await fs.readFile(inboxPath, 'utf-8');
        inbox = JSON.parse(data);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          console.warn(`[Collab] Gemini inbox read/parse failed (${code || err}), creating fresh inbox`);
        }
        inbox = {
          pid: participant.pid!,
          participantId: participant.id,
          channelId: message.channelId,
          channelName,
          messages: [],
          lastUpdated: new Date().toISOString(),
        };
      }

      // Gemini reads only `content`, so the reply line travels in front of it (this entry is a delivery copy; the stored message is unchanged).
      const replyLine = formatReplyContext(message.replyTo);
      inbox.messages.push({
        id: message.id, from: message.from.name, content: replyLine ? `${replyLine} ${message.content}` : message.content,
        timestamp: message.timestamp, read: false,
      });
      inbox.lastUpdated = new Date().toISOString();

      if (inbox.messages.length > 50) inbox.messages = inbox.messages.slice(-50);

      await fs.writeFile(inboxPath, JSON.stringify(inbox, null, 2));
    });
    console.log(`[Collab] Wrote bridge inbox for Gemini PID ${participant.pid}`);
  } catch (error) {
    console.error(`[Collab] Failed to write Gemini bridge inbox:`, error);
    emitCollabError(error, 'lib/collab-delivery', { severity: 'medium', context: { participant: participant.name, op: 'gemini-bridge-write' } });
  }
}

// ─── Recipient computation ────────────────────────────────────────────────────

/** Read roles from disk (lightweight, no lock needed) */
export async function readRolesData(): Promise<AgentRole[]> {
  try {
    const raw = await fs.readFile(ROLES_JSON_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return data.roles || [];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') console.error(`[Collab] Failed to read roles.json: ${code || err}`);
    return [];
  }
}

/**
 * Compute recipients for a message based on @mentions (names and roles).
 * Returns undefined for broadcasts (no @mentions), or an array of participant IDs
 * (mentioned participants + user) for targeted messages.
 */
export function computeRecipients(
  content: string,
  senderId: string,
  channel: CollabChannel,
  roles?: AgentRole[]
): string[] | undefined {
  const mentionedIds = parseAtMentions(content, channel.participants, channel.roster?.agents, roles);
  if (mentionedIds.length === 0) return undefined;

  const userParticipant = channel.participants.find(p => p.type === 'user');
  const recipients = new Set<string>(mentionedIds);
  if (userParticipant) recipients.add(userParticipant.id);
  return Array.from(recipients);
}

/**
 * SSE-leg recipients gate. Decides whether one real-time `collab:message` SSE
 * push should reach one connection — mirroring deliverMessage's inbox/PTY
 * recipients filtering (terminalTargets/ptyTargets above) for the otherwise
 * unfiltered SSE leg.
 *
 * The events route (`app/api/events`) fans every channel `collab:message` to
 * every subscriber via eventBus. Without this gate a targeted message
 * (recipients set) — e.g. an Ask-owner answer reshaped to recipients=[asker],
 * isHidden — leaked to, and was injected by, EVERY agent rather than only the
 * recipient.
 *
 * - Human/browser connections (isAgentConnection=false) are never filtered: the
 *   channel UI renders every message in real time and Ask-owner card-collapse
 *   rides the hidden answer SSE event.
 * - Broadcasts (recipients null/undefined/empty) reach every agent.
 * - Targeted (recipients set) reach only the listed participant IDs.
 */
export function sseConnectionShouldReceiveMessage(
  recipients: string[] | null | undefined,
  participantId: string | null,
  isAgentConnection: boolean
): boolean {
  if (!isAgentConnection) return true;
  if (!Array.isArray(recipients) || recipients.length === 0) return true;
  if (!participantId) return true;
  return recipients.includes(participantId);
}

// ─── Cross-channel forwarding queue ──────────────────────────────────────────

/** Get forwarding queue file path for a participant (stable across PID changes) */
function getForwardQueuePath(participantId: string): string {
  const safeId = participantId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
  return `/tmp/collab-forward-${safeId}.json`;
}

/** Write a message to an away agent's forwarding queue */
async function writeToForwardQueue(
  participant: CollabParticipant,
  message: CollabMessage,
  channelName: string
): Promise<void> {
  const queuePath = getForwardQueuePath(participant.id);

  try {
    await withFileLock(queuePath, async () => {
      interface ForwardQueue {
        participantId: string;
        messages: Array<{
          id: string;
          from: string;
          content: string;
          timestamp: string;
          sourceChannelId: string;
          sourceChannelName: string;
          replyTo?: { id: string; from: string; content: string };
        }>;
        lastUpdated: string;
      }

      let queue: ForwardQueue;
      try {
        const data = await fs.readFile(queuePath, 'utf-8');
        queue = JSON.parse(data);
      } catch {
        queue = { participantId: participant.id, messages: [], lastUpdated: new Date().toISOString() };
      }

      const imageUrls = message.metadata?.imageUrls;
      const rawContentWithImages = imageUrls && imageUrls.length > 0
        ? `${message.content}\n${imageUrls.map(url => `[Image: ${url}]`).join('\n')}`
        : message.content;
      const contentWithImages = message.metadata?.crossChannel || !participant.awayInChannelId
        ? rawContentWithImages
        : buildCrossChannelPrompt({
            content: rawContentWithImages,
            sourceChannel: { id: message.channelId, name: channelName },
            deliveryChannel: {
              id: participant.awayInChannelId,
              name: participant.awayInChannelName || participant.awayInChannelId,
            },
            sender: message.from,
            recipientId: participant.id,
          });

      queue.messages.push({
        id: message.id,
        from: message.from.name,
        content: contentWithImages,
        timestamp: message.timestamp,
        sourceChannelId: message.channelId,
        sourceChannelName: channelName,
        replyTo: message.replyTo ? {
          id: message.replyTo.id,
          from: message.replyTo.from?.name || 'Unknown',
          content: message.replyTo.content?.slice(0, 100) || '',
        } : undefined,
      });
      queue.lastUpdated = new Date().toISOString();

      // Cap at 50 messages
      if (queue.messages.length > 50) queue.messages = queue.messages.slice(-50);

      await fs.writeFile(queuePath, JSON.stringify(queue, null, 2));
    });
    console.log(`[Collab] Forwarded message to queue for away agent ${participant.name} (${participant.awayInChannelName || 'unknown channel'})`);
  } catch (error) {
    console.error(`[Collab] Failed to write forward queue for ${participant.name}:`, error);
  }
}

// ─── Full delivery pipeline ───────────────────────────────────────────────────

/**
 * Deliver a message to all eligible participants (inbox, PTY, Gemini).
 * Respects recipients filtering: undefined = broadcast, array = targeted.
 */
export function deliverMessage(
  senderId: string,
  newMessage: CollabMessage,
  channel: CollabChannel
): void {
  const { recipients } = newMessage;
  const deliveryMode: 'targeted' | 'broadcast' =
    Array.isArray(recipients) && recipients.length > 0 ? 'targeted' : 'broadcast';

  // Cascade guard (2026-05-16): an agent's broadcast must not auto-deliver to
  // other agents' inboxes/PTYs. Each agent treats inbox arrivals as a "turn to
  // respond to", which is how a single reply between agents can recursively
  // fan out into a runaway loop when multiple agents are in the same channel.
  // Rule: agent senders only deliver to other agents when explicitly @-mentioned
  // (deliveryMode === 'targeted'). User-typed messages always deliver to every
  // participant — that path is unchanged. Channel UI / human viewers still see
  // the message via SSE; this filter only suppresses the inbox/PTY/Gemini
  // delivery legs that trigger another agent's response loop.
  const sender = channel.participants.find(p => p.id === senderId);
  const senderIsAgent = sender
    ? sender.type !== 'user'
    : (senderId.startsWith('pty-') || senderId.startsWith('roster-'));
  const agentBroadcastBlocked = senderIsAgent && deliveryMode === 'broadcast';

  // Terminal participants (Claude wrappers with projectPath — both legacy
  // 'claude-terminal' and modern 'claude' types; see isInboxConsumer for the
  // 2026-05-22 fix that closes a silent-drop for modern-type roster claude
  // participants that previously had no delivery bucket at all).
  const terminalParticipants = channel.participants.filter(
    p => p.id !== senderId && isInboxConsumer(p)
  );
  let terminalTargets = recipients
    ? terminalParticipants.filter(p => recipients.includes(p.id))
    : terminalParticipants;
  if (agentBroadcastBlocked) terminalTargets = [];

  // Split: present agents get inbox write, away agents get forwarding queue
  const presentTargets = terminalTargets.filter(p => p.status !== 'away' || !p.awayInChannelId);
  const awayTargets = terminalTargets.filter(p => p.status === 'away' && p.awayInChannelId);

  // T3.2: a targeted recipient can be a roster agent that is currently STOPPED
  // and absent from channel.participants (killed agents are dropped from the
  // participant list but persist in roster.agents). parseAtMentions now keeps
  // such a mention TARGETED (resolves to the agent's stable participantId), but
  // the participant-filtered legs above would find no target and the message
  // would reach nobody. Synthesize an inbox target from the roster entry so the
  // message is queued to that agent's `.claude/inbox-<id>.json` for boot-drain.
  // Scoped to claude inbox-consumer wrappers (agentType 'claude' / unset — this
  // also covers deepseek-via-claude-wrapper); non-claude bridges
  // (antigravity, gemini) require a live pid and cannot be served while stopped.
  if (recipients && !agentBroadcastBlocked) {
    const knownParticipantIds = new Set(channel.participants.map(p => p.id));
    for (const agent of channel.roster?.agents || []) {
      if (agent.participantId === senderId) continue;
      if (!recipients.includes(agent.participantId)) continue;
      if (knownParticipantIds.has(agent.participantId)) continue; // already a live participant
      const projectPath = agent.effectiveWorkingDirectory || agent.workingDirectory;
      if (!projectPath) continue;
      if (agent.agentType && agent.agentType !== 'claude') continue;
      presentTargets.push({
        id: agent.participantId,
        name: agent.name,
        type: 'claude-terminal',
        projectPath,
        status: agent.status,
      } as unknown as CollabParticipant);
    }
  }

  // PTY participants. Two participant-id shapes feed the same PTY/tmux delivery
  // layer:
  //   1. legacy pty- prefix: sessionId is the suffix after 'pty-'
  //   2. modern roster- prefix: sessionId lives on roster.agents[].ptySessionId,
  //      looked up by participantId
  // 2026-05-22 fix: pre-existing code only handled (1), so modern roster claude
  // wrappers (Jack, Reynolds, etc.) never received the immediate tmux-inject leg.
  // The inbox-write leg (fixed earlier today) covered the safety-net poll within
  // ~120s, but the live-inject fast path was silently absent. Pair both legs so
  // a modern wrapper sees the @mention within milliseconds of channel-post.
  const resolvePtySessionId = (p: CollabParticipant): string | null => {
    if (p.id.startsWith('pty-')) return p.id.replace('pty-', '');
    if (p.id.startsWith('roster-')) {
      const agent = (channel.roster?.agents || []).find(a => a.participantId === p.id);
      return agent?.ptySessionId || null;
    }
    return null;
  };
  const ptyParticipants = channel.participants.filter(p => {
    if (p.id === senderId) return false;
    // Ledger-aware Codex wrappers claim from the durable server record. SSE,
    // polling, and PTY are wake-up mechanisms only; direct PTY injection would
    // bypass the lease and create a second delivery authority.
    if (isLedgerCodexRecipient(p, channel)) return false;
    // Inbox-consumer wrappers (Claude terminals) are served by their own ~2s
    // inbox poller, which injects the canonical `[Channel message from X in
    // <channelId>]` form. The PTY fast-path would ALSO inject the same message
    // (as `[X]: ...`), producing a duplicate in the agent's terminal. Serve
    // each wrapper via exactly one leg — the inbox poller — and skip the PTY
    // fast-path for them. Pure-PTY participants (no inbox) still use this leg.
    if (isInboxConsumer(p)) return false;
    return !!resolvePtySessionId(p);
  });
  let ptyTargets = recipients
    ? ptyParticipants.filter(p => recipients.includes(p.id))
    : ptyParticipants;
  if (agentBroadcastBlocked) ptyTargets = [];

  // Gemini participants
  const geminiParticipants = channel.participants.filter(
    p => p.id !== senderId && (p.type === 'gemini' || p.type === 'gemini-powershell') && p.pid
  );
  let geminiTargets = recipients
    ? geminiParticipants.filter(p => recipients.includes(p.id))
    : geminiParticipants;
  if (agentBroadcastBlocked) geminiTargets = [];

  if (agentBroadcastBlocked && (terminalParticipants.length + ptyParticipants.length + geminiParticipants.length) > 0) {
    const skipped = terminalParticipants.length + ptyParticipants.length + geminiParticipants.length;
    console.log(`[Collab] Cascade guard: agent broadcast from ${sender?.name || senderId} suppressed for ${skipped} agent recipient(s) — channel UI / users still see it via SSE`);
  }

  void (async () => {
    // Inbox writes for present terminal agents
    Promise.allSettled(
      presentTargets.map(p => {
        return writeToParticipantInbox(p, newMessage, channel.name);
      })
    ).then(results => {
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          console.error(`[Collab] Inbox notification failed for ${presentTargets[i]?.name}:`, result.reason);
        }
      });
    });

    // Forward queue for away terminal agents
    if (awayTargets.length > 0) {
      Promise.allSettled(
        awayTargets.map(p => {
          return writeToForwardQueue(p, newMessage, channel.name);
        })
      ).then(results => {
        results.forEach((result, i) => {
          if (result.status === 'rejected') {
            console.error(`[Collab] Forward queue write failed for ${awayTargets[i]?.name}:`, result.reason);
          }
        });
      });
    }

    // PTY participants — sessionId resolution covers both pty- and roster-
    // prefix shapes (see resolvePtySessionId above).
    for (const ptyParticipant of ptyTargets) {
      const sessionId = resolvePtySessionId(ptyParticipant);
      if (sessionId && isPtySessionActive(sessionId)) {
        const perTarget = newMessage;
        let formattedMessage = `[${perTarget.from.name}]: ${perTarget.content}`;
        const replyLine = formatReplyContext(perTarget.replyTo);
        if (replyLine) formattedMessage = `[${perTarget.from.name}] ${replyLine}: ${perTarget.content}`;
        const sent = sendToPty(sessionId, formattedMessage);
        if (sent) {
          console.log(`[Collab] Routed message to PTY session ${sessionId}`);
        } else {
          console.error(`[Collab] Failed to route to PTY session ${sessionId}`);
        }
      }
    }

    // Gemini participants
    Promise.allSettled(
      geminiTargets.map(p => {
        return writeToGeminiBridge(p, newMessage, channel.name);
      })
    ).then(results => {
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          console.error(`[Collab] Gemini bridge write failed for ${geminiTargets[i]?.name}:`, result.reason);
        }
      });
    });
  })();
}
