/**
 * Port change monitor
 * Polls listening ports every 15s and emits SSE event when anything changes.
 */
import { eventBus } from '../event-bus';
import { getListeningPorts, buildPortFingerprint } from '../port-utils';

const INTERVAL = 15_000;

export function startPortMonitor(): () => void {
  let lastFingerprint: string | null = null;

  const run = async () => {
    try {
      if (eventBus.getClientCount() === 0) return;

      const ports = await getListeningPorts();
      const fingerprint = buildPortFingerprint(ports);

      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        eventBus.emitEvent('ports:change', { ports });
      }
    } catch {
      // Silently ignore port check errors in background loop
    }
  };

  const timer = setInterval(run, INTERVAL);
  console.log('[DevFlow] SSE port monitor loop started (15s interval)');
  return () => clearInterval(timer);
}
