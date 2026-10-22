/**
 * Token Usage API Endpoint
 *
 * GET /api/collab/usage?channelId=xxx
 *   Returns per-agent token usage for a channel.
 *   Designed for frequent polling (1s intervals) - uses internal caching.
 *
 * GET /api/collab/usage?global=true
 *   Returns aggregate usage across all sessions today.
 *
 * GET /api/collab/usage?subscription=true
 *   Returns cached subscription usage data from claude.ai scraper.
 *
 * GET /api/collab/usage?limits=true
 *   Returns structured usage limit data for progress bar display.
 *   Includes daily session and weekly limits with percentages and reset times.
 *
 * POST /api/collab/usage
 *   { action: "scrape" } - Trigger a headless scrape of claude.ai/settings/usage
 *   { action: "set_cookie", sessionKey: "..." } - Store session cookie for scraper auth
 *   { action: "set_limits", ... } - Update subscription limit configuration
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { getChannelAgentUsage, getGlobalUsageSummary, getUsageLimits, setSubscriptionLimits } from '@/lib/token-usage';
import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';

const execAsync = promisify(exec);

const SCRAPER_DIR = appPath('scripts', 'usage-scraper');
const CACHE_FILE = path.join(SCRAPER_DIR, '.usage-cache.json');
const COOKIE_FILE = path.join(SCRAPER_DIR, '.session-cookie.json');

export const GET = tracked('/api/collab/usage', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  const { searchParams } = request.nextUrl;
  const channelId = searchParams.get('channelId');
  const isGlobal = searchParams.get('global') === 'true';
  const isSubscription = searchParams.get('subscription') === 'true';
  const isLimits = searchParams.get('limits') === 'true';

  try {
    if (isLimits) {
      const limits = await getUsageLimits();
      return NextResponse.json({ success: true, data: limits });
    }

    if (isSubscription) {
      // Return cached scraper data
      try {
        const content = await fs.readFile(CACHE_FILE, 'utf-8');
        const cached = JSON.parse(content);
        return NextResponse.json({ success: true, data: cached });
      } catch {
        return NextResponse.json({
          success: true,
          data: null,
          message: 'No subscription data available. Run scraper first or POST {action:"scrape"}',
        });
      }
    }

    if (isGlobal) {
      const summary = await getGlobalUsageSummary();
      return NextResponse.json({
        success: true,
        data: summary,
      });
    }

    if (!channelId) {
      return NextResponse.json(
        { success: false, error: 'channelId, global=true, or subscription=true is required' },
        { status: 400 }
      );
    }

    const usage = await getChannelAgentUsage(channelId);
    return NextResponse.json({
      success: true,
      data: usage,
    });
  } catch (error) {
    console.error('[usage-api] Error computing token usage:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to compute token usage' },
      { status: 500 }
    );
  }
});

export const POST = tracked('/api/collab/usage', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'scrape') {
      // Trigger headless scrape
      const scriptPath = path.join(SCRAPER_DIR, 'scrape-usage.mjs');
      try {
        const { stdout, stderr } = await execAsync(
          `node "${scriptPath}" --json`,
          { timeout: 60000, cwd: SCRAPER_DIR }
        );
        if (stderr) {
        }
        try {
          const result = JSON.parse(stdout);
          return NextResponse.json({ success: true, data: result });
        } catch {
          return NextResponse.json({ success: true, rawOutput: stdout });
        }
      } catch (err: unknown) {
        const execErr = err as { stderr?: string; message?: string };
        return NextResponse.json(
          { success: false, error: 'Scrape failed', details: execErr.stderr || execErr.message },
          { status: 500 }
        );
      }
    }

    if (action === 'set_limits') {
      const { plan, daily, weekly } = body;
      const updated = await setSubscriptionLimits({ plan, daily, weekly });
      return NextResponse.json({ success: true, data: updated, message: 'Subscription limits updated' });
    }

    if (action === 'set_cookie') {
      // Store session cookie for the scraper to use
      const { sessionKey } = body;
      if (!sessionKey) {
        return NextResponse.json(
          { success: false, error: 'sessionKey is required' },
          { status: 400 }
        );
      }

      await fs.mkdir(SCRAPER_DIR, { recursive: true });
      await fs.writeFile(COOKIE_FILE, JSON.stringify({
        sessionKey,
        savedAt: new Date().toISOString(),
      }));

      return NextResponse.json({ success: true, message: 'Session cookie saved' });
    }

    return NextResponse.json(
      { success: false, error: 'Unknown action. Use "scrape" or "set_cookie"' },
      { status: 400 }
    );
  } catch (error) {
    console.error('[usage-api] POST error:', error);
    return NextResponse.json(
      { success: false, error: 'Request failed' },
      { status: 500 }
    );
  }
});
