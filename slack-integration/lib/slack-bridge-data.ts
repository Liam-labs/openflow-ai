/**
 * Slack Integration - Bridge Data Management
 *
 * Handles reading/writing the slack-bridge.json config file.
 * Uses atomic writes (temp + rename) to prevent corruption.
 */

import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import {
  SlackBridgeData,
  SlackChannelMapping,
  SlackBridgeConfig,
  SyncError,
  DEFAULT_BRIDGE_DATA,
  DEFAULT_AUTO_SYNC_CONFIG,
} from './slack-types';
import { PRODUCT_NAME } from '@/lib/brand';

const DATA_PATH = join(process.cwd(), '.AppData', 'bridges', 'slack.json');
const MAX_ERRORS = 50;

/**
 * Read bridge data from disk.
 * Backfills missing autoSync config for backward compatibility.
 */
export async function readBridgeData(): Promise<SlackBridgeData> {
  try {
    if (!existsSync(DATA_PATH)) {
      return { ...DEFAULT_BRIDGE_DATA };
    }
    const raw = await readFile(DATA_PATH, 'utf-8');
    const data = JSON.parse(raw) as SlackBridgeData;
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
async function writeBridgeData(data: SlackBridgeData): Promise<void> {
  const dir = dirname(DATA_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const tmpPath = DATA_PATH + '.tmp.' + randomUUID().slice(0, 8);
  await writeFile(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  await rename(tmpPath, DATA_PATH);
}

// --- Config ---

/**
 * Save or update bridge configuration.
 */
export async function saveConfig(
  config: Partial<SlackBridgeConfig>
): Promise<SlackBridgeConfig> {
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
      workspaceId: config.workspaceId || '',
      appId: config.appId || '',
      botUserId: config.botUserId || '',
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
export async function getConfig(): Promise<SlackBridgeConfig | null> {
  const data = await readBridgeData();
  return data.config;
}

// --- Channel Mappings ---

/**
 * Create a new channel mapping.
 */
export async function createMapping(
  mapping: Omit<SlackChannelMapping, 'id' | 'createdAt' | 'lastSyncAt'>
): Promise<SlackChannelMapping> {
  const data = await readBridgeData();

  // Check for duplicate mapping
  const existing = data.mappings.find(
    (m) =>
      m.devflowChannelId === mapping.devflowChannelId &&
      m.slackChannelId === mapping.slackChannelId
  );
  if (existing) {
    throw new Error(
      `Mapping already exists between ${PRODUCT_NAME} channel and Slack channel`
    );
  }

  const newMapping: SlackChannelMapping = {
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
  updates: Partial<SlackChannelMapping>
): Promise<SlackChannelMapping> {
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
 * Delete a mapping and clean up sync state.
 */
export async function deleteMapping(mappingId: string): Promise<void> {
  const data = await readBridgeData();
  data.mappings = data.mappings.filter((m) => m.id !== mappingId);
  // Clean up sync state
  delete data.syncState.lastSlackTimestamp[mappingId];
  delete data.syncState.lastDevFlowTimestamp[mappingId];
  delete data.syncState.cursors[mappingId];
  await writeBridgeData(data);
}

/**
 * Get all mappings, optionally filtered.
 */
export async function getMappings(filter?: {
  devflowChannelId?: string;
  slackChannelId?: string;
  syncEnabled?: boolean;
}): Promise<SlackChannelMapping[]> {
  const data = await readBridgeData();
  let mappings = data.mappings;

  if (filter?.devflowChannelId) {
    mappings = mappings.filter(
      (m) => m.devflowChannelId === filter.devflowChannelId
    );
  }
  if (filter?.slackChannelId) {
    mappings = mappings.filter(
      (m) => m.slackChannelId === filter.slackChannelId
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
): Promise<SlackChannelMapping | null> {
  const data = await readBridgeData();
  return data.mappings.find((m) => m.id === mappingId) || null;
}

/**
 * Find mapping by DevFlow channel ID.
 */
export async function getMappingByDevFlowChannel(
  devflowChannelId: string
): Promise<SlackChannelMapping | null> {
  const data = await readBridgeData();
  return (
    data.mappings.find(
      (m) => m.devflowChannelId === devflowChannelId && m.syncEnabled
    ) || null
  );
}

/**
 * Find mapping by Slack channel ID.
 */
export async function getMappingBySlackChannel(
  slackChannelId: string
): Promise<SlackChannelMapping | null> {
  const data = await readBridgeData();
  return (
    data.mappings.find(
      (m) => m.slackChannelId === slackChannelId && m.syncEnabled
    ) || null
  );
}

// --- Sync State ---

/**
 * Update the last processed Slack message timestamp for a mapping.
 */
export async function updateSlackTimestampCursor(
  mappingId: string,
  timestamp: string
): Promise<void> {
  const data = await readBridgeData();
  data.syncState.lastSlackTimestamp[mappingId] = timestamp;
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
 * Save a cursor for Slack API pagination.
 */
export async function saveCursor(
  mappingId: string,
  cursor: string
): Promise<void> {
  const data = await readBridgeData();
  data.syncState.cursors[mappingId] = cursor;
  await writeBridgeData(data);
}

/**
 * Get the cursor for a mapping.
 */
export async function getCursor(
  mappingId: string
): Promise<string | undefined> {
  const data = await readBridgeData();
  return data.syncState.cursors[mappingId];
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
