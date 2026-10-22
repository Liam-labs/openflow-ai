import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { PRODUCT_NAME } from '@/lib/brand';

const execAsync = promisify(exec);

interface McpConfigEntry {
  type?: 'stdio' | 'http' | 'sse';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpServerSummary {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  url: string | null;
  command: string | null;
  args: string[];
  configSources: string[];
  pm2: { name: string; status: string; pid: number | null; mem: number; cpu: number; uptime: number | null } | null;
  port: number | null;
  health: 'ok' | 'fail' | 'unknown';
  enabled: boolean;
  enabledProjects: string[];
  disabledProjects: string[];
  knownProjects: string[];
}

const HOME = os.homedir();
const HOME_MCP_JSON = path.join(HOME, '.mcp.json');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const CLAUDE_DIR_MCP = path.join(HOME, '.claude', '.mcp.json');
const DEVFLOW_GATEWAY_HEALTH_URL = process.env.DEVFLOW_GATEWAY_HEALTH_URL ?? 'http://127.0.0.1:7007/health';

async function readJsonSafe<T = unknown>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function inferTransport(entry: McpConfigEntry): 'stdio' | 'http' | 'sse' {
  if (entry.type) return entry.type;
  if (entry.url?.includes('/sse')) return 'sse';
  if (entry.url) return 'http';
  return 'stdio';
}

function portFromUrl(url?: string | null): number | null {
  if (!url) return null;
  try {
    return Number(new URL(url).port) || null;
  } catch {
    return null;
  }
}

interface Pm2Proc {
  name: string;
  pid: number;
  pm2_env: { status: string; pm_uptime?: number };
  monit: { memory: number; cpu: number };
}

async function pm2List(): Promise<Pm2Proc[]> {
  try {
    const { stdout } = await execAsync('pm2 jlist', { maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout) as Pm2Proc[];
  } catch {
    return [];
  }
}

function matchPm2(name: string, port: number | null, procs: Pm2Proc[]): Pm2Proc | null {
  const lower = name.toLowerCase();
  // Direct name patterns first
  const direct = procs.find(p => {
    const pn = p.name.toLowerCase();
    return pn === `${lower}-mcp-http` || pn === `${lower}-mcp-sse` || pn === `${lower}-mcp` || pn.startsWith(`${lower}-`);
  });
  if (direct) return direct;
  // Fall back: port-based heuristic (search args)
  if (port) {
    const byPort = procs.find(p => p.name.includes(String(port)));
    if (byPort) return byPort;
  }
  return null;
}

async function checkHealth(transport: string, url: string | null): Promise<'ok' | 'fail' | 'unknown'> {
  if (!url) return 'unknown';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const probeUrl = transport === 'sse' ? url : url.replace(/\/mcp\/?$/, '/');
    const res = await fetch(probeUrl, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    return res.status < 500 ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}

async function buildSummary(): Promise<McpServerSummary[]> {
  const [homeMcp, claudeJson, claudeDirMcp, pm2Procs] = await Promise.all([
    readJsonSafe<{ mcpServers?: Record<string, McpConfigEntry>; _disabledServers?: Record<string, McpConfigEntry> }>(HOME_MCP_JSON),
    readJsonSafe<{
      mcpServers?: Record<string, McpConfigEntry>;
      _disabledServers?: Record<string, McpConfigEntry>;
      projects?: Record<string, { enabledMcpjsonServers?: string[]; disabledMcpjsonServers?: string[]; mcpServers?: Record<string, McpConfigEntry> }>;
    }>(CLAUDE_JSON),
    readJsonSafe<{ mcpServers?: Record<string, McpConfigEntry> }>(CLAUDE_DIR_MCP),
    pm2List(),
  ]);

  const merged: Record<string, { entry: McpConfigEntry; sources: string[]; disabled: boolean }> = {};

  function ingest(src: string, servers?: Record<string, McpConfigEntry>, disabled = false) {
    if (!servers) return;
    for (const [name, entry] of Object.entries(servers)) {
      if (!merged[name]) merged[name] = { entry, sources: [src], disabled };
      else {
        merged[name].sources.push(src);
        if (!disabled) merged[name].disabled = false;
      }
    }
  }
  ingest('~/.mcp.json', homeMcp?.mcpServers);
  ingest('~/.mcp.json (disabled)', homeMcp?._disabledServers, true);
  ingest('~/.claude.json', claudeJson?.mcpServers);
  ingest('~/.claude.json (disabled)', claudeJson?._disabledServers, true);
  ingest('~/.claude/.mcp.json', claudeDirMcp?.mcpServers);

  // Project-level enable/disable map
  const projects = claudeJson?.projects ?? {};
  const projectEnable: Record<string, string[]> = {};
  const projectDisable: Record<string, string[]> = {};
  const knownProjects = Object.keys(projects);
  for (const [projPath, projCfg] of Object.entries(projects)) {
    for (const en of projCfg.enabledMcpjsonServers ?? []) {
      (projectEnable[en] ??= []).push(projPath);
    }
    for (const dis of projCfg.disabledMcpjsonServers ?? []) {
      (projectDisable[dis] ??= []).push(projPath);
    }
    for (const [name, entry] of Object.entries(projCfg.mcpServers ?? {})) {
      if (!merged[name]) merged[name] = { entry, sources: [`project:${projPath}`], disabled: false };
    }
  }

  const summary: McpServerSummary[] = await Promise.all(
    Object.entries(merged).map(async ([name, { entry, sources, disabled }]) => {
      const transport = inferTransport(entry);
      const url = entry.url ?? null;
      const port = portFromUrl(url);
      const pm2 = matchPm2(name, port, pm2Procs);
      const health = await checkHealth(transport, url);
      // "Enabled" = config not parked AND (if pm2-backed) process online
      let enabled = !disabled;
      if (pm2 && pm2.pm2_env.status !== 'online') enabled = false;
      return {
        name,
        transport,
        url,
        command: entry.command ?? null,
        args: entry.args ?? [],
        configSources: sources,
        pm2: pm2
          ? {
              name: pm2.name,
              status: pm2.pm2_env.status,
              pid: pm2.pid || null,
              mem: pm2.monit.memory,
              cpu: pm2.monit.cpu,
              uptime: pm2.pm2_env.pm_uptime ?? null,
            }
          : null,
        port,
        health,
        enabled,
        enabledProjects: projectEnable[name] ?? [],
        disabledProjects: projectDisable[name] ?? [],
        knownProjects,
      };
    })
  );

  return summary.sort((a, b) => a.name.localeCompare(b.name));
}

async function writeJsonAtomic(p: string, data: unknown): Promise<void> {
  const tmp = `${p}.tmp.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, p);
}

async function setGlobalEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return { ok: false, error: 'invalid name' };
  // Determine where the server is configured
  const homeMcp = (await readJsonSafe<{ mcpServers?: Record<string, McpConfigEntry>; _disabledServers?: Record<string, McpConfigEntry> }>(HOME_MCP_JSON)) ?? {};
  const claudeJson = (await readJsonSafe<{ mcpServers?: Record<string, McpConfigEntry>; _disabledServers?: Record<string, McpConfigEntry> }>(CLAUDE_JSON)) ?? {};

  const inHomeActive = homeMcp.mcpServers?.[name];
  const inHomeParked = homeMcp._disabledServers?.[name];
  const inClaudeActive = claudeJson.mcpServers?.[name];
  const inClaudeParked = claudeJson._disabledServers?.[name];

  // Try PM2 first if backed
  const pm2Procs = await pm2List();
  const port = portFromUrl((inHomeActive ?? inHomeParked ?? inClaudeActive ?? inClaudeParked)?.url);
  const pm2 = matchPm2(name, port, pm2Procs);
  if (pm2) {
    const op = enabled ? 'start' : 'stop';
    try { await execAsync(`pm2 ${op} ${pm2.name}`); } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'pm2 op failed' };
    }
  }

  // Move stdio config between active and parking spot
  if (inHomeActive || inHomeParked) {
    const next = { ...homeMcp };
    next.mcpServers = { ...(next.mcpServers ?? {}) };
    next._disabledServers = { ...(next._disabledServers ?? {}) };
    if (enabled) {
      const cfg = inHomeParked ?? inHomeActive!;
      next.mcpServers[name] = cfg;
      delete next._disabledServers[name];
    } else {
      const cfg = inHomeActive ?? inHomeParked!;
      next._disabledServers[name] = cfg;
      delete next.mcpServers[name];
    }
    if (Object.keys(next._disabledServers).length === 0) delete next._disabledServers;
    await writeJsonAtomic(HOME_MCP_JSON, next);
    return { ok: true };
  }
  if (inClaudeActive || inClaudeParked) {
    // Don't touch ~/.claude.json structurally — too risky (auth state, projects, etc).
    // For ~/.claude.json-defined servers, "disabled" only means PM2 stop. Surface that.
    if (!pm2) return { ok: false, error: 'server is in ~/.claude.json with no PM2 backing — manual edit required' };
    return { ok: true };
  }
  return { ok: false, error: 'server not found in any config file' };
}

async function setProjectEnabled(name: string, projectPath: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return { ok: false, error: 'invalid name' };
  const claudeJson = (await readJsonSafe<{
    projects?: Record<string, { enabledMcpjsonServers?: string[]; disabledMcpjsonServers?: string[] }>;
  } & Record<string, unknown>>(CLAUDE_JSON)) ?? {};
  const projects = (claudeJson.projects ?? {}) as Record<string, { enabledMcpjsonServers?: string[]; disabledMcpjsonServers?: string[] }>;
  const proj = projects[projectPath];
  if (!proj) return { ok: false, error: `project not found in ~/.claude.json: ${projectPath}` };

  const enabledList = new Set(proj.enabledMcpjsonServers ?? []);
  const disabledList = new Set(proj.disabledMcpjsonServers ?? []);
  if (enabled) {
    enabledList.add(name);
    disabledList.delete(name);
  } else {
    disabledList.add(name);
    enabledList.delete(name);
  }
  proj.enabledMcpjsonServers = Array.from(enabledList);
  proj.disabledMcpjsonServers = Array.from(disabledList);
  // Reassemble preserving everything else
  (claudeJson.projects as Record<string, unknown>)[projectPath] = proj;
  await writeJsonAtomic(CLAUDE_JSON, claudeJson);
  return { ok: true };
}

export async function GET(request: NextRequest) {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  const action = request.nextUrl.searchParams.get('action') ?? 'list';

  if (action === 'list') {
    const servers = await buildSummary();
    return NextResponse.json({ ok: true, servers });
  }

  if (action === 'gateway-status') {
    try {
      const response = await fetch(DEVFLOW_GATEWAY_HEALTH_URL, {
        cache: 'no-store',
        signal: AbortSignal.timeout(3_000),
      });
      const body = await response.json();
      return NextResponse.json(body, { status: response.ok ? 200 : 502 });
    } catch (error) {
      return NextResponse.json({
        ok: false,
        name: `Model-neutral ${PRODUCT_NAME} MCP Gateway`,
        error: error instanceof Error ? error.message : 'Gateway unavailable',
      }, { status: 503 });
    }
  }

  if (action === 'pm2-action') {
    return NextResponse.json({ ok: false, error: 'use POST for pm2-action' }, { status: 400 });
  }

  return NextResponse.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
}

export async function POST(request: NextRequest) {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const action = body.action as string | undefined;

  if (action === 'pm2' && typeof body.target === 'string' && typeof body.op === 'string') {
    const allowedOps = new Set(['restart', 'stop', 'start']);
    if (!allowedOps.has(body.op)) {
      return NextResponse.json({ ok: false, error: 'op must be restart|stop|start' }, { status: 400 });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(body.target)) {
      return NextResponse.json({ ok: false, error: 'invalid target' }, { status: 400 });
    }
    try {
      await execAsync(`pm2 ${body.op} ${body.target}`, { maxBuffer: 4 * 1024 * 1024 });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'pm2 failed' }, { status: 500 });
    }
  }

  if (action === 'set-enabled' && typeof body.name === 'string' && typeof body.enabled === 'boolean') {
    const result = await setGlobalEnabled(body.name, body.enabled);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  }

  if (action === 'set-project-enabled' && typeof body.name === 'string' && typeof body.projectPath === 'string' && typeof body.enabled === 'boolean') {
    const result = await setProjectEnabled(body.name, body.projectPath, body.enabled);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  }

  return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
}
