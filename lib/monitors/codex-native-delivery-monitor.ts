import { codexNativeAutoDeliveryWorker } from '@/lib/codex-native-auto-delivery';

const INTERVAL_MS = 2_000;

export function startCodexNativeDeliveryMonitor(): () => void {
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    try {
      await codexNativeAutoDeliveryWorker.runOnce();
    } catch (error) {
      console.error(
        '[codex-native-auto] monitor cycle failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  void run();
  const timer = setInterval(() => void run(), INTERVAL_MS);
  timer.unref?.();
  console.log('[DevFlow] Codex Native automatic delivery started (2s interval)');
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
