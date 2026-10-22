/**
 * Sprint 43 P3-T1 — Integration: frozen-status pipeline.
 *
 * Composes the two Sprint 43 fixes against realistic multi-agent channel state:
 *   1. lib/frozen-detection.ts thresholds + `working`/activityDetail exemption
 *      (P1-T1, ColabPanel.tsx line 1179–1192 wires this).
 *   2. lib/collab-utils.ts:250 trailing-char strip extended to `*_` for
 *      bold/italic markdown around @mentions (P1-T2).
 *
 * Scenarios covered (these are the canonical regressions we want to lock in):
 *   - "Sam deep-think" — agent broadcasts `working` for >10 minutes and has an
 *     unread @mention older than the stale threshold. Must NOT flag.
 *   - "Obi-Wan stale cursor" — agent broadcasts a non-empty activityDetail
 *     (e.g. "Reading file…") for >10 minutes with an unread @mention. Must NOT
 *     flag, even though `activity` field may be 'typing' or undefined.
 *   - "Normal frozen still fires" — online agent with a 12-minute @mention,
 *     no working/activityDetail, no recent post. Must flag.
 *   - "Bold/italic @mention" — `@Daniel*` and `@Sam_` still resolve to the
 *     correct participants and feed the frozen-detection lookup correctly.
 *   - "Lookback cap" — @mention older than 30 minutes is ignored even if
 *     unread (otherwise stale historical noise would re-flag agents forever).
 *   - "Mixed channel" — multi-participant snapshot with one frozen agent,
 *     several exempt agents, one offline, one user. Only the right one flags.
 */
import { describe, it, expect } from 'vitest';
import {
  detectFrozenParticipantIds,
  FROZEN_STALE_THRESHOLD_MS,
  FROZEN_MENTION_LOOKBACK_MS,
  type FrozenDetectionInput,
} from '@/lib/frozen-detection';
import { parseAtMentions } from '@/lib/collab-utils';
import type { CollabParticipant } from '@/lib/types';

const NOW = 1_710_000_000_000;
const iso = (ageMs: number): string => new Date(NOW - ageMs).toISOString();

function agent(id: string, name: string, opts: { lastSeenAge?: number; lastReadAge?: number } = {}): FrozenDetectionInput['participants'][number] {
  return {
    id,
    name,
    type: 'agent',
    lastSeen: iso(opts.lastSeenAge ?? 0),
    lastRead: iso(opts.lastReadAge ?? 60 * 60 * 1000),
  };
}

function user(id: string, name: string): FrozenDetectionInput['participants'][number] {
  return { id, name, type: 'user', lastSeen: iso(0), lastRead: iso(0) };
}

function msg(fromId: string, contentText: string, ageMs: number): FrozenDetectionInput['messages'][number] {
  return { from: { id: fromId }, timestamp: iso(ageMs), content: contentText };
}

// ── Scenario 1: Sam deep-think ────────────────────────────────────────────────
describe('Sprint 43 P3-T1 — Sam deep-think (working activity exemption)', () => {
  it('does NOT flag agent broadcasting `working` even with a 12-minute-old @mention', () => {
    const input: FrozenDetectionInput = {
      participants: [agent('sam', 'Margaret')],
      messages: [msg('dave', '@Margaret can you check this?', 12 * 60 * 1000)],
      activeTyping: [{ participantId: 'sam', activity: 'working', activityDetail: null }],
      now: NOW,
    };
    expect(detectFrozenParticipantIds(input).size).toBe(0);
  });

  it('does NOT flag even when @mention has been unread for 25 minutes (still in lookback window)', () => {
    const input: FrozenDetectionInput = {
      participants: [agent('sam', 'Margaret', { lastReadAge: 30 * 60 * 1000 })],
      messages: [msg('dave', '@Margaret here', 25 * 60 * 1000)],
      activeTyping: [{ participantId: 'sam', activity: 'working', activityDetail: 'Spawning sub-agents…' }],
      now: NOW,
    };
    expect(detectFrozenParticipantIds(input).size).toBe(0);
  });
});

// ── Scenario 2: Obi-Wan stale cursor ──────────────────────────────────────────
describe('Sprint 43 P3-T1 — Obi-Wan stale cursor (activityDetail exemption)', () => {
  it('does NOT flag agent with non-empty activityDetail even if `activity` is typing/undefined', () => {
    const input: FrozenDetectionInput = {
      participants: [agent('obi', 'Obi-Wan')],
      messages: [msg('dave', '@Obi-Wan you alive?', 14 * 60 * 1000)],
      activeTyping: [{ participantId: 'obi', activity: 'typing', activityDetail: 'Reading file…' }],
      now: NOW,
    };
    expect(detectFrozenParticipantIds(input).size).toBe(0);
  });

  it('TREATS empty-string activityDetail as not-set (still flags if otherwise frozen)', () => {
    const input: FrozenDetectionInput = {
      participants: [agent('obi', 'Obi-Wan')],
      messages: [msg('dave', '@Obi-Wan?', 14 * 60 * 1000)],
      activeTyping: [{ participantId: 'obi', activity: 'typing', activityDetail: '' }],
      now: NOW,
    };
    expect(Array.from(detectFrozenParticipantIds(input))).toEqual(['obi']);
  });
});

// ── Scenario 3: Normal frozen still fires ─────────────────────────────────────
describe('Sprint 43 P3-T1 — normal frozen still fires', () => {
  it('flags an online agent with a 12-minute @mention, no working/detail, no recent post', () => {
    const input: FrozenDetectionInput = {
      participants: [agent('dan', 'Daniel')],
      messages: [msg('dave', '@Daniel ping', 12 * 60 * 1000)],
      activeTyping: [],
      now: NOW,
    };
    expect(Array.from(detectFrozenParticipantIds(input))).toEqual(['dan']);
  });

  it('does NOT flag a 9-minute @mention (under the new 10-minute stale threshold)', () => {
    expect(FROZEN_STALE_THRESHOLD_MS).toBe(10 * 60 * 1000);
    const input: FrozenDetectionInput = {
      participants: [agent('dan', 'Daniel')],
      messages: [msg('dave', '@Daniel ping', 9 * 60 * 1000)],
      activeTyping: [],
      now: NOW,
    };
    expect(detectFrozenParticipantIds(input).size).toBe(0);
  });
});

// ── Scenario 4: bold / italic @mention parser → frozen lookup ────────────────
describe('Sprint 43 P3-T1 — bold/italic @mention parser feeds frozen lookup', () => {
  const participants: CollabParticipant[] = [
    { id: 'dan', name: 'Daniel', type: 'codex', source: 'test', joinedAt: iso(0), lastSeen: iso(0) },
    { id: 'sam', name: 'Margaret', type: 'codex', source: 'test', joinedAt: iso(0), lastSeen: iso(0) },
  ];

  it('strips trailing * (markdown bold) so @Daniel* still resolves to Daniel', () => {
    const ids = parseAtMentions('hey @Daniel* please review', participants);
    expect(ids).toContain('dan');
  });

  it('strips trailing _ (markdown italic) so @Margaret_ still resolves', () => {
    const ids = parseAtMentions('what does @Margaret_ think?', participants);
    expect(ids).toContain('sam');
  });

  it('strips multiple trailing markdown chars: @Daniel** and @Sam_*', () => {
    const ids1 = parseAtMentions('@Daniel** ?', participants);
    expect(ids1).toContain('dan');
    const ids2 = parseAtMentions('@Margaret_* ?', participants);
    expect(ids2).toContain('sam');
  });

  it('preserved behaviour: trailing punctuation still strips (.,!?;:)])', () => {
    const ids = parseAtMentions('@Daniel, @Margaret!', participants);
    expect(ids.sort()).toEqual(['dan', 'sam']);
  });

  it('integration: bold @mention is still detected by frozen-detection content scan', () => {
    // frozen-detection scans for `@${p.name}` substring. The bold/italic suffix
    // doesn't break that — verify here so the whole chain stays consistent.
    const input: FrozenDetectionInput = {
      participants: [agent('dan', 'Daniel')],
      messages: [msg('dave', '**@Daniel** can you take this?', 12 * 60 * 1000)],
      activeTyping: [],
      now: NOW,
    };
    expect(Array.from(detectFrozenParticipantIds(input))).toEqual(['dan']);
  });
});

// ── Scenario 5: lookback cap (Sprint 43 new behaviour) ───────────────────────
describe('Sprint 43 P3-T1 — 30-minute lookback cap', () => {
  it('does NOT flag when only @mention is older than 30 minutes', () => {
    expect(FROZEN_MENTION_LOOKBACK_MS).toBe(30 * 60 * 1000);
    const input: FrozenDetectionInput = {
      participants: [agent('dan', 'Daniel', { lastReadAge: 60 * 60 * 1000 })],
      messages: [msg('dave', '@Daniel old ping', 35 * 60 * 1000)],
      activeTyping: [],
      now: NOW,
    };
    expect(detectFrozenParticipantIds(input).size).toBe(0);
  });

  it('flags when there are TWO @mentions, one stale and one in the 10–30 min window', () => {
    const input: FrozenDetectionInput = {
      participants: [agent('dan', 'Daniel', { lastReadAge: 60 * 60 * 1000 })],
      messages: [
        msg('dave', '@Daniel ancient ping', 45 * 60 * 1000),
        msg('dave', '@Daniel newer ping',   20 * 60 * 1000),
      ],
      activeTyping: [],
      now: NOW,
    };
    expect(Array.from(detectFrozenParticipantIds(input))).toEqual(['dan']);
  });
});

// ── Scenario 6: mixed multi-agent channel snapshot ───────────────────────────
describe('Sprint 43 P3-T1 — mixed multi-agent channel snapshot', () => {
  it('flags exactly the one truly-frozen agent in a realistic 5-participant channel', () => {
    const input: FrozenDetectionInput = {
      participants: [
        // Exempt: working
        agent('sam', 'Margaret'),
        // Exempt: activityDetail set
        agent('obi', 'Obi-Wan'),
        // Frozen: idle, mentioned, hasn't posted, online
        agent('dan', 'Daniel'),
        // Offline (lastSeen 5 min ago)
        agent('mck', 'McRae', { lastSeenAge: 5 * 60 * 1000 }),
        // User — should never flag
        user('pete', 'Pete'),
      ],
      messages: [
        msg('dave', '@Margaret update?', 13 * 60 * 1000),
        msg('dave', '@Obi-Wan?',         14 * 60 * 1000),
        msg('dave', '@Daniel review pls', 12 * 60 * 1000),
        msg('dave', '@McRae merge?',     13 * 60 * 1000),
        msg('dave', '@Pete call?',       12 * 60 * 1000),
      ],
      activeTyping: [
        { participantId: 'sam', activity: 'working', activityDetail: null },
        { participantId: 'obi', activity: 'typing',  activityDetail: 'Editing route.ts…' },
      ],
      now: NOW,
    };
    expect(Array.from(detectFrozenParticipantIds(input))).toEqual(['dan']);
  });
});
