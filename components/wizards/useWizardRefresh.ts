'use client';

import { useEffect, useRef } from 'react';
import { useEventStream } from '@/lib/contexts/EventStreamContext';

/** Subscribe before reading, then catch up on matching invalidations and reconnection. */
export function useWizardRefresh(wizard: 'tailscale' | 'cloudflare', refresh: () => Promise<void>) {
  // No fallback URL: a disconnected stream must never start status polling.
  const { data, isConnected } = useEventStream<{ wizard: 'tailscale' | 'cloudflare' }>('wizard:changed');
  const previous = useRef({ data, isConnected, initialized: false });
  useEffect(() => {
    const old = previous.current;
    previous.current = { data, isConnected, initialized: true };
    if (!old.initialized || (isConnected && !old.isConnected) || (data !== old.data && data?.wizard === wizard)) {
      void refresh();
    }
  }, [data, isConnected, refresh, wizard]);
}
