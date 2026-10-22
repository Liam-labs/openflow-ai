'use client';

import { useState } from 'react';
import { AlertTriangle, KeyRound } from 'lucide-react';
import { useHarnessAuth } from '@/components/useHarnessAuth';
import { HarnessSignInModal } from '@/components/modals/HarnessSignInModal';
import { formatResetTime, isNotInstalled, isSignInActive, loginAction } from '@/lib/harness-auth';

const HARNESS_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * Shown under the model choice when the harness behind it is not signed in on the machine the agent will run on.
 * Only Claude Code and Codex have logins; every other harness shows nothing.
 */
export function HarnessLoginNotice({ harness, onLaptop }: { harness: string; onLaptop: boolean }) {
  const name = HARNESS_NAME[harness];
  const { credentials, refresh } = useHarnessAuth(!!name, 10_000);
  const [open, setOpen] = useState(false);
  if (!name) return null;

  const credentialId = `${harness}@${onLaptop ? 'server' : 'desktop'}`;
  const credential = credentials?.find(item => item.id === credentialId);
  if (!credential) return null;

  const machine = onLaptop ? 'the remote server' : 'the desktop';
  const action = loginAction(credential);
  const notInstalled = isNotInstalled(credential);
  const limited = credential.state === 'limit_reached';
  const waiting = isSignInActive(credential.signIn);
  if (credential.state === 'ok' && !waiting) return null;

  let message: string;
  if (notInstalled) message = `${name} isn't installed on ${machine} yet, so this model can't run there.`;
  else if (waiting) message = `A ${name} sign-in on ${machine} is waiting for you to finish it.`;
  else if (limited) {
    const reset = credential.usage?.resetsAt ? ` It resets ${formatResetTime(credential.usage.resetsAt)}.` : '';
    message = `${name} has hit its usage limit on ${machine}.${reset}`;
  } else message = `${name} isn't signed in on ${machine}. An agent using this model can't start until it is.`;

  const buttonLabel = action === 'continue' ? 'Continue sign-in' : action === 'details' ? 'See details' : `Sign in to ${name}`;
  const tone = notInstalled || limited || waiting
    ? 'border-amber-400/35 bg-amber-500/[0.08] text-amber-100'
    : 'border-red-400/40 bg-red-500/[0.09] text-red-100';

  return (
    <div role="status" className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] ${tone}`}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 leading-snug">{message}</p>
      {action !== 'none' && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-white/20 bg-white/10 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-white/20"
        >
          <KeyRound className="h-3 w-3" aria-hidden />
          {buttonLabel}
        </button>
      )}
      {open && <HarnessSignInModal credentialId={credentialId} onClose={() => { setOpen(false); void refresh(); }} onChanged={() => { void refresh(); }} />}
    </div>
  );
}
