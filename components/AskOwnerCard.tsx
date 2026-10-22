'use client';
import React from 'react';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';
import { HelpCircle, CheckCircle, Clock, Pencil, Send, X } from 'lucide-react';
import {
  OTHER_OPTION_ID,
  type StructuredQuestion,
  type StructuredAnswer,
  type AskOwnerOption,
} from '@/lib/ask-owner/types';

const DEFERRED_OPTION_ID = '__deferred__';

interface AskOwnerCardProps {
  question: StructuredQuestion;
  currentParticipantId: string | null;
  /** Answer resolved from a correlated envelope / the stored question (cross-client / reload). */
  resolvedAnswer?: StructuredAnswer | null;
  /** Post the StructuredAnswer (parent rides it on metadata.client; server hides + routes). */
  onAnswer: (answer: StructuredAnswer) => void | Promise<void>;
  /** Hide this answered card from the local chat view without deleting its message record. */
  onDismiss?: () => void;
}

/**
 * Inline, non-blocking card that renders an ask-owner.question for the owner to answer
 * with one click. Single-select = click an option; multiSelect = checkboxes + Submit.
 * A SEPARATE "Other" path (allowOther / OTHER_OPTION_ID, never inside options[])
 * opens a free-text textarea. On answer the card collapses to show the selection.
 * Close X top-right defers the question — sends the asking agent a deferred notice.
 */
export function AskOwnerCard({ question, currentParticipantId, resolvedAnswer, onAnswer, onDismiss }: AskOwnerCardProps) {
  const [localAnswer, setLocalAnswer] = React.useState<StructuredAnswer | null>(null);
  const [otherOpen, setOtherOpen] = React.useState(false);
  const [otherText, setOtherText] = React.useState('');
  const [checked, setChecked] = React.useState<Set<string>>(() => new Set());

  const answer = question.answer ?? resolvedAnswer ?? localAnswer;
  const answered = question.status === 'answered' || !!answer;
  const isDeferred = answered && answer?.selectedOptionIds?.includes(DEFERRED_OPTION_ID);

  const buildAnswer = (ids: string[], labels: string[], free?: string): StructuredAnswer => ({
    questionId: question.id,
    selectedOptionIds: ids,
    selectedLabels: labels,
    ...(free ? { otherText: free } : {}),
    answeredBy: currentParticipantId ?? 'browser-user',
    answeredAt: new Date().toISOString(),
  });

  const submit = (a: StructuredAnswer) => {
    setLocalAnswer(a);
    void onAnswer(a);
  };

  const handleDefer = () => {
    submit(buildAnswer(
      [DEFERRED_OPTION_ID],
      [`${HUMAN_ROUTING_NAME} has deferred answering the question for now`],
    ));
  };

  const pickOne = (opt: AskOwnerOption) => submit(buildAnswer([opt.id], [opt.label]));

  const submitOther = () => {
    const t = otherText.trim();
    if (!t) return;
    submit(buildAnswer([OTHER_OPTION_ID], [t], t));
  };

  const toggleChecked = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const submitMulti = () => {
    const ids: string[] = [];
    const labels: string[] = [];
    for (const o of question.options) {
      if (checked.has(o.id)) {
        ids.push(o.id);
        labels.push(o.label);
      }
    }
    let free: string | undefined;
    if (checked.has(OTHER_OPTION_ID)) {
      const t = otherText.trim();
      if (t) {
        ids.push(OTHER_OPTION_ID);
        labels.push(t);
        free = t;
      }
    }
    if (ids.length === 0) return;
    submit(buildAnswer(ids, labels, free));
  };

  // ── Collapsed (answered / deferred) ──────────────────────────────────────────
  if (answered && answer) {
    return (
      <div className="ask-owner-card mt-1 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 max-w-[36rem]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
            <HelpCircle className="w-3.5 h-3.5 text-blue-400/70 flex-shrink-0" />
            <span className="truncate">{question.questionText}</span>
          </div>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="inline-flex min-h-8 flex-shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50"
              aria-label="Dismiss answered question"
              title="Dismiss this answered question"
            >
              <X className="w-3 h-3" /> Dismiss
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {isDeferred ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-white/40">
              <Clock className="w-3.5 h-3.5" /> Deferred
            </span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-300">
                <CheckCircle className="w-3.5 h-3.5" /> Answered
              </span>
              {answer.selectedLabels.map((label, i) => (
                <span
                  key={i}
                  className="inline-flex items-center px-2 py-0.5 rounded-md text-xs bg-blue-500/15 text-blue-200 border border-blue-500/25 break-words"
                >
                  {label}
                </span>
              ))}
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Interactive ───────────────────────────────────────────────────────────────
  return (
    <div className="ask-owner-card mt-1 rounded-xl border border-blue-500/20 bg-gradient-to-b from-blue-500/[0.08] to-blue-500/[0.04] px-3.5 py-3.5 max-w-[36rem]">

      {/* Card header — icon + header chip + defer X */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
          <HelpCircle className="w-4 h-4 text-blue-400 flex-shrink-0 mt-px" />
          {question.header && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-blue-500/20 text-blue-200 border border-blue-500/30 flex-shrink-0">
              {question.header}
            </span>
          )}
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-400/10 text-amber-300/90 border border-amber-400/20 select-none flex-shrink-0">
            Awaiting your answer
          </span>
        </div>
        {/* Prominent close/defer button — sends deferred notice to asking agent */}
        <button
          type="button"
          onClick={handleDefer}
          className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-white/35 hover:text-white/75 hover:bg-white/10 active:bg-white/15 transition-colors mt-px"
          aria-label="Defer — skip for now"
          title="Defer — I'll answer this later"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Question text — prominent heading */}
      <p className="text-[15px] font-semibold text-white leading-snug mb-4 break-words" style={{ overflowWrap: 'anywhere' }}>
        {question.questionText}
      </p>

      {/* Options */}
      <div className="flex flex-col gap-1.5">
        {question.options.map((opt) =>
          question.multiSelect ? (
            <label
              key={opt.id}
              className="flex items-start gap-2.5 px-3 py-2.5 min-h-[44px] rounded-lg border border-white/10 bg-white/[0.04] hover:bg-blue-500/10 hover:border-blue-500/35 transition-colors cursor-pointer"
            >
              <input
                type="checkbox"
                checked={checked.has(opt.id)}
                onChange={() => toggleChecked(opt.id)}
                className="mt-0.5 accent-blue-500 w-4 h-4 flex-shrink-0"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-white/90">{opt.label}</span>
                {opt.description && <span className="block text-xs text-muted mt-0.5">{opt.description}</span>}
              </span>
            </label>
          ) : (
            <button
              key={opt.id}
              type="button"
              onClick={() => pickOne(opt)}
              className="text-left px-3 py-2.5 min-h-[44px] rounded-lg border border-white/10 bg-white/[0.04] hover:bg-blue-500/15 hover:border-blue-500/45 active:bg-blue-500/20 active:scale-[0.99] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
            >
              <span className="block text-sm font-medium text-white/90">{opt.label}</span>
              {opt.description && <span className="block text-xs text-muted mt-0.5">{opt.description}</span>}
            </button>
          ),
        )}

        {/* Separate Other path — always available (allowOther) */}
        {question.allowOther && !otherOpen && (
          <button
            type="button"
            onClick={() => {
              setOtherOpen(true);
              if (question.multiSelect) toggleChecked(OTHER_OPTION_ID);
            }}
            className="flex items-center gap-2 text-left px-3 py-2.5 min-h-[44px] rounded-lg border border-white/10 bg-white/[0.02] text-muted hover:text-blue-300 hover:bg-blue-500/10 hover:border-blue-500/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
          >
            <Pencil className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="text-sm">Other — type your own answer</span>
          </button>
        )}

        {question.allowOther && otherOpen && (
          <div className="flex flex-col gap-2 pt-0.5">
            <textarea
              autoFocus
              value={otherText}
              rows={8}
              onChange={(e) => setOtherText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setOtherOpen(false);
                  setOtherText('');
                  if (question.multiSelect) toggleChecked(OTHER_OPTION_ID);
                }
              }}
              placeholder="Type your answer…"
              className="w-full px-3 py-2.5 rounded-lg bg-black/30 border border-white/15 text-sm text-white placeholder:text-white/35 focus:outline-none focus:border-blue-500/50 resize-none"
            />
            <div className="flex gap-2">
              {!question.multiSelect && (
                <button
                  type="button"
                  onClick={submitOther}
                  disabled={!otherText.trim()}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-sm font-medium bg-blue-500/20 text-blue-200 border border-blue-500/30 hover:bg-blue-500/30 disabled:opacity-40 transition-colors"
                >
                  <Send className="w-3.5 h-3.5" /> Send
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setOtherOpen(false);
                  setOtherText('');
                  if (question.multiSelect) toggleChecked(OTHER_OPTION_ID);
                }}
                className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm text-muted hover:text-white/80 hover:bg-white/10 transition-colors"
                aria-label="Cancel other answer"
              >
                <X className="w-3.5 h-3.5" /> Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {question.multiSelect && (
        <button
          type="button"
          onClick={submitMulti}
          disabled={checked.size === 0}
          className="mt-3 w-full flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-medium bg-blue-500/20 text-blue-100 border border-blue-500/35 hover:bg-blue-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Send className="w-3.5 h-3.5" /> Submit answer
        </button>
      )}
    </div>
  );
}
