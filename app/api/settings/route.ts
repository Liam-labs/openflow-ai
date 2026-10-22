/**
 * DevFlow Settings API
 *
 * GET  /api/settings          — Read current settings
 * PATCH /api/settings         — Update settings (e.g., toggle computerUse.enabled)
 *
 * The settings toggle for computer use is stored server-side so it cannot be
 * bypassed by agents calling the API directly. Browser localStorage is not used.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readSettings, setComputerUseEnabled, setComputerUseBackend } from '@/lib/computer-use-settings';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/settings', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  try {
    const settings = await readSettings();
    return NextResponse.json({ success: true, settings });
  } catch (error) {
    console.error('[settings] GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to read settings' },
      { status: 500 }
    );
  }
});

async function handleSettingsUpdate(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON in request body' },
      { status: 400 }
    );
  }

  if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
    return NextResponse.json(
      { success: false, error: 'Request body must be a non-empty JSON object' },
      { status: 400 }
    );
  }

  // Handle computerUse updates
  if ('computerUse' in body && typeof body.computerUse === 'object') {
    const cu = body.computerUse as Record<string, unknown>;
    const enabledBy = request.headers.get('x-agent-id') ?? 'user';

    // enabled toggle
    if ('enabled' in cu) {
      if (typeof cu.enabled !== 'boolean') {
        return NextResponse.json(
          { success: false, error: 'computerUse.enabled must be a boolean' },
          { status: 400 }
        );
      }
      await setComputerUseEnabled(cu.enabled, enabledBy);
    }

    // backend switcher
    if ('backend' in cu) {
      if (cu.backend !== 'api' && cu.backend !== 'max') {
        return NextResponse.json(
          { success: false, error: 'computerUse.backend must be "api" or "max"' },
          { status: 400 }
        );
      }
      await setComputerUseBackend(cu.backend);
    }

    if (!('enabled' in cu) && !('backend' in cu)) {
      return NextResponse.json(
        { success: false, error: 'computerUse must include "enabled" or "backend"' },
        { status: 400 }
      );
    }

    const settings = await readSettings();
    return NextResponse.json({ success: true, settings });
  }

  return NextResponse.json(
    { success: false, error: 'No recognised settings key in request body. Supported: computerUse' },
    { status: 400 }
  );
}

export const PATCH = tracked('/api/settings', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    return await handleSettingsUpdate(request);
  } catch (error) {
    console.error('[settings] PATCH error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update settings' },
      { status: 500 }
    );
  }
});

export const POST = tracked('/api/settings', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    return await handleSettingsUpdate(request);
  } catch (error) {
    console.error('[settings] POST error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update settings' },
      { status: 500 }
    );
  }
});
