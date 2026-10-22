import { describe, it, expect } from 'vitest';

/**
 * Tests the payload construction for respawn API calls.
 * The actual handleRosterRespawn lives in ColabPanel.tsx and calls
 * POST /api/collab/pty with action: 'roster_respawn'.
 *
 * This test verifies the payload shape matches what the backend expects:
 * - Standard respawn: { action, channelId, agentId, fresh }
 * - Rehydrate respawn: { action, channelId, agentId, fresh, rehydrate: true }
 */

function buildRespawnPayload(
  channelId: string,
  agentId: string,
  fresh = true,
  rehydrate = false,
) {
  return {
    action: 'roster_respawn',
    channelId,
    agentId,
    fresh,
    ...(rehydrate ? { rehydrate: true } : {}),
  };
}

describe('respawn payload construction', () => {
  const channelId = 'ch-123';
  const agentId = 'agent-456';

  it('standard respawn has no rehydrate field', () => {
    const payload = buildRespawnPayload(channelId, agentId);
    expect(payload).toEqual({
      action: 'roster_respawn',
      channelId: 'ch-123',
      agentId: 'agent-456',
      fresh: true,
    });
    expect('rehydrate' in payload).toBe(false);
  });

  it('rehydrate respawn includes rehydrate: true', () => {
    const payload = buildRespawnPayload(channelId, agentId, true, true);
    expect(payload).toEqual({
      action: 'roster_respawn',
      channelId: 'ch-123',
      agentId: 'agent-456',
      fresh: true,
      rehydrate: true,
    });
  });

  it('rehydrate false omits the field (backward compat)', () => {
    const payload = buildRespawnPayload(channelId, agentId, true, false);
    expect('rehydrate' in payload).toBe(false);
  });

  it('fresh=false with rehydrate=true both propagate', () => {
    const payload = buildRespawnPayload(channelId, agentId, false, true);
    expect(payload.fresh).toBe(false);
    expect(payload.rehydrate).toBe(true);
  });
});
