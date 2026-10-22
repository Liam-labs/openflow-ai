import { describe, it, expect } from 'vitest';
import {
  detectFrozenParticipantIds,
  FROZEN_STALE_THRESHOLD_MS,
  FROZEN_MENTION_LOOKBACK_MS,
  FROZEN_ONLINE_WINDOW_MS,
  type FrozenDetectionInput,
} from '@/lib/frozen-detection';

const NOW = 1_700_000_000_000;

const iso = (offsetMs: number): string => new Date(NOW - offsetMs).toISOString();

const baseAgent = (id: string, name: string, overrides: Partial<{ lastSeen: string; lastRead: string | null; type: string }> = {}) => ({
  id,
  name,
  type: overrides.type ?? 'agent',
  lastSeen: overrides.lastSeen ?? iso(0),
  lastRead: overrides.lastRead ?? iso(20 * 60 * 1000),
});

const mention = (fromId: string, name: string, ageMs: number, content?: string) => ({
  from: { id: fromId },
  timestamp: iso(ageMs),
  content: content ?? `@${name} please respond`,
});

describe('detectFrozenParticipantIds', () => {
  it('exports the new threshold constants', () => {
    expect(FROZEN_STALE_THRESHOLD_MS).toBe(10 * 60 * 1000);
    expect(FROZEN_MENTION_LOOKBACK_MS).toBe(30 * 60 * 1000);
    expect(FROZEN_ONLINE_WINDOW_MS).toBe(120 * 1000);
  });

  it('flags an online idle agent with a 12-minute-old @mention', () => {
    const input: FrozenDetectionInput = {
      participants: [baseAgent('a1', 'Daniel')],
      messages: [mention('jack', 'Daniel', 12 * 60 * 1000)],
      activeTyping: [],
      now: NOW,
    };
    expect(Array.from(detectFrozenParticipantIds(input))).toEqual(['a1']);
  });

  it('does NOT flag when @mention is younger than the 10-minute stale threshold', () => {
    const input: FrozenDetectionInput = {
      participants: [baseAgent('a1', 'Daniel')],
      messages: [mention('jack', 'Daniel', 6 * 60 * 1000)],
      activeTyping: [],
      now: NOW,
    };
    expect(detectFrozenParticipantIds(input).size).toBe(0);
  });

  it('does NOT flag when @mention is older than the 30-minute lookback cap', () => {
    const input: FrozenDetectionInput = {
      participants: [baseAgent('a1', 'Daniel', { lastRead: iso(60 * 60 * 1000) })],
      messages: [mention('jack', 'Daniel', 35 * 60 * 1000)],
      activeTyping: [],
      now: NOW,
    };
    expect(detectFrozenParticipantIds(input).size).toBe(0);
  });

  it('does NOT flag when agent activity is currently working', () => {
    const input: FrozenDetectionInput = {
      participants: [baseAgent('a1', 'Daniel')],
      messages: [mention('jack', 'Daniel', 12 * 60 * 1000)],
      activeTyping: [{ participantId: 'a1', activity: 'working', activityDetail: null }],
      now: NOW,
    };
    expect(detectFrozenParticipantIds(input).size).toBe(0);
  });

  it('does NOT flag when activityDetail is set (regardless of activity field)', () => {
    const input: FrozenDetectionInput = {
      participants: [baseAgent('a1', 'Daniel')],
      messages: [mention('jack', 'Daniel', 12 * 60 * 1000)],
      activeTyping: [{ participantId: 'a1', activity: 'typing', activityDetail: 'Reading file...' }],
      now: NOW,
    };
    expect(detectFrozenParticipantIds(input).size).toBe(0);
  });

  it('does NOT flag when agent has posted in the last 10 minutes', () => {
    const input: FrozenDetectionInput = {
      participants: [baseAgent('a1', 'Daniel')],
      messages: [
        mention('jack', 'Daniel', 12 * 60 * 1000),
        { from: { id: 'a1' }, timestamp: iso(8 * 60 * 1000), content: 'on it' },
      ],
      activeTyping: [],
      now: NOW,
    };
    expect(detectFrozenParticipantIds(input).size).toBe(0);
  });

  it('still flags when agent posted >10 minutes ago', () => {
    const input: FrozenDetectionInput = {
      participants: [baseAgent('a1', 'Daniel')],
      messages: [
        mention('jack', 'Daniel', 12 * 60 * 1000),
        { from: { id: 'a1' }, timestamp: iso(15 * 60 * 1000), content: 'old reply' },
      ],
      activeTyping: [],
      now: NOW,
    };
    expect(Array.from(detectFrozenParticipantIds(input))).toEqual(['a1']);
  });

  it('does NOT flag offline agents (lastSeen > 2 minutes)', () => {
    const input: FrozenDetectionInput = {
      participants: [baseAgent('a1', 'Daniel', { lastSeen: iso(5 * 60 * 1000) })],
      messages: [mention('jack', 'Daniel', 12 * 60 * 1000)],
      activeTyping: [],
      now: NOW,
    };
    expect(detectFrozenParticipantIds(input).size).toBe(0);
  });

  it('does NOT flag user participants', () => {
    const input: FrozenDetectionInput = {
      participants: [baseAgent('u1', 'Owner', { type: 'user' })],
      messages: [mention('jack', 'Owner', 12 * 60 * 1000)],
      activeTyping: [],
      now: NOW,
    };
    expect(detectFrozenParticipantIds(input).size).toBe(0);
  });

  it('does NOT flag when @mention is older than lastRead', () => {
    const input: FrozenDetectionInput = {
      participants: [baseAgent('a1', 'Daniel', { lastRead: iso(5 * 60 * 1000) })],
      messages: [mention('jack', 'Daniel', 12 * 60 * 1000)],
      activeTyping: [],
      now: NOW,
    };
    expect(detectFrozenParticipantIds(input).size).toBe(0);
  });

  it('handles activityDetail of empty string as not-set', () => {
    const input: FrozenDetectionInput = {
      participants: [baseAgent('a1', 'Daniel')],
      messages: [mention('jack', 'Daniel', 12 * 60 * 1000)],
      activeTyping: [{ participantId: 'a1', activity: 'typing', activityDetail: '' }],
      now: NOW,
    };
    expect(Array.from(detectFrozenParticipantIds(input))).toEqual(['a1']);
  });

  describe('addressed by routing fields, not by text', () => {
    const idle = () => baseAgent('sam', 'Architect');
    const envelope = (extra: Record<string, unknown>) => ({
      from: { id: 'other-architect' },
      timestamp: iso(12 * 60 * 1000),
      content: '@Builder FYI ... Reply routing: mention @Architect in the reply content.',
      ...extra,
    });

    it('does NOT flag when the text says @Name but the server addressed someone else', () => {
      const input: FrozenDetectionInput = { participants: [idle()], messages: [envelope({ mentions: ['builder'], recipients: ['builder', 'owner'] })], activeTyping: [], now: NOW };
      expect(detectFrozenParticipantIds(input).size).toBe(0);
    });

    it('flags when the server addressed this participant', () => {
      const input: FrozenDetectionInput = { participants: [idle()], messages: [envelope({ mentions: ['sam'], recipients: ['sam', 'owner'] })], activeTyping: [], now: NOW };
      expect(Array.from(detectFrozenParticipantIds(input))).toEqual(['sam']);
    });

    it('does NOT flag when the message has no mentions and was targeted elsewhere', () => {
      const input: FrozenDetectionInput = { participants: [idle()], messages: [envelope({ mentions: [], recipients: ['builder'] })], activeTyping: [], now: NOW };
      expect(detectFrozenParticipantIds(input).size).toBe(0);
    });

    it('still flags from the text when the message carries no routing fields', () => {
      const input: FrozenDetectionInput = { participants: [idle()], messages: [envelope({})], activeTyping: [], now: NOW };
      expect(Array.from(detectFrozenParticipantIds(input))).toEqual(['sam']);
    });
  });
});
