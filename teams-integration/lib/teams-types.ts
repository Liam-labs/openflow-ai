/**
 * Teams Integration - Type Definitions
 *
 * All types for the Teams bridge: config, channel mappings,
 * sync state, and API responses.
 */

// --- Auto-Sync Configuration ---

export interface AutoSyncConfig {
  /** Master switch for automatic channel sync */
  enabled: boolean;
  /** Automatically create a Teams channel when a DevFlow collab channel is created */
  autoCreateChannels: boolean;
  /** Automatically delete the Teams channel when the mapped DevFlow channel is deleted */
  autoDeleteChannels: boolean;
  /** Automatically rename the Teams channel when the DevFlow channel is renamed */
  autoRenameChannels: boolean;
  /** Default Teams channel type for auto-created channels */
  defaultTeamId: string | null;
  /** Default membership type for auto-created channels */
  defaultMembershipType: 'standard' | 'private';
}

export const DEFAULT_AUTO_SYNC_CONFIG: AutoSyncConfig = {
  enabled: false,
  autoCreateChannels: false,
  autoDeleteChannels: false,
  autoRenameChannels: false,
  defaultTeamId: null,
  defaultMembershipType: 'standard',
};

// --- Bridge Configuration ---

export interface TeamsBridgeConfig {
  tenantId: string;
  clientId: string;
  botId: string;
  tunnelUrl: string;
  syncEnabled: boolean;
  pollIntervalMs: number;
  /** Auto-sync settings for channel lifecycle events */
  autoSync: AutoSyncConfig;
  createdAt: string;
  updatedAt: string;
}

// --- Channel Mapping ---

export interface TeamsChannelMapping {
  id: string;
  devflowChannelId: string;
  devflowChannelName: string;
  teamsTeamId: string;
  teamsTeamName: string;
  teamsChannelId: string;
  teamsChannelName: string;
  syncEnabled: boolean;
  lastSyncAt: string;
  /** Bot Framework ConversationReference for proactive messaging */
  conversationReference: ConversationReference | null;
  /** Graph API subscription ID for change notifications */
  subscriptionId: string | null;
  subscriptionExpiresAt: string | null;
  createdAt: string;
}

// --- Bot Framework Types ---

export interface ConversationReference {
  activityId?: string;
  bot: {
    id: string;
    name: string;
  };
  channelId: string;
  conversation: {
    conversationType: string;
    id: string;
    isGroup: boolean;
    name: string;
    tenantId: string;
  };
  serviceUrl: string;
}

// --- Sync State ---

export interface SyncError {
  timestamp: string;
  error: string;
  context: string;
  mappingId?: string;
}

export interface TeamsBridgeSyncState {
  /** Last processed Teams message ID per mapping */
  lastTeamsMessageId: Record<string, string>;
  /** Last processed DevFlow timestamp per mapping */
  lastDevFlowTimestamp: Record<string, string>;
  /** Delta link for Graph API delta queries per mapping */
  deltaLinks: Record<string, string>;
  /** Recent errors (max 50) */
  errors: SyncError[];
}

// --- Data File Structure ---

export interface TeamsBridgeData {
  config: TeamsBridgeConfig | null;
  mappings: TeamsChannelMapping[];
  syncState: TeamsBridgeSyncState;
}

// --- API Response Types ---

export interface TeamsBridgeStatus {
  configured: boolean;
  connected: boolean;
  botRegistered: boolean;
  tunnelUrl: string | null;
  syncEnabled: boolean;
  activeMappings: number;
  totalMappings: number;
  lastSyncAt: string | null;
  recentErrors: SyncError[];
}

// --- Message Origin Tracking ---

export type MessageOrigin = 'devflow' | 'teams';

export interface BridgedMessageMetadata {
  source: MessageOrigin;
  originalMessageId: string;
  bridgedAt: string;
  mappingId: string;
}

// --- Default data ---

export const DEFAULT_BRIDGE_DATA: TeamsBridgeData = {
  config: null,
  mappings: [],
  syncState: {
    lastTeamsMessageId: {},
    lastDevFlowTimestamp: {},
    deltaLinks: {},
    errors: [],
  },
};
