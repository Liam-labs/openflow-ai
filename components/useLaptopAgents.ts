'use client';

import { useEffect, useState } from 'react';
import { parseLaptopStatus, LAPTOP_NOT_SET_UP, type LaptopStatus } from '@/lib/laptop-agents';
import { LOGINS_CHANGED_EVENT } from '@/lib/harness-auth';

const POLL_MS = 15_000;

/**
 * Whether agents can run on the Remote DevFlow Server right now (GET /api/system/laptop-agents). A failed or missing endpoint means not ready.
 * Re-checks every 15 s, after a sign-in, and when the person returns to the tab, so "Run remote" unlocks as soon as it is ready.
 */
export function useLaptopAgents(enabled = true): LaptopStatus & { loading: boolean } {
  const [state, setState] = useState<LaptopStatus & { loading: boolean }>({ ready: false, mode: null, reason: LAPTOP_NOT_SET_UP, loading: enabled });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const check = () => {
      fetch('/api/system/laptop-agents', { cache: 'no-store' })
        .then(async (response) => {
          let body: unknown = null;
          try { body = await response.json(); } catch { /* not JSON: treated as not ready */ }
          return parseLaptopStatus(response.ok, body);
        })
        .catch(() => parseLaptopStatus(false, null))
        .then((status) => { if (!cancelled) setState({ ...status, loading: false }); });
    };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    check();
    const timer = setInterval(check, POLL_MS);
    window.addEventListener(LOGINS_CHANGED_EVENT, check);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(LOGINS_CHANGED_EVENT, check);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);
  return state;
}
