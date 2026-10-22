/**
 * Token Usage Actions (Agent API)
 *
 * Provides programmatic access to per-agent and global token usage data.
 * Reads Claude Code JSONL session files to compute token consumption.
 */

import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';
import { getChannelAgentUsage, getGlobalUsageSummary, getUsageLimits, setSubscriptionLimits } from '@/lib/token-usage';
import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { appPath } from '@/lib/app-paths';

const execAsync = promisify(exec);
const SCRAPER_DIR = appPath('scripts', 'usage-scraper');

/**
 * usage.agents - Get per-agent token usage for a channel
 *
 * Required params:
 *   channelId: string - The channel to query
 *
 * Returns per-agent token breakdowns and channel total.
 */
export async function agents(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  if (!channelId) throw new Error('channelId is required');

  const usage = await getChannelAgentUsage(channelId);
  return usage;
}

/**
 * usage.summary - Get global token usage summary for today
 *
 * Returns aggregate usage across all sessions modified today.
 */
export async function summary(_body: AgentApiRequest, _auth: AgentAuthContext) {
  const usage = await getGlobalUsageSummary();
  return usage;
}

/**
 * usage.scrape - Trigger a scrape of claude.ai/settings/usage
 *
 * Requires session cookie to be set first via usage.set_cookie.
 * Returns scraped subscription usage data.
 */
export async function scrape(_body: AgentApiRequest, _auth: AgentAuthContext) {
  const scriptPath = path.join(SCRAPER_DIR, 'scrape-usage.sh');
  try {
    const { stdout } = await execAsync(
      `bash "${scriptPath}" --json`,
      { timeout: 60000, cwd: SCRAPER_DIR }
    );
    return JSON.parse(stdout);
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    throw new Error(`Scrape failed: ${execErr.stderr || execErr.message}`);
  }
}

/**
 * usage.subscription - Get cached subscription usage data
 *
 * Returns the most recent scrape result from claude.ai/settings/usage.
 */
export async function subscription(_body: AgentApiRequest, _auth: AgentAuthContext) {
  const cacheFile = path.join(SCRAPER_DIR, '.usage-cache.json');
  try {
    const content = await fs.readFile(cacheFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { success: false, message: 'No cached data. Run usage.scrape first.' };
  }
}

/**
 * usage.limits - Get usage limits with progress bar data
 *
 * Returns daily session and weekly limits with percentages and reset times.
 * Uses local token tracking against configured limits.
 */
export async function limits(_body: AgentApiRequest, _auth: AgentAuthContext) {
  return getUsageLimits();
}

/**
 * usage.set_limits - Update subscription limit configuration
 *
 * Optional params:
 *   plan: string - Plan name (e.g., "max", "pro")
 *   daily: { limitTokens?: number, windowHours?: number }
 *   weekly: { limitTokens?: number, resetDay?: number, resetHour?: number, resetTimezone?: string }
 */
export async function setLimits(body: AgentApiRequest, _auth: AgentAuthContext) {
  const { plan, daily, weekly } = body as { plan?: string; daily?: Record<string, unknown>; weekly?: Record<string, unknown> };
  const updated = await setSubscriptionLimits({ plan, daily, weekly } as Parameters<typeof setSubscriptionLimits>[0]);
  return { success: true, data: updated };
}

/**
 * usage.set_cookie - Store session cookie for claude.ai scraper
 *
 * Required params:
 *   sessionKey: string - The sessionKey cookie value from claude.ai
 */
export async function setCookie(body: AgentApiRequest, _auth: AgentAuthContext) {
  const sessionKey = body.sessionKey as string;
  if (!sessionKey) throw new Error('sessionKey is required');

  await fs.mkdir(SCRAPER_DIR, { recursive: true });
  await fs.writeFile(
    path.join(SCRAPER_DIR, '.session-cookie.json'),
    JSON.stringify({ sessionKey, savedAt: new Date().toISOString() })
  );

  return { success: true, message: 'Session cookie saved for claude.ai scraper' };
}
