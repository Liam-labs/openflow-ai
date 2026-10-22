/**
 * Memory of both machines for the Overview: the Remote server (read here) and the Desktop PC's WSL (read by its helper, agent-hostd,
 * because /proc and .wslconfig on the PC are not visible from the server). Each machine gives the same raw facts (a few /proc/meminfo lines, the
 * pressure-stall files, the memory lines of .wslconfig); one set of code turns them into the figures, so the two gauges can never disagree about
 * how "used" or "risk" is worked out. The thresholds are the ones /api/system/wsl-memory has always used.
 */
import { promises as fs } from 'node:fs';
import { defaultHost, hostCall, hostState } from './host-executor';

export interface PressureStats { avg10: number; avg60: number; avg300: number; totalStallUs: number }

export interface MemoryStats {
  totalMb: number;
  usedMb: number;
  availableMb: number;
  usagePercent: number;
  swapTotalMb: number;
  swapUsedMb: number;
  swapPercent: number;
  oomRisk: 'low' | 'moderate' | 'high' | 'critical';
  memTotalKb: number;
  memAvailableKb: number;
  memFreeKb: number;
  buffersKb: number;
  cachedKb: number;
  wslConfigMemoryMb: number | null;
  pressure: { memory: PressureStats | null; cpu: PressureStats | null; io: PressureStats | null };
  errors: string[];
}

/** What a machine reports: raw text, parsed here. `wslconfig` is null when it could not be read and "" when there is none. */
export interface MemoryRaw {
  meminfo: string;
  pressure: Partial<Record<'memory' | 'cpu' | 'io', string>>;
  wslconfig: string | null;
  errors?: string[];
}

export interface MachineMemory { id: 'desktop' | 'server'; label: string; reachable: boolean; reason?: string; memory?: MemoryStats }
export interface MachineMemoryReport { generatedAt: string; machines: MachineMemory[] }

const SERVER_LABEL = 'Remote server';
const DESKTOP_LABEL = 'Desktop PC (WSL)';

// ── turning raw text into figures ────────────────────────────────────────────

export function parseMeminfo(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(.+?):\s+(\d+)\s*kB$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

export function parsePressure(raw: string | undefined): PressureStats | null {
  if (!raw) return null;
  const someLine = raw.split('\n').find(l => l.startsWith('some '));
  if (!someLine) return null;
  const m = someLine.match(/^some\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)\s+total=(\d+)/);
  if (!m) return null;
  return { avg10: parseFloat(m[1]), avg60: parseFloat(m[2]), avg300: parseFloat(m[3]), totalStallUs: parseInt(m[4], 10) };
}

const UNIT_MB: Record<string, number> = { B: 1 / (1024 * 1024), KB: 1 / 1024, MB: 1, GB: 1024, TB: 1024 * 1024 };

/** The `memory=` limit in .wslconfig, in MB: "32GB", "8192MB", "7.5 gb". null when there is none. */
export function wslConfigMemoryMb(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/^\s*memory\s*=\s*([\d.]+)\s*(B|KB|MB|GB|TB)\s*(?:[#;].*)?$/im);
  if (!m) return null;
  const mb = Number(m[1]) * UNIT_MB[m[2].toUpperCase()];
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb) : null;
}

export function computeOomRisk(
  availableMb: number,
  totalMb: number,
  swapPercent: number,
  memPressure: PressureStats | null,
): 'low' | 'moderate' | 'high' | 'critical' {
  const availPct = totalMb > 0 ? (availableMb / totalMb) * 100 : 100;
  // Memory pressure: % of time tasks stalled waiting for memory in the last window.
  // PSI some > 10 means significant stall, so OOM is imminent even if meminfo looks ok.
  const memStall = memPressure?.avg10 ?? 0;

  if (availPct < 3 || swapPercent > 95 || memStall > 25) return 'critical';
  if (availPct < 8 || swapPercent > 80 || memStall > 10) return 'high';
  if (availPct < 15 || swapPercent > 60 || memStall > 2) return 'moderate';
  return 'low';
}

export function buildMemoryStats(raw: MemoryRaw): MemoryStats {
  const info = parseMeminfo(raw.meminfo);
  const memTotalKb = info['MemTotal'] ?? 0;
  const memAvailableKb = info['MemAvailable'] ?? 0;
  const memFreeKb = info['MemFree'] ?? 0;
  const buffersKb = info['Buffers'] ?? 0;
  const cachedKb = (info['Cached'] ?? 0) + (info['SReclaimable'] ?? 0);
  const swapTotalKb = info['SwapTotal'] ?? 0;
  const swapFreeKb = info['SwapFree'] ?? 0;

  const swapTotalMb = Math.round(swapTotalKb / 1024);
  const swapUsedMb = Math.round((swapTotalKb - swapFreeKb) / 1024);
  const swapPercent = swapTotalMb > 0 ? Math.round((swapUsedMb / swapTotalMb) * 100) : 0;

  const configMb = wslConfigMemoryMb(raw.wslconfig);
  const memory = parsePressure(raw.pressure.memory);
  // The limit WSL was given (when there is one) is the real ceiling; otherwise the kernel's own total.
  const totalMb = configMb ?? Math.round(memTotalKb / 1024);
  const availableMb = Math.round(memAvailableKb / 1024);
  const usedMb = Math.max(0, totalMb - availableMb);
  const usagePercent = totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0;

  return {
    totalMb, usedMb, availableMb, usagePercent, swapTotalMb, swapUsedMb, swapPercent,
    oomRisk: computeOomRisk(availableMb, totalMb, swapPercent, memory),
    memTotalKb, memAvailableKb, memFreeKb, buffersKb, cachedKb,
    wslConfigMemoryMb: configMb,
    pressure: { memory, cpu: parsePressure(raw.pressure.cpu), io: parsePressure(raw.pressure.io) },
    errors: [...(raw.errors ?? []), ...(raw.meminfo.trim() ? [] : ['no /proc/meminfo figures were read'])],
  };
}

// ── reading this machine ─────────────────────────────────────────────────────

const MEMINFO_KEYS = new Set(['MemTotal', 'MemFree', 'MemAvailable', 'Buffers', 'Cached', 'SReclaimable', 'SwapTotal', 'SwapFree']);

/** The system-wide pressure file first, then the cgroup one (the root cgroup has none on a plain Linux server). */
async function readPressure(name: 'memory' | 'cpu' | 'io'): Promise<string | undefined> {
  for (const file of [`/proc/pressure/${name}`, `/sys/fs/cgroup/${name}.pressure`]) {
    try { return (await fs.readFile(file, 'utf-8')).slice(0, 600); } catch { /* try the next */ }
  }
  return undefined;
}

/** Only when DevFlow itself runs inside the PC's WSL: the PC's .wslconfig is then visible under /mnt/c. */
async function readLocalWslConfig(): Promise<string | null> {
  const users = await fs.readdir('/mnt/c/Users').catch(() => [] as string[]);
  for (const user of users) {
    try {
      const text = await fs.readFile(`/mnt/c/Users/${user}/.wslconfig`, 'utf-8');
      return text.split('\n').filter(l => /^\s*(memory|swap|processors)\s*=/i.test(l)).join('\n');
    } catch { /* not this user */ }
  }
  return null;
}

export async function readLocalMemory(): Promise<MemoryRaw> {
  const errors: string[] = [];
  let meminfo = '';
  try {
    meminfo = (await fs.readFile('/proc/meminfo', 'utf-8')).split('\n').filter(l => MEMINFO_KEYS.has(l.split(':')[0])).join('\n');
  } catch (error) {
    errors.push(`/proc/meminfo read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const [memory, cpu, io, wslconfig] = await Promise.all([readPressure('memory'), readPressure('cpu'), readPressure('io'), readLocalWslConfig()]);
  return { meminfo, pressure: { memory, cpu, io }, wslconfig, errors };
}

// ── reading the desktop through its helper ───────────────────────────────────

type Call = <T>(host: string, op: string, args: Record<string, unknown>, waitMs?: number) => Promise<T>;

export async function collectDesktopMemory(
  host: string | null = defaultHost(),
  call: Call = hostCall,
  state: (host: string | null) => 'online' | 'offline' | 'local' = hostState,
): Promise<MemoryRaw> {
  if (!host) throw new Error('No desktop helper is set up on this server (DEVFLOW_AGENT_HOST is empty), so the PC cannot be checked.');
  if (state(host) === 'offline') throw new Error('The desktop helper is not connected right now, so the PC cannot be checked.');
  let raw: Partial<MemoryRaw> | null;
  try {
    raw = await call<Partial<MemoryRaw>>(host, 'memory-facts', {}, 15000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/did not answer/.test(message)) throw new Error('The desktop helper did not answer in time.');
    if (/unknown op|not allowed|unsupported/i.test(message)) throw new Error('The desktop helper is an older version that cannot report memory yet; restart devflow-hostd on the PC.');
    throw new Error(`The desktop helper could not read its memory: ${message}`.slice(0, 300));
  }
  if (!raw || typeof raw.meminfo !== 'string') throw new Error('The desktop helper sent an empty answer.');
  const pressure: MemoryRaw['pressure'] = {};
  for (const name of ['memory', 'cpu', 'io'] as const) {
    const text = raw.pressure?.[name];
    if (typeof text === 'string') pressure[name] = text;
  }
  return {
    meminfo: raw.meminfo,
    pressure,
    wslconfig: typeof raw.wslconfig === 'string' ? raw.wslconfig : null,
    errors: Array.isArray(raw.errors) ? raw.errors.filter((e): e is string => typeof e === 'string').slice(0, 5) : [],
  };
}

// ── the report ───────────────────────────────────────────────────────────────

export async function buildMachineMemory(
  readServer: () => Promise<MemoryRaw> = readLocalMemory,
  readDesktop: () => Promise<MemoryRaw> = collectDesktopMemory,
  now: () => Date = () => new Date(),
): Promise<MachineMemoryReport> {
  const one = async (id: MachineMemory['id'], label: string, read: () => Promise<MemoryRaw>): Promise<MachineMemory> => {
    try {
      return { id, label, reachable: true, memory: buildMemoryStats(await read()) };
    } catch (error) {
      return { id, label, reachable: false, reason: (error instanceof Error ? error.message : 'This machine could not be checked.').slice(0, 300) };
    }
  };
  const [server, desktop] = await Promise.all([one('server', SERVER_LABEL, readServer), one('desktop', DESKTOP_LABEL, readDesktop)]);
  return { generatedAt: now().toISOString(), machines: [server, desktop] };
}

interface Slot { at: number; report: MachineMemoryReport }
const globals = globalThis as unknown as { __devflowMachineMemory?: { slot?: Slot; inflight?: Promise<MachineMemoryReport> } };
const TTL_MS = 4000;

/** Cached for 4 s, and callers that arrive while a read is running share it, so a page that refreshes often never queues work on the desktop. */
export async function getMachineMemory(build: () => Promise<MachineMemoryReport> = buildMachineMemory): Promise<MachineMemoryReport> {
  const state = (globals.__devflowMachineMemory ??= {});
  if (state.inflight) return state.inflight;
  if (state.slot && Date.now() - state.slot.at < TTL_MS) return state.slot.report;
  const run = build()
    .then(report => { state.slot = { at: Date.now(), report }; return report; })
    .finally(() => { state.inflight = undefined; });
  state.inflight = run;
  return run;
}
