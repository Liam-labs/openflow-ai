/**
 * AI terminal tasks monitor
 * Polls terminal task state every 5s and emits SSE events on change.
 */
import { eventBus } from '../event-bus';
import { DataPaths } from '../data-paths';
import { readJsonFile } from '../data-io';

const INTERVAL = 5_000;

interface TerminalTaskSummary {
  id: string;
  status: string;
  engine?: string;
  prompt?: string;
  model?: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export function startTerminalTasksMonitor(): () => void {
  let lastFingerprint: string | null = null;

  const run = async () => {
    try {
      if (eventBus.getClientCount() === 0) return;

      const data = await readJsonFile<{ tasks: TerminalTaskSummary[]; lastUpdated: string }>(
        DataPaths.terminalTasks,
        { tasks: [], lastUpdated: '' }
      );

      const fingerprint = data.tasks
        .map((t) => `${t.id}:${t.status}`)
        .sort()
        .join('|');

      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        const taskSummaries = data.tasks.map((t) => ({
          id: t.id,
          status: t.status,
          engine: t.engine,
          prompt: t.prompt,
          model: t.model,
          createdAt: t.createdAt,
          startedAt: t.startedAt,
          completedAt: t.completedAt,
          durationMs: t.durationMs,
        }));
        eventBus.emitEvent('terminal:status', {
          tasks: taskSummaries,
          runningCount: data.tasks.filter((t) => t.status === 'running').length,
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // Silently ignore terminal task check errors in background loop
    }
  };

  const timer = setInterval(run, INTERVAL);
  console.log('[DevFlow] SSE terminal tasks monitor loop started (5s interval)');
  return () => clearInterval(timer);
}
