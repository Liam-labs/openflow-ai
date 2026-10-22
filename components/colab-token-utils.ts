/**
 * colab-token-utils.ts — Shared token utility functions for ColabPanel and ColabSidebar.
 *
 * Extracted from ColabPanel.tsx so both the main panel and the sidebar component
 * can import without circular dependencies.
 */

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

// Default usage limits (configurable via localStorage)
export const DEFAULT_DAILY_LIMIT = 5_000_000;  // 5M tokens
export const DEFAULT_WEEKLY_LIMIT = 25_000_000; // 25M tokens
export const USAGE_HISTORY_KEY = 'devflow-usage-daily-history';
export const DAILY_LIMIT_KEY = 'devflow-usage-daily-limit';
export const WEEKLY_LIMIT_KEY = 'devflow-usage-weekly-limit';

export function getUsageLimits(): { daily: number; weekly: number } {
  if (typeof window === 'undefined') return { daily: DEFAULT_DAILY_LIMIT, weekly: DEFAULT_WEEKLY_LIMIT };
  const daily = parseInt(localStorage.getItem(DAILY_LIMIT_KEY) || '', 10);
  const weekly = parseInt(localStorage.getItem(WEEKLY_LIMIT_KEY) || '', 10);
  return {
    daily: isNaN(daily) ? DEFAULT_DAILY_LIMIT : daily,
    weekly: isNaN(weekly) ? DEFAULT_WEEKLY_LIMIT : weekly,
  };
}

// Track daily usage in localStorage and compute rolling 7-day total
export function updateWeeklyHistory(todayTokens: number): number {
  if (typeof window === 'undefined') return todayTokens;
  const today = new Date().toISOString().split('T')[0];
  let stored: Array<{ date: string; tokens: number }> = [];
  try {
    stored = JSON.parse(localStorage.getItem(USAGE_HISTORY_KEY) || '[]');
  } catch {
    stored = [];
  }

  const todayIdx = stored.findIndex(e => e.date === today);
  if (todayIdx >= 0) {
    stored[todayIdx].tokens = todayTokens;
  } else {
    stored.push({ date: today, tokens: todayTokens });
  }

  // Keep only last 7 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const filtered = stored.filter(e => e.date >= cutoffStr);
  localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(filtered));

  return filtered.reduce((sum, e) => sum + e.tokens, 0);
}

// Compute time remaining until next 5-hour session window reset.
// Claude MAX uses ~5-hour rolling windows. We approximate with fixed windows from midnight.
export function getTimeUntilDailyReset(): string {
  const WINDOW_HOURS = 5;
  const now = new Date();
  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);
  const windowMs = WINDOW_HOURS * 3600_000;
  const elapsed = now.getTime() - todayMidnight.getTime();
  const currentWindowIndex = Math.floor(elapsed / windowMs);
  const nextReset = new Date(todayMidnight.getTime() + (currentWindowIndex + 1) * windowMs);
  const diff = nextReset.getTime() - now.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// Compute time remaining until next Sunday 10:00 AM (weekly reset), always in hours.
export function getTimeUntilWeeklyReset(): string {
  const RESET_DAY = 0;   // Sunday
  const RESET_HOUR = 10; // 10:00 AM
  const now = new Date();
  let daysUntilReset = RESET_DAY - now.getDay();
  if (daysUntilReset < 0) {
    daysUntilReset += 7;
  } else if (daysUntilReset === 0 && now.getHours() >= RESET_HOUR) {
    daysUntilReset = 7;
  }
  const nextReset = new Date(now);
  nextReset.setDate(now.getDate() + daysUntilReset);
  nextReset.setHours(RESET_HOUR, 0, 0, 0);
  const diff = nextReset.getTime() - now.getTime();
  const totalHours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
}
