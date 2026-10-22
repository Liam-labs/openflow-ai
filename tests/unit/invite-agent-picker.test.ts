/**
 * Tests for invite-agent-picker helpers.
 * Written TDD — RED first (lib/invite-agent-helpers.ts does not exist yet), then GREEN.
 * Covers: session filtering (exclude + search) and capability grouping.
 */

import { describe, it, expect } from 'vitest';
import {
  filterPickerSessions,
  groupSessionsByCapability,
  type PickerSession,
} from '@/lib/invite-agent-helpers';

const mkSession = (displayName: string, capabilities: string[] = []): PickerSession => ({
  pid: Math.floor(Math.random() * 90000) + 10000,
  displayName,
  capabilities,
  collabReady: true,
});

// ─── filterPickerSessions ─────────────────────────────────────────────────────

describe('filterPickerSessions', () => {
  it('excludes sessions whose displayName is in excludeNames', () => {
    const sessions = [mkSession('McRae'), mkSession('Dave'), mkSession('Margaret')];
    const result = filterPickerSessions(sessions, '', ['McRae', 'Margaret']);
    expect(result.map(s => s.displayName)).toEqual(['Dave']);
  });

  it('returns all non-excluded sessions when query is empty', () => {
    const sessions = [mkSession('McRae'), mkSession('Dave')];
    const result = filterPickerSessions(sessions, '', ['Margaret']);
    expect(result).toHaveLength(2);
  });

  it('filters by displayName substring (case-insensitive)', () => {
    const sessions = [mkSession('McRae'), mkSession('McBain'), mkSession('Dave')];
    const result = filterPickerSessions(sessions, 'mc', []);
    expect(result.map(s => s.displayName)).toEqual(['McRae', 'McBain']);
  });

  it('filters by capability token match (case-insensitive)', () => {
    const sessions = [
      mkSession('Agent1', ['code', 'web']),
      mkSession('Agent2', ['browser', 'chrome']),
      mkSession('Agent3', ['code']),
    ];
    const result = filterPickerSessions(sessions, 'browser', []);
    expect(result.map(s => s.displayName)).toEqual(['Agent2']);
  });

  it('returns empty array when all sessions match exclude list', () => {
    const sessions = [mkSession('McRae'), mkSession('Dave')];
    const result = filterPickerSessions(sessions, '', ['McRae', 'Dave']);
    expect(result).toHaveLength(0);
  });

  it('applies both exclude AND query filters simultaneously', () => {
    const sessions = [mkSession('McRae'), mkSession('Dave', ['code']), mkSession('Jonas', ['code'])];
    const result = filterPickerSessions(sessions, 'code', ['Jonas']);
    expect(result.map(s => s.displayName)).toEqual(['Dave']);
  });
});

// ─── groupSessionsByCapability ────────────────────────────────────────────────

describe('groupSessionsByCapability', () => {
  it('groups sessions with no capabilities under "General"', () => {
    const sessions = [mkSession('McRae'), mkSession('Dave')];
    const groups = groupSessionsByCapability(sessions);
    expect(groups.find(g => g.label === 'General')?.sessions).toHaveLength(2);
  });

  it('groups sessions by their first capability token', () => {
    const sessions = [
      mkSession('Agent1', ['browser', 'chrome']),
      mkSession('Agent2', ['browser']),
      mkSession('Agent3', ['code']),
    ];
    const groups = groupSessionsByCapability(sessions);
    const browserGroup = groups.find(g => g.label === 'browser');
    const codeGroup = groups.find(g => g.label === 'code');
    expect(browserGroup?.sessions).toHaveLength(2);
    expect(codeGroup?.sessions).toHaveLength(1);
  });

  it('returns an empty array for empty input', () => {
    expect(groupSessionsByCapability([])).toEqual([]);
  });

  it('preserves full capabilities array on each session in result', () => {
    const sessions = [mkSession('Agent1', ['browser', 'chrome'])];
    const groups = groupSessionsByCapability(sessions);
    expect(groups[0].sessions[0].capabilities).toEqual(['browser', 'chrome']);
  });
});
