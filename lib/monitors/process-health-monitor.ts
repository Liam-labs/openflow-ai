/**
 * Process health history poller
 * Samples thread count + zombie count every 30s into a circular 24h buffer.
 */
import { getQuickStats, appendProcessHealthHistory } from '../process-health';

const INTERVAL = 30_000;

export async function startProcessHealthMonitor(): Promise<() => void> {
  const poll = async () => {
    try {
      const { threads, zombies } = await getQuickStats();
      await appendProcessHealthHistory(threads, zombies);
    } catch { /* Silently ignore poll errors */ }
  };

  // Seed an entry on startup
  await poll();
  const timer = setInterval(poll, INTERVAL);
  console.log('[DevFlow] Process health history poller started (30s interval)');
  return () => clearInterval(timer);
}
