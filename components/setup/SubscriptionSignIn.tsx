'use client';

import { useState } from 'react';
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react';
import { HarnessSignInModal } from '@/components/modals/HarnessSignInModal';
import { useHarnessAuth } from '@/components/useHarnessAuth';
import type { HarnessCredential } from '@/lib/harness-auth';

/**
 * Setup wizard: sign in to Claude Code or Codex with a subscription, with no terminal and no API key.
 * The programs run their own login (scripts/harness_signin.py) and keep it in their own folders on this machine;
 * this page only shows the link they print and hands the pasted code to the waiting login. Nothing is stored here.
 * Credential ids ending in @desktop are the machine the agents run on, which is this one unless a remote agent host is set.
 */
const PROGRAMS = [
  { id: 'claude@desktop', title: 'Claude Code', button: 'Sign in to Claude Code', plans: 'Claude Pro, Max, Team or Enterprise plan', install: 'npm install -g @anthropic-ai/claude-code' },
  { id: 'codex@desktop', title: 'Codex', button: 'Sign in to Codex', plans: 'ChatGPT Plus, Pro, Business or Enterprise plan', install: 'npm install -g @openai/codex' },
  { id: 'antigravity@desktop', title: 'Antigravity (Gemini)', button: 'Sign in to Antigravity', plans: 'Google account with Gemini access', install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
] as const;

function statusLine(credential: HarnessCredential | undefined, loaded: boolean): { text: string; ok: boolean } {
  if (!loaded) return { text: 'Checking…', ok: false };
  if (!credential) return { text: 'Not available on this machine yet', ok: false };
  if (credential.state === 'ok') {
    const who = [credential.account, credential.plan].filter(Boolean).join(' · ');
    return { text: who ? `Signed in · ${who}` : 'Signed in', ok: true };
  }
  if (credential.state === 'limit_reached') return { text: 'Signed in, but its usage limit is reached for now', ok: true };
  return { text: credential.detail || 'Not signed in', ok: false };
}

export function SubscriptionSignIn() {
  const { credentials, loaded } = useHarnessAuth(true);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-white/80">Use a subscription</h3>
        <p className="mt-0.5 text-xs text-white/40 leading-relaxed">
          Sign in with your own plan. The program does the sign-in and keeps it on this machine; this page never sees or stores it.
          No API key needed.
        </p>
      </div>

      {PROGRAMS.map((program) => {
        const credential = credentials?.find((item) => item.id === program.id);
        const status = statusLine(credential, loaded);
        const notInstalled = !!credential && credential.state === 'unknown' && /not installed/i.test(credential.detail);
        const canSign = !!credential && !notInstalled && credential.state !== 'ok' && credential.state !== 'limit_reached';
        return (
          <div key={program.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-white">{program.title}</p>
              <p className={`mt-0.5 flex items-center gap-1.5 text-xs ${status.ok ? 'text-emerald-300' : 'text-white/45'}`}>
                {!loaded ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : status.ok ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : null}
                <span className="truncate">{status.text}</span>
              </p>
              {!status.ok && <p className="mt-0.5 text-[11px] text-white/30">{program.plans}</p>}
              {notInstalled && (
                <p className="mt-1 text-[11px] text-yellow-300/80">
                  Install it first, then reload this page: <code className="text-yellow-200">{program.install}</code>
                </p>
              )}
            </div>
            {canSign && (
              <button
                type="button"
                onClick={() => setOpen(program.id)}
                className="glass-button flex flex-shrink-0 items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#60a5fa]"
              >
                <KeyRound className="h-3.5 w-3.5" aria-hidden /> {program.button}
              </button>
            )}
          </div>
        );
      })}

      {open && (
        <HarnessSignInModal
          credentialId={open}
          title={PROGRAMS.find((program) => program.id === open)?.button}
          simple
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
