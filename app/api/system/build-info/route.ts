/**
 * GET /api/system/build-info
 *
 * Returns build + uptime metadata for the SystemsOverview build-stats widget.
 * No auth — read-only metadata, safe to expose locally.
 *
 * Response:
 *   buildId: string                  // contents of .next/BUILD_ID
 *   buildTime: string                // ISO mtime of .next/BUILD_ID
 *   devflowUptimeSeconds: number     // seconds since pm2 'devflow' process started
 *   serverUptimeSeconds: number      // os.uptime()
 *
 * Any field that cannot be resolved becomes null with an entry in `errors[]`.
 * The endpoint always returns 200 — partial data is more useful than a hard fail
 * for a status-panel widget.
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';
import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

interface PM2Process {
  name: string;
  pm2_env?: { pm_uptime?: number; restart_time?: number; created_at?: number };
}

interface BuildInfoResponse {
  buildId: string | null;
  buildTime: string | null;
  devflowUptimeSeconds: number | null;
  devflowRestartCount: number | null;
  devflowLastRestart: string | null;
  serverUptimeSeconds: number;
  serverUptimeFormatted: string;
  errors: string[];
}

async function readBuildId(): Promise<{ buildId: string | null; buildTime: string | null; error?: string }> {
  const buildIdPath = appPath('.next', 'BUILD_ID');
  try {
    const [buf, stat] = await Promise.all([
      fs.readFile(buildIdPath, 'utf-8'),
      fs.stat(buildIdPath),
    ]);
    return {
      buildId: buf.trim(),
      buildTime: stat.mtime.toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { buildId: null, buildTime: null, error: `BUILD_ID read failed: ${msg}` };
  }
}

interface DevflowInfo {
  uptimeSeconds: number | null;
  restartCount: number | null;
  lastRestart: string | null;
  error?: string;
}

async function readDevflowInfo(): Promise<DevflowInfo> {
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], {
      timeout: 5000,
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
    });
    const procs: PM2Process[] = JSON.parse(stdout);
    const devflow = procs.find((p) => p.name === 'devflow');
    if (!devflow) {
      return { uptimeSeconds: null, restartCount: null, lastRestart: null, error: "pm2 process 'devflow' not found" };
    }

    const startMs = devflow.pm2_env?.pm_uptime;
    // PM2 stores restart count as `restart_time` (confusing name, but it's the counter)
    const restarts = devflow.pm2_env?.restart_time;

    const uptimeSeconds = typeof startMs === 'number' && startMs > 0
      ? Math.max(0, Math.floor((Date.now() - startMs) / 1000))
      : null;

    const restartCount = typeof restarts === 'number' ? restarts : null;

    // Derive last restart time: process created_at timestamp (ms since epoch)
    const createdAt = devflow.pm2_env?.created_at;
    const lastRestart = typeof createdAt === 'number' && createdAt > 0
      ? new Date(createdAt).toISOString()
      : null;

    return { uptimeSeconds, restartCount, lastRestart };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { uptimeSeconds: null, restartCount: null, lastRestart: null, error: `pm2 jlist failed: ${msg}` };
  }
}

function formatServerUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export const GET = tracked('/api/system/build-info', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  const errors: string[] = [];

  const [buildInfo, devflowInfo] = await Promise.all([
    readBuildId(),
    readDevflowInfo(),
  ]);

  if (buildInfo.error) errors.push(buildInfo.error);
  if (devflowInfo.error) errors.push(devflowInfo.error);

  const serverUptimeSeconds = Math.floor(os.uptime());

  const body: BuildInfoResponse = {
    buildId: buildInfo.buildId,
    buildTime: buildInfo.buildTime,
    devflowUptimeSeconds: devflowInfo.uptimeSeconds,
    devflowRestartCount: devflowInfo.restartCount,
    devflowLastRestart: devflowInfo.lastRestart,
    serverUptimeSeconds,
    serverUptimeFormatted: formatServerUptime(serverUptimeSeconds),
    errors,
  };

  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
});
