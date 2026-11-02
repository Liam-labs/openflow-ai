'use client';

/**
 * The shape every setup wizard shares: Check (what is true now), Explain (what will change), Do, Prove (a real test),
 * Undo. Each wizard fills the slots; this file only lays them out so every wizard looks and reads the same.
 * On a Set up more card (see WizardShell) the five slots become five steps in a dialog, one at a time; used on its own it
 * stays one scrolling card.
 */
import { createPortal } from 'react-dom';
import { isValidElement, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { WizardShellContext, type Tone } from '@/components/wizards/WizardShell';

export interface ProofLine { name: string; ok: boolean; detail: string }

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`sc-pill sc-pill--${tone}`}>{children}</span>;
}

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-white/60"><span className="text-white/35 mr-1.5">{n}</span>{title}</h4>
      {children}
    </section>
  );
}

export function ProofList({ lines, busy }: { lines: ProofLine[] | null; busy?: boolean }) {
  if (busy) return <div className="flex items-center gap-2 text-xs text-white/60"><Loader2 className="w-3.5 h-3.5 animate-spin" />Testing with the real sign-in…</div>;
  if (!lines) return <p className="text-xs text-white/40">Nothing tested yet.</p>;
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Test results">
      {lines.map((l) => (
        <li key={l.name} className="flex items-start gap-2 text-xs">
          {l.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 mt-0.5 flex-shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 flex-shrink-0" />}
          <span className="text-white/75"><span className="font-medium">{l.name}.</span> <span className="text-white/50">{l.detail}</span></span>
        </li>
      ))}
    </ul>
  );
}

interface Props {
  title: string;
  status: ReactNode;
  check: ReactNode;
  explain: ReactNode;
  doIt: ReactNode;
  prove: ReactNode;
  undo: ReactNode;
  /** Bump this number when the real test starts, so the dialog moves to the Test step by itself. */
  testSignal?: number;
  /** While set, Continue on the Set it up step is off and this text says what to do first. The test jump above still works. */
  holdSetup?: string | null;
  /** The result of the last action (set up, test, switch off). Shown on whichever step is open, so it never lands out of sight. */
  message?: { ok: boolean; text: string } | null;
}

const STEPS = [
  { key: 'check', rail: 'Now', title: 'Where things stand', sub: 'What this computer is doing right now.' },
  { key: 'explain', rail: 'Changes', title: 'What this changes', sub: 'Read this before you set anything up.' },
  { key: 'doIt', rail: 'Set up', title: 'Set it up', sub: 'Do this step, then carry on to the test.' },
  { key: 'prove', rail: 'Test', title: 'Check that it works', sub: 'A real test, not just a tick.' },
  { key: 'undo', rail: 'Undo', title: 'Undo it', sub: 'Everything here can be switched off again.' },
] as const;

const TEST_STEP = STEPS.findIndex(s => s.key === 'prove');
const DO_STEP = STEPS.findIndex(s => s.key === 'doIt');
const UNDO_STEP = STEPS.findIndex(s => s.key === 'undo');

/**
 * Opens on the step a person needs: Set it up when nothing is on yet, Check that it works when it is. "Where things stand" and
 * "What this changes" are one click back, and the changes are also shown on the Set it up step.
 */
function Pager({ slots, startAt, testSignal, holdSetup, message }: { slots: Record<(typeof STEPS)[number]['key'], ReactNode>; startAt: number; testSignal: number; holdSetup: string | null; message: ReactNode }) {
  const [at, setAt] = useState(startAt);
  const firstRun = useRef(true);
  useEffect(() => { if (firstRun.current) { firstRun.current = false; return; } setAt(TEST_STEP); }, [testSignal]);
  const step = STEPS[at];
  const last = at === STEPS.length - 1;
  const held = holdSetup && at >= DO_STEP ? holdSetup : null;
  // The hold stops a skip to the test before anything is on. Undo stays reachable: a saved token or a part-made setup must be removable.
  const locked = (i: number) => !!holdSetup && i > DO_STEP && i !== UNDO_STEP && at <= DO_STEP;
  const goTo = (i: number) => { if (locked(i)) return; setAt(i); };
  return (
    <>
      <ol className="sc-rail" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li key={s.key} className={i < at ? 'is-done' : i === at ? 'is-now' : ''}>
            <button type="button" className="sc-dot" onClick={() => goTo(i)} disabled={locked(i)} aria-current={i === at ? 'step' : undefined} aria-label={`Step ${i + 1}: ${s.title}`}>
              {i < at ? <Check aria-hidden="true" /> : i + 1}
            </button>
            <span className="sc-lbl">{s.rail}</span>
          </li>
        ))}
      </ol>
      <h3 className="sc-step-h">{step.title}</h3>
      <p className="sc-step-sub">{step.sub}</p>
      <div className="sc-panel" key={step.key}>
        {step.key === 'doIt' && (
          <details open className="mb-3 text-xs text-white/60">
            <summary className="cursor-pointer text-white/50">What this changes</summary>
            <div className="mt-1">{slots.explain}</div>
          </details>
        )}
        {slots[step.key]}
        {message}
      </div>
      {held && <p className="text-xs text-yellow-200 mt-3" role="status">{held}</p>}
      <div className="sc-nav">
        {at > 0 ? <button type="button" className="sc-back" onClick={() => setAt(at - 1)}><ArrowLeft aria-hidden="true" />Back</button> : <span />}
        {!last && <button type="button" className="sc-go" disabled={!!held} onClick={() => goTo(at + 1)}>Continue<ArrowRight aria-hidden="true" /></button>}
      </div>
    </>
  );
}

export function WizardFrame({ title, status, check, explain, doIt, prove, undo, testSignal = 0, holdSetup = null, message = null }: Props) {
  const messageLine = message && <p className={`mt-2 text-xs ${message.ok ? 'text-green-300' : 'text-red-300'}`} role="status">{message.text}</p>;
  const shell = useContext(WizardShellContext);
  const tone = isValidElement(status) ? ((status.props as { tone?: Tone }).tone ?? null) : null;
  const setTone = shell?.setTone;
  useEffect(() => { setTone?.(tone); }, [setTone, tone]);

  if (shell) {
    return (
      <>
        {shell.cardStatusEl && createPortal(status, shell.cardStatusEl)}
        {shell.modalStatusEl && createPortal(status, shell.modalStatusEl)}
        {shell.bodyEl && createPortal(<Pager slots={{ check, explain, doIt, prove, undo }} startAt={tone === 'good' ? TEST_STEP : DO_STEP} testSignal={testSignal} holdSetup={holdSetup} message={messageLine} />, shell.bodyEl)}
      </>
    );
  }
  return (
    <div className="glass-card p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {status}
      </div>
      <Section n={1} title="What is true now">{check}</Section>
      <Section n={2} title="What this changes">{explain}</Section>
      <Section n={3} title="Do it">{doIt}</Section>
      <Section n={4} title="Check that it works">{prove}</Section>
      <Section n={5} title="Undo">{undo}</Section>
      {messageLine}
    </div>
  );
}
