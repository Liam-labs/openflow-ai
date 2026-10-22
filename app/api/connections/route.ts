import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { readJsonFile } from '@/lib/data-io';
import type { ConnectionsData, ConnectionHealthResult, ConnectionEnvCheckResult } from '@/lib/types';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';
import { selfOrigin } from '@/lib/self-origin';

const DATA_PATH = appPath('data', 'connections.json');

// ─── GET /api/connections ─────────────────────────────────────────────────────
// Returns connections.json — no auth required (data is non-sensitive)

export const GET = tracked('/api/connections', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  const data = await readJsonFile<ConnectionsData>(DATA_PATH, {
    connections: [],
    mcp_servers: [],
    meta: { generated: '', description: '' },
  });
  return NextResponse.json(data);
});

// ─── POST /api/connections ────────────────────────────────────────────────────
// Actions: "test" — live health check for a connection
//          "check_env" — return which env vars are present (boolean only)

export const POST = tracked('/api/connections', async (req: NextRequest) => {
  const authDenied = await requireAuthOrLocal(req, 'read');
  if (authDenied) return authDenied;

  const body = await req.json().catch(() => ({}));
  const { action, id } = body as { action: string; id: string };

  if (!action || !id) {
    return NextResponse.json({ success: false, error: 'Missing action or id' }, { status: 400 });
  }

  const data = await readJsonFile<ConnectionsData>(DATA_PATH, {
    connections: [],
    mcp_servers: [],
    meta: { generated: '', description: '' },
  });

  const conn =
    data.connections.find(c => c.id === id) ||
    data.mcp_servers.find(c => c.id === id);

  if (!conn) {
    return NextResponse.json({ success: false, error: `Connection '${id}' not found` }, { status: 404 });
  }

  // ── check_env ───────────────────────────────────────────────────────────────
  if (action === 'check_env') {
    const envVars = conn.env_vars || [];
    const envVars2: Record<string, boolean> = {};
    for (const varName of envVars) {
      envVars2[varName] = process.env[varName] !== undefined && process.env[varName] !== '';
    }
    const envResult: ConnectionEnvCheckResult = { id, envVars: envVars2 };
    return NextResponse.json(envResult);
  }

  // ── test ────────────────────────────────────────────────────────────────────
  if (action === 'test') {
    const result = await testConnection(conn);
    return NextResponse.json(result);
  }

  return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
});

// ─── Health Check Logic ───────────────────────────────────────────────────────

async function testConnection(
  conn: { id: string; connection_type: string; env_vars?: string[]; endpoint?: string; pm2_process?: string }
): Promise<ConnectionHealthResult> {
  const { id, connection_type, env_vars, endpoint } = conn;

  // Local HTTP services — real ping
  if (connection_type === 'local_http') {
    return pingHttp(id, endpoint || 'http://localhost:11434');
  }

  // n8n — local API key + real HTTP
  if (connection_type === 'api_key_local') {
    return pingHttp(id, endpoint ? `${endpoint}/healthz` : 'http://localhost:5678/healthz');
  }

  // Figma MCP — check PM2 process
  if (connection_type === 'websocket') {
    return checkPm2Process(id, (conn as { pm2_process?: string }).pm2_process || 'figma-mcp-ws');
  }

  // stdio / local — check PM2 if available
  if (connection_type === 'stdio' || connection_type === 'local') {
    const pm2Name = (conn as { pm2_process?: string }).pm2_process;
    if (pm2Name) return checkPm2Process(id, pm2Name);
    return { id, status: 'unknown', message: 'No process to check' };
  }

  // All other types — env var presence check
  if (!env_vars || env_vars.length === 0) {
    return { id, status: 'unknown', message: 'No env vars configured' };
  }

  const allSet = env_vars.every(v => process.env[v] !== undefined && process.env[v] !== '');
  const anySet = env_vars.some(v => process.env[v] !== undefined && process.env[v] !== '');

  if (allSet) return { id, status: 'ok', message: `All ${env_vars.length} env vars set` };
  if (anySet) {
    const missing = env_vars.filter(v => !process.env[v]);
    return { id, status: 'error', message: `Missing: ${missing.join(', ')}` };
  }
  return { id, status: 'error', message: 'No env vars set' };
}

async function pingHttp(id: string, url: string): Promise<ConnectionHealthResult> {
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const latencyMs = Date.now() - start;
    // 2xx or 4xx = service is up
    if (res.status < 500) {
      return { id, status: 'ok', latencyMs, message: `HTTP ${res.status}` };
    }
    return { id, status: 'error', latencyMs, message: `HTTP ${res.status}` };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : 'Connection failed';
    return { id, status: 'error', latencyMs, message: msg };
  }
}

async function checkPm2Process(id: string, processName: string): Promise<ConnectionHealthResult> {
  try {
    const res = await fetch(`${selfOrigin()}/api/pm2`);
    if (!res.ok) return { id, status: 'unknown', message: 'PM2 API unavailable' };
    const data = await res.json();
    const proc = (data.processes || []).find(
      (p: { name: string; status: string }) => p.name === processName
    );
    if (!proc) return { id, status: 'error', message: `Process '${processName}' not in PM2` };
    if (proc.status === 'online') return { id, status: 'ok', message: `PM2: ${proc.status}` };
    return { id, status: 'error', message: `PM2: ${proc.status}` };
  } catch {
    return { id, status: 'unknown', message: 'PM2 check failed' };
  }
}
