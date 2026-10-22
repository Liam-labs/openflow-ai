/**
 * Pure helpers for stability-digest route.
 *
 * Extracted here because Next.js 16 forbids non-handler exports from route files.
 */

import { promises as fs } from 'fs';
import path from 'path';

// ============================================
// Types
// ============================================

export interface ProjectEntry {
  id: string;
  name: string;
  server?: {
    autoStart?: boolean | null;
    pm2Name?: string;
  };
  devServer?: {
    enabled?: boolean | null;
    pm2Name?: string;
  };
}

export interface ServiceHealthEntry {
  name: string;
  status: 'healthy' | 'degraded' | 'offline';
  expectedOnline: boolean;
  failingChecks: string[];
  lastCheckedAt: string;
}

// ============================================
// Service expected-online classification
// ============================================

/**
 * Determine whether a service is expected to be running, based on the projects registry.
 *
 * A service is expected online only if its matched project has `server.autoStart === true`.
 * Dev servers, services with autoStart false/null/undefined, and unmatched services
 * default to expectedOnline = false.
 */
export function isServiceExpectedOnline(
  serviceName: string,
  projects: ProjectEntry[],
): boolean {
  for (const p of projects) {
    // Match by project id (slug), server.pm2Name, or devServer.pm2Name
    if (
      p.id === serviceName ||
      p.server?.pm2Name === serviceName ||
      p.devServer?.pm2Name === serviceName
    ) {
      // Dev servers are never expected online
      if (p.devServer?.pm2Name === serviceName) return false;
      return p.server?.autoStart === true;
    }
  }
  // Unmatched services — not expected online (conservative)
  return false;
}

/**
 * Load projects registry from disk.
 */
export async function loadProjectsRegistry(dataDir: string): Promise<ProjectEntry[]> {
  try {
    const raw = await fs.readFile(path.join(dataDir, 'projects.json'), 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data.projects) ? data.projects : [];
  } catch {
    return [];
  }
}

// ============================================
// Nightly build crash exclusion
// ============================================

/**
 * Parse the nightly build log and return the timestamp of the most recent successful build.
 * Returns null if the log doesn't exist or has no successful build entries.
 */
export async function getLastBuildTimestamp(buildLogPath: string): Promise<number | null> {
  try {
    const content = await fs.readFile(buildLogPath, 'utf-8');
    // Lines like: "2026-04-12 03:02:38 [safe-build] Build complete (ID: ...)"
    const regex = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[safe-build\] Build complete/gm;
    let lastMatch: string | null = null;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      lastMatch = m[1];
    }
    if (!lastMatch) return null;
    // Parse as local time (the log uses local timestamps)
    const ts = new Date(lastMatch.replace(' ', 'T')).getTime();
    return isNaN(ts) ? null : ts;
  } catch {
    return null;
  }
}

const BUILD_RESTART_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Filter out agent crashes that occurred within 10 minutes of a successful nightly build.
 * These are scheduled restarts (PM2 restarting after build), not real crashes.
 *
 * @param totalCrashes - raw crash count from agent uptime data
 * @param agentCrashTimestamps - individual crash timestamps (ms) from the window
 * @param lastBuildTs - timestamp of the last successful build (ms), or null
 * @returns scoringCrashes - crash count excluding build-restart crashes
 */
export function filterBuildRestartCrashes(
  totalCrashes: number,
  agentCrashTimestamps: number[],
  lastBuildTs: number | null,
): { scoringCrashes: number; excludedCount: number } {
  if (agentCrashTimestamps.length === 0) {
    return { scoringCrashes: totalCrashes, excludedCount: 0 };
  }

  // Filter 1: build-restart cluster (within 10m of last successful build).
  const buildExcluded = new Set<number>();
  if (lastBuildTs !== null) {
    for (let i = 0; i < agentCrashTimestamps.length; i++) {
      const ts = agentCrashTimestamps[i];
      if (ts >= lastBuildTs && ts <= lastBuildTs + BUILD_RESTART_WINDOW_MS) {
        buildExcluded.add(i);
      }
    }
  }

  // Filter 2: mass-crash bursts. Any cluster of >=3 crashes inside a 60s
  // window is almost certainly a single external event (tmux server died, WSL
  // hiccup, host hibernate/wake) rather than N independent agent failures.
  // Compress each burst to 1 "incident" — i.e. count one of the cluster
  // toward scoring, exclude the rest. 2026-05-18: the 12-agent 11:00:21 UTC
  // burst from a single WSL event was costing the score -40 (full crash cap)
  // every time it appeared in the 24h window.
  const BURST_WINDOW_MS = 60 * 1000;
  const BURST_MIN_AGENTS = 3;
  const sorted = agentCrashTimestamps
    .map((ts, i) => ({ ts, i }))
    .filter(({ i }) => !buildExcluded.has(i))
    .sort((a, b) => a.ts - b.ts);

  const burstExcluded = new Set<number>();
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j].ts - sorted[i].ts <= BURST_WINDOW_MS) j++;
    const clusterSize = j - i;
    if (clusterSize >= BURST_MIN_AGENTS) {
      // Keep one (sorted[i]) toward the score, drop the rest.
      for (let k = i + 1; k < j; k++) burstExcluded.add(sorted[k].i);
      i = j;
    } else {
      i++;
    }
  }

  const excludedCount = buildExcluded.size + burstExcluded.size;
  return {
    scoringCrashes: Math.max(0, totalCrashes - excludedCount),
    excludedCount,
  };
}
