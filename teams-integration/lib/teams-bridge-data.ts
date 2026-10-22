/**
 * Teams Integration - Bridge Data Management
 *
 * Handles reading/writing the teams-bridge.json config file.
 * Uses atomic writes (temp + rename) to prevent corruption.
 */

import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import {
  TeamsBridgeData,
  TeamsChannelMapping,
  TeamsBridgeConfig,
  SyncError,
  DEFAULT_BRIDGE_DATA,
  DEFAULT_AUTO_SYNC_CONFIG,
} from './teams-types';
import { PRODUCT_NAME } from '@/lib/brand';

const DATA_PATH = join(process.cwd(), '.AppData', 'bridges', 'teams.json');
const MAX_ERRORS = 50;

/**
 * Read bridge data from disk.
 * Backfills missing autoSync config for backward compatibility.
 */
export async function readBridgeData(): Promise<TeamsBridgeData> {
  try {
    if (!existsSync(DATA_PATH)) {
      return { ...DEFAULT_BRIDGE_DATA };
    }
    const raw = await readFile(DATA_PATH, 'utf-8');
    const data = JSON.parse(raw) as TeamsBridgeData;
    // Backfill autoSync if config exists but autoSync is missing (pre-existing data)
    if (data.config && !data.config.autoSync) {
      data.config.autoSync = { ...DEFAULT_AUTO_SYNC_CONFIG };
    }
    return data;
  } catch {
    return { ...DEFAULT_BRIDGE_DATA };
  }
}

/**
 * Write bridge data atomically (temp file + rename).
 */
async function writeBridgeData(data: TeamsBridgeData): Promise<void> {
  const dir = dirname(DATA_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const tmpPath = DATA_PATH + '.tmp.' + randomUUID().slice(0, 8);
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmpPath, DATA_PATH);
}

// --- Config ---

/**
 * Save or update bridge configuration.
 */
export async function saveConfig(
  config: Partial<TeamsBridgeConfig>
): Promise<TeamsBridgeConfig> {
  const data = await readBridgeData();
  const now = new Date().toISOString();

  if (data.config) {
    // Merge autoSync sub-object if provided, otherwise preserve existing
    const mergedAutoSync = config.autoSync
      ? { ...data.config.autoSync, ...config.autoSync }
      : data.config.autoSync;
    data.config = { ...data.config, ...config, autoSync: mergedAutoSync, updatedAt: now };
  } else {
    data.config = {
      tenantId: config.tenantId || '',
      clientId: config.clientId || '',
      botId: config.botId || '',
      tunnelUrl: config.tunnelUrl || '',
      syncEnabled: config.syncEnabled ?? false,
      pollIntervalMs: config.pollIntervalMs ?? 5000,
      autoSync: config.autoSync ?? { ...DEFAULT_AUTO_SYNC_CONFIG },
      createdAt: now,
      updatedAt: now,
    };
  }

  await writeBridgeData(data);
  return data.config;
}

/**
 * Get current bridge configuration.
 */
export async function getConfig(): Promise<TeamsBridgeConfig | null> {
  const data = await readBridgeData();
  return data.config;
}

// --- Channel Mappings ---

/**
 * Create a new channel mapping.
 */
export async function createMapping(
  mapping: Omit<TeamsChannelMapping, 'id' | 'createdAt' | 'lastSyncAt'>
): Promise<TeamsChannelMapping> {
  const data = await readBridgeData();

  // Check for duplicate mapping
  const existing = data.mappings.find(
    (m) =>
      m.devflowChannelId === mapping.devflowChannelId &&
      m.teamsChannelId === mapping.teamsChannelId
  );
  if (existing) {
    throw new Error(
      `Mapping already exists between ${PRODUCT_NAME} channel and Teams channel`
    );
  }

  const newMapping: TeamsChannelMapping = {
    ...mapping,
    id: randomUUID(),
    lastSyncAt: '',
    createdAt: new Date().toISOString(),
  };

  data.mappings.push(newMapping);
  await writeBridgeData(data);
  return newMapping;
}

/**
 * Update an existing mapping.
 */
export async function updateMapping(
  mappingId: string,
  updates: Partial<TeamsChannelMapping>
): Promise<TeamsChannelMapping> {
  const data = await readBridgeData();
  const index = data.mappings.findIndex((m) => m.id === mappingId);
  if (index === -1) {
    throw new Error(`Mapping not found: ${mappingId}`);
  }

  data.mappings[index] = { ...data.mappings[index], ...updates };
  await writeBridgeData(data);
  return data.mappings[index];
}

/**
 * Delete a mapping.
 */
export async function deleteMapping(mappingId: string): Promise<void> {
  const data = await readBridgeData();
  data.mappings = data.mappings.filter((m) => m.id !== mappingId);
  // Clean up sync state
  delete data.syncState.lastTeamsMessageId[mappingId];
  delete data.syncState.lastDevFlowTimestamp[mappingId];
  delete data.syncState.deltaLinks[mappingId];
  await writeBridgeData(data);
}

/**
 * Get all mappings, optionally filtered by devflow channel or teams channel.
 */
export async function getMappings(filter?: {
  devflowChannelId?: string;
  teamsChannelId?: string;
  syncEnabled?: boolean;
}): Promise<TeamsChannelMapping[]> {
  const data = await readBridgeData();
  let mappings = data.mappings;

  if (filter?.devflowChannelId) {
    mappings = mappings.filter(
      (m) => m.devflowChannelId === filter.devflowChannelId
    );
  }
  if (filter?.teamsChannelId) {
    mappings = mappings.filter(
      (m) => m.teamsChannelId === filter.teamsChannelId
    );
  }
  if (filter?.syncEnabled !== undefined) {
    mappings = mappings.filter((m) => m.syncEnabled === filter.syncEnabled);
  }

  return mappings;
}

/**
 * Get a single mapping by ID.
 */
export async function getMapping(
  mappingId: string
): Promise<TeamsChannelMapping | null> {
  const data = await readBridgeData();
  return data.mappings.find((m) => m.id === mappingId) || null;
}

/**
 * Find mapping by DevFlow channel ID.
 */
export async function getMappingByDevFlowChannel(
  devflowChannelId: string
): Promise<TeamsChannelMapping | null> {
  const data = await readBridgeData();
  return (
    data.mappings.find(
      (m) => m.devflowChannelId === devflowChannelId && m.syncEnabled
    ) || null
  );
}

// --- Sync State ---

/**
 * Update the last processed Teams message ID for a mapping.
 */
export async function updateTeamsMessageCursor(
  mappingId: string,
  messageId: string
): Promise<void> {
  const data = await readBridgeData();
  data.syncState.lastTeamsMessageId[mappingId] = messageId;
  const mapping = data.mappings.find((m) => m.id === mappingId);
  if (mapping) {
    mapping.lastSyncAt = new Date().toISOString();
  }
  await writeBridgeData(data);
}

/**
 * Update the last processed DevFlow timestamp for a mapping.
 */
export async function updateDevFlowTimestampCursor(
  mappingId: string,
  timestamp: string
): Promise<void> {
  const data = await readBridgeData();
  data.syncState.lastDevFlowTimestamp[mappingId] = timestamp;
  await writeBridgeData(data);
}

/**
 * Save a delta link for a mapping.
 */
export async function saveDeltaLink(
  mappingId: string,
  deltaLink: string
): Promise<void> {
  const data = await readBridgeData();
  data.syncState.deltaLinks[mappingId] = deltaLink;
  await writeBridgeData(data);
}

/**
 * Get the delta link for a mapping.
 */
export async function getDeltaLink(
  mappingId: string
): Promise<string | undefined> {
  const data = await readBridgeData();
  return data.syncState.deltaLinks[mappingId];
}

/**
 * Log a sync error.
 */
export async function logSyncError(
  error: string,
  context: string,
  mappingId?: string
): Promise<void> {
  const data = await readBridgeData();
  data.syncState.errors.unshift({
    timestamp: new Date().toISOString(),
    error,
    context,
    mappingId,
  });
  // Keep only the most recent errors
  if (data.syncState.errors.length > MAX_ERRORS) {
    data.syncState.errors = data.syncState.errors.slice(0, MAX_ERRORS);
  }
  await writeBridgeData(data);
}

/**
 * Get recent sync errors.
 */
export async function getRecentErrors(
  limit: number = 10
): Promise<SyncError[]> {
  const data = await readBridgeData();
  return data.syncState.errors.slice(0, limit);
}
