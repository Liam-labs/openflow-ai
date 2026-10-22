'use client';

/**
 * Sprint 5 — Refactored Summary View.
 *
 * Calls interpretStream() once per render (memoised) to pair tool_use +
 * tool_result into a single InterpretedAction row. Merged tool_result items
 * are suppressed (interpretStream returns null at those indices). Non-tool
 * items (text, system, summary) fall through to their existing renderers.
 *
 * Row anatomy: [icon] [VERB] [bold subject] · [muted detail] ··· [✓ outcome]  [ts]
 */

import React, { useMemo, useState } from 'react';
import { FileText, FileDigit } from 'lucide-react';
import {
  interpretStream,
  type InterpretedAction,
} from '@/lib/agent-stream-interpret';
import { formatTimestamp } from './helpers';
import { getIcon } from './iconMap';
import type { StreamItem } from './types';

export interface SummaryViewProps {
  items: StreamItem[];
  /** Kept for API compatibility — no longer used internally. */
  toolUseIndex: Map<string, StreamItem>;
}

export function SummaryView({ items }: SummaryViewProps) {
  const interpreted = useMemo(() => interpretStream(items), [items]);

  return (
    <ol className="agent-stream-drawer__items agent-stream-drawer__items--compact">
      {items.map((item, idx) => {
        const action = interpreted[idx];

        // Merged tool_result — suppress; it's shown as the outcome on its tool_use row.
        if (item.kind === 'tool_result' && action === null) return null;

        const ts = formatTimestamp(item.timestamp);

        if (action !== null && action !== undefined) {
          return (
            <li
              key={item.id}
              className={`agent-stream-drawer__item agent-stream-drawer__item--compact asd-item--interpreted is-${action.tone}`}
              data-role={item.role}
            >
              <ExpandableActionRow
                action={action}
                ts={ts}
                rawInput={item.kind === 'tool_use' ? item.toolInput : undefined}
              />
            </li>
          );
        }

        // Non-tool items (text, system, summary) — render as before.
        return (
          <li
            key={item.id}
            className={`agent-stream-drawer__item agent-stream-drawer__item--compact agent-stream-drawer__item--${item.kind}`}
            data-role={item.role}
          >
            <PlainItem item={item} ts={ts} />
          </li>
        );
      })}
    </ol>
  );
}

// ── Interpreted action row (expandable) ───────────────────────────────

interface ExpandableActionRowProps {
  action: InterpretedAction;
  ts: string;
  rawInput?: Record<string, unknown> | undefined;
}

function ExpandableActionRow({ action, ts, rawInput }: ExpandableActionRowProps) {
  const [open, setOpen] = useState(false);
  const Icon = getIcon(action.icon);

  const json = useMemo(() => {
    if (!rawInput) return null;
    try {
      return JSON.stringify(rawInput, null, 2);
    } catch {
      return null;
    }
  }, [rawInput]);

  const hasExpand = json !== null;
  const pending = action.outcome === null;

  return (
    <>
      <button
        type="button"
        onClick={() => hasExpand && setOpen((v) => !v)}
        className={`asd-action-row${hasExpand ? ' asd-action-row--expandable' : ''}`}
        aria-expanded={hasExpand ? open : undefined}
        tabIndex={hasExpand ? 0 : -1}
        style={{ cursor: hasExpand ? 'pointer' : 'default' }}
      >
        <span className={`asd-action-row__icon asd-action-row__icon--${action.tone}`} aria-hidden="true">
          <Icon className="w-3 h-3" />
        </span>

        <span className="asd-action-row__verb">{action.verb}</span>

        {action.subject && (
          <strong className="asd-action-row__subject" title={action.subject}>
            {action.subject}
          </strong>
        )}

        {action.detail && (
          <span className="asd-action-row__detail" aria-label={action.detail}>
            {action.detail}
          </span>
        )}

        <span className="asd-action-row__spacer" />

        {pending ? (
          <span className="asd-action-row__pending" aria-label="in progress">
            <span className="asd-action-row__pending-dot" />
            <span className="asd-action-row__pending-dot" />
            <span className="asd-action-row__pending-dot" />
          </span>
        ) : action.outcome ? (
          <span
            className={`asd-action-row__outcome ${action.outcome.ok ? 'is-ok' : 'is-err'}`}
            title={action.outcome.summary}
          >
            {action.outcome.count !== undefined
              ? `${action.outcome.ok ? '✓' : '✗'} ${action.outcome.count} ${action.outcome.countLabel ?? ''}`
              : action.outcome.summary}
          </span>
        ) : null}

        {ts && <time className="agent-stream-drawer__item-ts">{ts}</time>}

        {hasExpand && (
          <span className="asd-action-row__chevron" aria-hidden="true">
            {open ? '−' : '+'}
          </span>
        )}
      </button>

      {open && json && (
        <pre className="agent-stream-drawer__tool-input asd-action-row__json">{json}</pre>
      )}
    </>
  );
}

// ── Plain item fallback (text / system / summary) ─────────────────────

function PlainItem({ item, ts }: { item: StreamItem; ts: string }) {
  if (item.kind === 'text') {
    return (
      <>
        <div className="agent-stream-drawer__item-head">
          <span className="agent-stream-drawer__item-icon">
            <FileText className="w-3 h-3" aria-hidden="true" />
          </span>
          <span className="agent-stream-drawer__item-label">
            {item.role === 'user' ? 'user' : 'assistant'}
          </span>
          {ts && <time className="agent-stream-drawer__item-ts">{ts}</time>}
        </div>
        <div className="agent-stream-drawer__text">{item.text || ''}</div>
      </>
    );
  }

  if (item.kind === 'system' || item.kind === 'summary') {
    return (
      <>
        <div className="agent-stream-drawer__item-head">
          <span className="agent-stream-drawer__item-icon">
            <FileDigit className="w-3 h-3" aria-hidden="true" />
          </span>
          <span className="agent-stream-drawer__item-label">{item.kind}</span>
          {ts && <time className="agent-stream-drawer__item-ts">{ts}</time>}
        </div>
        <p className="agent-stream-drawer__system">{item.text || ''}</p>
      </>
    );
  }

  return null;
}
