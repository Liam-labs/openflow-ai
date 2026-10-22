'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LOGINS_CHANGED_EVENT, parseCredentials, type HarnessCredential } from '@/lib/harness-auth';

/**
 * Harness logins from GET /api/system/harness-auth. Polls while `enabled` (10 s while the sign-in modal is open).
 * `available` is false when the endpoint is missing or failing: treated as "no data".
 */
export function useHarnessAuth(enabled: boolean, intervalMs = 10_000) {
  const [credentials, setCredentials] = useState<HarnessCredential[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const cancelled = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/system/harness-auth', { cache: 'no-store' });
      let body: unknown = null;
      try { body = await response.json(); } catch { /* not JSON: no data */ }
      if (!cancelled.current) setCredentials(parseCredentials(response.ok, body));
    } catch {
      if (!cancelled.current) setCredentials(null);
    } finally {
      if (!cancelled.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    cancelled.current = false;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, intervalMs);
    return () => { cancelled.current = true; clearInterval(timer); };
  }, [enabled, intervalMs, refresh]);

  // Refresh at once after a sign-in and when the person comes back to this tab, instead of waiting for the next poll.
  useEffect(() => {
    if (!enabled) return;
    const now = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') now(); };
    window.addEventListener(LOGINS_CHANGED_EVENT, now);
    window.addEventListener('focus', now);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(LOGINS_CHANGED_EVENT, now);
      window.removeEventListener('focus', now);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, refresh]);

  return { credentials, available: credentials !== null, loaded, refresh };
}
