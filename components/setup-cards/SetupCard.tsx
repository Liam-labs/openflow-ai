'use client';

/**
 * One Set up more card. Logo, what it is (headline), what it does (summary), and underneath "Why it's worth it" which opens
 * out in place. The card, or its button, opens the setup dialog.
 */
import { useId, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';

interface Props {
  logo: ReactNode;
  /** The product's name, shown beside the logo when the headline is not already the name. */
  name?: string;
  headline: string;
  summary: string;
  why?: string[];
  recommended?: string;
  status?: ReactNode;
  statusSlotRef?: (el: HTMLElement | null) => void;
  chips?: ReactNode;
  /** Already on: the card gets a lit edge and the button says Manage. */
  ready?: boolean;
  onOpen: () => void;
}

export function SetupCard({ logo, name, headline, summary, why, recommended, status, statusSlotRef, chips, ready, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const whyId = useId();
  return (
    <article className={`sc-card${ready ? ' sc-card--ready' : ''}`} onClick={onOpen}>
      <div className="sc-top">
        {logo}
        {name ? <span className="sc-name">{name}</span> : <span className="sc-name" />}
        {recommended && <span className="sc-rec">{recommended}</span>}
        <span className="sc-status" ref={statusSlotRef}>{status}</span>
      </div>
      <h4 className="sc-h">{headline}</h4>
      <p className="sc-sum">{summary}</p>
      {chips && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: -2 }}>{chips}</div>}
      {why && why.length > 0 && (
        <div id={whyId} className={`sc-why${open ? ' sc-why--open' : ''}`} onClick={(e) => e.stopPropagation()}>
          <div {...(open ? {} : { inert: true })}>
            <ul>{why.map((w) => <li key={w}><Check aria-hidden="true" />{w}</li>)}</ul>
          </div>
        </div>
      )}
      <div className="sc-foot">
        {why && why.length > 0 ? (
          <button type="button" className="sc-more" aria-expanded={open} aria-controls={whyId} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
            Why it&apos;s worth it <ChevronDown aria-hidden="true" />
          </button>
        ) : <span />}
        <button type="button" className={`sc-go${ready ? ' sc-go--quiet' : ''}`} onClick={(e) => { e.stopPropagation(); onOpen(); }}>
          {ready ? 'Manage' : 'Set up'}
        </button>
      </div>
    </article>
  );
}
