/**
 * Slack Bridge — Configure API
 *
 * GET  /api/bridges/slack/configure  — return current config
 * POST /api/bridges/slack/configure  — save config fields
 *
 * POST body fields (all optional):
 *   workspaceId, appId, botUserId, syncEnabled, pollIntervalMs,
 *   devflowPublicUrl, notificationChannelId, notificationsEnabled,
 *   notificationEvents, autoSync (object)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getConfig, saveConfig } from '@/slack-integration/lib/slack-bridge-data';
import type { SlackBridgeConfig } from '@/slack-integration/lib/slack-types';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const GET = tracked('/api/bridges/slack/configure', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const config = await getConfig();
    return NextResponse.json({ config });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});

export const POST = tracked('/api/bridges/slack/configure', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json() as Partial<SlackBridgeConfig>;

    const config = await saveConfig(body);
    return NextResponse.json({ success: true, config });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});
