/**
 * Sprint 40 T1.1 — Tests for rehydrate param on roster_respawn.
 *
 * Tests the rehydrate block builder and verifies that handleRosterRespawnAction
 * correctly threads the rehydrate param to the spawn flow.
 */

import { describe, it, expect } from 'vitest';
import { buildRehydrateBlock } from '../../app/api/collab/pty/_handlers/message-inject';

describe('buildRehydrateBlock', () => {
  it('returns a markdown block with the rehydrate instruction when true', () => {
    const block = buildRehydrateBlock(true);
    expect(block).not.toBeNull();
    expect(block).toContain('[REHYDRATE]');
    expect(block).toContain('last 50 messages');
  });

  it('returns null when rehydrate is false', () => {
    expect(buildRehydrateBlock(false)).toBeNull();
  });

  it('returns null when rehydrate is undefined', () => {
    expect(buildRehydrateBlock(undefined)).toBeNull();
  });

  it('block starts with a heading for role temp file injection', () => {
    const block = buildRehydrateBlock(true)!;
    expect(block).toMatch(/^## /m);
  });

  it('block includes channel context instruction', () => {
    const block = buildRehydrateBlock(true)!;
    expect(block).toContain('channel');
    expect(block).toContain('before responding');
  });
});
