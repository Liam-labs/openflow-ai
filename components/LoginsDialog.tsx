'use client';

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertTriangle, KeyRound, Loader2, X, HelpCircle } from 'lucide-react';
import { useHarnessAuth } from '@/components/useHarnessAuth';
import { HarnessSignInModal } from '@/components/modals/HarnessSignInModal';
import { LoginHints } from '@/components/LoginHints';
import { credentialTitle, formatResetTime, loginAction, type HarnessCredential } from '@/lib/harness-auth';

const ACTION_LABEL = { 'sign-in': 'Sign in', continue: 'Continue sign-in', details: 'Details', none: '' } as const;

function StateChip({ credential }: { credential: HarnessCredential }) {
  if (credential.state === 'ok') return <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> Signed in</span>;
  if (credential.state === 'needs_login') return <span className="inline-flex items-center gap-1 text-red-300"><AlertTriangle className="h-3.5 w-3.5" /> Needs sign-in</span>;
  if (credential.state === 'limit_reached') return <span className="inline-flex items-center gap-1 text-amber-300"><AlertTriangle className="h-3.5 w-3.5" /> Limit reached</span>;
  return <span className="inline-flex items-center gap-1 text-white/55"><HelpCircle className="h-3.5 w-3.5" /> Unknown</span>;
}

function usageText(credential: HarnessCredential): string {
  const parts: string[] = [];
  if (credential.state === 'ok' && credential.account) parts.push(credential.account);
  if (credential.plan) parts.push(credential.plan);
  if (credential.usage) {
    const at = formatResetTime(credential.usage.resetsAt);
    parts.push(`${Math.round(credential.usage.percent)}% of ${credential.usage.window} limit${at ? `, resets ${at}` : ''}`);
  }
  return parts.join(' · ');
}

/** Every harness login (Claude and Codex, desktop and laptop) with a Sign in button. */
export function LoginsDialog({ onClose }: { onClose: () => void }) {
  const { credentials, available, loaded } = useHarnessAuth(true);
  const [openId, setOpenId] = useState<string | null>(null);

  // The sign-in dialog sits on top; Escape in it must not also close this list.
  if (openId) return <HarnessSignInModal credentialId={openId} onClose={() => setOpenId(null)} />;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-3" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Logins" className="w-full max-w-lg rounded-2xl border border-white/15 bg-[#0b1626] text-white shadow-2xl"
        onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
        <div className="flex items-start gap-3 border-b border-white/10 px-5 py-4">
          <KeyRound className="mt-0.5 h-5 w-5 text-sky-300" aria-hidden />
          <div className="flex-1">
            <h2 className="text-base font-semibold">Logins</h2>
            <p className="mt-0.5 text-xs text-white/50">Where Claude Code and Codex are signed in, on the desktop and the remote server.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-white/50 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-[70vh] space-y-2 overflow-y-auto px-5 py-4 text-sm">
          {!loaded && <p className="flex items-center gap-2 text-white/60"><Loader2 className="h-4 w-4 animate-spin" /> Checking logins…</p>}
          {loaded && !available && <p className="text-white/60">The sign-in service isn&apos;t answering. Try again in a moment.</p>}
          {credentials?.map(credential => {
            const action = loginAction(credential);
            const usage = usageText(credential);
            const running = credential.agents.filter(agent => agent.running).length;
            return (
              <div key={credential.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{credentialTitle(credential)}</span>
                    <span className="flex-shrink-0 rounded border border-white/15 px-1 text-[9px] uppercase tracking-wider text-white/45">{credential.host === 'server' ? 'Remote' : 'Desktop'}</span>
                  </div>
                  <div className="mt-0.5 text-xs"><StateChip credential={credential} /></div>
                  {(credential.state !== 'ok' || usage) && (
                    <p className="mt-0.5 truncate text-xs text-white/50" title={credential.detail}>{[credential.state !== 'ok' ? credential.detail : '', usage].filter(Boolean).join(' · ')}</p>
                  )}
                  {credential.state !== 'ok' && <LoginHints credential={credential} compact />}
                  {credential.state === 'ok' && !usage && running > 0 && <p className="mt-0.5 text-xs text-white/40">{running} agent{running === 1 ? '' : 's'} using it</p>}
                </div>
                {action !== 'none' && (
                  <button onClick={() => setOpenId(credential.id)} className={`flex-shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium ${action === 'details' ? 'border-white/20 bg-white/5 text-white/80 hover:bg-white/10' : 'border-sky-400/40 bg-sky-500/15 text-sky-100 hover:bg-sky-500/25'}`}>
                    {ACTION_LABEL[action]}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
