/**
 * Log Configuration — Centralized settings for the DevFlow logging system
 *
 * Stores configurable settings for:
 * - Event log retention (days)
 * - Memory timeline retention (hours)
 * - OOM event max count
 * - Error tracker buffer size
 * - Verbose/debug mode (global + per-module)
 *
 * Persisted to .AppData/logging-config.json
 * Loaded once on first access, cached in memory, reloaded on write.
 */

import path from 'path';
import { readJsonFile, writeJsonFile, withFileLock } from './data-io';
import { appRoot } from '@/lib/app-paths';

// ============================================
// Types
// ============================================

export interface LoggingConfig {
  /** Max days to keep rotated .jsonl event log files (default: 90) */
  retentionDays: number;

  /** Max hours to keep process health history entries (default: 24) */
  memoryTimelineHours: number;

  /** Max OOM events to keep in earlyoom-events.json (default: 100) */
  oomEventMax: number;

  /** Max errors in the error-tracker ring buffer (default: 500) */
  errorBufferSize: number;

  /** Global log level — entries below this level are suppressed (default: 'info') */
  logLevel: LogLevel;

  /** Per-module verbose overrides — module name → true enables debug for that module */
  verboseModules: Record<string, boolean>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

/** Numeric rank for level comparison — lower = more verbose */
export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4,
};

// ============================================
// Defaults
// ============================================

export const DEFAULT_LOGGING_CONFIG: LoggingConfig = {
  retentionDays: 90,
  memoryTimelineHours: 24,
  oomEventMax: 100,
  errorBufferSize: 500,
  logLevel: 'info',
  verboseModules: {},
};

// ============================================
// Config path
// ============================================

const CONFIG_PATH = path.join(
  appRoot(),
  process.env.DEVFLOW_APP_DATA_DIR || process.env.DEVFLOW_DATA_DIR || '.AppData',
  'logging-config.json',
);

// ============================================
// In-memory cache
// ============================================

let cachedConfig: LoggingConfig | null = null;

// ============================================
// Public API
// ============================================

/**
 * Get the current logging configuration.
 * Loads from disk on first call, then returns cached copy.
 */
export async function getLoggingConfig(): Promise<LoggingConfig> {
  if (cachedConfig) return cachedConfig;
  const stored = await readJsonFile<Partial<LoggingConfig>>(CONFIG_PATH, {});
  cachedConfig = { ...DEFAULT_LOGGING_CONFIG, ...stored };
  return cachedConfig;
}

/**
 * Update logging configuration. Merges partial updates with existing config.
 * Persists to disk and updates in-memory cache.
 */
export async function updateLoggingConfig(updates: Partial<LoggingConfig>): Promise<LoggingConfig> {
  return await withFileLock(CONFIG_PATH, async () => {
    const current = await readJsonFile<Partial<LoggingConfig>>(CONFIG_PATH, {});
    const merged: LoggingConfig = {
      ...DEFAULT_LOGGING_CONFIG,
      ...current,
      ...updates,
    };

    // Validate bounds
    merged.retentionDays = Math.max(1, Math.min(365, merged.retentionDays));
    merged.memoryTimelineHours = Math.max(1, Math.min(168, merged.memoryTimelineHours));
    merged.oomEventMax = Math.max(10, Math.min(10000, merged.oomEventMax));
    merged.errorBufferSize = Math.max(50, Math.min(5000, merged.errorBufferSize));

    if (!LOG_LEVEL_RANK.hasOwnProperty(merged.logLevel)) {
      merged.logLevel = DEFAULT_LOGGING_CONFIG.logLevel;
    }

    await writeJsonFile(CONFIG_PATH, merged);
    cachedConfig = merged;
    return merged;
  });
}

/**
 * Check if a given severity should be logged at the current global level.
 * Maps severity names to log levels for comparison.
 */
export function shouldLog(severity: string, moduleId?: string): boolean {
  if (!cachedConfig) return true; // Not loaded yet — allow everything

  // If module has verbose override, allow debug-level
  if (moduleId && cachedConfig.verboseModules[moduleId]) {
    return true;
  }

  const severityToLevel: Record<string, LogLevel> = {
    debug: 'debug',
    info: 'info',
    low: 'info',
    medium: 'warn',
    high: 'error',
    critical: 'critical',
    warn: 'warn',
    error: 'error',
  };

  const level = severityToLevel[severity] ?? 'info';
  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[cachedConfig.logLevel];
}

/**
 * Check if verbose/debug mode is active (globally or for a specific module).
 * Fast synchronous check — no I/O.
 */
export function isVerboseEnabled(moduleId?: string): boolean {
  if (!cachedConfig) return false;
  if (moduleId && cachedConfig.verboseModules[moduleId]) return true;
  return cachedConfig.logLevel === 'debug';
}

/**
 * Force reload config from disk (useful after external edits).
 */
export async function reloadLoggingConfig(): Promise<LoggingConfig> {
  cachedConfig = null;
  return getLoggingConfig();
}
