/**
 * Browser-use wizard (stage 3 of the setup wizards): a browser your agents can drive, with its own saved sign-ins.
 *
 * Do      start a dedicated Chrome/Chromium with its own profile folder and its control port (CDP) on this computer only, and add a
 *         Playwright MCP server that attaches to it, so agents work in the same browser you signed in to.
 * Prove   the browser answers, a real page is opened and photographed through the control port, and every other address of this
 *         computer REFUSES a connection to that port. The control port gives full control of every site the browser is signed in to,
 *         so if anything else can reach it the browser is stopped at once.
 * Undo    stop the browser and remove the MCP server. The profile (your saved sign-ins) is kept unless you ask to delete it.
 */

import { spawn } from 'child_process';
import { existsSync, openSync, closeSync, readdirSync, promises as fs } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { DataPaths } from '../data-paths';
import { readJsonFileStrict, writeJsonFile } from '../data-io';
import { isPidAlive, readProcCmdline } from '../proc-info';
import { BROWSER_PORT_FIRST, BROWSER_PORT_LAST, isBrowserDebugPort } from './ports';

type Env = Record<string, string | undefined>;

export interface BrowserRecord {
  enabled: boolean;
  port?: number;
  pid?: number;
  profileDir?: string;
  headless?: boolean;
  exe?: string;
  mcp?: boolean;
  at?: string;
}

// ─── Finding a browser ───────────────────────────────────────────────────────────────────────────────

export interface BrowserBinary { path: string; kind: 'chrome' | 'chromium' | 'edge' | 'playwright' }

export function browserCandidates(platform: string = process.platform, env: Env = process.env, home: string = os.homedir()): BrowserBinary[] {
  const list: BrowserBinary[] = [];
  const add = (p: string, kind: BrowserBinary['kind']) => list.push({ path: p, kind });
  if (platform === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome');
    add('/Applications/Chromium.app/Contents/MacOS/Chromium', 'chromium');
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'edge');
  } else if (platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (base) { add(path.join(base, 'Google/Chrome/Application/chrome.exe'), 'chrome'); add(path.join(base, 'Microsoft/Edge/Application/msedge.exe'), 'edge'); }
    }
  } else {
    for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const [name, kind] of [['google-chrome', 'chrome'], ['google-chrome-stable', 'chrome'], ['chromium', 'chromium'], ['chromium-browser', 'chromium'], ['microsoft-edge', 'edge']] as const) add(path.join(dir, name), kind);
    }
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/opt/google/chrome/chrome']) add(p, p.includes('chrome') && !p.includes('chromium') ? 'chrome' : 'chromium');
  }
  return list;
}

export function findBrowser(exists: (p: string) => boolean = existsSync, candidates: BrowserBinary[] = browserCandidates(), playwrightPath: string | null = null): BrowserBinary | null {
  return candidates.find((c) => exists(c.path)) ?? (playwrightPath && exists(playwrightPath) ? { path: playwrightPath, kind: 'playwright' } : null);
}

/** Playwright's own Chromium (a fallback when no Chrome is installed), found on disk without loading Playwright. */
export function playwrightChromiumPath(env: Env = process.env, home: string = os.homedir(), platform: string = process.platform, list: (d: string) => string[] = (d) => { try { return readdirSync(d); } catch { return []; } }, exists: (p: string) => boolean = existsSync): string | null {
  const root = env.PLAYWRIGHT_BROWSERS_PATH || (platform === 'darwin' ? path.join(home, 'Library/Caches/ms-playwright') : platform === 'win32' ? path.join(env.LOCALAPPDATA || home, 'ms-playwright') : path.join(home, '.cache/ms-playwright'));
  const dirs = list(root).filter((n) => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  const rel = platform === 'darwin' ? ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'] : platform === 'win32' ? ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe'] : ['chrome-linux/chrome', 'chrome-linux64/chrome'];
  for (const d of dirs) for (const r of rel) { const p = path.join(root, d, r); if (exists(p)) return p; }
  return null;
}

/** A visible window needs a display: always on Mac and Windows, DISPLAY or WAYLAND_DISPLAY on Linux. */
export function displayAvailable(platform: string = process.platform, env: Env = process.env): boolean {
  if (platform === 'darwin' || platform === 'win32') return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

// ─── Starting it ─────────────────────────────────────────────────────────────────────────────────────

export function launchArgs(o: { profileDir: string; port: number; headless: boolean; noSandbox: boolean }): string[] {
  if (!Number.isInteger(o.port) || !isBrowserDebugPort(o.port)) throw new Error('The control port must be one of the reserved browser ports.');
  return [
    `--remote-debugging-port=${o.port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${o.profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    ...(o.headless ? ['--headless=new'] : []),
    ...(o.noSandbox ? ['--no-sandbox'] : []),         // only for root (a container) or when the owner asks (DEVFLOW_BROWSER_NO_SANDBOX=1)
    'about:blank',
  ];
}

export async function pickPort(isFree: (port: number) => Promise<boolean>, first = BROWSER_PORT_FIRST, last = BROWSER_PORT_LAST): Promise<number | null> {
  for (let p = first; p <= last; p++) if (await isFree(p)) return p;
  return null;
}

export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

export interface Deps {
  env: Env;
  platform: string;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  readRecord: () => Promise<BrowserRecord>;
  writeRecord: (r: BrowserRecord) => Promise<void>;
  binary: () => Promise<BrowserBinary | null>;
  isFree: (port: number) => Promise<boolean>;
  spawnBrowser: (exe: string, args: string[]) => Promise<number | null>;
  /** The end of the browser's own start-up output, to explain a failed start. */
  startupLog: () => Promise<string>;
  isRunning: (r: BrowserRecord) => Promise<boolean>;
  killBrowser: (pid: number) => Promise<void>;
  cdpVersion: (port: number) => Promise<{ browser: string } | null>;
  shoot: (port: number, nonce: string) => Promise<{ ok: boolean; bytes: number; detail: string }>;
  openUrl: (port: number, url: string) => Promise<boolean>;
  externalAddresses: () => { address: string; family: 4 | 6 }[];
  canConnect: (host: string, port: number) => Promise<boolean>;
  servedPorts: () => Promise<number[]>;           // ports a Tailscale Serve entry forwards to
  mcp: { add: (port: number) => Promise<{ ok: boolean; message: string }>; remove: () => Promise<{ ok: boolean; message: string }> };
  removeDir: (dir: string) => Promise<void>;
  profileRoot: string;
}

export type StepResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; fix?: string };

const emptyRecord = (): BrowserRecord => ({ enabled: false });

export async function startBrowser(d: Deps): Promise<StepResult<{ port: number; headless: boolean }>> {
  const cur = await d.readRecord();
  if (cur.enabled && cur.port && (await d.isRunning(cur))) return { ok: true, port: cur.port, headless: !!cur.headless };
  const bin = await d.binary();
  if (!bin) return { ok: false, error: 'No Chrome, Chromium or Edge was found on this computer.', fix: 'install' };
  const port = cur.port && (await d.isFree(cur.port)) ? cur.port : await pickPort(d.isFree);
  if (!port) return { ok: false, error: `No free control port between ${BROWSER_PORT_FIRST} and ${BROWSER_PORT_LAST}.` };
  const profileDir = cur.profileDir ?? path.join(d.profileRoot, 'chrome-profile');
  const headless = !displayAvailable(d.platform, d.env);
  // Chrome's sandbox cannot run as root (a container); anyone else must opt out on purpose.
  const asRoot = d.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;
  const noSandbox = asRoot || d.env.DEVFLOW_BROWSER_NO_SANDBOX === '1';
  const pid = await d.spawnBrowser(bin.path, launchArgs({ profileDir, port, headless, noSandbox }));
  if (!pid) return { ok: false, error: 'The browser did not start.' };
  let up = null as { browser: string } | null;
  for (let i = 0; i < 40 && !up; i++) { up = await d.cdpVersion(port); if (!up) await d.sleep(500); }
  if (!up) {
    const log = await d.startupLog().catch(() => '');
    await d.killBrowser(pid);
    if (/No usable sandbox/i.test(log)) return { ok: false, error: 'The browser\'s own protection (its sandbox) cannot start on this Linux system, so it was not run without it. Installing Google Chrome fixes this (its package allows it), or you can allow unprivileged user namespaces yourself.', fix: 'sandbox' };
    return { ok: false, error: 'The browser started but its control port never answered. It was stopped.' };
  }
  await d.writeRecord({ ...cur, enabled: true, port, pid, profileDir, headless, exe: bin.path, at: d.now() });
  return { ok: true, port, headless };
}

// ─── Prove ───────────────────────────────────────────────────────────────────────────────────────────

export interface ProofStep { name: string; ok: boolean; detail: string }

export async function proveBrowser(d: Deps, nonce: string): Promise<{ ok: boolean; exposed: boolean; steps: ProofStep[] }> {
  const rec = await d.readRecord();
  const steps: ProofStep[] = [];
  if (!rec.enabled || !rec.port) return { ok: false, exposed: false, steps: [{ name: 'The browser is running', ok: false, detail: 'Start it first.' }] };
  const port = rec.port;

  // 1. Only this computer: every other address must refuse. Checked first, and it stops the browser if it fails.
  const open: string[] = [];
  for (const a of d.externalAddresses()) if (await d.canConnect(a.address, port)) open.push(a.address);
  const served = (await d.servedPorts()).includes(port);
  if (open.length || served) {
    if (rec.pid) await d.killBrowser(rec.pid);
    await d.writeRecord({ ...rec, enabled: false, pid: undefined });
    steps.push({ name: 'Only this computer can reach its control port', ok: false, detail: open.length ? `${open.join(', ')} could connect to port ${port}. The browser was stopped.` : `Tailscale Serve forwards port ${port}. The browser was stopped.` });
    return { ok: false, exposed: true, steps };
  }
  steps.push({ name: 'Only this computer can reach its control port', ok: true, detail: `Port ${port} answers on this computer and was refused on every other address of this computer${d.externalAddresses().length ? ` (${d.externalAddresses().map((a) => a.address).join(', ')})` : ''}.` });

  // 2. The browser answers.
  const v = await d.cdpVersion(port);
  steps.push({ name: 'The browser answers on its control port', ok: !!v, detail: v ? v.browser : 'No answer.' });
  if (!v) return { ok: false, exposed: false, steps };

  // 3. A real page, photographed.
  const shot = await d.shoot(port, nonce);
  steps.push({ name: 'It can open a page and take a picture of it', ok: shot.ok, detail: shot.detail });
  return { ok: steps.every((s) => s.ok), exposed: false, steps };
}

// ─── Agents, sign-in, undo ───────────────────────────────────────────────────────────────────────────

export function openUrlProblem(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return 'Enter a web address.';
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only http and https addresses can be opened.';
    return null;
  } catch {
    return 'That is not a web address (start with https://).';
  }
}

export async function addAgentAccess(d: Deps): Promise<StepResult<{ message: string }>> {
  const rec = await d.readRecord();
  if (!rec.enabled || !rec.port) return { ok: false, error: 'Start the browser first.' };
  const r = await d.mcp.add(rec.port);
  if (!r.ok) return { ok: false, error: r.message };
  await d.writeRecord({ ...rec, mcp: true });
  return { ok: true, message: r.message };
}

export async function stopBrowser(d: Deps, opts: { deleteProfile?: boolean } = {}): Promise<StepResult<{ note: string }>> {
  const rec = await d.readRecord();
  if (!rec.enabled && !rec.pid && !rec.mcp && !opts.deleteProfile) return { ok: true, note: 'Nothing was running here.' };
  if (rec.pid && (await d.isRunning(rec))) await d.killBrowser(rec.pid);
  let note = 'Browser stopped.';
  if (rec.mcp) {
    const r = await d.mcp.remove();
    note += r.ok ? ' Agent access removed.' : ` Agent access could not be removed (${r.message}).`;
  }
  if (opts.deleteProfile && rec.profileDir) {
    // Only the folder this wizard made: it must be inside the profile root.
    const inside = path.resolve(rec.profileDir).startsWith(path.resolve(d.profileRoot) + path.sep);
    if (!inside) return { ok: false, error: 'The recorded profile folder is not inside this app\'s data folder, so it was left alone.' };
    await d.removeDir(rec.profileDir);
    note += ' Saved sign-ins deleted.';
    await d.writeRecord(emptyRecord());
  } else {
    await d.writeRecord({ ...rec, enabled: false, pid: undefined, mcp: false });
    note += ' Your saved sign-ins are kept.';
  }
  return { ok: true, note };
}

// ─── Real implementations ────────────────────────────────────────────────────────────────────────────

export async function realCdpVersion(port: number): Promise<{ browser: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2500), cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as { Browser?: string };
    return j.Browser ? { browser: j.Browser } : null;
  } catch {
    return null;
  }
}

export async function realOpenUrl(port: number, url: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function realExternalAddresses(): { address: string; family: 4 | 6 }[] {
  const out: { address: string; family: 4 | 6 }[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal) continue;
      if (a.family === 'IPv6' && /^fe80:/i.test(a.address)) continue;      // link-local needs a zone id to connect
      out.push({ address: a.address, family: a.family === 'IPv6' ? 6 : 4 });
    }
  }
  return out;
}

export function realCanConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(2000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export async function realSpawn(exe: string, args: string[]): Promise<number | null> {
  const out = openSync(DataPaths.browserLog, 'w', 0o600);
  try {
    const child = spawn(exe, args, { detached: true, stdio: ['ignore', out, out] });
    child.on('error', () => undefined);
    child.unref();
    return child.pid ?? null;
  } finally {
    closeSync(out);
  }
}

export async function realStartupLog(): Promise<string> {
  try { return (await fs.readFile(DataPaths.browserLog, 'utf8')).slice(0, 4000); } catch { return ''; }
}

export async function realIsRunning(r: BrowserRecord): Promise<boolean> {
  if (!r.pid || !r.profileDir || !(await isPidAlive(r.pid))) return false;
  return (await readProcCmdline(r.pid)).includes(r.profileDir);        // a recycled pid is not our browser
}

export async function realKill(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let i = 0; i < 24 && (await isPidAlive(pid)); i++) await new Promise((r) => setTimeout(r, 250));
  if (await isPidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/** Everything start-up needs. The picture, agent-access and Tailscale pieces are added by browser-use.ts (they load heavier modules). */
export function coreDeps(env: Env = process.env): Deps {
  const unavailable = async () => { throw new Error('not available here'); };
  return {
    env, platform: process.platform, now: () => new Date().toISOString(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    readRecord: async () => ({ ...emptyRecord(), ...(await readJsonFileStrict<BrowserRecord>(DataPaths.browserUse, emptyRecord()).catch(() => emptyRecord())) }),
    writeRecord: (r) => writeJsonFile(DataPaths.browserUse, r),
    binary: async () => findBrowser(existsSync, browserCandidates(), playwrightChromiumPath(env)),
    isFree: portIsFree, spawnBrowser: realSpawn, startupLog: realStartupLog, isRunning: realIsRunning, killBrowser: realKill,
    cdpVersion: realCdpVersion, shoot: unavailable as unknown as Deps['shoot'], openUrl: realOpenUrl,
    externalAddresses: realExternalAddresses, canConnect: realCanConnect, servedPorts: async () => [],
    mcp: { add: unavailable as unknown as Deps['mcp']['add'], remove: unavailable as unknown as Deps['mcp']['remove'] },
    removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
    profileRoot: path.dirname(DataPaths.browserUse),
  };
}

/** Start the browser again after the app restarts, while the wizard's browser is switched on. */
export async function ensureBrowserAtStartup(d?: Deps): Promise<void> {
  const deps = d ?? coreDeps();
  const rec = await deps.readRecord();
  if (rec.enabled) await startBrowser(deps);
}
