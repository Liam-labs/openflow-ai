'use client';

/**
 * Sprint 5 — Refactored Full View.
 *
 * Shows every block including thinking. For tool_use items, renders an
 * interpreted headline ABOVE the collapsible raw JSON (spec §12). Merged
 * tool_result items (interpretStream returns null) are suppressed — their
 * outcome is captured in the tool_use row's action.outcome.
 *
 * Non-tool items (thinking, text, system, summary) are unaffected.
 */

import React, { useMemo, useState } from 'react';
import { Brain, FileText, FileDigit, Terminal } from 'lucide-react';
import { interpretStream, type InterpretedAction } from '@/lib/agent-stream-interpret';
import { formatTimestamp } from './helpers';
import { getIcon } from './iconMap';
import type { StreamItem } from './types';

export interface FullViewProps {
  items: StreamItem[];
  /** Kept for API compatibility — no longer used internally. */
  toolUseIndex: Map<string, StreamItem>;
}

export function FullView({ items }: FullViewProps) {
  const interpreted = useMemo(() => interpretStream(items), [items]);

  return (
    <ol className="agent-stream-drawer__items">
      {items.map((item, idx) => {
        const action = interpreted[idx];

        // Merged tool_result — suppress (shown as outcome on tool_use row).
        if (item.kind === 'tool_result' && action === null) return null;

        const ts = formatTimestamp(item.timestamp);

        if (action !== null && action !== undefined) {
          return (
            <li
              key={item.id}
              className={`agent-stream-drawer__item asd-item--interpreted is-${action.tone}`}
              data-role={item.role}
            >
              <FullActionCard
                action={action}
                ts={ts}
                rawInput={item.kind === 'tool_use' ? item.toolInput : undefined}
              />
            </li>
          );
        }

        // Non-tool items — existing renderers.
        return (
          <li
            key={item.id}
            className={`agent-stream-drawer__item agent-stream-drawer__item--${item.kind}`}
            data-role={item.role}
          >
            <PlainFullItem item={item} ts={ts} />
          </li>
        );
      })}
    </ol>
  );
}

// ── Full action card: interpreted headline + collapsible JSON ─────────

interface FullActionCardProps {
  action: InterpretedAction;
  ts: string;
  rawInput?: Record<string, unknown> | undefined;
}

function FullActionCard({ action, ts, rawInput }: FullActionCardProps) {
  const [open, setOpen] = useState(true);
  const Icon = getIcon(action.icon);
  const pending = action.outcome === null;

  const json = useMemo(() => {
    if (!rawInput) return null;
    try {
      return JSON.stringify(rawInput, null, 2);
    } catch {
      return null;
    }
  }, [rawInput]);

  return (
    <div className="asd-full-card">
      {/* Interpreted headline — always visible */}
      <div className="asd-full-card__headline">
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
          <span className="asd-action-row__detail">{action.detail}</span>
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
          >
            {action.outcome.count !== undefined
              ? `${action.outcome.ok ? '✓' : '✗'} ${action.outcome.count} ${action.outcome.countLabel ?? ''}`
              : action.outcome.summary}
          </span>
        ) : null}
        {ts && <time className="agent-stream-drawer__item-ts">{ts}</time>}
        {json && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="agent-stream-drawer__tool-toggle asd-full-card__toggle"
            aria-expanded={open}
            aria-label={open ? 'Collapse input' : 'Expand input'}
          >
            {open ? '−' : '+'}
          </button>
        )}
      </div>

      {/* Collapsible raw JSON — kept for debug fidelity */}
      {open && json && (
        <pre className="agent-stream-drawer__tool-input asd-full-card__json">{json}</pre>
      )}
    </div>
  );
}

// ── Plain item renderers (thinking / text / system / summary) ─────────

function PlainFullItem({ item, ts }: { item: StreamItem; ts: string }) {
  switch (item.kind) {
    case 'thinking':
      return (
        <>
          <div className="agent-stream-drawer__item-head">
            <span className="agent-stream-drawer__item-icon">
              <Brain className="w-3 h-3" aria-hidden="true" />
            </span>
            <span className="agent-stream-drawer__item-label">thinking</span>
            {ts && <time className="agent-stream-drawer__item-ts">{ts}</time>}
          </div>
          <p className="agent-stream-drawer__thinking">{item.text || ''}</p>
        </>
      );
    case 'text':
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
    case 'system':
    case 'summary':
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
    case 'raw':
      return (
        <>
          <div className="agent-stream-drawer__item-head">
            <span className="agent-stream-drawer__item-icon">
              <Terminal className="w-3 h-3" aria-hidden="true" />
            </span>
            <span className="agent-stream-drawer__item-label">log</span>
            {ts && <time className="agent-stream-drawer__item-ts">{ts}</time>}
          </div>
          <pre className="agent-stream-drawer__raw-log">{item.text || ''}</pre>
        </>
      );
    default:
      return null;
  }
}
