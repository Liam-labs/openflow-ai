import { promises as fs } from 'fs';
import path from 'path';

import { readJsonFile } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import { defaultHost, hostCall } from '@/lib/host-executor';
import type { CollabChannel, CollabChannelsData } from '@/lib/types';

/**
 * Channel tools: each channel's project folder holds `channel-tools/<tool>/tool.json` (plus any files the tool
 * needs). The AgentChat launcher lists them and opens them. The folder lives on the agent host (the PC), so when
 * DevFlow runs elsewhere it reads the folder through agent-hostd (ops channel-tools-list / channel-tools-read);
 * when DevFlow runs on the same machine it reads the disk directly. Reading only: DevFlow never runs a tool.
 */

export const CHANNEL_TOOLS_DIRNAME = 'channel-tools';
export const TOOL_MANIFEST = 'tool.json';
export const MAX_TOOL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_TOOLS = 100;
const HOST_WAIT_MS = 8_000;

export const TOOL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ChannelToolType = 'link' | 'html' | 'script';

export interface ChannelTool {
  id: string;
  name: string;
  description: string;
  /** One or two sentences telling agents when to point the owner to this tool or use it themselves. */
  whenToUse?: string;
  type: ChannelToolType;
  icon?: string;
  order: number;
  /** link: address to open (http/https, or a DevFlow path starting with a single /). */
  url?: string;
  /** html: file inside the tool folder that opens first. */
  entry?: string;
  /** html: where the browser opens it (served read-only by DevFlow). */
  launchPath?: string;
  /** script: command shown to copy and run; DevFlow never runs it. */
  run?: string;
  /** script: folder to run it from, relative to the tool folder. */
  cwd?: string;
}

export interface ChannelToolWarning { id: string; message: string }

export type ChannelToolsStatus = 'ok' | 'no-project' | 'no-folder' | 'host-offline' | 'host-outdated' | 'error';

export interface ChannelToolsResult {
  channelId: string;
  dir: string | null;
  status: ChannelToolsStatus;
  message?: string;
  tools: ChannelTool[];
  warnings: ChannelToolWarning[];
}

export interface RawTool { id: string; manifest: string | null; error: string | null }
export interface RawToolList { exists: boolean; tools: RawTool[] }

// ---------------------------------------------------------------------------------------------------------------
// Paths

/** Split a tool-relative path into safe segments, or null. No empty/dot/dot-dot segments, no dot-files. */
export function safeToolPath(rel: string): string[] | null {
  if (typeof rel !== 'string' || !rel || rel.length > 400 || rel.includes('\0') || rel.includes('\\')) return null;
  const segs = rel.split('/');
  if (segs.some(s => !s || s === '.' || s === '..' || s.startsWith('.'))) return null;
  return segs;
}

/** The channel's own project folder, or its parent channel's for a sub-channel. */
export function channelProjectPath(channelId: string, channels: CollabChannel[]): string | null {
  let current = channels.find(c => c.id === channelId);
  for (let depth = 0; current && depth < 4; depth++) {
    const p = current.projectPath?.trim();
    if (p) return path.isAbsolute(p) && !p.includes('\0') ? path.normalize(p) : null;
    const parentId: string | undefined = current.parentChannelId;
    current = parentId ? channels.find(c => c.id === parentId) : undefined;
  }
  return null;
}

export function channelToolsDir(channelId: string, channels: CollabChannel[]): string | null {
  const project = channelProjectPath(channelId, channels);
  return project ? path.join(project, CHANNEL_TOOLS_DIRNAME) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Manifest

type Parsed = { tool: ChannelTool } | { warning: string } | { hidden: true };

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

function validLink(url: string): boolean {
  if (url.startsWith('/')) return !url.startsWith('//') && !url.includes('\\') && !/[\u0000-\u001f]/.test(url);
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parse one tool.json. A bad manifest becomes a warning; a tool meant for other channels is hidden. */
export function parseToolManifest(id: string, raw: string, channel: { id: string; name: string }): Parsed {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return { warning: 'tool.json is not valid JSON' };
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { warning: 'tool.json must be a JSON object' };
  const o = m as Record<string, unknown>;

  if (o.channels !== undefined) {
    if (!Array.isArray(o.channels) || o.channels.some(c => typeof c !== 'string')) return { warning: '"channels" must be a list of channel names or ids' };
    const wanted = (o.channels as string[]).map(c => c.trim().toLowerCase());
    if (wanted.length && !wanted.includes(channel.id.toLowerCase()) && !wanted.includes(channel.name.trim().toLowerCase())) return { hidden: true };
  }

  let type = o.type;
  if (type === undefined) type = o.url ? 'link' : o.run ? 'script' : o.entry ? 'html' : undefined;
  if (type !== 'link' && type !== 'html' && type !== 'script') return { warning: '"type" must be link, html or script' };

  const tool: ChannelTool = {
    id,
    name: str(o.name, 80) ?? id,
    description: str(o.description, 300) ?? '',
    type,
    order: typeof o.order === 'number' && Number.isFinite(o.order) ? o.order : 100,
  };
  const whenToUse = str(o.whenToUse, 400);
  if (whenToUse) tool.whenToUse = whenToUse;
  const icon = str(o.icon, 8);
  if (icon) tool.icon = icon;

  if (type === 'link') {
    const url = str(o.url, 2000);
    if (!url || !validLink(url)) return { warning: 'a link tool needs "url" starting with http://, https:// or /' };
    tool.url = url;
  } else if (type === 'html') {
    const entry = str(o.entry, 300) ?? 'index.html';
    const segs = safeToolPath(entry);
    if (!segs || !/\.html?$/i.test(entry)) return { warning: '"entry" must be an .html file inside the tool folder' };
    tool.entry = entry;
    tool.launchPath = `/api/channel-tools/file/${encodeURIComponent(channel.id)}/${encodeURIComponent(id)}/${segs.map(encodeURIComponent).join('/')}`;
  } else {
    const run = str(o.run, 500);
    if (!run) return { warning: 'a script tool needs "run" (the command to copy and run)' };
    tool.run = run;
    const cwd = str(o.cwd, 300);
    if (cwd && cwd !== '.') {
      if (!safeToolPath(cwd)) return { warning: '"cwd" must stay inside the tool folder' };
      tool.cwd = cwd;
    }
  }
  return { tool };
}

export function buildResult(channel: { id: string; name: string }, dir: string, list: RawToolList): ChannelToolsResult {
  const tools: ChannelTool[] = [];
  const warnings: ChannelToolWarning[] = [];
  if (!list.exists) {
    return { channelId: channel.id, dir, status: 'no-folder', tools, warnings };
  }
  for (const raw of list.tools.slice(0, MAX_TOOLS)) {
    if (raw.error || raw.manifest === null) {
      warnings.push({ id: raw.id, message: raw.error || 'missing tool.json' });
      continue;
    }
    const parsed = parseToolManifest(raw.id, raw.manifest, channel);
    if ('tool' in parsed) tools.push(parsed.tool);
    else if ('warning' in parsed) warnings.push({ id: raw.id, message: parsed.warning });
  }
  tools.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return { channelId: channel.id, dir, status: 'ok', tools, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Local disk (DevFlow on the same machine as the folder) - same rules as agent-hostd

export async function listToolsOnDisk(dir: string): Promise<RawToolList> {
  const root = await fs.realpath(dir).catch(() => null);
  if (!root || !(await fs.stat(root).then(s => s.isDirectory(), () => false))) return { exists: false, tools: [] };
  const names = (await fs.readdir(root)).sort();
  const tools: RawTool[] = [];
  for (const name of names) {
    if (name.startsWith('.') || tools.length >= MAX_TOOLS) continue;
    const full = path.join(root, name);
    const lst = await fs.lstat(full).catch(() => null);
    if (!lst || lst.isSymbolicLink() || !lst.isDirectory()) continue;
    const item: RawTool = { id: name, manifest: null, error: null };
    if (!TOOL_ID_RE.test(name)) {
      item.error = 'folder name may only use letters, numbers, dot, dash and underscore';
    } else {
      const mf = path.join(full, TOOL_MANIFEST);
      const st = await fs.lstat(mf).catch(() => null);
      if (!st || st.isSymbolicLink() || !st.isFile()) item.error = 'missing tool.json';
      else if (st.size > MAX_MANIFEST_BYTES) item.error = 'tool.json is too large';
      else item.manifest = await fs.readFile(mf, 'utf-8').catch(() => { item.error = 'cannot read tool.json'; return null; });
    }
    tools.push(item);
  }
  return { exists: true, tools };
}

export async function readToolFileOnDisk(dir: string, toolId: string, segs: string[]): Promise<Buffer> {
  if (!TOOL_ID_RE.test(toolId)) throw Object.assign(new Error('bad tool name'), { statusCode: 400 });
  const root = await fs.realpath(dir);
  const toolDir = path.join(root, toolId);
  const toolStat = await fs.lstat(toolDir).catch(() => null);
  if (!toolStat || toolStat.isSymbolicLink() || !toolStat.isDirectory()) throw Object.assign(new Error('no such tool'), { statusCode: 404 });
  const toolReal = await fs.realpath(toolDir);
  const real = await fs.realpath(path.join(toolReal, ...segs)).catch(() => null);
  if (!real || !real.startsWith(toolReal + path.sep)) throw Object.assign(new Error('no such file'), { statusCode: 404 });
  const st = await fs.stat(real);
  if (!st.isFile()) throw Object.assign(new Error('no such file'), { statusCode: 404 });
  if (st.size > MAX_TOOL_FILE_BYTES) throw Object.assign(new Error('file too large'), { statusCode: 413 });
  return fs.readFile(real);
}

// ---------------------------------------------------------------------------------------------------------------
// Orchestration

function hostFailure(error: unknown): { status: ChannelToolsStatus; message: string } {
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code;
  if (code === 'EHOSTTIMEOUT') return { status: 'host-offline', message: 'The agent machine is not answering right now, so this channel\'s tools cannot be read.' };
  if (/unknown op/i.test(msg)) return { status: 'host-outdated', message: 'The agent machine\'s helper (agent-hostd) needs a restart before it can read channel tools.' };
  return { status: 'error', message: msg.slice(0, 300) };
}

async function loadChannels(): Promise<CollabChannel[]> {
  const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, { channels: [], lastUpdated: '' } as CollabChannelsData);
  return data.channels;
}

const cache = new Map<string, { at: number; result: ChannelToolsResult }>();
const CACHE_MS = 10_000;

export async function listChannelTools(channelId: string): Promise<ChannelToolsResult | null> {
  const channels = await loadChannels();
  const channel = channels.find(c => c.id === channelId);
  if (!channel) return null;
  const dir = channelToolsDir(channelId, channels);
  const who = { id: channel.id, name: channel.name };
  if (!dir) {
    return { channelId, dir: null, status: 'no-project', message: 'This channel has no project folder, so it has no channel tools folder.', tools: [], warnings: [] };
  }
  let result: ChannelToolsResult;
  try {
    const host = defaultHost();
    const list = host
      ? await hostCall<RawToolList>(host, 'channel-tools-list', { dir }, HOST_WAIT_MS)
      : await listToolsOnDisk(dir);
    result = buildResult(who, dir, list);
  } catch (error) {
    const f = hostFailure(error);
    result = { channelId, dir, status: f.status, message: f.message, tools: [], warnings: [] };
  }
  cache.set(channelId, { at: Date.now(), result });
  return result;
}

export type ToolFile =
  | { ok: true; data: Buffer }
  | { ok: false; statusCode: number; message: string };

/** Read one file of a declared html tool. Only files inside that tool's folder are ever returned. */
export async function readChannelToolFile(channelId: string, toolId: string, rel: string): Promise<ToolFile> {
  const segs = safeToolPath(rel);
  if (!segs || !TOOL_ID_RE.test(toolId)) return { ok: false, statusCode: 400, message: 'Bad path' };
  const cached = cache.get(channelId);
  const listing = cached && Date.now() - cached.at < CACHE_MS ? cached.result : await listChannelTools(channelId);
  if (!listing) return { ok: false, statusCode: 404, message: 'Channel not found' };
  if (!listing.dir) return { ok: false, statusCode: 404, message: 'This channel has no project folder' };
  const tool = listing.tools.find(t => t.id === toolId);
  if (!tool || tool.type !== 'html') return { ok: false, statusCode: 404, message: 'No such tool' };
  try {
    const host = defaultHost();
    if (!host) return { ok: true, data: await readToolFileOnDisk(listing.dir, toolId, segs) };
    const r = await hostCall<{ b64: string }>(host, 'channel-tools-read', { dir: listing.dir, tool: toolId, path: segs.join('/') }, HOST_WAIT_MS);
    return { ok: true, data: Buffer.from(r.b64, 'base64') };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code;
    const statusCode = (error as { statusCode?: number })?.statusCode
      ?? (code === 'EHOSTTIMEOUT' ? 504 : /too large/i.test(msg) ? 413 : /no such|FileNotFound/i.test(msg) ? 404 : /unknown op/i.test(msg) ? 503 : 502);
    return { ok: false, statusCode, message: statusCode === 404 ? 'File not found' : statusCode === 413 ? 'File too large (5 MB limit)' : 'Could not read the file' };
  }
}

const TEXT = 'charset=utf-8';
const CONTENT_TYPES: Record<string, string> = {
  html: `text/html; ${TEXT}`, htm: `text/html; ${TEXT}`, css: `text/css; ${TEXT}`, js: `text/javascript; ${TEXT}`,
  mjs: `text/javascript; ${TEXT}`, json: `application/json; ${TEXT}`, txt: `text/plain; ${TEXT}`, md: `text/plain; ${TEXT}`,
  csv: `text/csv; ${TEXT}`, svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', wav: 'audio/wav',
  ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', wasm: 'application/wasm',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** Test hook: forget remembered listings. */
export function clearChannelToolsCache(): void {
  cache.clear();
}
