/**
 * Slack Integration - Type Definitions
 *
 * All types for the Slack bridge: config, channel mappings,
 * sync state, and API responses.
 */

// --- Auto-Sync Configuration ---

export interface SlackAutoSyncConfig {
  /** Master switch for automatic channel sync */
  enabled: boolean;
  /** Automatically create a Slack channel when a DevFlow collab channel is created */
  autoCreateChannels: boolean;
  /** Automatically archive the Slack channel when the mapped DevFlow channel is deleted */
  autoArchiveChannels: boolean;
  /** Automatically rename the Slack channel when the DevFlow channel is renamed */
  autoRenameChannels: boolean;
  /** Default visibility for auto-created channels */
  defaultVisibility: 'public' | 'private';
  /** Slack user IDs to auto-invite when creating channels */
  autoInviteUserIds: string[];
}

export const DEFAULT_AUTO_SYNC_CONFIG: SlackAutoSyncConfig = {
  enabled: false,
  autoCreateChannels: false,
  autoArchiveChannels: false,
  autoRenameChannels: false,
  defaultVisibility: 'public',
  autoInviteUserIds: [],
};

// --- Bridge Configuration ---

export interface SlackBridgeConfig {
  /** Slack workspace ID (team ID) */
  workspaceId: string;
  /** Slack App ID */
  appId: string;
  /** Bot User ID (the bot's own user ID in the workspace) */
  botUserId: string;
  /** Whether message sync is enabled globally */
  syncEnabled: boolean;
  /** Poll interval for fallback polling (ms) — used when Socket Mode is unavailable */
  pollIntervalMs: number;
  /** Auto-sync settings for channel lifecycle events */
  autoSync: SlackAutoSyncConfig;
  /** Public URL for DevFlow (used in Block Kit button links). Defaults to http://localhost:3000 */
  devflowPublicUrl?: string;
  /** Slack channel ID for event-driven notifications (sprint changes, health alerts, etc.) */
  notificationChannelId?: string;
  /** Whether event-driven notifications are enabled */
  notificationsEnabled?: boolean;
  /** Which notification event types are enabled (defaults to all) */
  notificationEvents?: string[];
  createdAt: string;
  updatedAt: string;
}

// --- Channel Mapping ---

export interface SlackChannelMapping {
  id: string;
  devflowChannelId: string;
  devflowChannelName: string;
  /** Slack channel ID (e.g., C0123456789) */
  slackChannelId: string;
  slackChannelName: string;
  syncEnabled: boolean;
  lastSyncAt: string;
  /** Whether the bot has been added to the Slack channel */
  botInChannel: boolean;
  createdAt: string;
}

// --- Sync State ---

export interface SyncError {
  timestamp: string;
  error: string;
  context: string;
  mappingId?: string;
}

export interface SlackBridgeSyncState {
  /** Last processed Slack message timestamp per mapping (Slack uses ts as message ID) */
  lastSlackTimestamp: Record<string, string>;
  /** Last processed DevFlow timestamp per mapping */
  lastDevFlowTimestamp: Record<string, string>;
  /** Cursor for Slack conversations.history pagination per mapping */
  cursors: Record<string, string>;
  /** Recent errors (max 50) */
  errors: SyncError[];
}

// --- Data File Structure ---

export interface SlackBridgeData {
  config: SlackBridgeConfig | null;
  mappings: SlackChannelMapping[];
  syncState: SlackBridgeSyncState;
}

// --- API Response Types ---

export interface SlackBridgeStatus {
  configured: boolean;
  connected: boolean;
  botRegistered: boolean;
  syncEnabled: boolean;
  activeMappings: number;
  totalMappings: number;
  lastSyncAt: string | null;
  recentErrors: SyncError[];
}

// --- Message Origin Tracking ---

export type MessageOrigin = 'devflow' | 'slack';

export interface BridgedMessageMetadata {
  source: MessageOrigin;
  originalMessageId: string;
  bridgedAt: string;
  mappingId: string;
}

// --- Default data ---

export const DEFAULT_BRIDGE_DATA: SlackBridgeData = {
  config: null,
  mappings: [],
  syncState: {
    lastSlackTimestamp: {},
    lastDevFlowTimestamp: {},
    cursors: {},
    errors: [],
  },
};
