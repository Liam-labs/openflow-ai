'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, CheckCircle2, Copy, ExternalLink, KeyRound, Loader2, X } from 'lucide-react';
import { useHarnessAuth } from '@/components/useHarnessAuth';
import { LoginHints } from '@/components/LoginHints';
import {
  announceLoginsChanged, canStartSignIn, credentialTitle, isSignInActive, describeSignInError, formatResetTime, minutesLeft,
  type SignInSession,
} from '@/lib/harness-auth';

interface Props {
  credentialId: string;
  onClose: () => void;
  /** Called after a sign-in finished or agents were restarted, so the roster can refresh. */
  onChanged?: () => void;
  /** Setup wizard use: own title, no machine name, no "restart agents" step, and the sign-in starts by itself. */
  title?: string;
  simple?: boolean;
}

async function post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data: Record<string, unknown> = {};
    try { data = await response.json(); } catch { /* empty body */ }
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: { code: 'HOST_OFFLINE' } };
  }
}

export function HarnessSignInModal({ credentialId, onClose, onChanged, title, simple = false }: Props) {
  const { credentials, available, loaded, refresh } = useHarnessAuth(true);
  const credential = credentials?.find(item => item.id === credentialId) ?? null;
  const [localSignIn, setLocalSignIn] = useState<SignInSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState('');
  const [restartResult, setRestartResult] = useState<{ restarted: string[]; skipped: Array<{ name: string; reason: string }> } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const finishedRef = useRef(false);
  const autoStartedRef = useRef(false);

  const signIn = credential?.signIn ?? localSignIn;
  const active = isSignInActive(signIn);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Closing the dialog (after a sign-in or a cancel) refreshes everything that shows logins.
  useEffect(() => () => announceLoginsChanged(), []);
  // Re-render every 20 s so the "minutes left" for a one-time code counts down between polls.
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick(n => n + 1), 20_000); return () => clearInterval(timer); }, []);
  // Tell the roster once when a sign-in completes.
  useEffect(() => {
    if (signIn?.state === 'done' && !finishedRef.current) { finishedRef.current = true; onChanged?.(); announceLoginsChanged(); }
    if (signIn?.state !== 'done') finishedRef.current = false;
  }, [signIn?.state, onChanged]);

  const start = async () => {
    // Starting a Codex sign-in removes the existing Codex login at once. When we can't tell whether one exists, ask first.
    if (credential?.harness === 'codex' && credential.state === 'unknown'
      && !window.confirm('Signing in to Codex first removes its current login on this machine. Agents already running keep working until they restart. Continue?')) return;
    setBusy(true); setError(''); setRestartResult(null);
    const result = await post('/api/system/harness-auth/sign-in', { credentialId });
    const session = (result.data.signIn as SignInSession | undefined) ?? null;
    if (result.ok || result.data.code === 'SIGN_IN_ACTIVE') {
      if (session) setLocalSignIn(session);
    } else {
      setError(describeSignInError(result.data.code, result.data.error));
    }
    setBusy(false);
    void refresh();
  };

  const submitCode = async () => {
    if (!signIn || !code.trim()) return;
    setBusy(true); setError('');
    const sent = code.trim();
    setCode(''); // never kept after sending
    const result = await post('/api/system/harness-auth/sign-in/code', { signInId: signIn.id, code: sent });
    if (result.ok) {
      const session = result.data.signIn as SignInSession | undefined;
      if (session) setLocalSignIn(session);
    } else {
      setError(describeSignInError(result.data.code, result.data.error));
    }
    setBusy(false);
    void refresh();
  };

  const cancel = async () => {
    if (!signIn) return;
    setBusy(true);
    await post('/api/system/harness-auth/sign-in/cancel', { signInId: signIn.id });
    setLocalSignIn(null); setCode(''); setError('');
    setBusy(false);
    void refresh();
  };

  const restart = async () => {
    setBusy(true); setError('');
    const result = await post('/api/system/harness-auth/restart-blocked', { credentialId });
    if (result.ok) {
      setRestartResult({
        restarted: Array.isArray(result.data.restarted) ? result.data.restarted as string[] : [],
        skipped: Array.isArray(result.data.skipped) ? result.data.skipped as Array<{ name: string; reason: string }> : [],
      });
      onChanged?.();
    } else {
      setError(describeSignInError(result.data.code, result.data.error));
    }
    setBusy(false);
  };

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 1500); } catch { /* clipboard unavailable */ }
  };

  // In the setup wizard the person already pressed "Sign in to ...", so start as soon as the login's state is known.
  useEffect(() => {
    if (!simple || autoStartedRef.current || !credential || busy || signIn || !canStartSignIn(credential)) return;
    autoStartedRef.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simple, credential, busy, signIn]);

  // In the wizard, close the box a moment after "Signed in" so the page behind shows the new status.
  useEffect(() => {
    if (!simple || signIn?.state !== 'done') return;
    const timer = setTimeout(onClose, 1500);
    return () => clearTimeout(timer);
  }, [simple, signIn?.state, onClose]);

  const left = minutesLeft(signIn?.expiresAt);
  const blockedAgents = credential?.agents.filter(agent => agent.blocked) ?? [];

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-3" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Sign in" className="w-full max-w-md rounded-2xl border border-white/15 bg-[#0b1626] text-white shadow-2xl focus:outline-none">
        <div className="flex items-start gap-3 border-b border-white/10 px-5 py-4">
          <KeyRound className="mt-0.5 h-5 w-5 text-sky-300" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{title ?? (credential ? credentialTitle(credential) : credentialId)}</h2>
            <p className="mt-0.5 text-xs text-white/50">
              {credential?.state === 'ok' && credential.account ? `${credential.account} · ` : ''}{credential?.plan ? `${credential.plan} · ` : ''}{simple ? '' : credential?.host === 'server' ? 'Remote server' : credential?.host === 'desktop' ? 'Desktop' : ''}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-white/50 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm">
          {!loaded && <p className="flex items-center gap-2 text-white/60"><Loader2 className="h-4 w-4 animate-spin" /> Checking this login…</p>}
          {loaded && !available && <p className="text-white/60">Sign-in isn&apos;t available yet: the sign-in service isn&apos;t running. Try again later.</p>}
          {loaded && available && !credential && <p className="text-white/60">This login isn&apos;t listed any more. Close this and check the agent again.</p>}

          {credential && (
            <>
              {credential.state === 'ok' && !signIn && (
                <p className="flex items-center gap-2 text-emerald-300"><CheckCircle2 className="h-4 w-4" /> Signed in. {credential.detail}</p>
              )}
              {credential.state === 'limit_reached' && (
                <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-amber-100">
                  <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" /> Limit reached</p>
                  <p className="mt-1 text-xs">{credential.detail}</p>
                  {credential.usage?.resetsAt && <p className="mt-1 text-xs">Resets at {formatResetTime(credential.usage.resetsAt)}. Signing in again won&apos;t help; the agent resumes after the reset.</p>}
                </div>
              )}
              {(credential.state === 'needs_login' || credential.state === 'unknown') && !signIn && (
                <p className="text-white/75">{credential.detail || 'This login needs to be signed in again.'}</p>
              )}

              {credential.state !== 'ok' && <LoginHints credential={credential} />}

              {canStartSignIn(credential) && signIn?.state !== 'done' && (
                <button onClick={start} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-sky-400/40 bg-sky-500/15 px-4 py-2 font-medium text-sky-100 hover:bg-sky-500/25 disabled:opacity-50">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} {signIn?.state === 'failed' || signIn?.state === 'expired' ? 'Try again' : 'Sign in'}
                </button>
              )}

              {signIn && active && (
                <div className="space-y-3">
                  {signIn.state === 'starting' && <p className="flex items-center gap-2 text-white/60"><Loader2 className="h-4 w-4 animate-spin" /> Starting the sign-in…</p>}
                  {signIn.url && (
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-white/45">1. Open this link and sign in</p>
                      <div className="flex items-center gap-2">
                        <a href={signIn.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 flex-1 items-center gap-2 truncate rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sky-300 hover:bg-white/10">
                          <ExternalLink className="h-4 w-4 flex-shrink-0" /><span className="truncate">{signIn.url}</span>
                        </a>
                        <button onClick={() => copy(signIn.url!, 'link')} aria-label="Copy link" className="rounded-lg border border-white/15 p-2 hover:bg-white/10">
                          {copied === 'link' ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                  )}
                  {signIn.kind === 'device-code' && signIn.userCode && (
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-white/45">2. Enter this code there</p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-center text-xl font-semibold tracking-[0.25em]">{signIn.userCode}</code>
                        <button onClick={() => copy(signIn.userCode!, 'code')} aria-label="Copy code" className="rounded-lg border border-white/15 p-2 hover:bg-white/10">
                          {copied === 'code' ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
                        </button>
                      </div>
                      <p className="mt-2 flex items-center gap-2 text-xs text-white/55"><Loader2 className="h-3 w-3 animate-spin" /> Waiting for you to finish (Codex stays signed out until then){left !== null ? ` · code works for ${left} more minute${left === 1 ? '' : 's'}` : ''}</p>
                    </div>
                  )}
                  {signIn.kind === 'paste-code' && signIn.state !== 'starting' && (
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-white/45">2. Paste the code it gives you</p>
                      <form onSubmit={event => { event.preventDefault(); void submitCode(); }} className="flex items-center gap-2">
                        <input
                          type="password"
                          value={code}
                          onChange={event => setCode(event.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={busy || signIn.state === 'verifying'}
                          placeholder="Paste code"
                          aria-label="Sign-in code"
                          className="min-w-0 flex-1 rounded-lg border border-white/20 bg-black/30 px-3 py-2 font-mono focus:border-sky-400/60 focus:outline-none"
                        />
                        <button type="submit" disabled={busy || !code.trim() || signIn.state === 'verifying'} className="rounded-lg border border-sky-400/40 bg-sky-500/15 px-3 py-2 font-medium text-sky-100 hover:bg-sky-500/25 disabled:opacity-50">
                          {signIn.state === 'verifying' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Submit'}
                        </button>
                      </form>
                    </div>
                  )}
                  {signIn.message && <p className="text-xs text-white/55">{signIn.message}</p>}
                  <button onClick={cancel} disabled={busy} className="text-xs text-white/45 underline hover:text-white/75">Cancel sign-in</button>
                </div>
              )}

              {signIn?.state === 'done' && (
                <div className="space-y-3">
                  <p className="flex items-center gap-2 text-emerald-300"><CheckCircle2 className="h-4 w-4" /> Signed in.</p>
                  {!simple && !restartResult && (
                    <button onClick={restart} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-4 py-2 font-medium text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Restart blocked agents{blockedAgents.length ? ` (${blockedAgents.map(agent => agent.name).join(', ')})` : ''}
                    </button>
                  )}
                  {!simple && restartResult && (
                    <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-xs">
                      <p>{restartResult.restarted.length ? `Restarted: ${restartResult.restarted.join(', ')}.` : 'No agents needed a restart.'}</p>
                      {restartResult.skipped.map(item => <p key={item.name} className="mt-1 text-white/55">{item.name}: {item.reason}</p>)}
                    </div>
                  )}
                </div>
              )}

              {(signIn?.state === 'failed' || signIn?.state === 'expired') && (
                <div className="space-y-2">
                  <p className="flex items-start gap-2 text-red-300"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> <span>{signIn.state === 'expired' ? 'The sign-in timed out.' : 'The sign-in failed.'} {signIn.message} A new sign-in needs a new link.</span></p>
                </div>
              )}
            </>
          )}

          {error && <p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
