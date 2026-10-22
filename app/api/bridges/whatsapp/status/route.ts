/**
 * GET /api/bridges/whatsapp/status
 *
 * Returns live status: PM2 process state + bridge /health response.
 */

import { NextResponse } from 'next/server';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import type { WhatsAppBridgeConfig, WhatsAppBridgeHealth, WhatsAppBridgeStatus } from '@/lib/types';
import { pm2List } from '@/lib/host-bridge/client';
import { tracked } from '@/lib/api-tracking';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';
import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';

const BRIDGE_PM2_NAME = 'whatsapp-bridge-baileys';
const BRIDGE_PORT = 8301;
const BRIDGE_URL = `http://localhost:${BRIDGE_PORT}`;

const DEFAULT_CONFIG: WhatsAppBridgeConfig = {
  type: 'baileys',
  enabled: false,
  port: BRIDGE_PORT,
  allowedNumbers: [],
  commanderName: 'Jack',
  channelName: `WhatsApp — ${HUMAN_ROUTING_NAME}`,
  updatedAt: new Date().toISOString(),
};

export const GET = tracked('/api/bridges/whatsapp/status', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  // Read config and check PM2 + bridge in parallel
  const [config, pm2Status, bridgeHealth] = await Promise.all([
    readJsonFile<WhatsAppBridgeConfig>(DataPaths.bridges.whatsapp, DEFAULT_CONFIG),
    getPm2Status(),
    getBridgeHealth(),
  ]);

  const status: WhatsAppBridgeStatus = {
    config,
    pm2Status,
    bridge: bridgeHealth.health,
    reachable: bridgeHealth.reachable,
  };

  return NextResponse.json(status);
});

async function getPm2Status(): Promise<string> {
  try {
    const processes = await pm2List();
    const proc = processes.find(p => p.name === BRIDGE_PM2_NAME);
    if (!proc) return 'not found';
    return proc.status ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function getBridgeHealth(): Promise<{ reachable: boolean; health: WhatsAppBridgeHealth | null }> {
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { reachable: false, health: null };
    const health = await res.json() as WhatsAppBridgeHealth;
    return { reachable: true, health };
  } catch {
    return { reachable: false, health: null };
  }
}
