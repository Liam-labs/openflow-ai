'use client';
import type { ReactNode } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
export interface ProofLine { name: string; ok: boolean; detail: string }
export function StatusPill({ tone, children }: { tone: 'good' | 'warn' | 'idle'; children: ReactNode }) {
  return <span className={`text-sm ${tone === 'good' ? 'text-green-300' : tone === 'warn' ? 'text-amber-300' : 'text-white/60'}`}>{children}</span>;
}
export function ProofList({ lines, busy }: { lines: ProofLine[] | null; busy?: boolean }) {
  if (busy) return <p role="status" className="flex items-center gap-2 text-sm"><Loader2 size={16} className="animate-spin" />Testing the connection…</p>;
  if (!lines) return <p className="text-sm text-white/60">Nothing tested yet.</p>;
  return <ul aria-label="Test results" className="space-y-3">{lines.map(line => <li key={line.name} className="flex items-start gap-2 text-sm">{line.ok ? <CheckCircle2 className="shrink-0 text-green-400" size={18} /> : <XCircle className="shrink-0 text-red-300" size={18} />}<span><strong>{line.ok ? 'Passed' : 'Failed'}: {line.name}.</strong> {line.detail}</span></li>)}</ul>;
}
export function WizardFrame({ title, status, check, explain, doIt, prove, undo }: {
  title: string; status: ReactNode; check: ReactNode; explain: ReactNode; doIt: ReactNode; prove: ReactNode; undo: ReactNode; testSignal?: number; holdSetup?: string | null;
}) {
  return <div className="glass-card min-w-0 space-y-6 p-4 sm:p-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{title}</h2>{status}</header>
    {[['Check your connection', check], ['What will change', explain], ['Connect', doIt], ['Test the connection', prove], ['Disconnect', undo]].map(([label, content], index) => <section key={index} className="space-y-3 border-t border-white/10 pt-4"><h3 className="text-sm font-semibold">{index + 1}. {label}</h3>{content}</section>)}
  </div>;
}
