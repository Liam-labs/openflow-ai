/**
 * Tests for browser-user participant ID normalization.
 *
 * Bug: Owner has 4 different browser-user-* IDs across channels due to
 * localStorage resets. Current ID can't see unread counts for channels
 * joined with old IDs.
 */

import { describe, it, expect } from 'vitest';

// ─── Fix 1: Client-side fallback logic ──────────────────────────────────────

function findBrowserParticipant(
  participants: Array<{ id: string; unreadCount?: number }>,
  currentId: string
): { id: string; unreadCount?: number } | undefined {
  return participants.find(p => p.id === currentId)
    || participants.find(p => p.id.startsWith('browser-user-'));
}

describe('Fix 1: getUnreadCount browser-user fallback', () => {
  const CURRENT_ID = 'browser-user-mlgn22zz';

  it('finds exact match when current ID is in participants', () => {
    const participants = [
      { id: 'browser-user-mlgn22zz', unreadCount: 5 },
      { id: 'agent-1', unreadCount: 0 },
    ];
    const result = findBrowserParticipant(participants, CURRENT_ID);
    expect(result?.id).toBe(CURRENT_ID);
    expect(result?.unreadCount).toBe(5);
  });

  it('falls back to any browser-user-* when current ID not found', () => {
    const participants = [
      { id: 'browser-user-mm20vqfb', unreadCount: 3 },
      { id: 'agent-1', unreadCount: 0 },
    ];
    const result = findBrowserParticipant(participants, CURRENT_ID);
    expect(result?.id).toBe('browser-user-mm20vqfb');
    expect(result?.unreadCount).toBe(3);
  });

  it('returns undefined when no browser-user participant exists', () => {
    const participants = [
      { id: 'agent-1', unreadCount: 0 },
      { id: 'roster-abc', unreadCount: 2 },
    ];
    const result = findBrowserParticipant(participants, CURRENT_ID);
    expect(result).toBeUndefined();
  });

  it('prefers exact match over other browser-user IDs', () => {
    const participants = [
      { id: 'browser-user-mm20vqfb', unreadCount: 3 },
      { id: 'browser-user-mlgn22zz', unreadCount: 7 },
    ];
    const result = findBrowserParticipant(participants, CURRENT_ID);
    expect(result?.id).toBe(CURRENT_ID);
    expect(result?.unreadCount).toBe(7);
  });
});

// ─── Fix 2: Server-side mark_read normalization logic ───────────────────────

function findOrNormalizeBrowserParticipant(
  participants: Array<{ id: string; lastRead: string | null; lastSeen: string }>,
  requestedId: string
): { participant: { id: string; lastRead: string | null; lastSeen: string } | null; normalized: boolean } {
  // Exact match
  const exact = participants.find(p => p.id === requestedId);
  if (exact) return { participant: exact, normalized: false };

  // If requested ID is a browser-user, find any existing browser-user
  if (requestedId.startsWith('browser-user-')) {
    const existing = participants.find(p => p.id.startsWith('browser-user-'));
    if (existing) {
      existing.id = requestedId; // normalize to current ID
      return { participant: existing, normalized: true };
    }
  }

  return { participant: null, normalized: false };
}

describe('Fix 2: handleMarkRead browser-user normalization', () => {
  it('finds exact participant match', () => {
    const participants = [
      { id: 'browser-user-mlgn22zz', lastRead: null, lastSeen: '' },
    ];
    const { participant, normalized } = findOrNormalizeBrowserParticipant(
      participants, 'browser-user-mlgn22zz'
    );
    expect(participant?.id).toBe('browser-user-mlgn22zz');
    expect(normalized).toBe(false);
  });

  it('normalizes stale browser-user ID to current ID', () => {
    const participants = [
      { id: 'browser-user-mm20vqfb', lastRead: '2026-04-01T00:00:00Z', lastSeen: '' },
    ];
    const { participant, normalized } = findOrNormalizeBrowserParticipant(
      participants, 'browser-user-mlgn22zz'
    );
    expect(participant?.id).toBe('browser-user-mlgn22zz');
    expect(normalized).toBe(true);
    // Original lastRead preserved
    expect(participant?.lastRead).toBe('2026-04-01T00:00:00Z');
  });

  it('returns null for non-browser participant not found', () => {
    const participants = [
      { id: 'agent-1', lastRead: null, lastSeen: '' },
    ];
    const { participant } = findOrNormalizeBrowserParticipant(
      participants, 'browser-user-mlgn22zz'
    );
    expect(participant).toBeNull();
  });

  it('does not normalize non-browser-user IDs', () => {
    const participants = [
      { id: 'browser-user-mm20vqfb', lastRead: null, lastSeen: '' },
    ];
    const { participant } = findOrNormalizeBrowserParticipant(
      participants, 'agent-1'
    );
    expect(participant).toBeNull();
  });
});
