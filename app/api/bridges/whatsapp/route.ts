/**
 * WhatsApp Bridge (Baileys) API
 *
 * GET  /api/bridges/whatsapp          — config + basic state
 * POST /api/bridges/whatsapp          — actions: configure | toggle | pair | disconnect
 */

import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import type { WhatsAppBridgeConfig } from '@/lib/types';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { getHomeDir } from '@/lib/home-dir';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';

const execAsync = promisify(exec);

const BRIDGE_PM2_NAME = 'whatsapp-bridge-baileys';
const BRIDGE_PORT = 8301;
const BRIDGE_URL = `http://localhost:${BRIDGE_PORT}`;
const SESSIONS_DIR = `${getHomeDir()}/SG-1/tools/whatsapp-bridge-baileys/sessions`;
const ECOSYSTEM_PATH = `${getHomeDir()}/SG-1/tools/whatsapp-bridge-baileys/ecosystem.config.js`;

const DEFAULT_CONFIG: WhatsAppBridgeConfig = {
  type: 'baileys',
  enabled: false,
  port: BRIDGE_PORT,
  allowedNumbers: [],
  commanderName: 'Jack',
  channelName: `WhatsApp — ${HUMAN_ROUTING_NAME}`,
  updatedAt: new Date().toISOString(),
};

// Ensure parent directory exists for config file
async function ensureBridgesDir(): Promise<void> {
  await fs.mkdir(path.dirname(DataPaths.bridges.whatsapp), { recursive: true });
}

async function readConfig(): Promise<WhatsAppBridgeConfig> {
  return readJsonFile<WhatsAppBridgeConfig>(DataPaths.bridges.whatsapp, DEFAULT_CONFIG);
}

// GET — return stored config
export const GET = tracked('/api/bridges/whatsapp', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const config = await readConfig();
    return NextResponse.json({ config });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});

// POST — action dispatcher
export const POST = tracked('/api/bridges/whatsapp', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json() as {
      action: 'configure' | 'toggle' | 'pair' | 'disconnect';
      allowedNumbers?: string[];
      commanderName?: string;
      channelName?: string;
      port?: number;
      phoneNumber?: string;
    };

    switch (body.action) {
      case 'configure':
        return handleConfigure(body);
      case 'toggle':
        return handleToggle();
      case 'pair':
        return handlePair(body.phoneNumber);
      case 'disconnect':
        return handleDisconnect();
      default:
        return NextResponse.json({ error: `Unknown action: ${(body as { action: string }).action}` }, { status: 400 });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});

// Save config fields (allowed numbers, names, port) and ensure bridge is running
async function handleConfigure(body: {
  allowedNumbers?: string[];
  commanderName?: string;
  channelName?: string;
  port?: number;
}): Promise<NextResponse> {
  await ensureBridgesDir();

  const config = await withFileLock(DataPaths.bridges.whatsapp, async () => {
    const current = await readConfig();

    if (body.allowedNumbers !== undefined) {
      // Basic E.164 validation
      const invalid = body.allowedNumbers.filter(n => !/^\+\d{7,15}$/.test(n));
      if (invalid.length > 0) {
        throw new Error(`Invalid phone number format: ${invalid.join(', ')}. Use E.164 (e.g. +447700900000)`);
      }
      current.allowedNumbers = body.allowedNumbers;
    }
    if (body.commanderName !== undefined) current.commanderName = body.commanderName;
    if (body.channelName !== undefined) current.channelName = body.channelName;
    if (body.port !== undefined) current.port = body.port;
    current.enabled = true;
    current.updatedAt = new Date().toISOString();

    await writeJsonFile(DataPaths.bridges.whatsapp, current);
    return current;
  });

  // Ensure bridge PM2 process is running (may have been stopped by a prior disconnect)
  try {
    const startCmd = `pm2 start ${ECOSYSTEM_PATH} --only ${BRIDGE_PM2_NAME}`;
    await execAsync(startCmd, { timeout: 15000 });
  } catch {
    // Already running — not fatal
  }

  return NextResponse.json({ success: true, config });
}

// Enable or disable the bridge (PM2 start/stop)
async function handleToggle(): Promise<NextResponse> {
  const config = await readConfig();
  const newEnabled = !config.enabled;

  try {
    if (newEnabled) {
      // Start bridge via its ecosystem config
      const startCmd = `pm2 start ${ECOSYSTEM_PATH} --only ${BRIDGE_PM2_NAME}`;
      await execAsync(startCmd, { timeout: 15000 });
    } else {
      await execAsync(`pm2 stop ${BRIDGE_PM2_NAME}`, { timeout: 10000 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `PM2 ${newEnabled ? 'start' : 'stop'} failed: ${msg}` }, { status: 500 });
  }

  // Persist enabled state
  const updated = await withFileLock(DataPaths.bridges.whatsapp, async () => {
    const current = await readConfig();
    current.enabled = newEnabled;
    current.updatedAt = new Date().toISOString();
    await writeJsonFile(DataPaths.bridges.whatsapp, current);
    return current;
  });

  return NextResponse.json({ success: true, enabled: newEnabled, config: updated });
}

// Proxy pairing code request to bridge
async function handlePair(phoneNumber: string | undefined): Promise<NextResponse> {
  if (!phoneNumber) {
    return NextResponse.json({ error: 'phoneNumber is required' }, { status: 400 });
  }

  try {
    const res = await fetch(`${BRIDGE_URL}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: `Bridge error: ${text}` }, { status: res.status });
    }

    const data = await res.json() as { code: string };
    return NextResponse.json({ success: true, code: data.code });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Failed to reach bridge: ${msg}` }, { status: 503 });
  }
}

// Full reset: clear sessions directory + stop PM2 process
async function handleDisconnect(): Promise<NextResponse> {
  const errors: string[] = [];

  // 1. Stop PM2 process
  try {
    await execAsync(`pm2 stop ${BRIDGE_PM2_NAME}`, { timeout: 10000 });
  } catch {
    // Might already be stopped — not fatal
  }

  // 2. Delete sessions directory
  try {
    await fs.rm(SESSIONS_DIR, { recursive: true, force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Sessions cleanup: ${msg}`);
  }

  // 3. Mark as disabled in config
  const updated = await withFileLock(DataPaths.bridges.whatsapp, async () => {
    const current = await readConfig();
    current.enabled = false;
    current.updatedAt = new Date().toISOString();
    await writeJsonFile(DataPaths.bridges.whatsapp, current);
    return current;
  });

  return NextResponse.json({
    success: errors.length === 0,
    config: updated,
    ...(errors.length > 0 ? { warnings: errors } : {}),
  });
}
