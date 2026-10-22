/**
 * Regression: a single channel message must reach a modern roster Claude wrapper
 * exactly ONCE.
 *
 * Bug (2026-06-03): modern roster- Claude wrappers are inbox consumers (they read
 * `.claude/inbox-*.json` and also run their own SSE consumer). The 2026-05-22
 * change taught the PTY/tmux leg to resolve a roster- agent's ptySessionId, so
 * those wrappers ALSO got a raw `sendToPty` injection. Result: the same message
 * landed twice — once formatted by the wrapper as
 * `[Channel message from X in <ch>]` (inbox/SSE) and once raw as `[X]: ...`
 * (sendToPty). Owner saw both copies in his terminal.
 *
 * RED: inbox consumer receives sendToPty (duplicate).
 * GREEN: inbox consumers are excluded from the raw PTY leg; legacy non-inbox PTY
 *        agents (e.g. Edge, projectPath=null) still get it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (keep deliverMessage's side-effect legs inert) ──────────────────────

vi.mock('@/lib/collab-pty', () => ({
  sendToPty: vi.fn().mockReturnValue(true),
  isPtySessionActive: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/event-bus', () => ({
  eventBus: { emitEvent: vi.fn().mockReturnValue({ id: '1' }) },
  emitCollabError: vi.fn(),
}));

vi.mock('@/lib/log-writer', () => ({ logEvent: vi.fn() }));

vi.mock('@/lib/collab-utils', () => ({ parseAtMentions: vi.fn().mockReturnValue([]) }));

vi.mock('@/lib/data-io', () => ({
  withFileLock: vi.fn(async (_path: string, fn: () => Promise<unknown>) => fn()),
}));

// Keep inbox writes off disk.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    promises: {
      ...real.promises,
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue('[]'),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// ─── Import after mocks ────────────────────────────────────────────────────────

import { deliverMessage } from '@/lib/collab-delivery';
import { sendToPty } from '@/lib/collab-pty';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const CHANNEL_ID = 'channel-pty-dedup';
const SENDER_ID = 'user-owner';

function makeChannel(participants: object[], roster: object) {
  return {
    id: CHANNEL_ID,
    name: 'test-channel',
    participants: [
      { id: SENDER_ID, name: 'Owner', type: 'user' },
      ...participants,
    ],
    roster,
    messages: [],
    lastActivity: '2026-06-03T00:00:00Z',
    createdAt: '2026-06-03T00:00:00Z',
    settings: { autoRespond: false },
  } as never;
}

function makeMessage() {
  return {
    id: 'msg-1',
    channelId: CHANNEL_ID,
    from: { id: SENDER_ID, name: 'Owner', type: 'user' },
    content: 'where are we with the message deliver fix?',
    timestamp: '2026-06-03T12:00:00Z',
    // recipients undefined => broadcast (user sender => not cascade-blocked)
  } as never;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('deliverMessage — PTY leg dedup for inbox consumers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT raw-inject (sendToPty) into a modern roster Claude inbox consumer', () => {
    const reynolds = {
      id: 'roster-c751bee3',
      name: 'Reynolds',
      type: 'claude-terminal',
      projectPath: '/home/user/SG-1/Team/Reynolds',
      status: 'online',
    };
    const channel = makeChannel([reynolds], {
      agents: [{ participantId: 'roster-c751bee3', name: 'Reynolds', ptySessionId: 'pty-sess-reynolds' }],
    });

    deliverMessage(SENDER_ID, makeMessage(), channel);

    // Reynolds has inbox + SSE delivery; the raw tmux leg is a duplicate.
    expect(sendToPty).not.toHaveBeenCalled();
  });

  it('still raw-injects (sendToPty) into a legacy non-inbox PTY agent (Edge, projectPath=null)', () => {
    const edge = {
      id: 'pty-3f568191',
      name: 'Edge',
      type: 'claude-terminal',
      projectPath: null,
      status: 'online',
    };
    const channel = makeChannel([edge], { agents: [] });

    deliverMessage(SENDER_ID, makeMessage(), channel);

    // Edge does not read an inbox; the PTY leg is its delivery path — keep it.
    expect(sendToPty).toHaveBeenCalledTimes(1);
  });

  it.each(['codex', 'grok'])(
    'blocks non-prefixed %s agent broadcasts from cascading to PTY agents',
    (type) => {
      const sender = { id: `agent-${type}`, name: type, type };
      const edge = {
        id: 'pty-3f568191',
        name: 'Edge',
        type: 'claude-terminal',
        projectPath: null,
        status: 'online',
      };
      const baseChannel = makeChannel([edge], { agents: [] }) as unknown as Record<string, unknown>;
      const channel = {
        ...baseChannel,
        participants: [sender, edge],
      } as never;
      const baseMessage = makeMessage() as unknown as Record<string, unknown>;
      const message = {
        ...baseMessage,
        from: sender,
        content: 'agent broadcast',
      } as never;

      deliverMessage(sender.id, message, channel);

      expect(sendToPty).not.toHaveBeenCalled();
    },
  );

  it('uses roster ledger capability to suppress stale participant PTY delivery', () => {
    const codex = {
      id: 'roster-codex',
      name: 'Codex',
      type: 'codex',
      projectPath: null,
      status: 'online',
    };
    const channel = makeChannel([codex], {
      agents: [{
        participantId: 'roster-codex',
        agentType: 'codex',
        deliveryProtocol: 'ledger-v1',
        ptySessionId: 'pty-codex',
      }],
    });

    deliverMessage(SENDER_ID, makeMessage(), channel);

    expect(sendToPty).not.toHaveBeenCalled();
  });
});
