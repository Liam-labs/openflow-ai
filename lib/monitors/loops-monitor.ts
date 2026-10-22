/**
 * Ralph loops monitor
 * Scans active loops every 10s and emits SSE events when state changes.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { eventBus } from '../event-bus';
import { appPath } from '@/lib/app-paths';

const INTERVAL = 10_000;
const CONFIG_PATH = appPath('config', 'projects.json');
const METRICS_FILENAME = '.claude/ralph-loop-metrics.json';
const STATE_FILENAME = '.claude/ralph-loop.local.md';

export function startLoopsMonitor(): () => void {
  let lastFingerprint: string | null = null;

  const run = async () => {
    try {
      if (eventBus.getClientCount() === 0) return;

      let watchPaths: string[] = [];
      try {
        const configData = await fs.readFile(CONFIG_PATH, 'utf-8');
        const config = JSON.parse(configData);
        watchPaths = config.loopsConfig?.watchPaths || [];
      } catch {
        return;
      }
      if (watchPaths.length === 0) return;

      const active: unknown[] = [];
      for (const wp of watchPaths) {
        try {
          const metricsData = await fs.readFile(path.join(wp, METRICS_FILENAME), 'utf-8');
          const metrics = JSON.parse(metricsData);
          if (!metrics.session_id) continue;

          let stateExists = false;
          try {
            await fs.access(path.join(wp, STATE_FILENAME));
            stateExists = true;
          } catch { /* no state file */ }

          const isActive =
            metrics.final_status === 'running' || metrics.final_status === 'awaiting_input';
          if (stateExists && isActive) active.push(metrics);
        } catch {
          continue;
        }
      }

      type LoopEntry = { session_id: string; final_status: string; total_iterations?: number };
      const fingerprint = (active as LoopEntry[])
        .map((l) => `${l.session_id}:${l.final_status}:${l.total_iterations || 0}`)
        .sort()
        .join('|');

      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        eventBus.emitEvent('loops:status', {
          active,
          activeCount: active.length,
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // Silently ignore loop check errors in background loop
    }
  };

  const timer = setInterval(run, INTERVAL);
  console.log('[DevFlow] SSE loops monitor loop started (10s interval)');
  return () => clearInterval(timer);
}
