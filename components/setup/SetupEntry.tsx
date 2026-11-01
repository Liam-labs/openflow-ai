'use client';

import { useEffect, useState } from 'react';
import { SetupWizard } from '@/components/SetupWizard';
import { CreateLogin, type CreateLoginProps } from './CreateLogin';

type EntryState = 'loading' | 'create' | 'signin' | 'wizard' | 'error';

const createLogin: CreateLoginProps['createLogin'] = async (code, newPassword) => {
  const response = await fetch('/api/auth/setup', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, newPassword }),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) {
    if (result.code === 'already_configured') return { ok: false, signInRequired: true, error: 'A login already exists. Sign in to continue.' };
    if (result.code === 'invalid_code') return { ok: false, error: 'This setup code is invalid or expired. Get a new code from your installer.' };
    if (result.code === 'throttled') {
      const seconds = typeof result.retryAfterSeconds === 'number' && Number.isFinite(result.retryAfterSeconds)
        ? Math.max(1, Math.ceil(result.retryAfterSeconds)) : 60;
      return { ok: false, error: `Too many attempts. Wait ${seconds} seconds, then try again.` };
    }
    return { ok: false, error: typeof result.error === 'string' ? result.error : 'We could not create your login. Try again.' };
  }
  // Do not open the protected wizard if the browser refused the session cookie.
  const session = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' });
  if (!session.ok || (await session.json()).signedIn !== true) {
    return { ok: false, signInRequired: true, error: 'Your login was created, but this browser could not start a session. Sign in to continue.' };
  }
  return { ok: true };
};

export function SetupEntry() {
  const [state, setState] = useState<EntryState>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch('/api/auth/setup', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Setup status unavailable');
        const status = await response.json();
        if (typeof status.serverMode !== 'boolean' || typeof status.needsSetup !== 'boolean') throw new Error('Invalid setup status');
        if (!status.serverMode) { setState('wizard'); return; }
        if (status.needsSetup) { setState('create'); return; }
        const session = await fetch('/api/auth/session', { cache: 'no-store', signal: controller.signal });
        if (!session.ok) throw new Error('Session status unavailable');
        const auth = await session.json();
        setState(auth.signedIn === true || auth.onThisMachine === true || auth.viaTunnel === true ? 'wizard' : 'signin');
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt]);

  if (state === 'wizard') return <SetupWizard />;
  if (state === 'create') return <CreateLogin createLogin={createLogin} onCreated={() => setState('wizard')} />;
  return <section className="glass-card p-5 sm:p-8 text-white" aria-live="polite">
    {state === 'loading' && <p role="status">Checking your setup…</p>}
    {state === 'signin' && <><h1 className="text-xl font-semibold mb-4">Sign in to continue setup</h1><p className="text-white/70 mb-5">This server already has a login.</p><a href="/login?next=%2Fsetup" className="glass-button inline-block px-5 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400">Sign in</a></>}
    {state === 'error' && <><p role="alert" className="mb-5">We could not check your setup. Check your connection, then try again.</p><button type="button" className="glass-button px-5 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400" onClick={() => { setState('loading'); setAttempt((value) => value + 1); }}>Try again</button></>}
  </section>;
}
