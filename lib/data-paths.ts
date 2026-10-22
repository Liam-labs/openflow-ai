/**
 * Centralized data path configuration for DevFlow
 *
 * Three data zones:
 * - .AppData/   Runtime state (instance-specific, regenerable)
 * - .UserData/  User configuration (portable, backup-worthy)
 * - data/       Product data (git-tracked, ships with repo)
 *
 * Environment Variables:
 * - DEVFLOW_APP_DATA_DIR:  Override .AppData base (default: '.AppData')
 * - DEVFLOW_USER_DATA_DIR: Override .UserData base (default: '.UserData')
 * - DEVFLOW_DATA_DIR:      Legacy override — maps to APP_DATA if set
 */

import path from 'path';
import { promises as fs } from 'fs';
import { APP_CWD } from './app-paths';

// Base directories
const APP_DATA_DIR = process.env.DEVFLOW_APP_DATA_DIR || process.env.DEVFLOW_DATA_DIR || '.AppData';
const USER_DATA_DIR = process.env.DEVFLOW_USER_DATA_DIR || '.UserData';
const PRODUCT_DATA_DIR = 'data';

const APP_DATA_BASE = path.join(/* turbopackIgnore: true */ APP_CWD, APP_DATA_DIR);
const USER_DATA_BASE = path.join(/* turbopackIgnore: true */ APP_CWD, USER_DATA_DIR);
const PRODUCT_DATA_BASE = path.join(/* turbopackIgnore: true */ APP_CWD, PRODUCT_DATA_DIR);

// Legacy alias — most consumers use DATA_BASE which now points to .AppData
const DATA_BASE = APP_DATA_BASE;

/**
 * All data file paths used by DevFlow
 */
export const DataPaths = {
  // Base directories
  base: APP_DATA_BASE,
  appData: APP_DATA_BASE,
  userData: USER_DATA_BASE,
  productData: PRODUCT_DATA_BASE,

  // Collaboration system
  collabChannels: path.join(APP_DATA_BASE, 'collab-channels.json'),
  collabMessages: path.join(APP_DATA_BASE, 'collab-messages'),
  collabArchivedChannels: path.join(APP_DATA_BASE, 'collab-archived-channels.json'),
  collabArchivedMessages: path.join(APP_DATA_BASE, 'collab-archived-messages'),
  collabImages: path.join(APP_DATA_BASE, 'collab-images'),
  collabTasks: path.join(APP_DATA_BASE, 'collab-tasks.json'),
  collabPtySessions: path.join(APP_DATA_BASE, 'collab-pty-sessions.json'),
  rileyVoiceSettings: path.join(APP_DATA_BASE, 'riley-voice-settings.json'),

  // The account owner's profile and sidebar layout (lib/account-store.ts). Read by agents' scaffolding
  // sync through GET /api/account, never from this file directly.
  account: path.join(APP_DATA_BASE, 'account.json'),

  // Claude sessions & messages
  sessions: path.join(APP_DATA_BASE, 'sessions.json'),
  messages: path.join(APP_DATA_BASE, 'messages.json'),

  // Vault (encrypted secrets)
  vault: path.join(APP_DATA_BASE, 'vault.json'),

  // Agent API tokens
  apiTokens: path.join(APP_DATA_BASE, 'api-tokens.json'),

  // Model Registry (available AI models per provider/agent type)
  models: path.join(APP_DATA_BASE, 'models.json'),

  // Configured Models (per-agent overrides + provider auth config — UI-managed)
  configuredModels: path.join(APP_DATA_BASE, 'configuredModels.json'),

  // Channel Registry (lightweight index of all active channels for quick lookups)
  channelsRegistry: path.join(APP_DATA_BASE, 'channels-registry.json'),

  // App Registry (App Library Dashboard)
  appRegistry: path.join(APP_DATA_BASE, 'app-registry.json'),

  // Persistent teams
  teams: path.join(APP_DATA_BASE, 'teams.json'),

  // Idea Board
  ideas: path.join(APP_DATA_BASE, 'ideas.json'),
  ideaImages: path.join(APP_DATA_BASE, 'idea-images'),

  // Feature Docs (Sprint Summaries)
  featureDocs: path.join(APP_DATA_BASE, 'feature-docs.json'),
  sprintSummaries: path.join(APP_DATA_BASE, 'sprint-summaries'),

  // Terminal Tasks (AI Terminal Sessions)
  terminalTasks: path.join(APP_DATA_BASE, 'terminal-tasks.json'),

  // PowerShell Sessions (Cross-Platform Shell Access)
  powershellSessions: path.join(APP_DATA_BASE, 'powershell-sessions.json'),

  // Cron Jobs (Scheduled Tasks)
  cronJobs: path.join(APP_DATA_BASE, 'cron-jobs.json'),
  cronLogs: path.join(APP_DATA_BASE, 'cron-logs'),

  // Service Watchdog
  watchdogLogs: path.join(APP_DATA_BASE, 'watchdog-logs.json'),
  earlyoomEvents: path.join(APP_DATA_BASE, 'earlyoom-events.json'),

  // Gateway Services (WebGate)
  gatewayServices: path.join(APP_DATA_BASE, 'gateway-services.json'),
  typesafeDecisions: path.join(APP_DATA_BASE, 'typesafe', 'decisions.jsonl'),

  // Subscription Usage Limits
  subscriptionLimits: path.join(APP_DATA_BASE, 'subscription-limits.json'),

  // Agent Crash Logs
  crashLogs: path.join(APP_DATA_BASE, 'crash-logs'),

  // Process Health Monitor
  processHealthHistory: path.join(APP_DATA_BASE, 'process-health-history.json'),

  // Computer Use
  computerUseSessions: path.join(APP_DATA_BASE, 'computer-use-sessions.json'),

  // Delivery Evidence (receipts + immutable artifacts)
  deliveryEvidence: path.join(APP_DATA_BASE, 'delivery-evidence'),
  deliveryEvidenceTelemetry: path.join(
    APP_DATA_BASE,
    'delivery-evidence',
    'telemetry',
    'events.jsonl',
  ),

  // Directory Sync
  directorySync: path.join(APP_DATA_BASE, 'directory-sync.json'),
  directorySyncLogs: path.join(APP_DATA_BASE, 'directory-sync-logs'),

  // Android Studio
  androidStudio: path.join(APP_DATA_BASE, 'android-studio.json'),

  // Keep Alive
  keepAlive: path.join(APP_DATA_BASE, 'keep-alive'),

  // Event Logs (Logs Dashboard JSONL files — stored under DevFlow/logs/event-logs/)
  eventLogsBase: path.join(/* turbopackIgnore: true */ APP_CWD, 'logs', 'event-logs'),
  eventLogsCurrent: path.join(/* turbopackIgnore: true */ APP_CWD, 'logs', 'event-logs', 'current.jsonl'),
  eventLogsHeartbeat: path.join(/* turbopackIgnore: true */ APP_CWD, 'logs', 'event-logs', '.heartbeat'),

  // Sprint 38 T4.5 — auto-compact sweep event log (one JSONL entry per
  // attempted compact, appended by lib/auto-compact-events.ts).
  autoCompactEvents: path.join(/* turbopackIgnore: true */ APP_CWD, 'logs', 'auto-compact-events.jsonl'),

  // Supabase Instance Registry
  supabaseInstances: path.join(APP_DATA_BASE, 'supabase-instances.json'),

  // Logging Configuration
  loggingConfig: path.join(APP_DATA_BASE, 'logging-config.json'),

  // DevFlow Settings (server-side feature flags)
  settings: path.join(APP_DATA_BASE, 'settings.json'),

  // Messaging Bridges (consolidated under bridges/)
  bridges: {
    browser: path.join(APP_DATA_BASE, 'bridges', 'browser.json'),
    whatsapp: path.join(APP_DATA_BASE, 'bridges', 'whatsapp.json'),
    slack: path.join(APP_DATA_BASE, 'bridges', 'slack.json'),
    teams: path.join(APP_DATA_BASE, 'bridges', 'teams.json'),
  },

  // Scaffolding (runtime state — provisioned agents/teams)
  scaffolding: {
    agents: path.join(APP_DATA_BASE, 'scaffolding', 'agents.json'),
    teams: path.join(APP_DATA_BASE, 'scaffolding', 'teams.json'),
  },

  // User configuration (.UserData/)
  user: {
    knowledgeBase: path.join(USER_DATA_BASE, 'knowledge-base'),
    scaffoldingConfig: path.join(USER_DATA_BASE, 'scaffolding-config.json'),
    ecosystemConfig: path.join(USER_DATA_BASE, 'ecosystem.config.js'),
    profile: path.join(USER_DATA_BASE, 'user-profile.json'),
    credentials: path.join(USER_DATA_BASE, 'credentials.json'),
    integrations: path.join(USER_DATA_BASE, 'integrations.json'),
    team: path.join(USER_DATA_BASE, 'team.json'),
  },
} as const;

/**
 * Get the per-channel message file path
 */
export function collabMessageFile(channelId: string): string {
  return path.join(APP_DATA_BASE, 'collab-messages', `${channelId}.json`);
}

/**
 * Get the per-channel silent message file path
 */
export function collabSilentMessageFile(channelId: string): string {
  return path.join(APP_DATA_BASE, 'collab-messages', `${channelId}-silent.json`);
}

/**
 * Get the archived message file path for a channel
 */
export function archivedChannelMessageFile(channelId: string): string {
  return path.join(APP_DATA_BASE, 'collab-archived-messages', `${channelId}.json`);
}

/**
 * Get all archived message files matching a channel (includes archive-{ts} files)
 */
export function archivedChannelMessagesDir(): string {
  return path.join(APP_DATA_BASE, 'collab-archived-messages');
}

/**
 * Get the per-job cron execution log file path
 */
export function cronLogFile(jobId: string): string {
  return path.join(APP_DATA_BASE, 'cron-logs', `${jobId}.json`);
}

/**
 * Ensure the app data directory and subdirectories exist
 */
export async function ensureDataDirectory(): Promise<void> {
  const dirs = [
    APP_DATA_BASE,
    path.join(APP_DATA_BASE, 'bridges'),
    path.join(APP_DATA_BASE, 'scaffolding'),
    path.join(APP_DATA_BASE, 'collab-messages'),
    path.join(APP_DATA_BASE, 'collab-archived-messages'),
    path.join(APP_DATA_BASE, 'collab-images'),
    path.join(APP_DATA_BASE, 'crash-logs'),
    path.join(APP_DATA_BASE, 'cron-logs'),
    path.join(APP_DATA_BASE, 'idea-images'),
    path.join(APP_DATA_BASE, 'sprint-summaries'),
    path.join(APP_DATA_BASE, 'keep-alive'),
    path.join(APP_DATA_BASE, 'delivery-evidence'),
    path.join(/* turbopackIgnore: true */ APP_CWD, 'logs', 'event-logs'),
    path.join(/* turbopackIgnore: true */ APP_CWD, 'logs', 'event-logs', 'index'),
    USER_DATA_BASE,
    path.join(USER_DATA_BASE, 'knowledge-base'),
  ];
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        console.error('[DataPaths] Failed to create directory:', dir, error);
      }
    }
  }
}

/**
 * Get the current app data directory path
 */
export function getDataDir(): string {
  return APP_DATA_BASE;
}

/**
 * Get the product data directory path (git-tracked)
 */
export function getProductDataDir(): string {
  return PRODUCT_DATA_BASE;
}

/**
 * Check if running in test mode
 */
export function isTestMode(): boolean {
  return APP_DATA_DIR !== '.AppData' || process.env.DEVFLOW_TEST_MODE === 'true';
}
