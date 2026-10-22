/**
 * Regression coverage for roster.switchModel's canonical harness handoff.
 *
 * A model can support more than one runtime. The switch action must send the
 * registry's preferred runtime explicitly to roster_update; otherwise that
 * handler intentionally preserves an already-compatible old runtime.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const ptyCalls: Array<Record<string, unknown>> = [];

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    readFileSync: (filePath: string, ...rest: unknown[]) => {
      if (typeof filePath === 'string' && filePath.endsWith('/.AppData/models.json')) {
        return JSON.stringify({
          models: [
            { id: 'gpt-5.6-sol', agentTypes: ['codex', 'hermes'] },
          ],
        });
      }
      return (real.readFileSync as (...args: unknown[]) => unknown)(filePath, ...rest);
    },
  };
});

vi.mock('@/lib/log-emitter', () => ({ emitApiEvent: vi.fn() }));
vi.mock('@/lib/collab-message-io', () => ({
  appendMessage: vi.fn(),
  appendSilentMessage: vi.fn(),
  readChannelMessages: vi.fn(),
}));
vi.mock('@/lib/event-bus', () => ({ eventBus: { emitEvent: vi.fn() } }));

describe('roster.switchModel canonical harness routing', () => {
  beforeEach(() => {
    ptyCalls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      ptyCalls.push(body);
      if (body.action === 'roster_list') {
        return new Response(JSON.stringify({
          success: true,
          agents: [{
            id: 'agent-builder',
            name: 'Builder',
            participantId: 'roster-builder',
            workingDirectory: '/tmp/builder',
            status: 'running',
            model: 'deepseek-v4-pro',
            agentType: 'hermes',
          }],
        }), { status: 200 });
      }
      if (body.action === 'roster_update') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (body.action === 'roster_respawn') {
        // A failed respawn is sufficient for this unit: it avoids handoff-file
        // I/O while still proving update-before-respawn ordering.
        return new Response(JSON.stringify({ success: false, error: 'test stop' }), { status: 500 });
      }
      return new Response(JSON.stringify({ success: false, error: 'unexpected action' }), { status: 400 });
    }));
  });

  it('passes inferred Codex explicitly to roster_update before respawning', async () => {
    const { switchModel } = await import('@/app/api/agent/actions/roster');
    await switchModel(
      { action: 'roster.switchModel', channelId: 'channel-1', agentId: 'agent-builder', targetModel: 'gpt-5.6-sol' },
      { tokenId: 'test', tokenName: 'test', scope: 'write', createdBy: 'test' },
    );

    expect(ptyCalls.map((call) => call.action)).toEqual([
      'roster_list',
      'roster_update',
      'roster_respawn',
    ]);
    expect(ptyCalls[1]).toMatchObject({
      action: 'roster_update',
      channelId: 'channel-1',
      agentId: 'agent-builder',
      model: 'gpt-5.6-sol',
      agentType: 'codex',
    });
  });
});
