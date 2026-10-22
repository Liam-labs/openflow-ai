'use client';

/**
 * Sprint 5 — Agent Live-Feed Drawer (updated).
 *
 * Changes from Sprint 36 baseline:
 *   - Default view is now 'summary' (spec §12 / T6)
 *   - Sticky "Now Doing" strip: shows the latest in-flight InterpretedAction
 *     (tool_use with outcome === null). Disappears when idle. (T6)
 *   - Summary and Full views now render interpreted action rows (T5, via
 *     SummaryView.tsx / FullView.tsx).
 */

import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Radio, WifiOff, FileStack, RotateCw, Loader2, CheckCircle2 } from 'lucide-react';
import { interpretStream, type InterpretedAction } from '@/lib/agent-stream-interpret';
import { useAgentStream } from './useAgentStream';
import { buildToolUseIndex, filterForSummary } from './helpers';
import { FullView } from './FullView';
import { SummaryView } from './SummaryView';
import { getIcon } from './iconMap';

export type AgentStreamView = 'full' | 'summary';

const THINKING_ACTION: InterpretedAction = {
  icon: 'brain', verb: 'Thinking', subject: '', detail: '',
  outcome: null, tone: 'neutral', toolName: '_thinking', toolUseId: '',
};
const WRITING_ACTION: InterpretedAction = {
  icon: 'sparkles', verb: 'Writing', subject: '', detail: '',
  outcome: null, tone: 'neutral', toolName: '_text', toolUseId: '',
};

export interface AgentStreamDrawerProps {
  /** Agent display name (what /api/agent-stream?agent=<name> expects). Null/undefined hides the drawer. */
  agent: string | null;
  /** Channel the agent belongs to — scopes the feed to the correct channel. */
  channelId?: string | null;
  open: boolean;
  onClose: () => void;
}

export function AgentStreamDrawer({
  agent,
  channelId,
  open,
  onClose,
}: AgentStreamDrawerProps) {
  // Sprint 5: default to summary view (spec §12 / T6)
  const [view, setView] = useState<AgentStreamView>('summary');
  const { items, meta, connectionState, error, rotatedPath } = useAgentStream(
    open ? agent : null,
    channelId,
  );
  const [paused, setPaused] = useState(false);
  const [rotatedNoticeDismissed, setRotatedNoticeDismissed] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastScrollRef = useRef(0);

  const toolUseIndex = useMemo(() => buildToolUseIndex(items), [items]);
  const visibleItems = useMemo(
    () => (view === 'summary' ? filterForSummary(items) : items),
    [items, view],
  );

  // Sprint 5 T6: compute in-flight action for NowDoing strip.
  // Walk all items (not just visible) so thinking blocks don't hide the current call.
  const interpretedAll = useMemo(() => interpretStream(items), [items]);
  const nowDoing = useMemo(() => {
    for (let i = interpretedAll.length - 1; i >= 0; i--) {
      const a = interpretedAll[i];
      if (a && a.outcome === null) return a;
    }
    return null;
  }, [interpretedAll]);

  // When no tool is in-flight, show the most recent completed action so the
  // strip never disappears — the agent is always doing *something* worth showing.
  const lastDoing = useMemo(() => {
    if (nowDoing) return null;
    for (let i = interpretedAll.length - 1; i >= 0; i--) {
      const a = interpretedAll[i];
      if (a && a.outcome !== null) return a;
    }
    return null;
  }, [interpretedAll, nowDoing]);

  // Detect active thinking/writing between tool calls. Walk raw items backwards:
  // if the most recent agent activity (before any tool boundary) is a thinking
  // or text block, the agent is currently generating — show that state with the
  // spinner so the owner always sees real-time activity, not just tool calls.
  // Text items use a 20-second recency gate to avoid showing stale state.
  const generatingKind = useMemo((): 'thinking' | 'text' | null => {
    if (nowDoing) return null;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it) continue;
      if (it.kind === 'tool_use' || it.kind === 'tool_result') return null;
      if (it.kind === 'thinking') return 'thinking';
      if (it.kind === 'text') {
        const age = Date.now() - new Date(it.timestamp).getTime();
        return age < 20_000 ? 'text' : null;
      }
    }
    return null;
  }, [items, nowDoing]);

  // Auto-scroll to the bottom whenever new items arrive, unless the user has
  // manually scrolled up.
  React.useEffect(() => {
    if (paused) return;
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.clientHeight - el.scrollTop;
    if (distanceFromBottom > 80 && el.scrollTop < lastScrollRef.current) {
      return;
    }
    el.scrollTop = el.scrollHeight;
    lastScrollRef.current = el.scrollTop;
  }, [visibleItems, paused]);

  React.useEffect(() => {
    if (rotatedPath) setRotatedNoticeDismissed(false);
  }, [rotatedPath]);

  if (!open || !agent) return null;

  const statusLabel = labelForState(connectionState, error);
  const isLive = connectionState === 'open';

  // Portal to document.body so position:fixed escapes any transformed ancestor
  // (on mobile, ColabRightPanel uses translate-x transforms that create a new
  // stacking context and trap fixed descendants — portal breaks out of it).
  return createPortal(
    <aside
      className="agent-stream-drawer"
      role="complementary"
      aria-label={`Live feed for ${agent}`}
    >
      <header className="agent-stream-drawer__header">
        <div className="agent-stream-drawer__title-row">
          <Radio
            className={`agent-stream-drawer__pulse ${
              isLive ? 'agent-stream-drawer__pulse--live' : ''
            }`}
            aria-hidden="true"
          />
          <div className="agent-stream-drawer__title">
            <span className="agent-stream-drawer__eyebrow">LIVE FEED</span>
            <span className="agent-stream-drawer__agent">{agent}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="agent-stream-drawer__close"
            aria-label="Close live feed"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Now Doing strip — shows in-flight tool (NOW) or generating state (THINK/WRITE). Hidden when idle. */}
        {(nowDoing ?? (generatingKind === 'thinking' ? THINKING_ACTION : generatingKind === 'text' ? WRITING_ACTION : null)) && (
          <NowDoingStrip
            action={(nowDoing ?? (generatingKind === 'thinking' ? THINKING_ACTION : WRITING_ACTION))!}
            live={isLive}
            mode={nowDoing ? 'now' : 'generating'}
          />
        )}

        <div
          className="agent-stream-drawer__toggle"
          role="tablist"
          aria-label="View mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === 'summary'}
            className={`agent-stream-drawer__toggle-btn ${
              view === 'summary' ? 'is-active' : ''
            }`}
            onClick={() => setView('summary')}
          >
            Summary
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'full'}
            className={`agent-stream-drawer__toggle-btn ${
              view === 'full' ? 'is-active' : ''
            }`}
            onClick={() => setView('full')}
          >
            Full
          </button>
        </div>

        <div className="agent-stream-drawer__meta">
          <span
            className={`agent-stream-drawer__status agent-stream-drawer__status--${connectionState}`}
          >
            {connectionState === 'error' && (
              <WifiOff className="w-3 h-3" aria-hidden="true" />
            )}
            {statusLabel}
          </span>
          {meta && (
            <span
              className="agent-stream-drawer__path"
              title={meta.path}
            >
              {shortPath(meta.path)}
              <span className="agent-stream-drawer__resolved">
                {meta.resolvedVia}
              </span>
            </span>
          )}
        </div>

        {rotatedPath && !rotatedNoticeDismissed && (
          <div
            role="status"
            className="agent-stream-drawer__notice"
          >
            <RotateCw className="w-3 h-3" aria-hidden="true" />
            Session rotated — stream continues.
            <button
              type="button"
              className="agent-stream-drawer__notice-dismiss"
              onClick={() => setRotatedNoticeDismissed(true)}
              aria-label="Dismiss rotation notice"
            >
              ×
            </button>
          </div>
        )}
      </header>

      <div
        ref={scrollRef}
        className="agent-stream-drawer__body"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        {visibleItems.length === 0 ? (
          <EmptyState connectionState={connectionState} error={error} />
        ) : view === 'full' ? (
          <FullView items={visibleItems} toolUseIndex={toolUseIndex} />
        ) : (
          <SummaryView items={visibleItems} toolUseIndex={toolUseIndex} />
        )}
      </div>

      {paused && visibleItems.length > 0 && (
        <div className="agent-stream-drawer__pause-indicator" role="status">
          Auto-scroll paused
        </div>
      )}
    </aside>,
    document.body,
  );
}

// ── Now Doing strip ───────────────────────────────────────────────────

function NowDoingStrip({
  action, live, mode,
}: {
  action: InterpretedAction;
  live: boolean;
  mode: 'now' | 'generating' | 'last';
}) {
  const Icon = getIcon(action.icon);
  const isActive = mode === 'now' || mode === 'generating';
  const label = mode === 'now' ? 'NOW' : mode === 'generating' ? (action.toolName === '_thinking' ? 'THINK' : 'WRITE') : 'LAST';
  return (
    <div
      className={`asd-now-doing${live && isActive ? ' asd-now-doing--live' : ''}${!isActive ? ' asd-now-doing--idle' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={isActive ? `Agent: ${action.verb} ${action.subject}` : `Last: ${action.verb} ${action.subject}`}
    >
      {isActive ? (
        <Loader2 className="asd-now-doing__spinner w-3 h-3" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="asd-now-doing__done w-3 h-3" aria-hidden="true" />
      )}
      <span className="asd-now-doing__label">{label}</span>
      <span className={`asd-now-doing__icon asd-now-doing__icon--${action.tone}`} aria-hidden="true">
        <Icon className="w-3 h-3" />
      </span>
      <span className="asd-now-doing__verb">{action.verb}</span>
      {action.subject && (
        <strong className="asd-now-doing__subject" title={action.subject}>
          {action.subject}
        </strong>
      )}
      {action.detail && (
        <span className="asd-now-doing__detail">{action.detail}</span>
      )}
    </div>
  );
}

// ── Supporting components ─────────────────────────────────────────────

function EmptyState({
  connectionState,
  error,
}: {
  connectionState: string;
  error: string | null;
}) {
  if (connectionState === 'error') {
    return (
      <div className="agent-stream-drawer__empty agent-stream-drawer__empty--error">
        <WifiOff className="w-6 h-6" aria-hidden="true" />
        <p>Stream unavailable</p>
        {error && <small>{error}</small>}
      </div>
    );
  }
  if (connectionState === 'connecting') {
    return (
      <div className="agent-stream-drawer__empty">
        <FileStack className="w-6 h-6 agent-stream-drawer__empty-icon--spin" aria-hidden="true" />
        <p>Connecting…</p>
      </div>
    );
  }
  return (
    <div className="agent-stream-drawer__empty">
      <FileStack className="w-6 h-6" aria-hidden="true" />
      <p>Waiting for activity</p>
      <small>Events appear as soon as the agent does anything.</small>
    </div>
  );
}

function labelForState(state: string, error: string | null): string {
  if (state === 'open') return 'live';
  if (state === 'connecting') return 'connecting';
  if (state === 'error') return error || 'error';
  if (state === 'closed') return 'closed';
  return 'idle';
}

function shortPath(p: string): string {
  if (!p) return '';
  const parts = p.split('/');
  return parts.slice(-2).join('/');
}
