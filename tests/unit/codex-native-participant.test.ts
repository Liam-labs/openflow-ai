import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CODEX_NATIVE_PARTICIPANT_SOURCE,
  createCodexNativeParticipantRegistry,
} from '@/lib/codex-native-participant';
import { parseAtMentions } from '@/lib/collab-utils';
import type { CollabChannelsData, CollabParticipant } from '@/lib/types';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function harness(participants: CollabParticipant[] = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-participant-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'channels.json');
  const state: CollabChannelsData = {
    channels: [{
      id: 'channel-1',
      name: 'Commander',
      description: '',
      createdAt: '2026-08-09T00:00:00.000Z',
      lastActivity: '2026-08-09T00:00:00.000Z',
      participants,
      messages: [],
      settings: { autoRespond: false },
    }],
    lastUpdated: '2026-08-09T00:00:00.000Z',
  };
  await fs.writeFile(filePath, JSON.stringify(state));
  const registry = createCodexNativeParticipantRegistry({
    filePath,
    now: () => new Date('2026-08-09T00:01:00.000Z'),
    randomId: () => 'participant-1',
  });
  return { filePath, registry };
}

describe('Codex Native liaison participant registry', () => {
  it('creates one stable channel liaison and reuses it idempotently', async () => {
    const { filePath, registry } = await harness();

    const first = await registry.ensure('channel-1');
    const second = await registry.ensure('channel-1');

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      id: 'participant-1',
      name: 'Codex',
      type: 'codex',
      source: CODEX_NATIVE_PARTICIPANT_SOURCE,
    });
    expect(parseAtMentions('@Codex check the native chat', [first])).toEqual(['participant-1']);
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8')) as CollabChannelsData;
    expect(stored.channels[0].participants).toHaveLength(1);
  });

  it('migrates an existing multi-word liaison name during a connection read', async () => {
    const existing: CollabParticipant = {
      id: 'existing-bridge',
      name: 'Codex Native',
      type: 'codex',
      source: CODEX_NATIVE_PARTICIPANT_SOURCE,
      joinedAt: '2026-08-08T00:00:00.000Z',
      lastSeen: '2026-08-08T00:00:00.000Z',
      color: '#3b82f6',
    };
    const { filePath, registry } = await harness([existing]);

    await expect(registry.get('channel-1')).resolves.toMatchObject({
      id: 'existing-bridge',
      name: 'Codex',
    });
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8')) as CollabChannelsData;
    expect(stored.channels[0].participants[0].name).toBe('Codex');
  });

  it('uses a no-space fallback when Codex is already another participant name', async () => {
    const collision: CollabParticipant = {
      id: 'other-codex',
      name: 'Codex',
      type: 'codex',
      source: 'Roster',
      joinedAt: '2026-08-08T00:00:00.000Z',
      lastSeen: '2026-08-08T00:00:00.000Z',
      color: '#94a3b8',
    };
    const { registry } = await harness([collision]);

    await expect(registry.ensure('channel-1')).resolves.toMatchObject({
      id: 'participant-1',
      name: 'CodexDesktop',
    });
  });

  it('fails closed for an unknown channel', async () => {
    const { registry } = await harness();
    await expect(registry.ensure('missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});
