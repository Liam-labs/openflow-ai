/**
 * Token Usage Tracking
 *
 * Reads Claude Code JSONL session files to compute per-agent and aggregate token usage.
 * Session files are located at ~/.claude/projects/{project-dir}/{session-id}.jsonl
 * Each assistant message contains a `usage` field with token counts.
 *
 * Uses INCREMENTAL parsing — only reads new bytes since last check.
 * JSONL files are append-only, so previously parsed data never changes.
 * First read: full file scan. Subsequent reads: only the delta (< 10KB typically).
 *
 * Also supports Grok agents: reads /tmp/grok-usage-{pid}.json for token breakdown.
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import type { CollabChannelsData, AgentRosterEntry } from '@/lib/types';
import { remoteFile, remoteFilesSince, remoteWindow, type RemoteFileUsage } from '@/lib/remote-usage';
import { remoteStreamFs } from '@/lib/agent-stream-fs';
import { resolveJsonlForDir } from '@/lib/agent-jsonl-resolver';
import { filesHostFor } from '@/lib/host-executor';

// ============================================
// Types
// ============================================

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  thinkingTokens?: number; // Grok reasoning tokens (optional for Claude compat)
}

export interface AgentTokenUsage {
  participantId: string;
  agentName: string;
  sessionId: string | null;
  tokens: TokenCounts;
  totalTokens: number; // input + output + thinking (excludes cache for simplicity)
  messageCount: number;
  lastActivity: string | null;
}

export interface ChannelUsageResult {
  channelId: string;
  agents: AgentTokenUsage[];
  total: TokenCounts & { totalTokens: number };
  computedAt: string;
}

export interface ModelCostEntry {
  modelId: string;
  displayName: string;
  tokens: TokenCounts;
  totalTokens: number;
  costGBP: number;
}

export interface GlobalUsageSummary {
  todayTokens: TokenCounts & { totalTokens: number };
  sessionCount: number;
  computedAt: string;
  totalCostGBP: number;
  modelBreakdown: ModelCostEntry[];
}

// ============================================
// Model Pricing (GBP per million tokens, ~0.79 USD/GBP)
// ============================================

const MODEL_RATES_GBP: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  haiku:  { input: 0.632,  output: 3.16,  cacheWrite: 0.79,   cacheRead: 0.0632  },
  sonnet: { input: 1.58,   output: 7.90,  cacheWrite: 1.975,  cacheRead: 0.158   },  // Sonnet 5/5.5: $2/$10
  opus:   { input: 11.85,  output: 59.25, cacheWrite: 14.81,  cacheRead: 1.185   },
};

function getModelRates(modelId: string) {
  const lower = modelId.toLowerCase();
  if (lower.includes('haiku')) return MODEL_RATES_GBP.haiku;
  if (lower.includes('opus'))  return MODEL_RATES_GBP.opus;
  return MODEL_RATES_GBP.sonnet;
}

export function computeModelCostGBP(tokens: TokenCounts, modelId: string): number {
  const r = getModelRates(modelId);
  return (
    tokens.inputTokens        * r.input      +
    tokens.outputTokens       * r.output     +
    tokens.cacheCreationTokens * r.cacheWrite +
    tokens.cacheReadTokens    * r.cacheRead
  ) / 1_000_000;
}

function modelDisplayName(modelId: string): string {
  // e.g. "claude-sonnet-4-6" → "Sonnet 4.6"
  const m = modelId.match(/claude-(\w+)-([\d-]+)/i);
  if (!m) return modelId;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const version = m[2].replace(/-(\d{8})$/, ''); // strip date suffix
  return `${family} ${version}`;
}

// ============================================
// Incremental Cache
// ============================================

interface IncrementalCacheEntry {
  fileSize: number;
  byteOffset: number;
  tokens: TokenCounts;
  modelTokens: Record<string, TokenCounts>; // per-model accumulation
  messageCount: number;
  lastActivity: string | null;
  cachedAt: number;
}

// Cache keyed by file path. Uses incremental parsing - only reads new bytes.
const usageCache = new Map<string, IncrementalCacheEntry>();

// No TTL needed - we use file size comparison for invalidation.
// If file hasn't grown, cached data is still valid (JSONL is append-only).

// ============================================
// Grok Usage File Reading
// ============================================

interface GrokUsageFile {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  total_tokens?: number;
  pid?: number;
  updatedAt?: string;
}

// Cache for Grok usage files (keyed by pid), invalidated by mtime
const grokUsageCache = new Map<string, { data: GrokUsageFile; mtime: number; cachedAt: number }>();

/**
 * Read Grok token usage from /tmp/grok-usage-{pid}.json
 * Uses mtime-based caching to avoid repeated reads.
 */
async function computeGrokTokenUsage(pid: number): Promise<{
  tokens: TokenCounts;
  messageCount: number;
  lastActivity: string | null;
}> {
  const filePath = `/tmp/grok-usage-${pid}.json`;
  const empty = {
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 },
    messageCount: 0,
    lastActivity: null,
  };

  try {
    const stat = await fs.stat(filePath);
    const cached = grokUsageCache.get(filePath);

    // Return cached data if file hasn't changed
    if (cached && cached.mtime === stat.mtimeMs) {
      const d = cached.data;
      return {
        tokens: {
          inputTokens: d.input_tokens || 0,
          outputTokens: d.output_tokens || 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          thinkingTokens: d.thinking_tokens || 0,
        },
        messageCount: 0,
        lastActivity: d.updatedAt || null,
      };
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const data: GrokUsageFile = JSON.parse(content);

    grokUsageCache.set(filePath, { data, mtime: stat.mtimeMs, cachedAt: Date.now() });

    return {
      tokens: {
        inputTokens: data.input_tokens || 0,
        outputTokens: data.output_tokens || 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        thinkingTokens: data.thinking_tokens || 0,
      },
      messageCount: 0,
      lastActivity: data.updatedAt || null,
    };
  } catch {
    return empty;
  }
}

// ============================================
// JSONL Parsing
// ============================================

interface JsonlUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface JsonlRecord {
  type?: string;
  message?: {
    model?: string;
    usage?: JsonlUsage;
  };
  timestamp?: string;
}

/**
 * Parse JSONL lines and accumulate token counts (total + per-model).
 * Used by both full reads and incremental reads.
 */
function parseJsonlLines(
  content: string,
  tokens: TokenCounts,
  modelTokens: Record<string, TokenCounts>,
): { messageCount: number; lastActivity: string | null } {
  const lines = content.split('\n');
  let messageCount = 0;
  let lastActivity: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record: JsonlRecord = JSON.parse(line);
      if (record.type === 'assistant' && record.message?.usage) {
        const usage = record.message.usage;
        const input    = usage.input_tokens || 0;
        const output   = usage.output_tokens || 0;
        const cacheR   = usage.cache_read_input_tokens || 0;
        const cacheW   = usage.cache_creation_input_tokens || 0;
        tokens.inputTokens         += input;
        tokens.outputTokens        += output;
        tokens.cacheReadTokens     += cacheR;
        tokens.cacheCreationTokens += cacheW;
        // Accumulate per-model
        const modelId = record.message.model || 'unknown';
        if (!modelTokens[modelId]) {
          modelTokens[modelId] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
        }
        modelTokens[modelId].inputTokens         += input;
        modelTokens[modelId].outputTokens        += output;
        modelTokens[modelId].cacheReadTokens     += cacheR;
        modelTokens[modelId].cacheCreationTokens += cacheW;
        messageCount++;
        if (record.timestamp) {
          lastActivity = record.timestamp;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { messageCount, lastActivity };
}

/**
 * Compute token usage from a single JSONL session file.
 * Uses INCREMENTAL parsing — only reads new bytes since last check.
 * JSONL files are append-only, so previously parsed data never changes.
 *
 * Performance: First read parses the whole file. Subsequent reads only parse
 * the delta (typically < 10KB vs potentially 10MB+ for the full file).
 */
export async function computeSessionTokenUsage(filePath: string): Promise<{
  tokens: TokenCounts;
  modelTokens: Record<string, TokenCounts>;
  messageCount: number;
  lastActivity: string | null;
}> {
  try {
    const stat = await fs.stat(filePath);
    const cached = usageCache.get(filePath);

    // File hasn't grown — return cached totals (JSONL is append-only)
    if (cached && cached.fileSize === stat.size) {
      return { tokens: { ...cached.tokens }, modelTokens: { ...cached.modelTokens }, messageCount: cached.messageCount, lastActivity: cached.lastActivity };
    }

    // File shrunk or doesn't match — full re-read needed
    if (cached && stat.size < cached.byteOffset) {
      usageCache.delete(filePath);
    }

    const existing = usageCache.get(filePath);

    if (existing && stat.size > existing.byteOffset) {
      // INCREMENTAL READ: Only read new bytes from byteOffset to end of file
      const deltaSize = stat.size - existing.byteOffset;
      const buffer = Buffer.alloc(deltaSize);
      const fh = await fs.open(filePath, 'r');
      try {
        await fh.read(buffer, 0, deltaSize, existing.byteOffset);
      } finally {
        await fh.close();
      }

      const newContent = buffer.toString('utf-8');
      const firstNewline = newContent.indexOf('\n');
      const safeContent = firstNewline >= 0 ? newContent.slice(firstNewline + 1) : newContent;

      const { messageCount: newMsgCount, lastActivity: newActivity } = parseJsonlLines(safeContent, existing.tokens, existing.modelTokens);

      existing.messageCount += newMsgCount;
      if (newActivity) existing.lastActivity = newActivity;
      existing.fileSize = stat.size;
      existing.byteOffset = stat.size;
      existing.cachedAt = Date.now();

      return { tokens: { ...existing.tokens }, modelTokens: { ...existing.modelTokens }, messageCount: existing.messageCount, lastActivity: existing.lastActivity };
    }

    // FULL READ: First time seeing this file (or cache was cleared)
    const content = await fs.readFile(filePath, 'utf-8');
    const tokens: TokenCounts = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const modelTokens: Record<string, TokenCounts> = {};

    const { messageCount, lastActivity } = parseJsonlLines(content, tokens, modelTokens);

    usageCache.set(filePath, {
      fileSize: stat.size,
      byteOffset: stat.size,
      tokens,
      modelTokens,
      messageCount,
      lastActivity,
      cachedAt: Date.now(),
    });

    return { tokens: { ...tokens }, modelTokens: { ...modelTokens }, messageCount, lastActivity };
  } catch {
    return {
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      modelTokens: {},
      messageCount: 0,
      lastActivity: null,
    };
  }
}

// ============================================
// Session File Discovery
// ============================================

/**
 * Convert a working directory path to the Claude projects directory name.
 * e.g., ~/DevFlow → -home-<user>-DevFlow
 */
function workingDirToProjectDir(workingDir: string): string {
  return workingDir.replace(/\//g, '-');
}

/**
 * Find the JSONL session file for a given Claude session ID and working directory.
 */
export function getSessionFilePath(sessionId: string, workingDirectory: string, home?: string): string {
  const homeDir = home ?? os.homedir();
  const projectDir = workingDirToProjectDir(workingDirectory);
  return path.join(homeDir, '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
}

/**
 * Find all JSONL session files for a given working directory.
 */
async function findAllSessionFiles(workingDirectory: string): Promise<string[]> {
  const homeDir = os.homedir();
  const projectDir = workingDirToProjectDir(workingDirectory);
  const dirPath = path.join(homeDir, '.claude', 'projects', projectDir);

  try {
    const files = await fs.readdir(dirPath);
    return files
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(dirPath, f));
  } catch {
    return [];
  }
}

// ============================================
// PID-based Session Discovery
// ============================================

/**
 * Find the most recently modified JSONL session file for a given working directory.
 * Used as a fallback when lastClaudeSessionId is not available (e.g., after reboot).
 * Only considers files modified today.
 */
async function findNewestSessionFile(workingDirectory: string): Promise<string | null> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const files = await findAllSessionFiles(workingDirectory);
  let newest: { path: string; mtime: Date } | null = null;

  for (const filePath of files) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtime < todayStart) continue;
      if (!newest || stat.mtime > newest.mtime) {
        newest = { path: filePath, mtime: stat.mtime };
      }
    } catch {
      // Skip unreadable files
    }
  }

  return newest?.path || null;
}

// PID discovery cache — avoids repeated pgrep/ps calls on the 1s poll interval
const pidCache = new Map<number, { claudePid: number | null; cachedAt: number }>();
const PID_CACHE_TTL_MS = 30_000; // 30s — PIDs don't change during an agent's lifetime

/**
 * Try to discover a Claude session file for an agent by walking the process tree.
 * Looks for /tmp/collab-session-{claude_pid}.json to find the Claude process,
 * then finds the newest JSONL session file in the project directory.
 *
 * Uses async execFile (non-blocking) with timeouts and a 30s PID cache.
 */
async function discoverSessionByPid(pid: number, workingDirectory: string): Promise<string | null> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // Check cache first
    const cached = pidCache.get(pid);
    const now = Date.now();
    let claudePid: number | null;

    if (cached && (now - cached.cachedAt) < PID_CACHE_TTL_MS) {
      claudePid = cached.claudePid;
    } else {
      // Walk process tree async: bash(pid) → python3 → claude (up to 3 levels)
      claudePid = await findClaudePidAsync(execFileAsync, pid, 0);
      pidCache.set(pid, { claudePid, cachedAt: now });

      // Evict old cache entries periodically
      if (pidCache.size > 100) {
        for (const [k, v] of pidCache) {
          if (now - v.cachedAt > PID_CACHE_TTL_MS) pidCache.delete(k);
        }
      }
    }

    if (!claudePid) return null;

    // Check /tmp/collab-session-{claudePid}.json for project info
    try {
      const sessionData = JSON.parse(await fs.readFile(`/tmp/collab-session-${claudePid}.json`, 'utf-8'));
      const projectPath = sessionData.projectPath || workingDirectory;
      return findNewestSessionFile(projectPath);
    } catch {
      return findNewestSessionFile(workingDirectory);
    }
  } catch {
    return null;
  }
}

async function findClaudePidAsync(
  execFileAsync: (cmd: string, args: string[], opts: object) => Promise<{ stdout: string }>,
  parentPid: number,
  depth: number
): Promise<number | null> {
  if (depth > 3) return null;
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(parentPid)], { timeout: 3000, encoding: 'utf-8' });
    for (const childStr of stdout.trim().split('\n')) {
      const childPid = parseInt(childStr, 10);
      if (isNaN(childPid)) continue;
      try {
        const { stdout: comm } = await execFileAsync('ps', ['-p', String(childPid), '-o', 'comm='], { timeout: 3000, encoding: 'utf-8' });
        if (comm.trim() === 'claude') return childPid;
      } catch { /* skip */ }
      const found = await findClaudePidAsync(execFileAsync, childPid, depth + 1);
      if (found) return found;
    }
  } catch { /* pgrep failed = no children */ }
  return null;
}

// ============================================
// Sessions on the agent host
// ============================================

interface HostAgentUsage { tokens: TokenCounts; messageCount: number; lastActivity: string | null; sessionId: string | null }

/**
 * Usage of the Claude agents whose files are on the agent host. The transcript is found the way the Live Feed finds it (scratch
 * pointer, session id, newest file), then its totals are asked of the host. Agents with no transcript there, or a host that
 * does not answer, are left out so the local path still handles them.
 */
export async function remoteAgentUsage(roster: AgentRosterEntry[]): Promise<Map<string, HostAgentUsage>> {
  const out = new Map<string, HostAgentUsage>();
  await Promise.all(roster.map(async (agent) => {
    const type = (agent as AgentRosterEntry & { agentType?: string }).agentType;
    if (type && type !== 'claude') return;
    const host = filesHostFor(agent);
    if (!host) return;
    try {
      const fsx = remoteStreamFs(host);
      const dir = agent.effectiveWorkingDirectory?.trim() || agent.workingDirectory;
      const home = await fsx.home();
      const known = agent.lastClaudeSessionId ? getSessionFilePath(agent.lastClaudeSessionId, agent.workingDirectory, home) : null;
      const filePath = known ?? (await resolveJsonlForDir(dir, { fsx }))?.path ?? null;
      if (!filePath) return;
      const usage = await remoteFile(filePath);
      if (!usage) return;
      out.set(agent.participantId, {
        tokens: usage.tokens,
        messageCount: usage.messageCount,
        lastActivity: usage.lastActivity,
        sessionId: path.basename(filePath, '.jsonl'),
      });
    } catch { /* host not answering: this agent shows no usage rather than failing the panel */ }
  }));
  return out;
}

// ============================================
// Channel-Level Usage
// ============================================

/**
 * Get token usage for all agents in a collab channel.
 * Reads each agent's Claude session JSONL file based on roster data.
 * Falls back to PID-based session discovery when lastClaudeSessionId is null.
 * For Grok agents (agentType === 'grok'), reads /tmp/grok-usage-{pid}.json instead.
 */
export async function getChannelAgentUsage(channelId: string): Promise<ChannelUsageResult> {
  const channelsData = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, { channels: [], lastUpdated: '' });
  const channel = channelsData.channels.find(c => c.id === channelId);

  if (!channel) {
    return {
      channelId,
      agents: [],
      total: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, totalTokens: 0 },
      computedAt: new Date().toISOString(),
    };
  }

  const roster: AgentRosterEntry[] = channel.roster?.agents || [];
  const agentUsages: AgentTokenUsage[] = [];

  // Pre-compute unique session files to avoid duplicate reads.
  const sessionCache = new Map<string, { tokens: TokenCounts; messageCount: number; lastActivity: string | null }>();

  // Agents whose transcripts are written on the agent host (not on this machine) are read there: the host sums them and only totals come back.
  const remoteUsage = await remoteAgentUsage(roster);

  // Collect unique sessions first (includes discovered sessions)
  const uniqueSessions = new Map<string, { sessionId: string; workingDir: string }>();
  // Track agents that need PID-based discovery
  const needsDiscovery: AgentRosterEntry[] = [];
  // Track Grok agents (read usage from /tmp/grok-usage-{pid}.json)
  const grokAgents: AgentRosterEntry[] = [];

  for (const agent of roster) {
    if (remoteUsage.has(agent.participantId)) continue;
    if ((agent as AgentRosterEntry & { agentType?: string }).agentType === 'grok') {
      if (agent.pid) grokAgents.push(agent);
    } else if (agent.lastClaudeSessionId && !uniqueSessions.has(agent.lastClaudeSessionId)) {
      uniqueSessions.set(agent.lastClaudeSessionId, {
        sessionId: agent.lastClaudeSessionId,
        workingDir: agent.workingDirectory,
      });
    } else if (!agent.lastClaudeSessionId && agent.pid) {
      needsDiscovery.push(agent);
    }
  }

  // Discover session files for agents without session IDs (in parallel)
  const discoveredFiles = new Map<string, string>(); // participantId -> filePath
  if (needsDiscovery.length > 0) {
    await Promise.all(needsDiscovery.map(async (agent) => {
      const filePath = await discoverSessionByPid(agent.pid!, agent.workingDirectory);
      if (filePath) {
        discoveredFiles.set(agent.participantId, filePath);
      }
    }));
  }

  // Read Grok usage files in parallel
  const grokUsageMap = new Map<string, { tokens: TokenCounts; messageCount: number; lastActivity: string | null }>();
  if (grokAgents.length > 0) {
    await Promise.all(grokAgents.map(async (agent) => {
      const result = await computeGrokTokenUsage(agent.pid!);
      grokUsageMap.set(agent.participantId, result);
    }));
  }

  // Read unique known sessions in parallel
  const sessionEntries = Array.from(uniqueSessions.entries());
  await Promise.all(sessionEntries.map(async ([sessionId, { workingDir }]) => {
    const filePath = getSessionFilePath(sessionId, workingDir);
    const result = await computeSessionTokenUsage(filePath);
    sessionCache.set(sessionId, result);
  }));

  // Read discovered session files in parallel
  const discoveredCache = new Map<string, { tokens: TokenCounts; messageCount: number; lastActivity: string | null }>();
  const discoveredEntries = Array.from(discoveredFiles.entries());
  await Promise.all(discoveredEntries.map(async ([participantId, filePath]) => {
    const result = await computeSessionTokenUsage(filePath);
    discoveredCache.set(participantId, result);
  }));

  // Map roster agents to their usage
  for (const agent of roster) {
    const isGrok = (agent as AgentRosterEntry & { agentType?: string }).agentType === 'grok';

    // Grok agent — use grok usage file
    if (isGrok) {
      const grokData = grokUsageMap.get(agent.participantId);
      const tokens = grokData?.tokens || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 };
      agentUsages.push({
        participantId: agent.participantId,
        agentName: agent.name,
        sessionId: null,
        tokens,
        totalTokens: tokens.inputTokens + tokens.outputTokens + (tokens.thinkingTokens || 0),
        messageCount: grokData?.messageCount || 0,
        lastActivity: grokData?.lastActivity || null,
      });
      continue;
    }

    // Transcript on the agent host
    const onHost = remoteUsage.get(agent.participantId);
    if (onHost) {
      agentUsages.push({
        participantId: agent.participantId,
        agentName: agent.name,
        sessionId: onHost.sessionId,
        tokens: onHost.tokens,
        totalTokens: onHost.tokens.inputTokens + onHost.tokens.outputTokens,
        messageCount: onHost.messageCount,
        lastActivity: onHost.lastActivity,
      });
      continue;
    }

    // Try known session first
    if (agent.lastClaudeSessionId) {
      const cached = sessionCache.get(agent.lastClaudeSessionId);
      const tokens = cached?.tokens || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
      agentUsages.push({
        participantId: agent.participantId,
        agentName: agent.name,
        sessionId: agent.lastClaudeSessionId,
        tokens,
        totalTokens: tokens.inputTokens + tokens.outputTokens,
        messageCount: cached?.messageCount || 0,
        lastActivity: cached?.lastActivity || null,
      });
      continue;
    }

    // Try PID-discovered session
    const discovered = discoveredCache.get(agent.participantId);
    if (discovered && (discovered.tokens.inputTokens + discovered.tokens.outputTokens) > 0) {
      const tokens = discovered.tokens;
      agentUsages.push({
        participantId: agent.participantId,
        agentName: agent.name,
        sessionId: null,
        tokens,
        totalTokens: tokens.inputTokens + tokens.outputTokens,
        messageCount: discovered.messageCount,
        lastActivity: discovered.lastActivity,
      });
      continue;
    }

    // No usage data available
    agentUsages.push({
      participantId: agent.participantId,
      agentName: agent.name,
      sessionId: null,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      totalTokens: 0,
      messageCount: 0,
      lastActivity: null,
    });
  }

  // Compute totals from all sources
  const total: TokenCounts & { totalTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
  };

  for (const [, data] of sessionCache) {
    total.inputTokens += data.tokens.inputTokens;
    total.outputTokens += data.tokens.outputTokens;
    total.cacheReadTokens += data.tokens.cacheReadTokens;
    total.cacheCreationTokens += data.tokens.cacheCreationTokens;
    total.totalTokens += data.tokens.inputTokens + data.tokens.outputTokens;
  }
  for (const [, data] of discoveredCache) {
    total.inputTokens += data.tokens.inputTokens;
    total.outputTokens += data.tokens.outputTokens;
    total.cacheReadTokens += data.tokens.cacheReadTokens;
    total.cacheCreationTokens += data.tokens.cacheCreationTokens;
    total.totalTokens += data.tokens.inputTokens + data.tokens.outputTokens;
  }
  for (const [, data] of remoteUsage) {
    total.inputTokens += data.tokens.inputTokens;
    total.outputTokens += data.tokens.outputTokens;
    total.cacheReadTokens += data.tokens.cacheReadTokens;
    total.cacheCreationTokens += data.tokens.cacheCreationTokens;
    total.totalTokens += data.tokens.inputTokens + data.tokens.outputTokens;
  }
  for (const [, data] of grokUsageMap) {
    total.inputTokens += data.tokens.inputTokens;
    total.outputTokens += data.tokens.outputTokens;
    total.thinkingTokens = (total.thinkingTokens || 0) + (data.tokens.thinkingTokens || 0);
    total.totalTokens += data.tokens.inputTokens + data.tokens.outputTokens + (data.tokens.thinkingTokens || 0);
  }

  return {
    channelId,
    agents: agentUsages,
    total,
    computedAt: new Date().toISOString(),
  };
}

// ============================================
// Global Usage Summary
// ============================================

let globalUsageCache: { data: GlobalUsageSummary; cachedAt: number } | null = null;

function addRemoteFile(total: TokenCounts & { totalTokens: number }, models: Record<string, TokenCounts>, file: RemoteFileUsage): void {
  total.inputTokens += file.tokens.inputTokens;
  total.outputTokens += file.tokens.outputTokens;
  total.cacheReadTokens += file.tokens.cacheReadTokens;
  total.cacheCreationTokens += file.tokens.cacheCreationTokens;
  total.totalTokens += file.tokens.inputTokens + file.tokens.outputTokens;
  for (const [modelId, mt] of Object.entries(file.modelTokens)) {
    const slot = (models[modelId] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    slot.inputTokens += mt.inputTokens;
    slot.outputTokens += mt.outputTokens;
    slot.cacheReadTokens += mt.cacheReadTokens;
    slot.cacheCreationTokens += mt.cacheCreationTokens;
  }
}
const GLOBAL_CACHE_TTL_MS = 5_000; // 5s cache (incremental parsing makes this cheap)

/**
 * Get aggregate token usage across all recent sessions (today).
 * Scans all JSONL files modified today in the DevFlow project directory.
 * Also includes Grok usage from /tmp/grok-usage-*.json files.
 * Results are cached server-side to avoid redundant filesystem scans.
 */
export async function getGlobalUsageSummary(): Promise<GlobalUsageSummary> {
  if (globalUsageCache && (Date.now() - globalUsageCache.cachedAt) < GLOBAL_CACHE_TTL_MS) {
    return globalUsageCache.data;
  }
  const homeDir = os.homedir();
  const projectsDir = path.join(homeDir, '.claude', 'projects');

  const total: TokenCounts & { totalTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
  };

  let sessionCount = 0;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const globalModelTokens: Record<string, TokenCounts> = {};

  try {
    const projectDirs = await fs.readdir(projectsDir);

    for (const dir of projectDirs) {
      const dirPath = path.join(projectsDir, dir);
      const dirStat = await fs.stat(dirPath).catch(() => null);
      if (!dirStat?.isDirectory()) continue;

      const files = await findAllSessionFiles('/' + dir.replace(/-/g, '/').replace(/^\//, ''));

      for (const filePath of files) {
        try {
          const stat = await fs.stat(filePath);
          if (stat.mtime < todayStart) continue;

          const { tokens, modelTokens } = await computeSessionTokenUsage(filePath);
          total.inputTokens += tokens.inputTokens;
          total.outputTokens += tokens.outputTokens;
          total.cacheReadTokens += tokens.cacheReadTokens;
          total.cacheCreationTokens += tokens.cacheCreationTokens;
          total.totalTokens += tokens.inputTokens + tokens.outputTokens;
          // Merge per-model counts
          for (const [modelId, mt] of Object.entries(modelTokens)) {
            if (!globalModelTokens[modelId]) {
              globalModelTokens[modelId] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
            }
            globalModelTokens[modelId].inputTokens         += mt.inputTokens;
            globalModelTokens[modelId].outputTokens        += mt.outputTokens;
            globalModelTokens[modelId].cacheReadTokens     += mt.cacheReadTokens;
            globalModelTokens[modelId].cacheCreationTokens += mt.cacheCreationTokens;
          }
          sessionCount++;
        } catch {
          // Skip unreadable files
        }
      }
    }
  } catch {
    // Projects directory doesn't exist
  }

  // Sessions on the agent host (summed there; only totals come back)
  for (const file of await remoteFilesSince(todayStart.getTime())) {
    addRemoteFile(total, globalModelTokens, file);
    sessionCount++;
  }

  // Also include Grok usage files from /tmp/grok-usage-*.json
  try {
    const tmpFiles = await fs.readdir('/tmp');
    const grokFiles = tmpFiles.filter(f => f.startsWith('grok-usage-') && f.endsWith('.json'));
    await Promise.all(grokFiles.map(async (f) => {
      try {
        const filePath = path.join('/tmp', f);
        const stat = await fs.stat(filePath);
        if (stat.mtime < todayStart) return;
        const content = await fs.readFile(filePath, 'utf-8');
        const data: GrokUsageFile = JSON.parse(content);
        const input = data.input_tokens || 0;
        const output = data.output_tokens || 0;
        const thinking = data.thinking_tokens || 0;
        total.inputTokens += input;
        total.outputTokens += output;
        total.thinkingTokens = (total.thinkingTokens || 0) + thinking;
        total.totalTokens += input + output + thinking;
        sessionCount++;
      } catch { /* skip */ }
    }));
  } catch { /* /tmp not readable */ }

  // Build per-model cost breakdown, sorted by cost desc
  const modelBreakdown: ModelCostEntry[] = Object.entries(globalModelTokens)
    .map(([modelId, mt]) => ({
      modelId,
      displayName: modelDisplayName(modelId),
      tokens: mt,
      totalTokens: mt.inputTokens + mt.outputTokens,
      costGBP: computeModelCostGBP(mt, modelId),
    }))
    .sort((a, b) => b.costGBP - a.costGBP);

  const totalCostGBP = modelBreakdown.reduce((sum, m) => sum + m.costGBP, 0);

  const result: GlobalUsageSummary = {
    todayTokens: total,
    sessionCount,
    computedAt: new Date().toISOString(),
    totalCostGBP,
    modelBreakdown,
  };
  globalUsageCache = { data: result, cachedAt: Date.now() };
  return result;
}

/**
 * Format token count for display (e.g., 1234567 → "1.2M", 45678 → "45.7K")
 */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return count.toString();
}

// ============================================
// Subscription Limits
// ============================================

export interface SubscriptionLimitsConfig {
  plan: string;
  daily: {
    limitTokens: number;
    windowHours: number;
  };
  weekly: {
    limitTokens: number;
    resetDay: number;      // 0=Sunday, 1=Monday, ...
    resetHour: number;     // Local hour (24h) e.g., 10 for 10:00 AM
    resetTimezone: string; // e.g., "Australia/Brisbane"
  };
  lastUpdated: string;
}

export interface UsageLimitBar {
  usedTokens: number;
  limitTokens: number;
  percentage: number;       // 0-100, capped at 100
  resetTime: string;        // ISO timestamp of next reset
  resetIn: string;          // Human-readable e.g., "2 hr 42 min"
  label: string;            // e.g., "Current session" or "Weekly limits"
}

export interface UsageLimitsResponse {
  daily: UsageLimitBar;
  weekly: UsageLimitBar;
  plan: string;
  configured: boolean;
  computedAt: string;
}

const DEFAULT_LIMITS: SubscriptionLimitsConfig = {
  plan: 'max',
  daily: {
    limitTokens: 850_000_000,    // ~850M all-inclusive tokens per session window (MAX plan, calibrated against Anthropic /usage)
    windowHours: 5,
  },
  weekly: {
    limitTokens: 4_000_000_000,  // ~4B all-inclusive tokens per week (MAX plan, calibrated against Anthropic /usage)
    resetDay: 0,                 // Sunday
    resetHour: 10,               // 10:00 AM
    resetTimezone: 'Australia/Brisbane',
  },
  lastUpdated: new Date().toISOString(),
};

/**
 * Read the subscription limits config from disk.
 * Returns defaults if not configured.
 */
export async function getSubscriptionLimits(): Promise<SubscriptionLimitsConfig> {
  return readJsonFile<SubscriptionLimitsConfig>(DataPaths.subscriptionLimits, DEFAULT_LIMITS);
}

/**
 * Save subscription limits config to disk.
 */
export async function setSubscriptionLimits(config: Partial<SubscriptionLimitsConfig>): Promise<SubscriptionLimitsConfig> {
  return withFileLock(DataPaths.subscriptionLimits, async () => {
    const current = await getSubscriptionLimits();
    const updated: SubscriptionLimitsConfig = {
      plan: config.plan ?? current.plan,
      daily: { ...current.daily, ...config.daily },
      weekly: { ...current.weekly, ...config.weekly },
      lastUpdated: new Date().toISOString(),
    };
    await writeJsonFile(DataPaths.subscriptionLimits, updated);
    return updated;
  });
}

/**
 * Calculate time remaining until next reset, returned as human-readable string.
 */
function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return 'now';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/**
 * Calculate next daily session reset time.
 * The session window is a rolling window of `windowHours` hours.
 * We estimate it as resetting every `windowHours` from midnight today.
 */
function getNextDailyReset(windowHours: number): Date {
  const now = new Date();
  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);

  const windowMs = windowHours * 3600_000;
  const elapsed = now.getTime() - todayMidnight.getTime();
  const currentWindowIndex = Math.floor(elapsed / windowMs);
  const nextReset = new Date(todayMidnight.getTime() + (currentWindowIndex + 1) * windowMs);

  return nextReset;
}

/**
 * Calculate next weekly reset time based on day/hour/timezone config.
 */
function getNextWeeklyReset(resetDay: number, resetHour: number, _timezone: string): Date {
  const now = new Date();
  const currentDay = now.getDay();
  const currentHour = now.getHours();

  let daysUntilReset = resetDay - currentDay;
  if (daysUntilReset < 0) {
    daysUntilReset += 7;
  } else if (daysUntilReset === 0 && currentHour >= resetHour) {
    daysUntilReset = 7;
  }

  const nextReset = new Date(now);
  nextReset.setDate(now.getDate() + daysUntilReset);
  nextReset.setHours(resetHour, 0, 0, 0);

  return nextReset;
}

// Per-file timeline of assistant usage messages, read incrementally. The
// usage bar polls every few seconds and the rolling window spans hundreds of
// megabytes of transcripts; re-reading all of them each time kept the DevFlow
// event loop busy for seconds at a time.
interface UsageTimeline {
  ino: number;
  byteOffset: number; // bytes consumed through the last complete line
  times: number[];
  tokens: number[];
}

const usageTimelineCache = new Map<string, UsageTimeline>();

async function readUsageTimeline(filePath: string, stat: { ino: number; size: number }): Promise<UsageTimeline> {
  let timeline = usageTimelineCache.get(filePath);
  if (!timeline || timeline.ino !== stat.ino || stat.size < timeline.byteOffset) {
    timeline = { ino: stat.ino, byteOffset: 0, times: [], tokens: [] };
    usageTimelineCache.set(filePath, timeline);
  }
  if (stat.size <= timeline.byteOffset) return timeline;

  const buffer = Buffer.alloc(stat.size - timeline.byteOffset);
  const fh = await fs.open(filePath, 'r');
  let bytesRead: number;
  try {
    ({ bytesRead } = await fh.read(buffer, 0, buffer.length, timeline.byteOffset));
  } finally {
    await fh.close();
  }
  // Leave a partially written last line for the next read.
  const lastNewline = bytesRead > 0 ? buffer.lastIndexOf(0x0a, bytesRead - 1) : -1;
  if (lastNewline < 0) return timeline;

  for (const line of buffer.toString('utf-8', 0, lastNewline).split('\n')) {
    if (!line.includes('"usage"')) continue;
    try {
      const record: JsonlRecord = JSON.parse(line);
      if (record.type !== 'assistant' || !record.message?.usage || !record.timestamp) continue;
      const msgTime = new Date(record.timestamp).getTime();
      if (isNaN(msgTime)) continue;
      const usage = record.message.usage;
      timeline.times.push(msgTime);
      timeline.tokens.push((usage.input_tokens || 0)
        + (usage.output_tokens || 0)
        + (usage.cache_read_input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0));
    } catch { /* skip malformed lines */ }
  }
  timeline.byteOffset += lastNewline + 1;
  return timeline;
}

/**
 * Get tokens used within the daily session window AND find the rolling session start.
 *
 * Filters by individual message timestamps (not file mtime) for accurate counting:
 * only messages with timestamp >= windowStart are counted. This prevents over-counting
 * tokens from old messages in long-running session files.
 *
 * The sessionStart (earliest message in the window) is used to compute the true
 * rolling reset time: reset = sessionStart + windowHours (matches claude.ai/usage).
 */
async function getTokensAndSessionStart(windowHours: number): Promise<{
  tokens: number;
  sessionStart: Date | null;
}> {
  const homeDir = os.homedir();
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  const windowStartMs = Date.now() - windowHours * 3_600_000;

  let totalTokens = 0;
  let sessionStartMs: number | null = null;
  const seen = new Set<string>();

  try {
    const projectDirs = await fs.readdir(projectsDir);

    for (const dir of projectDirs) {
      const dirPath = path.join(projectsDir, dir);
      const dirStat = await fs.stat(dirPath).catch(() => null);
      if (!dirStat?.isDirectory()) continue;

      let jsonlFiles: string[];
      try {
        const entries = await fs.readdir(dirPath);
        jsonlFiles = entries.filter(f => f.endsWith('.jsonl')).map(f => path.join(dirPath, f));
      } catch {
        continue;
      }

      for (const filePath of jsonlFiles) {
        try {
          const stat = await fs.stat(filePath);
          // Quick pre-filter: skip files not touched in the window
          if (stat.mtimeMs < windowStartMs) continue;
          seen.add(filePath);

          const timeline = await readUsageTimeline(filePath, stat);
          for (let i = 0; i < timeline.times.length; i++) {
            const msgTime = timeline.times[i];
            if (msgTime < windowStartMs) continue;
            // Track the oldest message in the window — that's when this session started
            if (sessionStartMs === null || msgTime < sessionStartMs) sessionStartMs = msgTime;
            totalTokens += timeline.tokens[i];
          }
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* projects directory doesn't exist */ }

  // Files that left the window no longer need their timelines.
  for (const filePath of usageTimelineCache.keys()) {
    if (!seen.has(filePath)) usageTimelineCache.delete(filePath);
  }

  // The agent host's sessions count toward the same account: add what it measured over the same window.
  const hostWindow = await remoteWindow(windowStartMs);
  if (hostWindow) {
    totalTokens += hostWindow.tokens;
    if (hostWindow.sessionStartMs !== null && (sessionStartMs === null || hostWindow.sessionStartMs < sessionStartMs)) sessionStartMs = hostWindow.sessionStartMs;
  }

  return { tokens: totalTokens, sessionStart: sessionStartMs === null ? null : new Date(sessionStartMs) };
}

/**
 * Get tokens used since the start of the current weekly window.
 */
async function getTokensSinceWeeklyReset(resetDay: number, resetHour: number): Promise<number> {
  const now = new Date();
  const currentDay = now.getDay();
  const currentHour = now.getHours();

  let daysSinceReset = currentDay - resetDay;
  if (daysSinceReset < 0) {
    daysSinceReset += 7;
  } else if (daysSinceReset === 0 && currentHour < resetHour) {
    daysSinceReset = 7;
  }

  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - daysSinceReset);
  weekStart.setHours(resetHour, 0, 0, 0);

  const homeDir = os.homedir();
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  let totalTokens = 0;

  try {
    const projectDirs = await fs.readdir(projectsDir);

    for (const dir of projectDirs) {
      const dirPath = path.join(projectsDir, dir);
      const dirStat = await fs.stat(dirPath).catch(() => null);
      if (!dirStat?.isDirectory()) continue;

      const files = await findAllSessionFiles('/' + dir.replace(/-/g, '/').replace(/^\//, ''));

      for (const filePath of files) {
        try {
          const stat = await fs.stat(filePath);
          if (stat.mtime < weekStart) continue;

          const { tokens } = await computeSessionTokenUsage(filePath);
          totalTokens += tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheCreationTokens;
        } catch {
          // Skip unreadable files
        }
      }
    }
  } catch {
    // Projects directory doesn't exist
  }

  for (const file of await remoteFilesSince(weekStart.getTime())) {
    totalTokens += file.tokens.inputTokens + file.tokens.outputTokens + file.tokens.cacheReadTokens + file.tokens.cacheCreationTokens;
  }

  return totalTokens;
}

// ============================================
// Result-level cache for getUsageLimits
// ============================================
// Ensures the expensive filesystem scan only runs once per interval,
// even if multiple clients/tabs poll simultaneously.
let limitsCache: { data: UsageLimitsResponse; cachedAt: number } | null = null;
const LIMITS_CACHE_TTL_MS = 5_000; // 5s cache (incremental parsing makes this cheap)

/**
 * Get complete usage limits data for progress bar display.
 * Combines configured limits with actual token tracking.
 * Results are cached server-side to avoid redundant filesystem scans.
 */
export async function getUsageLimits(): Promise<UsageLimitsResponse> {
  // Return cached result if fresh
  if (limitsCache && (Date.now() - limitsCache.cachedAt) < LIMITS_CACHE_TTL_MS) {
    return limitsCache.data;
  }
  // Concurrent polls from several tabs share one scan.
  limitsInFlight ??= computeUsageLimits().finally(() => { limitsInFlight = null; });
  return limitsInFlight;
}

let limitsInFlight: Promise<UsageLimitsResponse> | null = null;

async function computeUsageLimits(): Promise<UsageLimitsResponse> {
  const config = await getSubscriptionLimits();
  const now = new Date();

  // Calculate daily session usage with accurate rolling session start
  const { tokens: dailyUsed, sessionStart } = await getTokensAndSessionStart(config.daily.windowHours);

  // Compute rolling reset time: session started at sessionStart, expires windowHours later.
  // Falls back to midnight-aligned estimate when there's no recent session activity.
  let dailyReset: Date;
  if (sessionStart) {
    dailyReset = new Date(sessionStart.getTime() + config.daily.windowHours * 3_600_000);
    // If reset is already in the past (session window expired), use fallback
    if (dailyReset <= now) {
      dailyReset = getNextDailyReset(config.daily.windowHours);
    }
  } else {
    dailyReset = getNextDailyReset(config.daily.windowHours);
  }
  const dailyResetMs = dailyReset.getTime() - now.getTime();

  // Calculate weekly usage
  const weeklyUsed = await getTokensSinceWeeklyReset(config.weekly.resetDay, config.weekly.resetHour);
  const weeklyReset = getNextWeeklyReset(config.weekly.resetDay, config.weekly.resetHour, config.weekly.resetTimezone);
  const weeklyResetMs = weeklyReset.getTime() - now.getTime();

  const result: UsageLimitsResponse = {
    daily: {
      usedTokens: dailyUsed,
      limitTokens: config.daily.limitTokens,
      percentage: Math.min(100, Math.round((dailyUsed / config.daily.limitTokens) * 100)),
      resetTime: dailyReset.toISOString(),
      resetIn: formatTimeRemaining(dailyResetMs),
      label: 'Current session',
    },
    weekly: {
      usedTokens: weeklyUsed,
      limitTokens: config.weekly.limitTokens,
      percentage: Math.min(100, Math.round((weeklyUsed / config.weekly.limitTokens) * 100)),
      resetTime: weeklyReset.toISOString(),
      resetIn: formatTimeRemaining(weeklyResetMs),
      label: 'Weekly limits',
    },
    plan: config.plan,
    configured: true,
    computedAt: now.toISOString(),
  };

  limitsCache = { data: result, cachedAt: Date.now() };
  return result;
}
