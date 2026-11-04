'use client';

/**
 * Lets a setup wizard live on a card. The wizard stays mounted (so it keeps what it has read and typed) and WizardFrame
 * portals its status onto the card, and its five steps into the dialog when that is open. Outside a shell, WizardFrame
 * draws itself in place as before.
 */
import { uiExtensions } from '@/instance/ui';
import { createContext, useMemo, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SetupCard } from '@/components/setup-cards/SetupCard';
import { SetupModal } from '@/components/setup-cards/SetupModal';
import { Logo } from '@/components/setup-cards/Logo';

export type Tone = 'good' | 'warn' | 'idle';

export interface WizardShellValue {
  cardStatusEl: HTMLElement | null;
  modalStatusEl: HTMLElement | null;
  bodyEl: HTMLElement | null;
  setTone: (tone: Tone | null) => void;
}

export const WizardShellContext = createContext<WizardShellValue | null>(null);

export interface WizardMeta {
  headline: string;
  summary: string;
  why: string[];
  brand?: string;
  Glyph: LucideIcon;
  recommended?: string;
}

export function WizardCard({ meta, children }: { meta: WizardMeta; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [cardStatusEl, setCardStatusEl] = useState<HTMLElement | null>(null);
  const [modalStatusEl, setModalStatusEl] = useState<HTMLElement | null>(null);
  const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null);
  const [tone, setTone] = useState<Tone | null>(null);
  const value = useMemo(() => ({ cardStatusEl, modalStatusEl, bodyEl, setTone }), [cardStatusEl, modalStatusEl, bodyEl]);
  return (
    <WizardShellContext.Provider value={value}>
      <SetupCard
        logo={<Logo brand={meta.brand} Glyph={meta.Glyph} />}
        headline={meta.headline}
        summary={meta.summary}
        why={meta.why}
        recommended={meta.recommended}
        statusSlotRef={setCardStatusEl}
        ready={tone === 'good'}
        onOpen={() => setOpen(true)}
      />
      {open && (
        <SetupModal
          title={meta.headline}
          subtitle={meta.summary}
          extras={uiExtensions.wizardCardLinks.map((Link, i) => <Link key={i} topic={meta.headline} />)}
          logo={<Logo brand={meta.brand} Glyph={meta.Glyph} size="lg" />}
          statusSlotRef={setModalStatusEl}
          bodyRef={setBodyEl}
          onClose={() => setOpen(false)}
        />
      )}
      {children}
    </WizardShellContext.Provider>
  );
}
