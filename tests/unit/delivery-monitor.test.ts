import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  evaluateDeliveryAlerts,
  evaluateDeliveryBacklogs,
  evaluateDeliveryLoops,
  parsePositiveMinutes,
  reconcileCanonicalDeliveries,
  readAlertCooldowns,
  writeAlertCooldowns,
  type DeliveryAlertOpts,
  loadRecipientLiveness,
  selectNewDeadLetters,
} from '../../lib/monitors/delivery-monitor';
import { DELIVERY_PROTOCOL, type DeliveryRecord } from '../../lib/collab-delivery-ledger';
import type { CollabChannel, CollabMessage } from '../../lib/types';
import type { DeliveryEvent } from '../../lib/delivery-telemetry';

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600 * 1000).toISOString();
}

function makeOpts(overrides: Partial<DeliveryAlertOpts> = {}): DeliveryAlertOpts {
  return {
    windowHours: 1,
    failureCountThreshold: 5,
    failureRateThreshold: 0.1,
    lastAlertTimes: {},
    nowMs: Date.now(),
    alertCooldownMs: 30 * 60 * 1000,
    ...overrides,
  };
}

function failure(agentName: string, minsAgo = 10): DeliveryEvent {
  return {
    messageId: `msg-${Math.random()}`,
    status: 'delivery_failure',
    timestamp: new Date(Date.now() - minsAgo * 60 * 1000).toISOString(),
    agentName,
    channelId: 'chan-1',
    failureReason: 'injection_timeout',
  };
}

function delivered(agentName: string, minsAgo = 5): DeliveryEvent {
  return {
    messageId: `msg-${Math.random()}`,
    status: 'delivered',
    timestamp: new Date(Date.now() - minsAgo * 60 * 1000).toISOString(),
    agentName,
    channelId: 'chan-1',
  };
}

describe('parsePositiveMinutes', () => {
  it('accepts positive finite values and falls back for invalid thresholds', () => {
    expect(parsePositiveMinutes('2.5', 5)).toBe(2.5);
    expect(parsePositiveMinutes(undefined, 5)).toBe(5);
    expect(parsePositiveMinutes('not-a-number', 5)).toBe(5);
    expect(parsePositiveMinutes('0', 5)).toBe(5);
    expect(parsePositiveMinutes('-3', 5)).toBe(5);
  });
});

describe('persistent monitor cooldown state', () => {
  it('survives a monitor process restart', async () => {
    const appDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-monitor-state-'));
    process.env.DEVFLOW_APP_DATA_DIR = appDataDir;
    try {
      await writeAlertCooldowns({ 'ledger:channel:participant': 12345 });
      expect(await readAlertCooldowns()).toEqual({ 'ledger:channel:participant': 12345 });
    } finally {
      delete process.env.DEVFLOW_APP_DATA_DIR;
      await fs.rm(appDataDir, { recursive: true, force: true });
    }
  });
});

describe('canonical delivery reconciliation', () => {
  it('does not reopen the ledger once per canonical message when its delivery tombstone exists', async () => {
    const now = new Date().toISOString();
    const participant = {
      id: 'roster-codex', name: 'Codex', type: 'codex' as const, source: 'test',
      joinedAt: now, lastSeen: now, deliveryProtocol: DELIVERY_PROTOCOL,
    };
    const sender = {
      id: 'user-owner', name: 'Owner', type: 'user' as const, source: 'test',
      joinedAt: now, lastSeen: now,
    };
    const channel = {
      id: 'channel-1', name: 'Signal', createdAt: now, lastActivity: now,
      participants: [sender, participant], messages: [], settings: { autoRespond: false },
    } satisfies CollabChannel;
    const message = {
      id: 'message-1', channelId: channel.id, from: sender, content: '@Codex work',
      timestamp: now, recipients: [participant.id],
      metadata: { durableDelivery: DELIVERY_PROTOCOL },
    } satisfies CollabMessage;
    const record = {
      id: `${channel.id}:${participant.id}:${message.id}`,
      channelId: channel.id,
      participantId: participant.id,
      messageId: message.id,
      protocol: DELIVERY_PROTOCOL,
      token: `[[collab-delivery:${participant.id}:${message.id}]]`,
      state: 'handled' as const,
      message,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
      handledAt: now,
    } satisfies DeliveryRecord;
    const enqueue = vi.fn();

    const repaired = await reconcileCanonicalDeliveries(Date.now(), {
      readChannels: async () => ({ channels: [channel], lastUpdated: now }),
      readMessages: async () => ({ channelId: channel.id, messages: [message], lastUpdated: now }),
      readRecords: async () => [record],
      enqueue,
    });

    expect(repaired).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('evaluateDeliveryAlerts', () => {
  it('returns empty array when no events', () => {
    expect(evaluateDeliveryAlerts([], makeOpts())).toEqual([]);
  });

  it('returns no alert when failures below both thresholds', () => {
    // 3 failures out of 30 total = 10% rate, equal to threshold (not exceeding)
    const events: DeliveryEvent[] = [
      failure('Worf'), failure('Worf'), failure('Worf'),
      ...Array.from({ length: 27 }, () => delivered('Worf')),
    ];
    const results = evaluateDeliveryAlerts(events, makeOpts({
      failureCountThreshold: 5,
      failureRateThreshold: 0.10,  // 10% threshold; 3/30 = exactly 10% — not exceeding
    }));
    expect(results.every(r => !r.shouldAlert)).toBe(true);
  });

  it('alerts when failure count exceeds threshold', () => {
    const events: DeliveryEvent[] = Array.from({ length: 6 }, () => failure('Worf'));
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureCountThreshold: 5 }));
    const worfResult = results.find(r => r.agentName === 'Worf');
    expect(worfResult?.shouldAlert).toBe(true);
    expect(worfResult?.reason).toMatch(/count/i);
  });

  it('alerts when failure rate exceeds threshold', () => {
    // 3 failures out of 4 total = 75% rate, threshold 10%
    const events: DeliveryEvent[] = [
      failure('Jonas'), failure('Jonas'), failure('Jonas'),
      delivered('Jonas'),
    ];
    const results = evaluateDeliveryAlerts(events, makeOpts({
      failureCountThreshold: 100, // high so count doesn't trigger
      failureRateThreshold: 0.1,
    }));
    const jonasResult = results.find(r => r.agentName === 'Jonas');
    expect(jonasResult?.shouldAlert).toBe(true);
    expect(jonasResult?.reason).toMatch(/rate/i);
  });

  it('computes failure rate correctly', () => {
    const events: DeliveryEvent[] = [
      failure('Worf'), failure('Worf'),
      delivered('Worf'), delivered('Worf'), delivered('Worf'), delivered('Worf'), delivered('Worf'), delivered('Worf'), delivered('Worf'), delivered('Worf'),
    ];
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureRateThreshold: 0.5, failureCountThreshold: 100 }));
    const worfResult = results.find(r => r.agentName === 'Worf');
    expect(worfResult?.failureRate).toBeCloseTo(0.2, 2); // 2/10
    expect(worfResult?.shouldAlert).toBe(false); // 20% < 50% threshold
  });

  it('ignores events outside the time window', () => {
    const events: DeliveryEvent[] = [
      // 6 failures but all older than 1h window
      ...Array.from({ length: 6 }, () => ({
        messageId: `msg-${Math.random()}`,
        status: 'delivery_failure' as const,
        timestamp: hoursAgo(2),
        agentName: 'Worf',
      })),
    ];
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureCountThreshold: 5 }));
    const worfResult = results.find(r => r.agentName === 'Worf');
    expect(worfResult?.shouldAlert ?? false).toBe(false);
  });

  it('respects alert cooldown — no repeat alert within cooldown window', () => {
    const events: DeliveryEvent[] = Array.from({ length: 6 }, () => failure('Worf'));
    const recentAlert = Date.now() - 5 * 60 * 1000; // 5 min ago
    const opts = makeOpts({
      failureCountThreshold: 5,
      lastAlertTimes: { Worf: recentAlert },
      alertCooldownMs: 30 * 60 * 1000, // 30 min cooldown
    });
    const results = evaluateDeliveryAlerts(events, opts);
    const worfResult = results.find(r => r.agentName === 'Worf');
    expect(worfResult?.shouldAlert).toBe(false); // in cooldown
  });

  it('alerts after cooldown expires', () => {
    const events: DeliveryEvent[] = Array.from({ length: 6 }, () => failure('Worf'));
    const oldAlert = Date.now() - 45 * 60 * 1000; // 45 min ago > 30 min cooldown
    const opts = makeOpts({
      failureCountThreshold: 5,
      lastAlertTimes: { Worf: oldAlert },
      alertCooldownMs: 30 * 60 * 1000,
    });
    const results = evaluateDeliveryAlerts(events, opts);
    const worfResult = results.find(r => r.agentName === 'Worf');
    expect(worfResult?.shouldAlert).toBe(true);
  });

  it('groups results per agent independently', () => {
    const events: DeliveryEvent[] = [
      ...Array.from({ length: 6 }, () => failure('Worf')),
      delivered('Jonas'), delivered('Jonas'), delivered('Jonas'),
    ];
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureCountThreshold: 5 }));
    const worfResult = results.find(r => r.agentName === 'Worf');
    const jonasResult = results.find(r => r.agentName === 'Jonas');
    expect(worfResult?.shouldAlert).toBe(true);
    expect(jonasResult?.shouldAlert ?? false).toBe(false);
  });

  it('returns delivery counts in result', () => {
    const events: DeliveryEvent[] = [
      failure('Worf'), failure('Worf'),
      delivered('Worf'), delivered('Worf'), delivered('Worf'),
    ];
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureCountThreshold: 100 }));
    const worfResult = results.find(r => r.agentName === 'Worf');
    expect(worfResult?.failures).toBe(2);
    expect(worfResult?.delivered).toBe(3);
  });

  it('deduplicates repeated success telemetry for one delivery identity', () => {
    const event = delivered('Worf');
    event.messageId = 'message-1';
    event.participantId = 'roster-worf';
    const results = evaluateDeliveryAlerts(
      [event, { ...event }, { ...event }],
      makeOpts({ failureCountThreshold: 100 }),
    );
    expect(results.find(result => result.agentName === 'Worf')?.delivered).toBe(1);
  });

  // ─── Sprint 51 T1 ──────────────────────────────────────────────────────
  // Verifier false-positives (jsonl_ingestion_timeout) must not contribute to
  // alert counts/rates. Real loss reasons (tmux_send_failed, child_died,
  // injection_timeout) must keep firing.

  function jsonlVerifierTimeout(
    agentName: string,
    minsAgo = 10,
    failureReason = 'jsonl_ingestion_timeout',
  ): DeliveryEvent {
    return {
      messageId: `msg-${Math.random()}`,
      status: 'delivery_failure',
      timestamp: new Date(Date.now() - minsAgo * 60 * 1000).toISOString(),
      agentName,
      channelId: 'chan-1',
      failureReason,
    };
  }

  it('Sprint 51 T1 — does NOT alert when only jsonl_ingestion_timeout failures (false positives)', () => {
    // 10 verifier-timeout false positives, no real failures, no deliveries
    const events: DeliveryEvent[] = Array.from({ length: 10 }, () => jsonlVerifierTimeout('Jack'));
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureCountThreshold: 5 }));
    const jackResult = results.find(r => r.agentName === 'Jack');
    // Either Jack is filtered out entirely (no countable failures) or has zero failures and no alert.
    expect(jackResult?.shouldAlert ?? false).toBe(false);
    expect(jackResult?.failures ?? 0).toBe(0);
  });

  it('does NOT alert on jsonl_verify_timeout_noreinject failures', () => {
    const events: DeliveryEvent[] = Array.from(
      { length: 10 },
      () => jsonlVerifierTimeout('Vala', 10, 'jsonl_verify_timeout_noreinject'),
    );
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureCountThreshold: 5 }));
    const valaResult = results.find(r => r.agentName === 'Vala');
    expect(valaResult?.shouldAlert ?? false).toBe(false);
    expect(valaResult?.failures ?? 0).toBe(0);
  });

  it('Sprint 51 T1 — STILL alerts when real failures exceed threshold (jsonl mixed in)', () => {
    const events: DeliveryEvent[] = [
      // 6 real injection_timeout failures — should trigger
      ...Array.from({ length: 6 }, () => failure('Worf')),
      // 4 noise events — should NOT contribute
      ...Array.from({ length: 4 }, () => jsonlVerifierTimeout('Worf')),
    ];
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureCountThreshold: 5 }));
    const worfResult = results.find(r => r.agentName === 'Worf');
    expect(worfResult?.shouldAlert).toBe(true);
    // Failure count must reflect only the real ones — not 10.
    expect(worfResult?.failures).toBe(6);
  });

  it('Sprint 51 T1 — failure RATE excludes jsonl_ingestion_timeout from numerator', () => {
    // 1 real failure + 9 verifier false positives + 9 deliveries
    // Old behavior: 10/19 = 53% (alerts). New behavior: 1/(1+9)=10% (boundary, not exceed).
    const events: DeliveryEvent[] = [
      failure('Jonas'),
      ...Array.from({ length: 9 }, () => jsonlVerifierTimeout('Jonas')),
      ...Array.from({ length: 9 }, () => delivered('Jonas')),
    ];
    const results = evaluateDeliveryAlerts(events, makeOpts({
      failureCountThreshold: 100,
      failureRateThreshold: 0.10, // exactly 10% — must not exceed
    }));
    const jonasResult = results.find(r => r.agentName === 'Jonas');
    expect(jonasResult?.failures).toBe(1);
    expect(jonasResult?.failureRate).toBeCloseTo(0.1, 2);
    expect(jonasResult?.shouldAlert).toBe(false);
  });

  it('Sprint 51 T1 — child_died and tmux_send_failed and injection_timeout still counted', () => {
    function failureWith(reason: string): DeliveryEvent {
      return {
        messageId: `msg-${Math.random()}`,
        status: 'delivery_failure',
        timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        agentName: 'Tealc',
        channelId: 'chan-1',
        failureReason: reason,
      };
    }
    const events: DeliveryEvent[] = [
      failureWith('child_died'), failureWith('child_died'),
      failureWith('tmux_send_failed'), failureWith('tmux_send_failed'),
      failureWith('injection_timeout'), failureWith('injection_timeout'),
    ];
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureCountThreshold: 5 }));
    const tealcResult = results.find(r => r.agentName === 'Tealc');
    expect(tealcResult?.failures).toBe(6);
    expect(tealcResult?.shouldAlert).toBe(true);
  });

  // ─── Sprint 57 T2 ──────────────────────────────────────────────────────
  // Defense-in-depth: events originating from test harnesses or ad-hoc scripts
  // (agentName matching ^TestAgent$ or ^test[-_]) must never reach the
  // stability-alerts pipeline. Real agent names (Jack, Builder, Worf, Jonas…)
  // must keep alerting exactly as before.

  it('Sprint 57 T2 — TestAgent failures excluded from counts (no alert)', () => {
    const events: DeliveryEvent[] = Array.from({ length: 20 }, () => failure('TestAgent'));
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureCountThreshold: 5 }));
    const testResult = results.find(r => r.agentName === 'TestAgent');
    expect(testResult?.shouldAlert ?? false).toBe(false);
    expect(testResult?.failures ?? 0).toBe(0);
  });

  it('Sprint 57 T2 — TestAgent events excluded from rate denominator too', () => {
    // 20 TestAgent events (all failures) should not even appear in results.
    const events: DeliveryEvent[] = [
      ...Array.from({ length: 20 }, () => failure('TestAgent')),
      ...Array.from({ length: 10 }, () => delivered('TestAgent')),
    ];
    const results = evaluateDeliveryAlerts(events, makeOpts());
    const testResult = results.find(r => r.agentName === 'TestAgent');
    // Filtered completely — should not appear in byAgent bucket at all.
    expect(testResult).toBeUndefined();
  });

  it('Sprint 57 T2 — test[-_] prefix variants also excluded', () => {
    const names = ['test-agent-1', 'test_harness', 'TEST_rig', 'Test-Runner', 'testagent']; // all must be dropped
    const events: DeliveryEvent[] = names.flatMap(n =>
      Array.from({ length: 10 }, () => failure(n))
    );
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureCountThreshold: 5 }));
    for (const n of names) {
      expect(results.find(r => r.agentName === n), `${n} should be filtered`).toBeUndefined();
    }
  });

  it('Sprint 57 T2 — real agent names still alert (regression)', () => {
    const realAgents = ['Jack', 'Builder', 'Worf', 'Jonas', 'Architect'];
    const events: DeliveryEvent[] = realAgents.flatMap(n =>
      Array.from({ length: 6 }, () => failure(n))
    );
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureCountThreshold: 5 }));
    for (const n of realAgents) {
      const r = results.find(x => x.agentName === n);
      expect(r?.shouldAlert, `${n} should alert on 6 failures`).toBe(true);
      expect(r?.failures).toBe(6);
    }
  });

  it('Sprint 57 T2 — mixed: TestAgent dropped, real agent still alerts', () => {
    const events: DeliveryEvent[] = [
      ...Array.from({ length: 50 }, () => failure('TestAgent')), // noise
      ...Array.from({ length: 6 }, () => failure('Jack')),       // real
    ];
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureCountThreshold: 5 }));
    expect(results.find(r => r.agentName === 'TestAgent')).toBeUndefined();
    const jackResult = results.find(r => r.agentName === 'Jack');
    expect(jackResult?.shouldAlert).toBe(true);
    expect(jackResult?.failures).toBe(6);
  });

  it('Sprint 57 T2 — names containing test but not starting with it still counted', () => {
    // "latest-model-agent", "contestant", "Tester" — do NOT match ^test[-_]
    // (hyphen/underscore separator required) or ^TestAgent$ (not exact).
    const events: DeliveryEvent[] = [
      ...Array.from({ length: 6 }, () => failure('Tester')),
      ...Array.from({ length: 6 }, () => failure('contestant')),
      ...Array.from({ length: 6 }, () => failure('latest-agent')),
    ];
    const results = evaluateDeliveryAlerts(events, makeOpts({ failureCountThreshold: 5 }));
    expect(results.find(r => r.agentName === 'Tester')?.shouldAlert).toBe(true);
    expect(results.find(r => r.agentName === 'contestant')?.shouldAlert).toBe(true);
    expect(results.find(r => r.agentName === 'latest-agent')?.shouldAlert).toBe(true);
  });
});

describe('evaluateDeliveryLoops', () => {
  it('alerts on three rapid failures for the same delivery, including verifier timeouts', () => {
    const now = Date.now();
    const events: DeliveryEvent[] = Array.from({ length: 3 }, (_, index) => ({
      messageId: 'message-loop',
      participantId: 'roster-jack',
      channelId: 'channel-1',
      agentName: 'Jack',
      status: 'delivery_failure',
      failureReason: 'jsonl_ingestion_timeout',
      timestamp: new Date(now - index * 1_000).toISOString(),
    }));

    const loops = evaluateDeliveryLoops(events, now);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ messageId: 'message-loop', attempts: 3 });
  });

  it('does not combine failures from different message identities', () => {
    const now = Date.now();
    const events: DeliveryEvent[] = ['a', 'b', 'c'].map(messageId => ({
      messageId,
      participantId: 'roster-jack',
      channelId: 'channel-1',
      agentName: 'Jack',
      status: 'delivery_failure',
      timestamp: new Date(now).toISOString(),
    }));
    expect(evaluateDeliveryLoops(events, now)).toEqual([]);
  });
});

describe('evaluateDeliveryBacklogs', () => {
  it('groups stale replayable ledger records by recipient and channel', () => {
    const nowMs = Date.now();
    const records = [
      {
        channelId: 'signal', participantId: 'daniel', messageId: 'm1', state: 'pending',
        createdAt: new Date(nowMs - 10 * 60_000).toISOString(),
      },
      {
        channelId: 'signal', participantId: 'daniel', messageId: 'm2', state: 'submitted',
        createdAt: new Date(nowMs - 8 * 60_000).toISOString(),
      },
      {
        channelId: 'signal', participantId: 'builder', messageId: 'm3', state: 'pending',
        createdAt: new Date(nowMs - 30_000).toISOString(),
      },
      {
        channelId: 'signal', participantId: 'daniel', messageId: 'm4', state: 'handled',
        createdAt: new Date(nowMs - 20 * 60_000).toISOString(),
      },
    ];

    expect(evaluateDeliveryBacklogs(records, nowMs, 5 * 60_000)).toEqual([{
      channelId: 'signal',
      participantId: 'daniel',
      count: 2,
      oldestAgeMs: 10 * 60_000,
      oldestMessageId: 'm1',
    }]);
  });
});

describe('loadRecipientLiveness', () => {
  const now = Date.parse('2026-09-27T11:17:25.000Z');
  const channel = {
    id: 'costa',
    name: 'Costa Vida',
    createdAt: '2026-09-27T00:00:00.000Z',
    lastActivity: '2026-09-27T00:00:00.000Z',
    participants: [
      { id: 'busy', name: 'Architect', type: 'codex', source: 'test', joinedAt: '2026-09-27T00:00:00.000Z', lastSeen: '2026-09-27T11:15:00.000Z' },
      { id: 'gone', name: 'Gone', type: 'codex', source: 'test', joinedAt: '2026-09-27T00:00:00.000Z', lastSeen: '2026-09-27T09:00:00.000Z' },
    ],
    messages: [],
    settings: { autoRespond: false },
  } as unknown as CollabChannel;
  const record = (participantId: string, channelId = 'costa') => ({ channelId, participantId }) as DeliveryRecord;

  it('treats a heartbeating recipient as live and stale or unknown ones as gone', async () => {
    const isLive = await loadRecipientLiveness(async () => ({ channels: [channel], lastUpdated: '' }), now);
    expect(isLive(record('busy'))).toBe(true);
    expect(isLive(record('gone'))).toBe(false);
    expect(isLive(record('missing'))).toBe(false);
    expect(isLive(record('busy', 'other'))).toBe(false);
  });
});

describe('selectNewDeadLetters', () => {
  const rec = (id: string, state: string) => ({ id, state }) as unknown as DeliveryRecord;

  it('alerts each quarantined record once, not on every cooldown', () => {
    const times: Record<string, number> = { 'dead-letter:a': 1 };
    const picked = selectNewDeadLetters([rec('a', 'dead_letter'), rec('b', 'dead_letter'), rec('c', 'pending')], times);
    expect(picked.map(r => r.id)).toEqual(['b']);
  });

  it('prunes keys for records that left the dead-letter queue and keeps other alert keys', () => {
    const times: Record<string, number> = { 'dead-letter:gone': 1, 'dead-letter:a': 1, 'loop:x': 1 };
    selectNewDeadLetters([rec('a', 'dead_letter')], times);
    expect(Object.keys(times).sort()).toEqual(['dead-letter:a', 'loop:x']);
  });
});
