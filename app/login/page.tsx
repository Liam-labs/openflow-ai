'use client';

import { FormEvent, Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PRODUCT_NAME } from '@/lib/brand';
import { safeNextPath } from '@/lib/safe-next-path';

type SessionInfo = { passwordSet: boolean; signedIn: boolean; onThisMachine: boolean };

function LoginForm() {
  const params = useSearchParams();
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/auth/session', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: SessionInfo) => {
        setInfo(data);
        if (data.signedIn || data.onThisMachine) window.location.replace(safeNextPath(params.get('next')));
      })
      .catch(() => setInfo({ passwordSet: true, signedIn: false, onThisMachine: false }));
  }, [params]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        window.location.replace(safeNextPath(params.get('next')));
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Sign in failed.');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.04] p-8 shadow-xl backdrop-blur">
      <h1 className="text-xl font-semibold text-white">{PRODUCT_NAME}</h1>
      <p className="mt-1 text-sm text-white/60">Sign in to continue.</p>

      {info && !info.passwordSet ? (
        <div className="mt-6 space-y-3 text-sm text-white/80" role="status">
          <p>No password has been set yet, so nobody can sign in from here.</p>
          <p>Open the setup page to create your first login with the code from your installer.</p>
          <a href="/setup" className="inline-block text-blue-300 underline">Continue setup</a>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block text-sm text-white/80" htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-white outline-none focus:border-blue-400"
          />
          {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
          <button
            type="submit"
            disabled={busy || !password}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{ background: 'radial-gradient(ellipse at 30% 20%, rgba(59,130,246,0.08) 0%, transparent 55%), #050510' }}
    >
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
