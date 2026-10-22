/**
 * WSL2 network bridge monitor
 * Checks WSL IP + self-ping every 30s.
 * Emits 'network:wsl-status' SSE event and writes a Windows-side status file
 * when bridge health changes, so open browser tabs can show a warning.
 */
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { eventBus } from '../event-bus';
import { getWindowsHome } from '@/lib/home-dir';
import { PRODUCT_NAME } from '@/lib/brand';
import { selfOrigin } from '@/lib/self-origin';

const execAsync = promisify(execCb);
const INTERVAL = 30_000;
const STATUS_FILE = `${getWindowsHome()}/devflow-bridge/network-status.txt`;
const STATUS_DIR = `${getWindowsHome()}/devflow-bridge`;

export async function startWslBridgeMonitor(): Promise<() => void> {
  let lastIp: string | null = null;
  let lastStatus: 'ok' | 'degraded' | 'unknown' = 'unknown';
  let consecutiveFailures = 0;

  const run = async () => {
    try {
      let wslIp: string | null = null;
      try {
        const { stdout } = await execAsync(
          "ip addr show eth0 | grep 'inet ' | awk '{print $2}' | cut -d/ -f1",
          { timeout: 5000 }
        );
        wslIp = stdout.trim() || null;
      } catch { wslIp = null; }

      // Retry loop: transient event-loop stalls can cause 4s timeouts
      let selfOk = false;
      let lastCode = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { stdout } = await execAsync(
            `curl -s -o /dev/null -w "%{http_code}" --max-time 10 ${selfOrigin()}/api/health 2>/dev/null; true`,
            { timeout: 12000 }
          );
          const code = stdout.trim().slice(0, 3);
          lastCode = code;
          // code "000" = curl couldn't connect at all (transient or down)
          // Accept 2xx/3xx/401/404 as healthy; 000 and 5xx are failures
          selfOk = /^[23]/.test(code) || code === '401' || code === '404';
          if (selfOk) break;
          if (attempt === 0) {
            // Brief pause before retry — often clears transient stalls
            await new Promise(r => setTimeout(r, 3000));
          }
        } catch (err) {
          lastCode = 'exception';
          selfOk = false;
        }
      }
      if (!selfOk) {
        console.warn(`[WSL2Monitor] Self-check failed after retries — code: "${lastCode}"`);
      }

      const ipChanged = lastIp !== null && wslIp !== null && wslIp !== lastIp;
      if (wslIp) lastIp = wslIp;

      consecutiveFailures = selfOk ? 0 : consecutiveFailures + 1;
      // Require 3+ consecutive failures (~90s of downtime) before surfacing
      const bridgeStatus: 'ok' | 'degraded' | 'unknown' = selfOk
        ? (ipChanged ? 'degraded' : 'ok')
        : consecutiveFailures >= 3 ? 'unknown' : lastStatus;

      if (bridgeStatus !== lastStatus) {
        lastStatus = bridgeStatus;
        const now = new Date().toISOString();
        const statusLine =
          bridgeStatus === 'ok'
            ? `[${now}] WSL2 bridge OK — IP: ${wslIp ?? 'unknown'}`
            : bridgeStatus === 'degraded'
            ? `[${now}] WARNING: WSL2 IP changed to ${wslIp} — Windows port forwarding may be stale. Run: netsh interface portproxy reset (Windows cmd as admin), then restart DevFlow.`
            : `[${now}] WARNING: ${PRODUCT_NAME} self-check failed — server may be unresponsive`;

        if (bridgeStatus !== 'ok') console.warn(`[WSL2Monitor] ${statusLine}`);

        try {
          await fs.mkdir(STATUS_DIR, { recursive: true });
          await fs.writeFile(STATUS_FILE, statusLine + '\n', 'utf-8');
        } catch { /* Windows FS may not be mounted */ }

        eventBus.emitEvent('network:wsl-status', {
          status: bridgeStatus,
          wslIp,
          ipChanged,
          selfOk,
          timestamp: now,
          message: bridgeStatus !== 'ok' ? statusLine : undefined,
        });
      }
    } catch (err) {
      console.warn(`[WSL2Monitor] checkWslBridge error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Run immediately on startup, then on interval
  await run();
  const timer = setInterval(run, INTERVAL);
  console.log('[DevFlow] WSL2 network bridge monitor started (30s interval)');
  return () => clearInterval(timer);
}
