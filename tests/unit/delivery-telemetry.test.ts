import { describe, it, expect } from 'vitest';
import { computeDeliveryStats, type DeliveryEvent } from '../../lib/delivery-telemetry';

function makeEvent(overrides: Partial<DeliveryEvent> = {}): DeliveryEvent {
  return {
    messageId: 'msg-1',
    status: 'delivery_failure',
    timestamp: new Date().toISOString(),
    agentName: 'Worf',
    channelId: 'chan-abc',
    failureReason: 'injection_timeout',
    ...overrides,
  };
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600 * 1000).toISOString();
}

describe('computeDeliveryStats', () => {
  it('returns zeroes for empty store', () => {
    const stats = computeDeliveryStats([]);
    expect(stats.totalFailures).toBe(0);
    expect(stats.failuresByAgent).toEqual({});
    expect(stats.failuresByReason).toEqual({});
    expect(stats.failuresByChannel).toEqual({});
    expect(stats.windowHours).toBe(24);
  });

  it('counts delivery_failure events within 24h window', () => {
    const events = [
      makeEvent({ messageId: 'a', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'b', timestamp: hoursAgo(12) }),
    ];
    const stats = computeDeliveryStats(events);
    expect(stats.totalFailures).toBe(2);
  });

  it('ignores events older than 24h', () => {
    const events = [
      makeEvent({ messageId: 'a', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'b', timestamp: hoursAgo(25) }),
    ];
    const stats = computeDeliveryStats(events);
    expect(stats.totalFailures).toBe(1);
  });

  it('ignores delivered and timeout events (only counts delivery_failure)', () => {
    const events = [
      makeEvent({ messageId: 'a', status: 'delivered', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'b', status: 'timeout', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'c', status: 'delivery_failure', timestamp: hoursAgo(1) }),
    ];
    const stats = computeDeliveryStats(events);
    expect(stats.totalFailures).toBe(1);
  });

  it('groups failures by agentName', () => {
    const events = [
      makeEvent({ messageId: 'a', agentName: 'Worf', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'b', agentName: 'Worf', timestamp: hoursAgo(2) }),
      makeEvent({ messageId: 'c', agentName: 'Jonas', timestamp: hoursAgo(3) }),
    ];
    const stats = computeDeliveryStats(events);
    expect(stats.failuresByAgent).toEqual({ Worf: 2, Jonas: 1 });
  });

  it('groups failures by failureReason', () => {
    const events = [
      makeEvent({ messageId: 'a', failureReason: 'injection_timeout', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'b', failureReason: 'injection_timeout', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'c', failureReason: 'tmux_send_failed', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'd', failureReason: 'child_died', timestamp: hoursAgo(1) }),
    ];
    const stats = computeDeliveryStats(events);
    expect(stats.failuresByReason).toEqual({
      injection_timeout: 2,
      tmux_send_failed: 1,
      child_died: 1,
    });
  });

  it('groups failures by channelId', () => {
    const events = [
      makeEvent({ messageId: 'a', channelId: 'chan-1', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'b', channelId: 'chan-2', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'c', channelId: 'chan-1', timestamp: hoursAgo(1) }),
    ];
    const stats = computeDeliveryStats(events);
    expect(stats.failuresByChannel).toEqual({ 'chan-1': 2, 'chan-2': 1 });
  });

  it('handles missing optional fields gracefully', () => {
    const events = [
      { messageId: 'a', status: 'delivery_failure' as const, timestamp: hoursAgo(1) },
    ];
    const stats = computeDeliveryStats(events);
    expect(stats.totalFailures).toBe(1);
    expect(stats.failuresByAgent).toEqual({ unknown: 1 });
    expect(stats.failuresByChannel).toEqual({ unknown: 1 });
    expect(stats.failuresByReason).toEqual({ unknown: 1 });
  });

  it('respects custom windowHours', () => {
    const events = [
      makeEvent({ messageId: 'a', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'b', timestamp: hoursAgo(3) }),
    ];
    const stats = computeDeliveryStats(events, { windowHours: 2 });
    expect(stats.totalFailures).toBe(1);
    expect(stats.windowHours).toBe(2);
  });

  // ─── Sprint 51 T1 ──────────────────────────────────────────────────────
  // jsonl_ingestion_timeout is a verifier false-positive (Jack 2026-04-18 audit:
  // 22/22 jsonl_ingestion_timeout events actually delivered). Don't count them
  // in failure stats; real reasons (tmux_send_failed, child_died,
  // injection_timeout) must still be counted.

  it('Sprint 51 T1 — excludes jsonl_ingestion_timeout from totalFailures', () => {
    const events = [
      makeEvent({ messageId: 'a', failureReason: 'jsonl_ingestion_timeout', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'b', failureReason: 'jsonl_ingestion_timeout', timestamp: hoursAgo(2) }),
      makeEvent({ messageId: 'c', failureReason: 'tmux_send_failed', timestamp: hoursAgo(1) }),
    ];
    const stats = computeDeliveryStats(events);
    expect(stats.totalFailures).toBe(1);
  });

  it('excludes jsonl_verify_timeout_noreinject from all failure rollups', () => {
    const events = [
      makeEvent({ messageId: 'a', agentName: 'Jack', channelId: 'sg1', failureReason: 'jsonl_verify_timeout_noreinject', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'b', agentName: 'Jack', channelId: 'sg1', failureReason: 'tmux_send_failed', timestamp: hoursAgo(1) }),
    ];
    const stats = computeDeliveryStats(events);
    expect(stats.totalFailures).toBe(1);
    expect(stats.failuresByReason).toEqual({ tmux_send_failed: 1 });
    expect(stats.failuresByAgent).toEqual({ Jack: 1 });
    expect(stats.failuresByChannel).toEqual({ sg1: 1 });
  });

  it('Sprint 51 T1 — excludes jsonl_ingestion_timeout from failuresByReason', () => {
    const events = [
      makeEvent({ messageId: 'a', failureReason: 'jsonl_ingestion_timeout', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'b', failureReason: 'tmux_send_failed', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'c', failureReason: 'child_died', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'd', failureReason: 'injection_timeout', timestamp: hoursAgo(1) }),
    ];
    const stats = computeDeliveryStats(events);
    expect(stats.failuresByReason).toEqual({
      tmux_send_failed: 1,
      child_died: 1,
      injection_timeout: 1,
    });
    expect(stats.failuresByReason).not.toHaveProperty('jsonl_ingestion_timeout');
  });

  it('Sprint 51 T1 — excludes jsonl_ingestion_timeout from failuresByAgent and failuresByChannel', () => {
    const events = [
      makeEvent({ messageId: 'a', agentName: 'Jack', channelId: 'sg1', failureReason: 'jsonl_ingestion_timeout', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'b', agentName: 'Jack', channelId: 'sg1', failureReason: 'jsonl_ingestion_timeout', timestamp: hoursAgo(1) }),
      makeEvent({ messageId: 'c', agentName: 'Jack', channelId: 'sg1', failureReason: 'tmux_send_failed', timestamp: hoursAgo(1) }),
    ];
    const stats = computeDeliveryStats(events);
    expect(stats.failuresByAgent).toEqual({ Jack: 1 });
    expect(stats.failuresByChannel).toEqual({ sg1: 1 });
  });
});
