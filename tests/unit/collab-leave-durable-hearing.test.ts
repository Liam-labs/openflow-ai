import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/data-io', () => ({ readJsonFile: vi.fn(), writeJsonFile: vi.fn() }));
vi.mock('@/lib/event-bus', () => ({ eventBus: { emitEvent: vi.fn() }, emitCollabError: vi.fn() }));
vi.mock('@/lib/collab-message-io', () => ({
  getMessagesPaginated: vi.fn(), appendMessages: vi.fn(), deleteChannelMessages: vi.fn(),
}));
vi.mock('@/teams-integration/lib/teams-auto-sync', () => ({ onChannelCreated: vi.fn(), onChannelDeleted: vi.fn() }));
vi.mock('@/slack-integration/lib/slack-auto-sync', () => ({ onChannelCreated: vi.fn(), onChannelDeleted: vi.fn() }));
vi.mock('@/lib/channels-registry', () => ({
  onChannelCreated: vi.fn(), onChannelArchived: vi.fn(), onChannelRestored: vi.fn(), onChannelDeleted: vi.fn(),
}));
vi.mock('@/lib/frozen-detection-jsonl', () => ({ enrichParticipantsJsonlMtime: vi.fn() }));
vi.mock('@/app/api/collab/_collab-shared', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeData: vi.fn(),
}));

import { handleLeave } from '@/app/api/collab/_handlers/lifecycle';
import type { CollabChannelsData, CollabParticipant } from '@/lib/types';

const COMPANION = {
  id: 'hearing-client-weir-rehearsal-20261008', name: 'Hearing companion', type: 'user',
  source: 'Hearing companion', joinedAt: '', lastSeen: '2026-10-08T12:39:58.000Z',
} as CollabParticipant;

function data(...participants: CollabParticipant[]): CollabChannelsData {
  return {
    lastUpdated: '',
    channels: [{
      id: 'cms', name: 'CMS - Case', createdAt: '', lastActivity: '', messages: [],
      settings: { autoRespond: false }, participants, roster: { lastUpdated: '', agents: [] },
    }],
  } as unknown as CollabChannelsData;
}

async function leave(d: CollabChannelsData, participantId: string, extra: Record<string, unknown> = {}) {
  const res = await handleLeave(d, { action: 'leave', channelId: 'cms', participantId, ...extra } as never, 'now', 'local');
  return { status: res.status, body: await res.json() };
}

describe('leave guard for the commissioned Hearing companion', () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('refuses an old browser client\'s ordinary or idle-cleanup leave and keeps the row', async () => {
    for (const extra of [{}, { block: false }, { block: true }, { force: false }]) {
      const d = data({ ...COMPANION });
      const r = await leave(d, COMPANION.id, extra);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('DURABLE_PARTICIPANT_PROTECTED');
      expect(d.channels[0].participants.map(p => p.id)).toEqual([COMPANION.id]);
    }
  });

  it('removes it on a legitimate explicit force', async () => {
    const d = data({ ...COMPANION });
    const r = await leave(d, COMPANION.id, { force: true, block: false });
    expect(r.status).toBe(200);
    expect(d.channels[0].participants).toHaveLength(0);
  });

  it('treats lookalike rows as ordinary participants', async () => {
    const lookalikes = [
      { ...COMPANION, id: 'hearing-x' },
      { ...COMPANION, id: 'hearing-client-2', name: 'Someone' },
      { ...COMPANION, id: 'hearing-client-3', source: 'DevFlow' },
      { ...COMPANION, id: 'hearing-client-4', type: 'claude-terminal' },
    ] as CollabParticipant[];
    for (const row of lookalikes) {
      const d = data(row);
      expect((await leave(d, row.id, { block: false })).status).toBe(200);
      expect(d.channels[0].participants).toHaveLength(0);
    }
  });

  it('rejects malformed force values for any participant without removing anything', async () => {
    for (const force of ['true', 1, null, {}, 'yes']) {
      for (const row of [COMPANION, { ...COMPANION, id: 'browser-user-a', name: 'Owner', source: 'DevFlow' }]) {
        const d = data({ ...row } as CollabParticipant);
        const r = await leave(d, row.id, { force });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('INVALID_FIELD');
        expect(d.channels[0].participants).toHaveLength(1);
      }
    }
  });

  it('logs bounded ids and codes only, never the request body', async () => {
    const d = data({ ...COMPANION });
    await leave(d, COMPANION.id, { block: false, content: 'secret text' });
    const [tag, fields] = info.mock.calls.find(c => c[0] === '[collab] leave')!;
    expect(tag).toBe('[collab] leave');
    expect(fields).toEqual({
      channel_id: 'cms', participant_id: COMPANION.id, durable_hearing_client: true,
      force: null, block: false, caller_kind: 'local', outcome: 'DURABLE_PROTECTED',
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('secret text');
  });

  it('never copies a malformed block value into the log', async () => {
    const marker = 'INVENTED-MARKER-7f3a';
    for (const block of [{ note: marker }, marker, [marker], 7]) {
      for (const row of [COMPANION, { ...COMPANION, id: 'browser-user-b', name: 'Owner', source: 'DevFlow' }]) {
        info.mockClear();
        await leave(data({ ...row } as CollabParticipant), row.id, { block });
        const [, fields] = info.mock.calls.find(c => c[0] === '[collab] leave')!;
        expect(fields.block).toBe('invalid');
        expect(JSON.stringify(info.mock.calls)).not.toContain(marker);
      }
    }
  });
});
