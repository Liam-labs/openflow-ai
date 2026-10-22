import { randomUUID } from 'node:crypto';

import { readJsonFile } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { DataPaths } from '@/lib/data-paths';
import type { CollabChannelsData, CollabParticipant } from '@/lib/types';
import { CODEX_NATIVE_PARTICIPANT_SOURCE } from '@/lib/collab-participant-cleanup';

export { CODEX_NATIVE_PARTICIPANT_SOURCE } from '@/lib/collab-participant-cleanup';
const DEFAULT_CHANNELS: CollabChannelsData = { channels: [], lastUpdated: '' };

interface ParticipantRegistryOptions {
  now?: () => Date;
  randomId?: () => string;
}

function mentionableLiaisonName(
  participants: CollabParticipant[],
  liaisonId?: string,
): string {
  const names = new Set(
    participants
      .filter((participant) => participant.id !== liaisonId)
      .map((participant) => participant.name?.toLowerCase()),
  );
  if (!names.has('codex')) return 'Codex';
  if (!names.has('codexdesktop')) return 'CodexDesktop';

  let suffix = 2;
  while (names.has(`codexdesktop${suffix}`)) suffix += 1;
  return `CodexDesktop${suffix}`;
}

export class CodexNativeParticipantError extends Error {
  readonly code = 'CODEX_NATIVE_CHANNEL_NOT_FOUND';
  readonly statusCode = 404;

  constructor() {
    super('AgentChat channel not found');
    this.name = 'CodexNativeParticipantError';
  }
}

export function createCodexNativeParticipantRegistry(options: ParticipantRegistryOptions = {}) {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;

  async function get(channelId: string): Promise<CollabParticipant | null> {
    const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, DEFAULT_CHANNELS);
    const channel = data.channels.find((item) => item.id === channelId);
    if (!channel) return null;
    const existing = channel.participants.find(
      (participant) => participant.source === CODEX_NATIVE_PARTICIPANT_SOURCE,
    ) ?? null;
    if (!existing) return null;

    const expectedName = mentionableLiaisonName(channel.participants, existing.id);
    if (existing.name === expectedName) return existing;

    // Idempotent read-path migration: existing channels created before the
    // single-token mention name should become targetable as soon as their
    // connection state is fetched, without requiring a reconnect.
    return mutateChannels('codex-native-participant:rename-liaison', async (latest) => {
      const latestChannel = latest.channels.find((item) => item.id === channelId);
      const latestExisting = latestChannel?.participants.find(
        (participant) => participant.source === CODEX_NATIVE_PARTICIPANT_SOURCE,
      );
      if (!latestChannel || !latestExisting) return null;

      const latestExpectedName = mentionableLiaisonName(latestChannel.participants, latestExisting.id);
      if (latestExisting.name !== latestExpectedName) {
        latestExisting.name = latestExpectedName;
        await saveChannels(latest);
      }
      return latestExisting;
    });
  }

  async function ensure(channelId: string): Promise<CollabParticipant> {
    return mutateChannels('codex-native-participant:ensure', async (data) => {
      const channel = data.channels.find((item) => item.id === channelId);
      if (!channel) {
        throw new CodexNativeParticipantError();
      }
      const existing = channel.participants.find(
        (participant) => participant.source === CODEX_NATIVE_PARTICIPANT_SOURCE,
      );
      if (existing) {
        const expectedName = mentionableLiaisonName(channel.participants, existing.id);
        if (existing.name !== expectedName) {
          existing.name = expectedName;
          await saveChannels(data);
        }
        return existing;
      }

      const timestamp = now().toISOString();
      const name = mentionableLiaisonName(channel.participants);
      const participant: CollabParticipant = {
        id: randomId(),
        type: 'codex',
        name,
        source: CODEX_NATIVE_PARTICIPANT_SOURCE,
        joinedAt: timestamp,
        lastSeen: timestamp,
        color: '#3b82f6',
      };
      channel.participants.push(participant);
      channel.lastActivity = timestamp;
      await saveChannels(data);
      return participant;
    });
  }

  return { get, ensure };
}

export const codexNativeParticipantRegistry = createCodexNativeParticipantRegistry();
