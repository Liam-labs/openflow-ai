import { applyAllPendingCodexRuntimeConfigs } from '@/lib/codex-runtime-config';

const INTERVAL_MS = 2_000;

export function startCodexRuntimeConfigMonitor(): () => void {
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    try {
      await applyAllPendingCodexRuntimeConfigs();
    } catch (error) {
      console.error('[codex-runtime-config] monitor cycle failed:', error instanceof Error ? error.message : String(error));
    }
  };

  void run();
  const timer = setInterval(() => void run(), INTERVAL_MS);
  timer.unref?.();
  console.log('[DevFlow] Codex live config monitor started (2s interval)');
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
