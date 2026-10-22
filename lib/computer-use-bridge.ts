/**
 * computer-use-bridge.ts — DevFlow Computer Use Bridge Utilities
 *
 * Handles WSL→Windows HTTP communication for the computer-use bridge service.
 * Bridge runs natively on Windows (scripts/computer_use_bridge.py) on port 2150.
 *
 * Key responsibilities:
 * - Resolve the Windows host IP from WSL
 * - Start/stop the bridge process via PowerShell
 * - Health check the bridge before actions
 * - Schedule idle shutdown when sessions close
 */

import { exec, execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import { defaultHost, hostCall } from './host-executor';
import { getDevflowHome, getWindowsHome } from '@/lib/home-dir';
import { PRODUCT_NAME } from '@/lib/brand';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Detect WSL2 — loopback forwarding is broken in WSL2 mirrored mode (KB5074109).
// When running in WSL, we use cmd.exe → curl.exe to reach Windows-side bridge services.
const IS_WSL: boolean = (() => {
  if (process.platform === 'win32') return false;
  try {
    const v = require('fs').readFileSync('/proc/version', 'utf-8') as string;
    return v.toLowerCase().includes('microsoft');
  } catch { return false; }
})();

/**
 * Convert a WSL path (/mnt/c/...) to a Windows path (C:\...).
 * Required when passing paths to PowerShell or cmd.exe from within WSL.
 */
function wslPathToWindows(p: string): string {
  const m = p.match(/^\/mnt\/([a-z])\/(.*)/);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
  return p;
}

function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch { return true; }
}

/**
 * agent-hostd id of the PC that owns the Windows desktop, when DevFlow runs elsewhere.
 * On the server DEVFLOW_AGENT_HOST names the PC; there is no Windows Python or powershell.exe
 * here, so the PC's hostd starts the bridge and devflow-desktop-tunnel carries port 2150 back
 * to this machine's loopback. Null when DevFlow runs in WSL on the PC itself (local start).
 */
export function bridgeAgentHost(): string | null {
  return IS_WSL ? null : defaultHost();
}

/**
 * Raw fetch implementation: routes through cmd.exe → curl.exe when running in WSL,
 * native fetch otherwise. NO auto-recovery — used by:
 *   1. The recovery wrapper itself (`bridgeFetch`) to perform the actual HTTP call.
 *   2. `checkBridgeHealth` and `shutdownBridge` — internal probes that must NOT
 *      cascade into a recovery attempt (would create infinite recursion).
 *
 * External callers should always use `bridgeFetch` (the recovery-aware wrapper
 * exported below this function), not `bridgeFetchRaw` directly.
 *
 * WSL2 mirrored mode (networkingMode=mirrored + KB5074109) breaks loopback forwarding,
 * so WSL's Node.js fetch cannot reach Windows localhost. cmd.exe runs in Windows network
 * context and CAN reach Windows localhost:2150. We use it as a transparent HTTP relay.
 */
export async function bridgeFetchRaw(
  url: string,
  options: { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<unknown>; text(): Promise<string> }> {
  // The cmd.exe relay only exists to reach THIS PC's Windows loopback. An explicit remote
  // bridge host (COMPUTER_USE_BRIDGE_HOST=<other machine>) is reached with a normal fetch.
  if (!IS_WSL || !isLoopbackUrl(url)) {
    const signal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const res = await fetch(url, {
      method: options.method,
      body: options.body,
      headers: options.headers as HeadersInit,
      signal,
    } as RequestInit);
    return { ok: res.ok, status: res.status, statusText: res.statusText, json: () => res.json(), text: () => res.text() };
  }

  // WSL: run curl.exe via cmd.exe (Windows network context reaches localhost:2150)
  const method = (options.method ?? 'GET').toUpperCase();
  const timeoutMs = options.timeoutMs ?? 10000;

  // Build curl.exe args array (will be shell-joined via cmd /c).
  // Body is written to a response temp file (-o) instead of stdout, so stdout only carries
  // the HTTP status line. This keeps the execAsync stdout buffer tiny regardless of payload
  // size and avoids ERR_CHILD_PROCESS_STDIO_MAXBUFFER on large screenshots (high-DPI multi-
  // monitor PNG+base64 routinely exceeds the previous 50MB cap).
  const curlParts: string[] = [
    'curl.exe', '-s', '-w', '%{http_code}',
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '--max-filesize', String(BRIDGE_MAX_RESPONSE_BYTES), // server-side size cap; curl aborts >200MB
    '-X', method,
  ];

  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      curlParts.push('-H', `${k}: ${v}`);
    }
  }

  // Use C:\Temp (Windows-native) for body temp files — avoids UNC path issues.
  // curl.exe can read C:\Temp\file.json directly; \\wsl.localhost\Ubuntu\tmp\... causes failures
  // because shell quoting of UNC paths through bash→cmd.exe is fragile.
  const WIN_TEMP_DIR_WSL = '/mnt/c/Temp';
  const WIN_TEMP_DIR_WIN = 'C:\\Temp';
  await fs.mkdir(WIN_TEMP_DIR_WSL, { recursive: true });

  let reqTmpFile: string | null = null;
  let respTmpFile: string | null = null;
  try {
    if (options.body) {
      const filename = `bridge-req-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
      reqTmpFile = `${WIN_TEMP_DIR_WSL}/${filename}`;
      await fs.writeFile(reqTmpFile, options.body, 'utf-8');
      const winTmp = `${WIN_TEMP_DIR_WIN}\\${filename}`;
      curlParts.push('-d', `@${winTmp}`);
    }

    const respFilename = `bridge-resp-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
    respTmpFile = `${WIN_TEMP_DIR_WSL}/${respFilename}`;
    const winRespTmp = `${WIN_TEMP_DIR_WIN}\\${respFilename}`;
    curlParts.push('-o', winRespTmp);

    curlParts.push(url);

    // Quote args that contain spaces or backslashes for cmd.exe
    const quotedArgs = curlParts.map(a => (a.includes(' ') || a.includes('\\') || a.includes('"')) ? `"${a.replace(/"/g, '\\"')}"` : a);
    // Set cwd to a real Windows drive path (/mnt/c/Windows) so cmd.exe doesn't start with a
    // UNC CWD (\\wsl.localhost\Ubuntu\...). UNC CWDs cause cmd.exe to refuse reading @file paths.
    // stdout now only contains the 3-digit HTTP status code — 1MB execAsync default is ample.
    const { stdout } = await execAsync(
      `cmd.exe /c ${quotedArgs.join(' ')}`,
      { timeout: timeoutMs + 3000, cwd: '/mnt/c/Windows' },
    );

    const status = parseInt((stdout ?? '').trim()) || 0;

    // Server-side size validation: belt-and-braces. curl --max-filesize already aborts mid-download
    // if the response exceeds the cap, but checking again here covers the edge case where the
    // server doesn't send Content-Length (curl can't enforce --max-filesize without it).
    const body = await loadBridgeResponseBody(respTmpFile, BRIDGE_MAX_RESPONSE_BYTES);

    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
      json: async () => {
        try { return JSON.parse(body); }
        catch {
          const { ComputerUseError } = await import('./computer-use');
          throw new ComputerUseError(
            `Invalid JSON response from bridge: ${body.slice(0, 200)}`,
            'COMPUTER_USE_BRIDGE_BAD_RESPONSE',
            502,
            { bridgeUrl: getBridgeUrl(), bridgeDetail: body.slice(0, 500) },
          );
        }
      },
      text: async () => body,
    };
  } finally {
    if (reqTmpFile) await unlinkWithRetry(reqTmpFile);
    if (respTmpFile) await unlinkWithRetry(respTmpFile);
  }
}

// ─── Auto-Recovery (d7890b68) ────────────────────────────────────────────────
// State machine + one-shot restart-and-retry on transient bridge failures.
// Design: `.DevData/docs/ComputerUse/bridge-recovery-design.md`.

export type BridgeRecoveryState = 'HEALTHY' | 'DEGRADED' | 'DOWN';

export interface BridgeRecoveryStats {
  state: BridgeRecoveryState;
  totalRecoveryAttempts: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  lastRecoveryAt: string | null;
  lastFailureReason: string | null;
  cooldownExpiresAt: string | null;
}

interface BridgeRecoveryOutcome {
  recovered: boolean;
  restarted: boolean;
  portCollision: boolean;
  error?: Error;
}

const COOLDOWN_MS = Number(process.env.COMPUTER_USE_RECOVERY_COOLDOWN_MS) || 60_000;
const RECOVERY_TIMEOUT_MS = Number(process.env.COMPUTER_USE_RECOVERY_TIMEOUT_MS) || 30_000;

let _bridgeState: BridgeRecoveryState = 'HEALTHY';
let _recoveryPromise: Promise<BridgeRecoveryOutcome> | null = null;
let _cooldownExpiresAt = 0;
let _cooldownProbeTimer: ReturnType<typeof setTimeout> | null = null;
let _totalRecoveryAttempts = 0;
let _successfulRecoveries = 0;
let _failedRecoveries = 0;
let _lastRecoveryAt: string | null = null;
let _lastFailureReason: string | null = null;

// Dependency injection seam — lets unit tests replace the underlying fetch /
// health / start functions without mocking the entire module. Same-module
// identifier calls can't be spied via vi.spyOn (ESM exports are bindings,
// not properties), so the recovery code reads through these slots when set.
interface BridgeRecoveryDeps {
  fetch?: typeof bridgeFetchRaw;
  checkHealth?: typeof checkBridgeHealth;
  start?: typeof startBridge;
}
let _injectedDeps: BridgeRecoveryDeps = {};

export function _setBridgeRecoveryDeps(deps: BridgeRecoveryDeps): void {
  _injectedDeps = deps;
}

/**
 * Classify whether a fetch failure looks like "bridge process is gone" (recoverable
 * via a one-shot restart) vs a domain failure that a restart wouldn't fix.
 *
 * Per design §5: only network-shape failures and bridge-side 5xx infrastructure
 * errors are recoverable. ComputerUseError instances with auth/config/validation
 * codes are NOT — restart fixes nothing for those.
 */
export function isRecoverableFailure(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string }).code ?? '';
  if (
    code === 'COMPUTER_USE_TOKEN_MISSING' ||
    code === 'COMPUTER_USE_DISABLED' ||
    code === 'COMPUTER_USE_BRIDGE_PYTHON_MISSING' ||
    code === 'COMPUTER_USE_BRIDGE_SCRIPT_MISSING' ||
    code === 'COMPUTER_USE_SESSION_NOT_FOUND' ||
    code === 'COMPUTER_USE_SESSION_CLOSED' ||
    code.startsWith('COMPUTER_USE_VALIDATION_')
  ) {
    return false;
  }
  const msg = ((err as Error)?.message ?? '').toLowerCase();
  return (
    msg.includes('econnrefused') ||
    msg.includes('fetch failed') ||
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    msg.includes('reset by peer') ||
    msg.includes('network error') ||
    msg.includes('bridge unreachable') ||
    msg.includes('bridge request timed out')
  );
}

function _emitRecoveryEvent(transition: string, extra?: Record<string, unknown>): void {
  // Lazy require to avoid import-time cycles with consumers of bridge module.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { eventBus } = require('./event-bus') as typeof import('./event-bus');
    eventBus.emitEvent('computer-use:bridge-recovery', {
      transition,
      state: _bridgeState,
      ...(extra ?? {}),
    });
  } catch {
    /* event-bus optional during early bootstrap / tests */
  }
}

function _scheduleCooldownProbe(): void {
  if (_cooldownProbeTimer !== null) return;
  _cooldownProbeTimer = setTimeout(async () => {
    _cooldownProbeTimer = null;
    invalidateBridgeHealthCache();
    const health = await checkBridgeHealth();
    if (health.ok) {
      const prev = _bridgeState;
      _bridgeState = 'HEALTHY';
      _cooldownExpiresAt = 0;
      console.log(`[bridge-recovery] ${prev} → HEALTHY (cooldown probe)`);
      _emitRecoveryEvent(`${prev}->HEALTHY`, { reason: 'cooldown-probe' });
    } else {
      // Still down — restart the cooldown timer for another COOLDOWN_MS window.
      _cooldownExpiresAt = Date.now() + COOLDOWN_MS;
      _scheduleCooldownProbe();
    }
  }, COOLDOWN_MS);
  // Don't keep the Node event loop alive for this timer alone (matches existing pattern).
  if (typeof (_cooldownProbeTimer as unknown as { unref?: () => void }).unref === 'function') {
    (_cooldownProbeTimer as unknown as { unref: () => void }).unref();
  }
}

async function _attemptRecovery(reason: string): Promise<BridgeRecoveryOutcome> {
  if (_recoveryPromise) return _recoveryPromise;

  _totalRecoveryAttempts++;
  _lastFailureReason = reason;

  const checkHealth = _injectedDeps.checkHealth ?? checkBridgeHealth;
  const start = _injectedDeps.start ?? startBridge;

  const work = (async (): Promise<BridgeRecoveryOutcome> => {
    invalidateBridgeHealthCache();
    const health = await checkHealth();
    if (health.ok) {
      // Transient — bridge came back on its own between fetch failure and now.
      return { recovered: true, restarted: false, portCollision: false };
    }
    try {
      const startResult = await start();
      // Re-probe to confirm the bridge actually responds (not just that the
      // PowerShell launch returned). startBridge() does its own waitForBridge
      // poll, so checkBridgeHealth() should now succeed — if it doesn't AND
      // startBridge reported "alreadyRunning", port 2150 is held by something
      // that isn't our bridge.
      invalidateBridgeHealthCache();
      const reprobe = await checkHealth();
      if (reprobe.ok) {
        return { recovered: true, restarted: !startResult.alreadyRunning, portCollision: false };
      }
      return {
        recovered: false,
        restarted: false,
        portCollision: startResult.alreadyRunning,
      };
    } catch (err) {
      return { recovered: false, restarted: false, portCollision: false, error: err as Error };
    }
  })();

  // Wrap the recovery work in a hard timeout — defence against startBridge()
  // hanging for any reason. Belt + braces: startBridge already has its own 30s
  // bridge-readiness wait, but if pwsh.exe itself blocks we'd otherwise hang
  // every concurrent caller forever.
  const timeout = new Promise<BridgeRecoveryOutcome>((resolve) => {
    setTimeout(() => resolve({ recovered: false, restarted: false, portCollision: false, error: new Error('recovery timeout') }), RECOVERY_TIMEOUT_MS);
  });

  _recoveryPromise = Promise.race([work, timeout]).finally(() => {
    _recoveryPromise = null;
  });
  return _recoveryPromise;
}

/**
 * Recovery-aware wrapper around `bridgeFetchRaw`. External call sites should use
 * this — it auto-restarts the bridge on a transient fetch failure and retries
 * the original request once. Persistent failure surfaces the original error.
 */
export async function bridgeFetch(
  url: string,
  options: Parameters<typeof bridgeFetchRaw>[1] = {},
): ReturnType<typeof bridgeFetchRaw> {
  // Fast-fail during cooldown — a known-DOWN bridge doesn't earn another
  // restart attempt until the cooldown elapses.
  if (_bridgeState === 'DOWN' && Date.now() < _cooldownExpiresAt) {
    const { ComputerUseError } = await import('./computer-use');
    throw new ComputerUseError(
      'Bridge unavailable (cooldown active)',
      'COMPUTER_USE_BRIDGE_UNAVAILABLE',
      503,
      { bridgeUrl: getBridgeUrl(), cooldownExpiresAt: new Date(_cooldownExpiresAt).toISOString() },
    );
  }

  const fetcher = _injectedDeps.fetch ?? bridgeFetchRaw;
  try {
    return await fetcher(url, options);
  } catch (err) {
    if (!isRecoverableFailure(err)) throw err;

    const prevState = _bridgeState;
    _bridgeState = 'DEGRADED';
    const reason = (err as Error).message ?? 'unknown';
    console.log(`[bridge-recovery] ${prevState} → DEGRADED reason="${reason}"`);
    _emitRecoveryEvent(`${prevState}->DEGRADED`, { reason });

    const outcome = await _attemptRecovery(reason);

    if (!outcome.recovered) {
      _failedRecoveries++;
      _lastRecoveryAt = new Date().toISOString();
      _bridgeState = 'DOWN';
      _cooldownExpiresAt = Date.now() + COOLDOWN_MS;
      _scheduleCooldownProbe();
      console.log(`[bridge-recovery] DEGRADED → DOWN cooldownMs=${COOLDOWN_MS} portCollision=${outcome.portCollision}`);
      _emitRecoveryEvent('DEGRADED->DOWN', { cooldownMs: COOLDOWN_MS, portCollision: outcome.portCollision });

      if (outcome.portCollision) {
        const { ComputerUseError } = await import('./computer-use');
        throw new ComputerUseError(
          `Port ${BRIDGE_PORT} is held by another process. Run 'netstat -ano | findstr :${BRIDGE_PORT}' on Windows to identify the holder.`,
          'COMPUTER_USE_BRIDGE_PORT_HELD',
          503,
          { bridgeUrl: getBridgeUrl(), port: BRIDGE_PORT, hint: `netstat -ano | findstr :${BRIDGE_PORT}` },
        );
      }
      throw err; // surface the original error per design §4
    }

    _successfulRecoveries++;
    _lastRecoveryAt = new Date().toISOString();
    _bridgeState = 'HEALTHY';
    console.log(`[bridge-recovery] recovery success: restart=${outcome.restarted}`);
    _emitRecoveryEvent('DEGRADED->HEALTHY', { restarted: outcome.restarted });

    // ONE retry — no recursion. If the retry fails again, surface that fresh error.
    return await fetcher(url, options);
  }
}

export function getBridgeRecoveryStats(): BridgeRecoveryStats {
  return {
    state: _bridgeState,
    totalRecoveryAttempts: _totalRecoveryAttempts,
    successfulRecoveries: _successfulRecoveries,
    failedRecoveries: _failedRecoveries,
    lastRecoveryAt: _lastRecoveryAt,
    lastFailureReason: _lastFailureReason,
    cooldownExpiresAt: _cooldownExpiresAt > 0 ? new Date(_cooldownExpiresAt).toISOString() : null,
  };
}

export function _resetBridgeRecoveryState(): void {
  _bridgeState = 'HEALTHY';
  _recoveryPromise = null;
  _cooldownExpiresAt = 0;
  if (_cooldownProbeTimer !== null) {
    clearTimeout(_cooldownProbeTimer);
    _cooldownProbeTimer = null;
  }
  _totalRecoveryAttempts = 0;
  _successfulRecoveries = 0;
  _failedRecoveries = 0;
  _lastRecoveryAt = null;
  _lastFailureReason = null;
  _injectedDeps = {};
}

// 200MB cap for bridge responses. Sized to absorb a 4K@144-DPI multi-monitor screenshot
// after Daniel's pyautogui DPI-awareness fix lands (PER_MONITOR_AWARE_V2 increases pixel
// counts ~2.25× on hi-DPI). Enforced both client-side (curl --max-filesize) and server-side
// (fs.stat after download). Tuneable via env if a future workflow needs more.
const BRIDGE_MAX_RESPONSE_BYTES =
  Number(process.env.COMPUTER_USE_BRIDGE_MAX_RESPONSE_BYTES) || 200 * 1024 * 1024;

async function loadBridgeResponseBody(path: string, maxBytes: number): Promise<string> {
  try {
    const stat = await fs.stat(path);
    if (stat.size > maxBytes) {
      const { ComputerUseError } = await import('./computer-use');
      throw new ComputerUseError(
        `Bridge response exceeds ${maxBytes} byte cap ` +
        `(${stat.size} bytes) — refusing to load into memory`,
        'COMPUTER_USE_BRIDGE_BAD_RESPONSE',
        502,
        { bridgeUrl: getBridgeUrl(), bridgeDetail: `response_size=${stat.size};cap=${maxBytes}` },
      );
    }
    if (stat.size === 0) return '';
    return await fs.readFile(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT means curl never wrote the file (network error mid-download / aborted).
    // Surface as an empty body — the status code (which we still got) drives caller behaviour.
    if (code === 'ENOENT') return '';
    throw err;
  }
}

export function _loadBridgeResponseBody(path: string, maxBytes: number): Promise<string> {
  return loadBridgeResponseBody(path, maxBytes);
}

// Track persistent temp-file cleanup failures so degraded state can be surfaced.
let _unlinkFailureCount = 0;
let _lastUnlinkFailureAt: string | null = null;

export async function _unlinkWithRetry(path: string): Promise<void> {
  return unlinkWithRetry(path);
}

async function unlinkWithRetry(path: string): Promise<void> {
  try {
    await fs.unlink(path);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return; // already gone — idempotent success
    const reason = code ?? (err as Error).message;
    console.warn(`[computer-use-bridge] temp file unlink failed (${reason}); retrying once: ${path}`);
  }

  await new Promise((r) => setTimeout(r, 50));

  try {
    await fs.unlink(path);
  } catch (err2) {
    const code2 = (err2 as NodeJS.ErrnoException).code;
    if (code2 === 'ENOENT') return; // raced with another cleanup
    _unlinkFailureCount++;
    _lastUnlinkFailureAt = new Date().toISOString();
    const reason2 = code2 ?? (err2 as Error).message;
    console.error(
      `[computer-use-bridge] temp file unlink failed after retry (${reason2}); ` +
      `cumulativeFailures=${_unlinkFailureCount}: ${path}`
    );
  }
}

/**
 * Returns the cumulative count of temp-file cleanup failures and the timestamp of the most
 * recent one. Callers can treat a steadily-increasing count as a "bridge degraded" signal —
 * the bridge keeps working but C:\Temp is filling with stale request bodies.
 */
export function getBridgeUnlinkFailures(): { count: number; lastAt: string | null } {
  return { count: _unlinkFailureCount, lastAt: _lastUnlinkFailureAt };
}

export function _resetBridgeUnlinkFailures(): void {
  _unlinkFailureCount = 0;
  _lastUnlinkFailureAt = null;
}

export const BRIDGE_PORT = 2150;
const BRIDGE_HEALTH_TIMEOUT_MS = 2000;
const BRIDGE_START_TIMEOUT_MS = 45000; // max wait for bridge to be ready (pywinauto first-import is slow)
const BRIDGE_START_POLL_INTERVAL_MS = 500;
const BRIDGE_IDLE_SHUTDOWN_DELAY_MS = 5 * 60 * 1000; // 5 minutes

// WSL path to the bridge script (accessible from Windows via network share)
const BRIDGE_SCRIPT_WSL_PATH = `${getDevflowHome()}/scripts/computer_use_bridge.py`;

/**
 * Resolve the Windows UNC path to the bridge script at runtime.
 * Uses `wslpath -w` so it adapts to any distro name / DEVFLOW_HOME.
 */
async function getBridgeScriptWindowsPath(): Promise<string> {
  try {
    const { stdout } = await execAsync(`wslpath -w "${BRIDGE_SCRIPT_WSL_PATH}"`);
    return stdout.trim();
  } catch {
    // Fallback: derive from WSL distro name
    const distro = await getWslDistroName();
    const home = getDevflowHome();
    return `\\\\wsl.localhost\\${distro}${home.replace(/\//g, '\\')}\\scripts\\computer_use_bridge.py`;
  }
}

async function getWslDistroName(): Promise<string> {
  try {
    const { stdout } = await execAsync('echo $WSL_DISTRO_NAME');
    const name = stdout.trim();
    if (name) return name;
  } catch { /* fall through */ }
  return 'Ubuntu';
}

// Pending shutdown timer (cancelled if a new session starts before it fires)
let shutdownTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Host Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the Windows host IP from WSL2.
 *
 * Priority:
 * 1. COMPUTER_USE_BRIDGE_HOST env var (manual override)
 * 2. Default gateway from /proc/net/route (most reliable — works with WSL2 DNS proxy)
 * 3. nameserver from /etc/resolv.conf (WSL2 gateway in older configs, typically 172.x.x.x)
 * 4. 'localhost' fallback (works on Windows 11 with WSL port mirroring)
 *
 * Note: In newer WSL2 configurations the nameserver in /etc/resolv.conf is 10.255.255.254
 * (WSL's internal DNS proxy), NOT the Windows host. The actual Windows host is the default
 * route gateway in /proc/net/route.
 */
export function getWindowsHostIp(): string {
  const override = process.env.COMPUTER_USE_BRIDGE_HOST;
  if (override) return override;

  // Try default gateway from routing table — most reliable across all WSL2 modes
  try {
    const route = require('fs').readFileSync('/proc/net/route', 'utf-8') as string;
    for (const line of route.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      // Default route: destination = 00000000, mask = 00000000
      if (parts.length >= 8 && parts[1] === '00000000' && parts[7] === '00000000') {
        const hex = parts[2].padStart(8, '0');
        // Gateway is stored as little-endian hex — reverse bytes for IP presentation
        const ip = [
          parseInt(hex.slice(6, 8), 16),
          parseInt(hex.slice(4, 6), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(0, 2), 16),
        ].join('.');
        if (ip !== '0.0.0.0') return ip;
      }
    }
  } catch {
    // Ignore — fall through to resolv.conf
  }

  try {
    // Sync read is fine here — this is called infrequently and resolv.conf is tiny
    const resolv = require('fs').readFileSync('/etc/resolv.conf', 'utf-8') as string;
    const match = resolv.match(/^nameserver\s+(.+)$/m);
    if (match) {
      const ip = match[1].trim();
      // Skip 10.255.255.254 — that's WSL2's internal DNS proxy, not the Windows host
      if (ip !== '10.255.255.254') return ip;
    }
  } catch {
    // Ignore — fall through to localhost
  }

  return 'localhost'; // Windows 11 WSL port mirroring fallback
}

/**
 * Get the full bridge base URL.
 */
export function getBridgeUrl(): string {
  // Port 2150 is below the WSL2 ignoredPorts range (3000-9999), so it is accessible
  // via localhost in mirrored mode. Using getWindowsHostIp() here returns the LAN IP
  // (e.g. 192.168.1.1) which is NOT reachable from WSL in the current network config.
  const override = process.env.COMPUTER_USE_BRIDGE_HOST;
  const host = override ?? 'localhost';
  return `http://${host}:${BRIDGE_PORT}`;
}

// ─── Health Check ─────────────────────────────────────────────────────────────

export interface BridgeHealthResult {
  ok: boolean;
  url: string;
  screen?: { width: number; height: number };
  monitorCount?: number;
  monitors?: Array<{ index: number; width: number; height: number; left: number; top: number; orientation: 'landscape' | 'portrait' }>;
  dpiScale?: number;
  dpiWarning?: boolean;
  writablePaths?: Record<string, string>;
  checkedAt: string;
}

// 30-second health check cache — avoids redundant round-trips on every session.start.
let _healthCache: { result: BridgeHealthResult; expiresAt: number } | null = null;
const HEALTH_CACHE_TTL_MS = 30_000;

export function invalidateBridgeHealthCache(): void {
  _healthCache = null;
}

/**
 * Check if the bridge is reachable and responsive.
 * Uses a short 2s timeout — caller should not wait longer.
 * Results are cached for 30s to avoid redundant round-trips.
 */
export async function checkBridgeHealth(): Promise<BridgeHealthResult> {
  if (_healthCache && Date.now() < _healthCache.expiresAt) {
    return _healthCache.result;
  }

  const url = getBridgeUrl();
  const checkedAt = new Date().toISOString();

  try {
    const res = await bridgeFetchRaw(`${url}/health`, { timeoutMs: BRIDGE_HEALTH_TIMEOUT_MS });

    if (!res.ok) return { ok: false, url, checkedAt };

    const data = await res.json() as {
      status?: string;
      screen?: { width: number; height: number };
      monitorCount?: number;
      monitors?: Array<{ index: number; width: number; height: number; left: number; top: number; orientation: string }>;
      dpiScale?: number;
      dpiWarning?: boolean;
      writablePaths?: Record<string, string>;
    };

    const result: BridgeHealthResult = {
      ok: data.status === 'ok',
      url,
      screen: data.screen,
      monitorCount: data.monitorCount,
      monitors: data.monitors as BridgeHealthResult['monitors'],
      dpiScale: data.dpiScale,
      dpiWarning: data.dpiWarning,
      writablePaths: data.writablePaths,
      checkedAt,
    };
    if (result.ok) {
      _healthCache = { result, expiresAt: Date.now() + HEALTH_CACHE_TTL_MS };
    } else {
      _healthCache = null; // don't cache negative results
    }
    return result;
  } catch {
    _healthCache = null;
    return { ok: false, url, checkedAt };
  }
}

// ─── Bridge Startup ───────────────────────────────────────────────────────────

export interface BridgeStartResult {
  url: string;
  alreadyRunning: boolean;
}

/**
 * Convert a WSL path (/mnt/c/...) to a Windows-native path (C:\...) for use in PowerShell.
 */
async function toWindowsPath(wslPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`wslpath -w "${wslPath}"`);
    return stdout.trim();
  } catch { /* fall through */ }

  const match = wslPath.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
  if (match) {
    const drive = match[1].toUpperCase();
    const rest = (match[2] || '').replace(/\//g, '\\');
    return `${drive}:${rest}`;
  }

  return wslPath;
}

/**
 * Find python.exe on Windows from WSL.
 * Prefers pythonw.exe (headless — no console window needed).
 * Returns the Windows-native path (C:\...) for use in PowerShell commands.
 */
async function findWindowsPython(): Promise<string> {
  const candidates = [
    // Python 3.12 explicitly — bridge deps (pywinauto, mss, pyautogui) are installed there.
    // Python 3.13 (currently first in PATH) lacks these deps.
    // Use python.exe (not pythonw.exe) — uvicorn needs stdout/stderr; pythonw sets them to None.
    `${getWindowsHome()}/AppData/Local/Programs/Python/Python312/python.exe`,
    '/mnt/c/Python312/python.exe',
    '/mnt/c/Windows/py.exe',
    '/mnt/c/Python311/python.exe',
    '/mnt/c/Python310/python.exe',
  ];

  for (const wslPath of candidates) {
    try {
      await execAsync(`test -f "${wslPath}"`);
      return await toWindowsPath(wslPath);
    } catch {
      continue;
    }
  }

  const { ComputerUseError } = await import('./computer-use');
  throw new ComputerUseError(
    'Windows Python not found. Install Python from python.org and ensure python.exe is in PATH.',
    'COMPUTER_USE_BRIDGE_PYTHON_MISSING',
    501,
  );
}

/**
 * Wait for the bridge to become healthy (polls until ready or timeout).
 */
async function waitForBridge(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const health = await checkBridgeHealth();
    if (health.ok) return;
    await new Promise((resolve) => setTimeout(resolve, BRIDGE_START_POLL_INTERVAL_MS));
  }

  const { ComputerUseError } = await import('./computer-use');
  throw new ComputerUseError(
    `Bridge did not become ready within ${timeoutMs / 1000}s. ` +
    `Check that python.exe and dependencies are installed on Windows.`,
    'COMPUTER_USE_BRIDGE_STARTUP_TIMEOUT',
    503,
    { bridgeUrl: getBridgeUrl(), durationMs: timeoutMs },
  );
}

/**
 * Start the bridge on Windows via PowerShell.
 * Returns immediately if the bridge is already running.
 */
export async function startBridge(): Promise<BridgeStartResult> {
  // Cancel any pending shutdown — a new session is starting
  if (shutdownTimer !== null) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }

  const url = getBridgeUrl();

  // Already running? Nothing to do.
  const health = await checkBridgeHealth();
  if (health.ok) {
    return { url, alreadyRunning: true };
  }

  const agentHost = bridgeAgentHost();
  if (agentHost) return startBridgeOnAgentHost(agentHost, url);

  // Find Windows Python
  let pythonPath: string;
  try {
    pythonPath = await findWindowsPython();
  } catch (err) {
    // Inner error is a ComputerUseError (BRIDGE_PYTHON_MISSING) — rethrow as-is
    // so the typed code propagates instead of getting flattened to a string wrap.
    const { ComputerUseError } = await import('./computer-use');
    if (err instanceof ComputerUseError) throw err;
    throw new ComputerUseError(
      `Cannot start bridge: ${(err as Error).message}`,
      'COMPUTER_USE_BRIDGE_SPAWN_FAILED',
      500,
      { bridgeUrl: getBridgeUrl() },
    );
  }

  // Verify script is accessible from WSL
  try {
    await fs.access(BRIDGE_SCRIPT_WSL_PATH);
  } catch {
    const { ComputerUseError } = await import('./computer-use');
    throw new ComputerUseError(
      `Bridge script not found at ${BRIDGE_SCRIPT_WSL_PATH}. ` +
      `Ensure ${PRODUCT_NAME} repo is accessible.`,
      'COMPUTER_USE_BRIDGE_SCRIPT_MISSING',
      500,
      { bridgeUrl: getBridgeUrl() },
    );
  }

  // Spawn bridge via PowerShell. Use cmd.exe wrapper so shell-level 2>> redirection works
  // without triggering PowerShell's -RedirectStandardError restriction (Access Denied from WSL).
  // Also ensure Windows Firewall allows inbound on the bridge port (WSL2 needs this to reach Windows).
  const errorLog = 'C:\\Temp\\devflow-bridge-error.log';
  // Convert WSL path (/mnt/c/...) to Windows path (C:\...) for cmd.exe compatibility
  const winPythonPath = wslPathToWindows(pythonPath);
  // Resolve the bridge script path dynamically (adapts to distro name + DEVFLOW_HOME)
  const bridgeScriptPath = await getBridgeScriptWindowsPath();
  // cmd /C args: run python, redirect both stdout+stderr to log, then exit
  // No quotes needed around paths — they contain no spaces. The previous ""path"" escaping
  // broke cmd.exe parsing (""X"" is interpreted as empty-string + X + empty-string, not "X").
  const cmdArgs = `${winPythonPath} ${bridgeScriptPath} --port ${BRIDGE_PORT} --host 0.0.0.0 >> ${errorLog} 2>&1`;
  const psCmd =
    `if (!(Test-Path C:\\Temp)) { New-Item -ItemType Directory -Path C:\\Temp | Out-Null }; ` +
    `$fw = Get-NetFirewallRule -DisplayName 'DevFlow Computer Use Bridge' -ErrorAction SilentlyContinue; ` +
    `if (-not $fw) { New-NetFirewallRule -DisplayName 'DevFlow Computer Use Bridge' -Direction Inbound -Protocol TCP -LocalPort ${BRIDGE_PORT} -Action Allow | Out-Null }; ` +
    `Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList "/C ${cmdArgs}"`;

  console.log('[computer-use-bridge] Starting bridge via PowerShell...');

  try {
    // Use -EncodedCommand (Base64 UTF-16LE) to avoid shell quote escaping issues
    // with inner double-quotes in -ArgumentList @("path", "--flag")
    const encoded = Buffer.from(psCmd, 'utf16le').toString('base64');
    await execAsync(`powershell.exe -EncodedCommand ${encoded}`);
  } catch (err) {
    const { ComputerUseError } = await import('./computer-use');
    throw new ComputerUseError(
      `Failed to start bridge via PowerShell: ${(err as Error).message}`,
      'COMPUTER_USE_BRIDGE_SPAWN_FAILED',
      500,
      { bridgeUrl: getBridgeUrl(), bridgeDetail: (err as Error).message },
    );
  }

  // Wait for bridge to become ready
  try {
    await waitForBridge(BRIDGE_START_TIMEOUT_MS);
  } catch (err) {
    // waitForBridge already throws BRIDGE_STARTUP_TIMEOUT — augment with the
    // tail of the bridge's own log (if accessible) so callers can diagnose
    // pip-missing / pywintypes failures without ssh'ing to the Windows host.
    const { ComputerUseError } = await import('./computer-use');
    let startupErr = '';
    try {
      const logContent = await fs.readFile('/mnt/c/Temp/devflow-bridge-error.log', 'utf-8');
      if (logContent.trim()) startupErr = logContent.trim().split('\n').slice(-5).join(' | ');
    } catch { /* log not accessible */ }
    throw new ComputerUseError(
      `Bridge did not become ready within ${BRIDGE_START_TIMEOUT_MS / 1000}s.` +
      (startupErr ? `\nBridge error: ${startupErr}` : ' Check that python.exe and dependencies are installed on Windows.') +
      '\nInstall deps: python.exe -m pip install fastapi uvicorn mss Pillow pyautogui',
      'COMPUTER_USE_BRIDGE_STARTUP_TIMEOUT',
      503,
      {
        bridgeUrl: getBridgeUrl(),
        durationMs: BRIDGE_START_TIMEOUT_MS,
        ...(startupErr ? { bridgeDetail: startupErr } : {}),
        ...(err instanceof ComputerUseError ? err.context ?? {} : {}),
      },
    );
  }

  invalidateBridgeHealthCache(); // force fresh check after startup
  console.log(`[computer-use-bridge] Bridge ready at ${url}`);
  return { url, alreadyRunning: false };
}

/**
 * Server path: ask the PC's agent-hostd to start the bridge (it returns at once), then wait for
 * /health through the tunnel. A timeout carries the tail of the bridge's own log from the PC.
 */
async function startBridgeOnAgentHost(agentHost: string, url: string): Promise<BridgeStartResult> {
  const { ComputerUseError } = await import('./computer-use');
  console.log(`[computer-use-bridge] Asking ${agentHost} to start the bridge...`);
  try {
    await hostCall(agentHost, 'cu-bridge-start', {}, 30_000);
  } catch (err) {
    const message = (err as Error).message;
    const pythonMissing = /Windows Python not found/.test(message);
    throw new ComputerUseError(
      `Cannot start the bridge on ${agentHost}: ${message}`,
      pythonMissing ? 'COMPUTER_USE_BRIDGE_PYTHON_MISSING' : 'COMPUTER_USE_BRIDGE_SPAWN_FAILED',
      pythonMissing ? 501 : 503,
      { bridgeUrl: url, bridgeDetail: message },
    );
  }

  try {
    await waitForBridge(BRIDGE_START_TIMEOUT_MS);
  } catch (err) {
    let startupErr = '';
    try {
      const { tail } = await hostCall<{ tail: string }>(agentHost, 'cu-bridge-log', {}, 10_000);
      startupErr = tail.trim().split('\n').slice(-5).join(' | ');
    } catch { /* log not reachable */ }
    throw new ComputerUseError(
      `Bridge on ${agentHost} did not answer at ${url} within ${BRIDGE_START_TIMEOUT_MS / 1000}s. ` +
      `Check the devflow-desktop-tunnel unit on that PC (it carries port ${BRIDGE_PORT}).` +
      (startupErr ? `\nBridge log: ${startupErr}` : ''),
      'COMPUTER_USE_BRIDGE_STARTUP_TIMEOUT',
      503,
      {
        bridgeUrl: url,
        durationMs: BRIDGE_START_TIMEOUT_MS,
        ...(startupErr ? { bridgeDetail: startupErr } : {}),
        ...(err instanceof ComputerUseError ? err.context ?? {} : {}),
      },
    );
  }

  invalidateBridgeHealthCache();
  console.log(`[computer-use-bridge] Bridge on ${agentHost} ready at ${url}`);
  return { url, alreadyRunning: false };
}

// ─── Bridge Shutdown ──────────────────────────────────────────────────────────

/**
 * Schedule the bridge to shut down after the idle timeout.
 * If startBridge() is called before the timer fires, it is cancelled.
 *
 * Call this after a session closes and activeSessions === 0.
 */
export function scheduleBridgeShutdown(): void {
  if (shutdownTimer !== null) return; // Already scheduled

  shutdownTimer = setTimeout(async () => {
    shutdownTimer = null;
    console.log('[computer-use-bridge] Idle timeout reached, shutting down bridge...');
    await shutdownBridge();
  }, BRIDGE_IDLE_SHUTDOWN_DELAY_MS);
}

/**
 * Immediately shut down the bridge via the /shutdown endpoint.
 * Swallows errors — if the bridge is already down, that's fine.
 */
export async function shutdownBridge(): Promise<void> {
  // A cached healthy result would make the next startBridge() skip the restart.
  invalidateBridgeHealthCache();
  try {
    await bridgeFetchRaw(`${getBridgeUrl()}/shutdown`, { method: 'POST', timeoutMs: 3000 });
  } catch {
    // Bridge already gone, or unreachable — that's acceptable
  }
}

/**
 * Cancel any pending idle shutdown (called when a new session starts).
 */
export function cancelBridgeShutdown(): void {
  if (shutdownTimer !== null) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}

