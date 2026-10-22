'use client';

import React from 'react';
import {
  Check,
  CheckCircle2,
  ExternalLink,
  ImageOff,
  Layers3,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  MAX_COMBINED_REFERENCES,
  type DesignReferenceBoard,
  type DesignReferenceCandidate,
  type DesignReferenceSelection,
  type DesignReferenceUseMode,
} from '@/lib/design-references/types';

interface DesignReferenceBoardCardProps {
  board: DesignReferenceBoard;
  currentParticipantId: string | null;
  resolvedSelection?: DesignReferenceSelection | null;
  onSelection: (selection: DesignReferenceSelection) => void | Promise<void>;
}

type PriceFilter = 'all' | 'free' | 'paid';
type ModeFilter = 'all' | DesignReferenceUseMode;

const USE_MODE_LABELS: Record<DesignReferenceUseMode, string> = {
  'inspiration-only': 'Inspiration only',
  'purchase-and-adapt': 'Purchase & adapt',
  'open-source-base': 'Open-source base',
};

function formatPrice(candidate: DesignReferenceCandidate): string {
  if (!candidate.price || candidate.price.amount === 0) return 'Free';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: candidate.price.currency,
      maximumFractionDigits: 2,
    }).format(candidate.price.amount);
  } catch {
    return `${candidate.price.currency} ${candidate.price.amount}`;
  }
}

function candidateLabel(board: DesignReferenceBoard, candidateId: string): string {
  return board.candidates.find(candidate => candidate.id === candidateId)?.title ?? candidateId;
}

export function DesignReferenceBoardCard({
  board,
  currentParticipantId,
  resolvedSelection,
  onSelection,
}: DesignReferenceBoardCardProps) {
  const [localSelection, setLocalSelection] = React.useState<DesignReferenceSelection | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());
  const [sourceFilter, setSourceFilter] = React.useState('all');
  const [priceFilter, setPriceFilter] = React.useState<PriceFilter>('all');
  const [modeFilter, setModeFilter] = React.useState<ModeFilter>('all');
  const [refineOpen, setRefineOpen] = React.useState(false);
  const [refineNote, setRefineNote] = React.useState('');
  const [failedImages, setFailedImages] = React.useState<Set<string>>(() => new Set());
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const selection = resolvedSelection ?? localSelection;
  const sources = React.useMemo(
    () => Array.from(new Set(board.candidates.map(candidate => candidate.source))).sort(),
    [board.candidates],
  );
  const candidates = React.useMemo(() => (
    board.candidates
      .filter(candidate => sourceFilter === 'all' || candidate.source === sourceFilter)
      .filter(candidate => {
        if (priceFilter === 'all') return true;
        const isFree = !candidate.price || candidate.price.amount === 0;
        return priceFilter === 'free' ? isFree : !isFree;
      })
      .filter(candidate => modeFilter === 'all' || candidate.useMode === modeFilter)
      .sort((a, b) => b.fitScore - a.fitScore)
  ), [board.candidates, modeFilter, priceFilter, sourceFilter]);

  const submit = (action: DesignReferenceSelection['action'], candidateIds: string[], note?: string) => {
    const next: DesignReferenceSelection = {
      boardId: board.id,
      channelId: board.channelId,
      boardRevision: board.revision,
      boardFingerprint: board.fingerprint,
      action,
      candidateIds,
      ...(note?.trim() ? { note: note.trim() } : {}),
      answeredBy: currentParticipantId ?? 'browser-user',
      answeredAt: new Date().toISOString(),
    };
    setSubmitError(null);
    setLocalSelection(next);
    void Promise.resolve(onSelection(next)).catch((error: unknown) => {
      setLocalSelection(null);
      setSubmitError(
        error instanceof Error && error.message.trim()
          ? error.message
          : 'That decision could not be saved. Please try again.',
      );
    });
  };

  const toggleCandidate = (candidateId: string) => {
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (next.has(candidateId)) next.delete(candidateId);
      else if (next.size < MAX_COMBINED_REFERENCES) next.add(candidateId);
      return next;
    });
  };

  if (selection) {
    const selectedLabels = selection.candidateIds.map(id => candidateLabel(board, id));
    return (
      <section className="w-full rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.05] px-4 py-4" aria-label="Design reference decision">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300/80">Direction selected</p>
            <p className="mt-1 text-sm font-semibold text-white">
              {selection.action === 'refine'
                ? 'Refine the search'
                : selection.action === 'use-one'
                  ? selectedLabels[0]
                  : `Combine ${selectedLabels.join(' + ')}`}
            </p>
            {selection.note && <p className="mt-1 text-xs leading-relaxed text-white/55">{selection.note}</p>}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="w-full overflow-hidden rounded-2xl border border-amber-300/20 bg-[#0b1524] shadow-[0_24px_70px_-35px_rgba(245,158,11,0.55)]" aria-labelledby={`design-board-${board.id}`}>
      <header className="relative overflow-hidden border-b border-white/10 px-4 py-5 sm:px-5">
        <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-amber-400/10 blur-3xl" />
        <div className="relative flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-amber-300/80">
              <span className="inline-flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5" /> Visual direction board
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/20 bg-amber-300/[0.08] px-2 py-1 tracking-[0.14em] text-amber-200">
                <ShieldAlert className="h-3 w-3" /> Build paused
              </span>
            </div>
            <h3 id={`design-board-${board.id}`} className="mt-2 text-xl font-semibold tracking-tight text-white">
              Choose the design DNA before we build
            </h3>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-white/55">{board.brief}</p>
          </div>
          <div className="shrink-0 rounded-xl border border-amber-300/15 bg-amber-300/[0.06] px-3 py-2 text-right">
            <span className="block text-xl font-semibold tabular-nums text-amber-200">{board.candidates.length}</span>
            <span className="text-[10px] uppercase tracking-wider text-white/40">ranked references</span>
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.08] bg-white/[0.025] px-4 py-3 sm:px-5" aria-label="Reference filters">
        <select
          value={sourceFilter}
          onChange={event => setSourceFilter(event.target.value)}
          className="min-h-10 rounded-lg border border-white/10 bg-[#101d30] px-3 text-xs text-white/75 outline-none focus:border-amber-300/50 focus:ring-2 focus:ring-amber-300/20"
          aria-label="Filter by source"
        >
          <option value="all">All sources</option>
          {sources.map(source => <option key={source} value={source}>{source}</option>)}
        </select>
        <select
          value={priceFilter}
          onChange={event => setPriceFilter(event.target.value as PriceFilter)}
          className="min-h-10 rounded-lg border border-white/10 bg-[#101d30] px-3 text-xs text-white/75 outline-none focus:border-amber-300/50 focus:ring-2 focus:ring-amber-300/20"
          aria-label="Filter by price"
        >
          <option value="all">Any price</option>
          <option value="free">Free</option>
          <option value="paid">Paid</option>
        </select>
        <select
          value={modeFilter}
          onChange={event => setModeFilter(event.target.value as ModeFilter)}
          className="min-h-10 rounded-lg border border-white/10 bg-[#101d30] px-3 text-xs text-white/75 outline-none focus:border-amber-300/50 focus:ring-2 focus:ring-amber-300/20"
          aria-label="Filter by permitted use"
        >
          <option value="all">Any use mode</option>
          {Object.entries(USE_MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <span className="ml-auto text-[11px] text-white/35">Sorted by project fit</span>
      </div>

      <div className="grid grid-cols-1 gap-3 p-3 sm:p-4 lg:grid-cols-2 2xl:grid-cols-3">
        {candidates.map((candidate, index) => {
          const selected = selectedIds.has(candidate.id);
          const selectionFull = selectedIds.size >= MAX_COMBINED_REFERENCES && !selected;
          return (
            <article
              key={candidate.id}
              className={`group flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white/[0.035] transition-colors ${selected ? 'border-amber-300/70 bg-amber-300/[0.07]' : 'border-white/10 hover:border-white/20'}`}
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-[#152238]">
                {failedImages.has(candidate.id) ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-[#172840] to-[#0b1524] text-white/30">
                    <ImageOff className="h-7 w-7" />
                    <span className="text-xs">Preview unavailable — open live demo</span>
                  </div>
                ) : (
                  <img
                    src={candidate.imageUrl}
                    alt={`${candidate.title} website template preview`}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={() => setFailedImages(previous => new Set(previous).add(candidate.id))}
                    className="h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.025]"
                  />
                )}
                <div className="absolute left-2 top-2 rounded-md border border-black/20 bg-black/70 px-2 py-1 text-[10px] font-semibold text-white/80 backdrop-blur-md">
                  {String(index + 1).padStart(2, '0')} · {candidate.source}
                </div>
                <div className="absolute right-2 top-2 grid h-11 w-11 place-items-center rounded-full border border-amber-200/30 bg-[#0b1524]/90 text-sm font-bold text-amber-200 shadow-lg backdrop-blur-md" title="Project fit score">
                  {Math.round(candidate.fitScore)}
                </div>
                <button
                  type="button"
                  onClick={() => toggleCandidate(candidate.id)}
                  disabled={selectionFull}
                  aria-pressed={selected}
                  aria-label={`${selected ? 'Remove' : 'Add'} ${candidate.title} ${selected ? 'from' : 'to'} combined direction`}
                  className={`absolute bottom-2 right-2 flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold backdrop-blur-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70 disabled:cursor-not-allowed disabled:opacity-40 ${selected ? 'border-amber-200/60 bg-amber-300 text-[#251400]' : 'border-white/20 bg-black/70 text-white hover:border-amber-200/50 hover:text-amber-100'}`}
                >
                  {selected ? <Check className="h-3.5 w-3.5" /> : <Layers3 className="h-3.5 w-3.5" />}
                  {selected ? 'Selected' : 'Combine'}
                </button>
              </div>

              <div className="flex flex-1 flex-col p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="truncate text-sm font-semibold text-white" title={candidate.title}>{candidate.title}</h4>
                    <p className="mt-0.5 truncate text-[11px] text-white/40">
                      {candidate.creator ? `by ${candidate.creator} · ` : ''}{candidate.platform}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs font-semibold text-amber-200">{formatPrice(candidate)}</span>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] text-white/60">
                    {candidate.licence.status === 'clear' ? <ShieldCheck className="h-3 w-3 text-emerald-300" /> : <ShieldAlert className="h-3 w-3 text-amber-300" />}
                    {USE_MODE_LABELS[candidate.useMode]}
                  </span>
                  {candidate.popularity && (
                    <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] text-white/60" title={`${candidate.popularity.label}; ${candidate.popularity.confidence} confidence`}>
                      {candidate.popularity.label}: {candidate.popularity.value} · {candidate.popularity.confidence} confidence
                    </span>
                  )}
                  {candidate.stack.slice(0, 3).map(item => (
                    <span key={item} className="rounded-md border border-blue-300/10 bg-blue-300/[0.05] px-2 py-1 text-[10px] text-blue-100/60">{item}</span>
                  ))}
                </div>

                <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-white/60">
                  {candidate.fitReasons.slice(0, 2).map(reason => (
                    <li key={reason} className="flex gap-2"><span className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-amber-300/80" />{reason}</li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] leading-relaxed text-white/35"><span className="text-white/50">Trade-off:</span> {candidate.tradeoff}</p>

                <div className="mt-auto flex items-center gap-2 pt-4">
                  <button
                    type="button"
                    onClick={() => submit('use-one', [candidate.id])}
                    className="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-amber-300 px-3 text-xs font-bold text-[#251400] transition-colors hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/70"
                  >
                    Use this direction
                  </button>
                  <a
                    href={candidate.previewUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open live preview for ${candidate.title}`}
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-white/10 text-white/55 transition-colors hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/60"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-white/30">
                  <span>Captured {new Date(candidate.capturedAt).toLocaleDateString()}</span>
                  {candidate.licence.url && <a href={candidate.licence.url} target="_blank" rel="noreferrer" className="underline decoration-white/20 underline-offset-2 hover:text-white/60">Licence</a>}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {candidates.length === 0 && (
        <div className="mx-4 mb-4 rounded-xl border border-dashed border-white/15 px-4 py-10 text-center text-sm text-white/40">
          No references match those filters.
        </div>
      )}

      <footer className="sticky bottom-0 border-t border-white/10 bg-[#0b1524]/95 px-4 py-3 backdrop-blur-xl sm:px-5">
        {submitError && (
          <p role="alert" className="mb-2 rounded-lg border border-red-400/20 bg-red-400/[0.08] px-3 py-2 text-xs text-red-200">
            {submitError}
          </p>
        )}
        {refineOpen ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <textarea
              autoFocus
              rows={2}
              value={refineNote}
              onChange={event => setRefineNote(event.target.value)}
              placeholder="What should change? e.g. warmer, more editorial, fewer dashboard patterns…"
              className="min-h-11 flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-white/30 outline-none focus:border-amber-300/50 focus:ring-2 focus:ring-amber-300/15"
            />
            <button
              type="button"
              onClick={() => submit('refine', [], refineNote)}
              className="min-h-11 rounded-lg border border-amber-300/40 bg-amber-300/10 px-4 text-xs font-semibold text-amber-100 hover:bg-amber-300/15"
            >
              Send refinement
            </button>
            <button type="button" onClick={() => setRefineOpen(false)} className="min-h-11 rounded-lg px-3 text-xs text-white/45 hover:bg-white/[0.05] hover:text-white/70">Cancel</button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 text-xs text-white/45">
              {selectedIds.size === 0
                ? `Select 2-${MAX_COMBINED_REFERENCES} cards to blend their strongest traits.`
                : `${selectedIds.size} selected: ${Array.from(selectedIds).map(id => candidateLabel(board, id)).join(' + ')}`}
            </div>
            <button
              type="button"
              onClick={() => setRefineOpen(true)}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-white/10 px-4 text-xs font-semibold text-white/60 hover:border-white/20 hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refine search
            </button>
            <button
              type="button"
              disabled={selectedIds.size < 2 || selectedIds.size > MAX_COMBINED_REFERENCES}
              onClick={() => submit('combine', Array.from(selectedIds))}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-amber-300 px-4 text-xs font-bold text-[#251400] hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <Layers3 className="h-3.5 w-3.5" /> Combine selected
            </button>
          </div>
        )}
      </footer>
    </section>
  );
}
