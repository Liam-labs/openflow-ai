/**
 * Claude sessions monitor
 * Scans active Claude agent sessions every 10s and emits SSE events on change.
 */
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { eventBus } from '../event-bus';
import { isAgentAlive } from '../agent-liveness';

const execAsync = promisify(execCb);
const INTERVAL = 10_000;

export function startSessionsMonitor(): () => void {
  let lastFingerprint: string | null = null;

  const run = async () => {
    try {
      if (eventBus.getClientCount() === 0) return;

      const sessions: Array<{ pid: number; name: string; cwd: string }> = [];
      const seenPids = new Set<number>();

      // Primary source: /tmp/collab-ready-*.json files
      try {
        const { stdout: files } = await execAsync(
          'ls /tmp/collab-ready-*.json 2>/dev/null || true',
          { timeout: 3000 }
        );
        for (const file of files.trim().split('\n').filter(Boolean)) {
          try {
            const content = await readFile(file, 'utf-8');
            const data = JSON.parse(content);
            const pid = data.pid;
            const platform = data.platform === 'windows' ? 'windows' : 'wsl';
            if (await isAgentAlive(pid, platform)) {
              sessions.push({ pid, name: data.name || `Agent-${pid}`, cwd: data.cwd || '' });
              seenPids.add(pid);
            }
          } catch { /* skip corrupt files */ }
        }
      } catch { /* no ready files */ }

      // Secondary: bare claude processes on pts/
      try {
        const { stdout } = await execAsync(
          'ps -eo pid,tty,args 2>/dev/null | grep "pts/" | grep -E "^\\s*[0-9]+\\s+pts/[0-9]+\\s+claude" | grep -v grep',
          { timeout: 3000 }
        );
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[0], 10);
          if (!isNaN(pid) && !seenPids.has(pid)) {
            sessions.push({ pid, name: `Claude-${pid}`, cwd: '' });
            seenPids.add(pid);
          }
        }
      } catch { /* no claude processes found */ }

      const fingerprint = sessions
        .map((s) => `${s.pid}:${s.name}`)
        .sort()
        .join('|');

      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        eventBus.emitEvent('sessions:change', {
          sessions,
          sessionCount: sessions.length,
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // Silently ignore session check errors in background loop
    }
  };

  const timer = setInterval(run, INTERVAL);
  console.log('[DevFlow] SSE sessions monitor loop started (10s interval)');
  return () => clearInterval(timer);
}
