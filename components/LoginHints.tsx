'use client';

import { ExternalLink, UserRound } from 'lucide-react';
import type { HarnessCredential } from '@/lib/harness-auth';

type Hints = Pick<HarnessCredential, 'accountHint' | 'setupHint' | 'setupUrl' | 'setupLabel' | 'setupTitle' | 'setupSteps'>;

/**
 * Which account to use and any one-time setup, shown on a login row (compact) and in its sign-in box.
 * The box shows the numbered steps when the backend sends them, otherwise the one-line note. Renders nothing when there are no hints.
 */
export function LoginHints({ credential, compact = false }: { credential: Hints; compact?: boolean }) {
  const { accountHint, setupHint, setupUrl, setupLabel, setupTitle } = credential;
  const steps = Array.isArray(credential.setupSteps) ? credential.setupSteps.filter(step => typeof step === 'string' && step.trim()) : [];
  const safeUrl = typeof setupUrl === 'string' && /^https:\/\//i.test(setupUrl) ? setupUrl : null;
  if (!accountHint && !setupHint && !safeUrl && steps.length === 0) return null;

  const link = safeUrl && (
    <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-300 underline hover:text-sky-200">
      {setupLabel || safeUrl}<ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
  const account = accountHint && (
    <p className="flex items-start gap-1.5"><UserRound className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-sky-300" aria-hidden /><span>{accountHint}</span></p>
  );

  if (compact || steps.length === 0) {
    const text = compact ? 'text-[11px]' : 'text-xs';
    return (
      <div className={`space-y-1.5 ${text} leading-snug ${compact ? 'mt-1.5 text-white/60' : 'rounded-lg border border-sky-400/20 bg-sky-500/[0.07] p-3 text-sky-50/90'}`}>
        {account}
        {(setupHint || link) && <p>{setupHint}{link && <>{setupHint ? ' ' : ''}{link}</>}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2.5 text-xs leading-snug">
      {accountHint && <div className="text-sky-50/90">{account}</div>}
      <div className="rounded-lg border border-sky-400/20 bg-sky-500/[0.07] p-3 text-sky-50/90">
        {setupTitle && <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-sky-200/80">{setupTitle}</p>}
        <ol className="list-decimal space-y-1.5 pl-4 marker:text-sky-300/70">
          {steps.map((step, index) => (
            <li key={index}>
              {step}
              {index === 0 && link && <div className="mt-0.5">{link}</div>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
