'use client';

/**
 * The dialog behind every Set up more card: logo, headline and status at the top, setup below.
 * Escape or a click outside closes it; focus moves in, stays in, and returns to the card that opened it.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface Props {
  title: string;
  subtitle?: string;
  /** Small extras under the subtitle (an instance may add links here). */
  extras?: React.ReactNode;
  logo: ReactNode;
  status?: ReactNode;
  /** For a status that lives inside a wizard: the wizard portals its status into this element. */
  statusSlotRef?: (el: HTMLElement | null) => void;
  /** The element the wizard portals its steps into. */
  bodyRef?: (el: HTMLElement | null) => void;
  onClose: () => void;
  children?: ReactNode;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function SetupModal({ title, subtitle, extras, logo, status, statusSlotRef, bodyRef, onClose, children }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const scrollY = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    return () => { document.body.style.overflow = scrollY; opener?.focus?.(); };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current(); return; }
    if (e.key !== 'Tab' || !dialog.current) return;
    const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="sc-scrim mg-scope" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} className="sc-dialog" role="dialog" aria-modal="true" aria-labelledby="sc-dialog-title" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="sc-dh">
          {logo}
          <div className="sc-dh-text">
            <h2 id="sc-dialog-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
            {extras}
            <span className="sc-status" ref={statusSlotRef}>{status}</span>
          </div>
          <button type="button" className="sc-x" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className="sc-db" ref={bodyRef}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
