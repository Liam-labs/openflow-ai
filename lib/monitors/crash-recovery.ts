/**
 * Crash recovery + heartbeat writer
 * On startup: checks stale heartbeat to detect unclean shutdown and files a crash log event.
 * Then writes heartbeat every 30s and runs daily log rotation check every hour.
 */
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import { logEvent, checkRotationNeeded, rotateEventLogs } from '../log-writer';
import { appPath } from '@/lib/app-paths';

const execAsync = promisify(execCb);
const HEARTBEAT_PATH = appPath('logs', 'event-logs', '.heartbeat');
const HEARTBEAT_INTERVAL = 30_000;
const ROTATION_INTERVAL = 60 * 60 * 1000; // 1 hour
const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

export async function startCrashRecovery(): Promise<() => void> {
  // Check for stale heartbeat (unclean shutdown)
  try {
    const stat = await fs.stat(HEARTBEAT_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > STALE_THRESHOLD_MS) {
      console.warn(`[DevFlow] Crash recovery: stale heartbeat detected (${Math.round(ageMs / 1000)}s old)`);

      const forensic: Record<string, string> = {};

      try {
        const { stdout } = await execAsync('pm2 jlist', { timeout: 10000 });
        const procs = JSON.parse(stdout) as Array<{
          name: string;
          pm2_env?: { status: string; restart_time: number };
        }>;
        forensic.pm2Summary = procs
          .map((p) => `${p.name}: ${p.pm2_env?.status ?? 'unknown'} (restarts: ${p.pm2_env?.restart_time ?? 0})`)
          .join(', ');
      } catch { forensic.pm2Summary = 'unavailable'; }

      try {
        const { stdout } = await execAsync('free -m', { timeout: 5000 });
        forensic.memoryFree = stdout.trim();
      } catch { forensic.memoryFree = 'unavailable'; }

      try {
        const { stdout } = await execAsync("df -h / --output=avail | tail -1", { timeout: 5000 });
        forensic.diskAvail = stdout.trim();
      } catch { forensic.diskAvail = 'unavailable'; }

      try {
        const { stdout } = await execAsync(
          'dmesg --time-format=iso 2>/dev/null | grep -i "oom\\|killed process" | tail -5 || true',
          { timeout: 5000 }
        );
        forensic.oomEvents = stdout.trim() || 'none';
      } catch { forensic.oomEvents = 'unavailable'; }

      try {
        const { stdout } = await execAsync(
          `tail -20 "${appPath('logs', 'error.log')}" 2>/dev/null || true`,
          { timeout: 5000 }
        );
        forensic.recentErrors = stdout.trim() || 'empty';
      } catch { forensic.recentErrors = 'unavailable'; }

      await logEvent('crash', 'high', 'DevFlow crash recovery detected (unclean shutdown)', {
        event: 'crash-detected',
        heartbeatAgeMs: Math.round(ageMs),
        ...forensic,
      });
    }
  } catch { /* No heartbeat file = first startup or clean env */ }

  // Write heartbeat
  const writeHeartbeat = async () => {
    try {
      await fs.mkdir(path.dirname(HEARTBEAT_PATH), { recursive: true });
      await fs.writeFile(HEARTBEAT_PATH, new Date().toISOString() + '\n', 'utf-8');
    } catch { /* non-fatal */ }
  };

  await writeHeartbeat();
  const heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL);
  console.log('[DevFlow] Crash recovery heartbeat writer started (30s interval)');

  // Hourly log rotation check
  const doRotation = async () => {
    try {
      const needed = await checkRotationNeeded();
      if (needed) await rotateEventLogs();
    } catch { /* non-fatal */ }
  };
  await doRotation();
  const rotationTimer = setInterval(doRotation, ROTATION_INTERVAL);

  return () => {
    clearInterval(heartbeatTimer);
    clearInterval(rotationTimer);
  };
}
