/**
 * Teams Bridge — Configure API
 *
 * GET  /api/bridges/teams/configure  — return current config
 * POST /api/bridges/teams/configure  — save config fields
 *
 * POST body fields (all optional):
 *   tenantId, clientId, botId, tunnelUrl, syncEnabled,
 *   pollIntervalMs, autoSync (object)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getConfig, saveConfig } from '@/teams-integration/lib/teams-bridge-data';
import type { TeamsBridgeConfig } from '@/teams-integration/lib/teams-types';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const GET = tracked('/api/bridges/teams/configure', async (request: NextRequest) => {
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

export const POST = tracked('/api/bridges/teams/configure', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json() as Partial<TeamsBridgeConfig>;

    const config = await saveConfig(body);
    return NextResponse.json({ success: true, config });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});
