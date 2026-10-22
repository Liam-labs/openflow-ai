'use client';

/**
 * NewVersionPill - tells an already-open tab that DevFlow has been rebuilt.
 *
 * A tab keeps running the JavaScript it loaded, so a phone left open across a deploy
 * never shows new buttons until it reloads. The build id comes from /api/system/build-info;
 * when it changes we show a tap-to-reload pill instead of reloading under the user's draft.
 */

import { useEffect, useRef, useState } from 'react';

const CHECK_MS = 60_000;

async function fetchBuildId(): Promise<string | null> {
  try {
    const res = await fetch('/api/system/build-info', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json() as { buildId?: string | null };
    return data.buildId ?? null;
  } catch {
    return null;
  }
}

export function NewVersionPill() {
  const loaded = useRef<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const id = await fetchBuildId();
      if (cancelled || !id) return;
      if (loaded.current === null) loaded.current = id;
      else if (id !== loaded.current) setStale(true);
    };
    check();
    const timer = setInterval(check, CHECK_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!stale) return null;
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="fixed left-1/2 top-16 z-[9998] -translate-x-1/2 whitespace-nowrap rounded-full border border-sky-400/40 bg-slate-900/95 px-4 py-2 text-sm font-medium text-sky-200 shadow-lg"
      style={{ backdropFilter: 'blur(8px)' }}
    >
      New version ready · tap to reload
    </button>
  );
}
