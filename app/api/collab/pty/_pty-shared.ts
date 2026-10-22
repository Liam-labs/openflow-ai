/**
 * Shared types, constants, and utilities for /api/collab/pty route handlers.
 * Extracted from route.ts to reduce per-file TypeScript compilation size.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type {
  CollabChannelsData,
  AgentRosterEntry,
} from '@/lib/types';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import { appPath, appRoot } from '@/lib/app-paths';
import { getHomeDir } from '@/lib/home-dir';

// ---------------------------------------------------------------------------
// Request / Response Types
// ---------------------------------------------------------------------------

export interface PtyActionRequest {
  action: string;
  channelId?: string;
  sessionId?: string;
  content?: string;
  agentName?: string;
  systemPrompt?: string;
  // Roster fields
  agentId?: string;
  participantId?: string;
  name?: string;
  workingDirectory?: string;
  autoResume?: boolean;
  useCollabWrapper?: boolean;
  dangerouslySkipPermissions?: boolean;
  claudeFlags?: string[];
  roleId?: string;
  model?: string;
  agentType?: 'claude' | 'gemini' | 'grok' | 'codex' | 'antigravity';
  personality?: string;
  spawnMode?: 'wsl' | 'powershell';
  psWorkingDirectory?: string; // Windows-native working directory for powershell spawn mode
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'; // Reasoning effort; Codex applies it live, other runtimes on spawn
  runLocation?: 'server' | 'desktop' | null; // 'server' = DevFlow server agent; anything else = desktop
  fastMode?: boolean; // Codex Fast mode (1.5x)
  fresh?: boolean;
  color?: string;
  lastClaudeSessionId?: string;
  file?: string;      // Directive file key (personality, directives, expertise)
  systems?: import('@/lib/system-ownership').OwnedSystem[]; // roster_system_ownership_write — full-replace systems[] payload
  temporary?: boolean; // If true, agent is ephemeral — removable via "Remove from Channel"
  rehydrate?: boolean; // For 'roster_respawn' — inject rehydrate instruction on spawn (Sprint 40)
  restartOnly?: boolean; // For 'roster_launch_all' — only relaunch agents that were already running; leave offline agents stopped (graceful-restart vs launch-all)
  keepAliveMs?: number; // For 'roster_respawn' — keep old session alive for N ms after spawn (overlap; owner 2026-06-06)
  reason?: string;              // For 'roster_remove' — why the agent is being removed (audit trail)
  callerParticipantId?: string; // For 'roster_remove' — who requested the removal
  callerName?: string;          // For 'roster_remove' — human-readable caller name
}

export interface PtyActionResponse {
  success: boolean;
  session?: import('@/lib/types').CollabPtySession;
  participant?: import('@/lib/types').CollabParticipant;
  messageId?: string;
  contextFile?: string;
  command?: string;
  error?: string;
  agents?: AgentRosterEntry[];
  agent?: AgentRosterEntry;
  launched?: number;
  killed?: number;
  failed?: number;
  errors?: string[];
  runtimeApply?: {
    state: 'applied' | 'pending' | 'not-running' | 'not-codex' | 'failed';
    message?: string;
  };
}

export interface PtyListResponse {
  sessions: import('@/lib/types').CollabPtySession[];
  timestamp: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHANNELS_PATH = DataPaths.collabChannels;

export const DEFAULT_CHANNELS_DATA: CollabChannelsData = {
  channels: [],
  lastUpdated: new Date().toISOString(),
};

/** Minimum available memory (MB) required to spawn a new agent. */
export const MIN_MEMORY_FOR_SPAWN_MB = 2048;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Validate that a tmux session name contains only safe characters.
 * Prevents shell injection when tmuxSessionName is used in exec calls.
 * Tmux session names allow: alphanumeric, hyphens, underscores, dots, colons.
 */
export function isValidTmuxSessionName(name: string): boolean {
  return /^[a-zA-Z0-9_\-.:]+$/.test(name) && name.length > 0 && name.length <= 200;
}

/**
 * Validate that workingDirectory is within an allowed base path.
 * Prevents path traversal attacks (arbitrary directory creation).
 */
export function isAllowedWorkingDirectory(dir: string): boolean {
  const resolved = path.resolve(dir);
  const home = getHomeDir();
  const cwd = appRoot();
  return resolved.startsWith(home + path.sep) || resolved === home ||
         resolved.startsWith(cwd + path.sep) || resolved === cwd;
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

export async function readChannelsData(): Promise<CollabChannelsData> {
  return readJsonFile<CollabChannelsData>(CHANNELS_PATH, DEFAULT_CHANNELS_DATA);
}

// Writing the channels file is not done here: every change goes through
// `mutateChannels` / `saveChannels` in lib/collab-channel-store.ts, the only write path.

// ---------------------------------------------------------------------------
// System utilities
// ---------------------------------------------------------------------------

/**
 * Check available system memory by reading /proc/meminfo.
 * Returns available memory in MB, or null if unable to read.
 */
export async function getAvailableMemoryMB(): Promise<number | null> {
  try {
    const meminfo = await fs.readFile('/proc/meminfo', 'utf-8');
    const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (match) {
      return Math.floor(parseInt(match[1], 10) / 1024);
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// File utilities (shared by roster-ops and message-inject)
// ---------------------------------------------------------------------------

export async function readTemplateFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function findPersonalityFile(name: string): Promise<string | null> {
  const personalitiesDir = appPath('data', 'roles', 'personalities');
  const topLevel = path.join(personalitiesDir, `${name}.md`);
  try { await fs.access(topLevel); return topLevel; } catch { /* not found */ }

  let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }> = [];
  try {
    entries = await fs.readdir(personalitiesDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subPath = path.join(personalitiesDir, entry.name, `${name}.md`);
      try { await fs.access(subPath); return subPath; } catch { /* not in this subdir */ }
    }
  }

  // Substring fallback: pick the longest personality whose filename (sans .md)
  // is a case-insensitive substring of the agent name. So "CJack" → "Jack.md",
  // "TeamSamantha" → "an agent.md". Minimum length 3 to avoid false positives.
  const nameLower = name.toLowerCase();
  const candidates: { file: string; basename: string }[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const basename = entry.name.replace(/\.md$/, '');
      if (basename.length >= 3 && nameLower.includes(basename.toLowerCase())) {
        candidates.push({ file: path.join(personalitiesDir, entry.name), basename });
      }
    }
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.basename.length - a.basename.length);
    return candidates[0].file;
  }

  return null;
}
