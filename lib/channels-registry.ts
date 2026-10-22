/**
 * Channels Registry
 *
 * Maintains a lightweight index of all active channels in
 * data/channels-registry.json. Updated automatically on:
 *   - Channel create
 *   - Channel delete (soft or hard)
 *   - Channel rename
 *   - Channel archive / restore
 *
 * The registry is intentionally lean — it holds only the fields needed
 * for quick lookups and listings, NOT full channel objects.
 * Full channel data lives in data/collab-channels.json as the source of truth.
 */

import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile } from '@/lib/data-io';
import type { CollabChannel } from '@/lib/types';

export interface ChannelRegistryEntry {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  lastActivity: string;
  ownerId?: string;
  teamId?: string;
  projectId?: string;
  parentChannelId?: string;
  protected?: boolean;
  archived?: boolean;           // true when channel is archived (soft-deleted)
  archivedAt?: string;
  participantCount: number;
  hasRoster: boolean;
}

export interface ChannelsRegistryData {
  version: string;
  updatedAt: string;
  channels: ChannelRegistryEntry[];
}

const DEFAULT_DATA: ChannelsRegistryData = {
  version: '1.0.0',
  updatedAt: new Date().toISOString(),
  channels: [],
};

export async function loadRegistry(): Promise<ChannelsRegistryData> {
  return readJsonFile<ChannelsRegistryData>(DataPaths.channelsRegistry, DEFAULT_DATA);
}

function toEntry(channel: CollabChannel, overrides: Partial<ChannelRegistryEntry> = {}): ChannelRegistryEntry {
  return {
    id: channel.id,
    name: channel.name,
    description: channel.description,
    createdAt: channel.createdAt,
    lastActivity: channel.lastActivity,
    ownerId: channel.ownerId,
    teamId: channel.teamId,
    projectId: channel.projectId,
    parentChannelId: channel.parentChannelId,
    protected: channel.protected,
    archived: false,
    participantCount: channel.participants?.length ?? 0,
    hasRoster: (channel.roster?.agents?.length ?? 0) > 0,
    ...overrides,
  };
}

/** Called when a channel is created. Adds it to the registry. */
export async function onChannelCreated(channel: CollabChannel): Promise<void> {
  try {
    const data = await loadRegistry();
    // Upsert by id (idempotent)
    const idx = data.channels.findIndex(c => c.id === channel.id);
    const entry = toEntry(channel);
    if (idx >= 0) {
      data.channels[idx] = entry;
    } else {
      data.channels.push(entry);
    }
    data.updatedAt = new Date().toISOString();
    await writeJsonFile(DataPaths.channelsRegistry, data);
  } catch (err) {
    console.error('[ChannelsRegistry] onChannelCreated error:', err);
  }
}

/** Called when a channel is renamed or its metadata changes. Updates the entry. */
export async function onChannelUpdated(channel: CollabChannel): Promise<void> {
  try {
    const data = await loadRegistry();
    const idx = data.channels.findIndex(c => c.id === channel.id);
    if (idx >= 0) {
      data.channels[idx] = toEntry(channel, { archived: data.channels[idx].archived });
    } else {
      data.channels.push(toEntry(channel));
    }
    data.updatedAt = new Date().toISOString();
    await writeJsonFile(DataPaths.channelsRegistry, data);
  } catch (err) {
    console.error('[ChannelsRegistry] onChannelUpdated error:', err);
  }
}

/** Called when a channel is archived (soft-deleted). Marks it archived in the registry. */
export async function onChannelArchived(channelId: string, archivedAt: string): Promise<void> {
  try {
    const data = await loadRegistry();
    const idx = data.channels.findIndex(c => c.id === channelId);
    if (idx >= 0) {
      data.channels[idx].archived = true;
      data.channels[idx].archivedAt = archivedAt;
    }
    data.updatedAt = new Date().toISOString();
    await writeJsonFile(DataPaths.channelsRegistry, data);
  } catch (err) {
    console.error('[ChannelsRegistry] onChannelArchived error:', err);
  }
}

/** Called when a channel is restored from the archive. Clears the archived flag. */
export async function onChannelRestored(channel: CollabChannel): Promise<void> {
  try {
    const data = await loadRegistry();
    const idx = data.channels.findIndex(c => c.id === channel.id);
    if (idx >= 0) {
      data.channels[idx] = toEntry(channel, { archived: false, archivedAt: undefined });
    } else {
      data.channels.push(toEntry(channel));
    }
    data.updatedAt = new Date().toISOString();
    await writeJsonFile(DataPaths.channelsRegistry, data);
  } catch (err) {
    console.error('[ChannelsRegistry] onChannelRestored error:', err);
  }
}

/** Called when a channel is permanently deleted. Removes it from the registry. */
export async function onChannelDeleted(channelId: string): Promise<void> {
  try {
    const data = await loadRegistry();
    data.channels = data.channels.filter(c => c.id !== channelId);
    data.updatedAt = new Date().toISOString();
    await writeJsonFile(DataPaths.channelsRegistry, data);
  } catch (err) {
    console.error('[ChannelsRegistry] onChannelDeleted error:', err);
  }
}

/**
 * Rebuild the entire registry from the canonical channels data.
 * Use when the registry is out of sync or on first initialisation.
 */
export async function rebuildRegistry(channels: CollabChannel[]): Promise<void> {
  const data: ChannelsRegistryData = {
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    channels: channels.map(c => toEntry(c)),
  };
  await writeJsonFile(DataPaths.channelsRegistry, data);
}
