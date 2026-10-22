'use client';

import React, {
  useState, useEffect, useCallback, useRef, useMemo,
} from 'react';
import { VariableSizeList } from 'react-window';
import { ChevronRight } from 'lucide-react';
import type { UnifiedLogEntry, LogSource, LogSeverity } from '@/lib/log-types';

// ─── Types ────────────────────────────────────────────────────────────────────

type ListItem =
  | { type: 'group-header'; key: string; label: string; count: number; hasCritical: boolean; collapsed: boolean }
  | { type: 'entry'; entry: UnifiedLogEntry };

// ─── Constants ────────────────────────────────────────────────────────────────

const ROW_COLLAPSED  = 36;
const ROW_EXPANDED   = 148;
const ROW_GROUP      = 32;

const SEVERITY_LABELS: Record<LogSeverity, string> = {
  critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', info: 'INFO', debug: 'DBG',
};

const SOURCE_COLORS: Record<LogSource, string> = {
  agent:   'var(--df-accent)',
  api:     'var(--df-success)',
  cron:    'var(--df-warning)',
  service: 'var(--df-purple)',
  build:   'var(--df-info)',
  error:   'var(--df-error)',
  tools:   'var(--df-pink)',
  crash:   '#b91c1c',
  'supabase-backup': 'var(--df-error)',
};

const SEV_COLORS: Record<LogSeverity, string> = {
  critical: 'var(--df-error)',
  high:     '#f97316',
  medium:   'var(--df-warning)',
  low:      'var(--df-text-muted)',
  info:     'var(--df-accent)',
  debug:    'rgba(148,163,184,0.6)',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hourKey(ts: string): string {
  try {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
  } catch { return 'unknown'; }
}

function formatHourLabel(key: string): string {
  try {
    const [y, mo, d, h] = key.split('-').map(Number);
    const today = new Date();
    const isToday =
      today.getFullYear() === y && today.getMonth() === mo && today.getDate() === d;
    const prefix = isToday ? 'Today' : `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return `${prefix} ${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`;
  } catch { return key; }
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const today = now.toDateString() === d.toDateString();
    if (today) {
      return d.toTimeString().slice(0, 8); // HH:MM:SS
    }
    return `${d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })} ${d.toTimeString().slice(0, 5)}`;
  } catch { return iso; }
}

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  try {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
    return parts.map((p, i) =>
      p.toLowerCase() === query.toLowerCase()
        ? <mark key={i} className="logs-highlight">{p}</mark>
        : p
    );
  } catch { return text; }
}

function metaRows(entry: UnifiedLogEntry): { label: string; value: string }[] {
  const m = entry.metadata as Record<string, unknown>;
  const rows: { label: string; value: string }[] = [];
  const add = (label: string, key: string) => {
    if (m[key] !== undefined && m[key] !== null) {
      rows.push({ label, value: String(m[key]) });
    }
  };
  // Source-specific key ordering
  if (entry.source === 'agent') {
    add('Agent',      'agentName');
    add('Event',      'event');
    add('Signal',     'signal');
    add('Exit',       'exitCode');
    add('Memory',     'memoryMB');
    add('Crash #',    'crashCount');
  } else if (entry.source === 'service') {
    add('Service',    'serviceName');
    add('Event',      'event');
    add('Reason',     'reason');
    add('Restarts',   'restartCount');
  } else if (entry.source === 'build') {
    add('Event',      'event');
    add('Build ID',   'buildId');
    add('Duration',   'durationMs');
    add('Trigger',    'trigger');
  } else if (entry.source === 'tools') {
    add('Tool',       'tool');
    add('Event',      'event');
    add('Task ID',    'taskId');
    add('By',         'requestedBy');
    add('URL',        'targetUrl');
    add('Result',     'result');
  } else if (entry.source === 'api') {
    add('Method',     'method');
    add('Path',       'path');
    add('Status',     'status');
    add('Duration',   'durationMs');
  }
  if (entry.details) rows.push({ label: 'Details', value: entry.details });
  return rows.slice(0, 5);
}

// ─── Entry Row ────────────────────────────────────────────────────────────────

function EntryRow({
  entry,
  expanded,
  onToggle,
  onOpenDetails,
  searchQuery,
  style,
}: {
  entry: UnifiedLogEntry;
  expanded: boolean;
  onToggle: () => void;
  onOpenDetails?: (entry: UnifiedLogEntry) => void;
  searchQuery: string;
  style: React.CSSProperties;
}) {
  const sevColor = SEV_COLORS[entry.severity] ?? 'var(--df-text-muted)';
  const srcColor = SOURCE_COLORS[entry.source] ?? 'var(--df-text-muted)';
  const rows     = expanded ? metaRows(entry) : [];

  return (
    <div
      className={`logs-entry ${expanded ? 'logs-entry--expanded' : ''}`}
      style={style}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
    >
      <div className="logs-entry__row">
        <ChevronRight
          size={11}
          className={`logs-entry__chevron ${expanded ? 'logs-entry__chevron--open' : ''}`}
        />
        <span className="logs-entry__ts">{formatTs(entry.timestamp)}</span>
        <span
          className="logs-entry__sev"
          style={{ color: sevColor, borderColor: `${sevColor}44`, background: `${sevColor}14` }}
        >
          {SEVERITY_LABELS[entry.severity]}
        </span>
        <span
          className="logs-entry__src"
          style={{ color: srcColor, borderColor: `${srcColor}44`, background: `${srcColor}14` }}
        >
          {entry.source}
        </span>
        <span className="logs-entry__title">
          {highlight(entry.title, searchQuery)}
        </span>
      </div>

      {expanded && (
        <div className="logs-entry__detail">
          {rows.map((r, i) => (
            <div key={i} className="logs-entry__detail-row">
              <span className="logs-entry__detail-key">{r.label}</span>
              <span className="logs-entry__detail-val">{r.value}</span>
            </div>
          ))}
          {onOpenDetails && (
            <button
              className="logs-entry__open-details"
              onClick={e => { e.stopPropagation(); onOpenDetails(entry); }}
              aria-label="Open full details"
            >
              Open details →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Group Header ─────────────────────────────────────────────────────────────

function GroupHeader({
  label,
  count,
  hasCritical,
  collapsed,
  onToggle,
  style,
}: {
  label: string;
  count: number;
  hasCritical: boolean;
  collapsed: boolean;
  onToggle: () => void;
  style: React.CSSProperties;
}) {
  return (
    <div className="logs-group-header" style={style} onClick={onToggle}>
      <span className="logs-group-header__rule" />
      <span className="logs-group-header__label">{label}</span>
      <span className="logs-group-header__count">
        {count} event{count !== 1 ? 's' : ''}
        {hasCritical && <span className="logs-group-header__crit">● critical</span>}
      </span>
      <span className="logs-group-header__rule" />
      <ChevronRight
        size={11}
        className={`logs-group-header__chevron ${collapsed ? '' : 'logs-group-header__chevron--open'}`}
      />
    </div>
  );
}

// ─── LogsEntryList ────────────────────────────────────────────────────────────

interface LogsEntryListProps {
  entries: UnifiedLogEntry[];
  searchQuery: string;
  /** When true, scrolls to the last item whenever entries change (live tail) */
  autoScrollToBottom?: boolean;
  /** Called when the user manually scrolls upward (disables live tail) */
  onUserScrollUp?: () => void;
  /** Called when the user clicks "Open details →" in an expanded row */
  onOpenDetails?: (entry: UnifiedLogEntry) => void;
}

export function LogsEntryList({
  entries,
  searchQuery,
  autoScrollToBottom,
  onUserScrollUp,
  onOpenDetails,
}: LogsEntryListProps) {
  const listRef         = useRef<VariableSizeList>(null);
  const containerRef    = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(600);
  const [expandedIds, setExpandedIds]         = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [focusedIdx, setFocusedIdx]           = useState<number>(-1);

  // ── Container height tracking ──────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(([e]) => setHeight(e.contentRect.height));
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ── Build list items with grouping ────────────────────────────────────────
  const items = useMemo<ListItem[]>(() => {
    // Group by hour
    const groups = new Map<string, UnifiedLogEntry[]>();
    for (const e of entries) {
      const k = hourKey(e.timestamp);
      const g = groups.get(k) ?? [];
      g.push(e);
      groups.set(k, g);
    }

    const result: ListItem[] = [];
    for (const [key, groupEntries] of groups) {
      const hasCritical = groupEntries.some(
        e => e.severity === 'critical' || e.severity === 'high'
      );
      // Auto-collapse quiet groups (≤2 non-critical events, no critical/high)
      const isQuiet = groupEntries.length <= 2 && !hasCritical;
      if (isQuiet && !collapsedGroups.has(`auto:${key}`) && !collapsedGroups.has(`manual:${key}`)) {
        // Mark as auto-collapsed only on first render
        setCollapsedGroups(prev => {
          if (prev.has(`auto:${key}`) || prev.has(`manual:${key}`)) return prev;
          const next = new Set(prev);
          next.add(`auto:${key}`);
          return next;
        });
      }
      const collapsed = collapsedGroups.has(`auto:${key}`) || collapsedGroups.has(`manual:${key}`);
      result.push({
        type: 'group-header',
        key,
        label: formatHourLabel(key),
        count: groupEntries.length,
        hasCritical,
        collapsed,
      });
      if (!collapsed) {
        for (const e of groupEntries) {
          result.push({ type: 'entry', entry: e });
        }
      }
    }
    return result;
  }, [entries, collapsedGroups]);

  // Only entry items for keyboard nav index
  const entryIndices = useMemo(
    () => items.reduce<number[]>((acc, item, i) => {
      if (item.type === 'entry') acc.push(i);
      return acc;
    }, []),
    [items]
  );

  // ── Auto-scroll to bottom when live tail is active ────────────────────────
  const prevItemCount = useRef(0);
  useEffect(() => {
    if (autoScrollToBottom && items.length > prevItemCount.current) {
      listRef.current?.scrollToItem(items.length - 1, 'end');
    }
    prevItemCount.current = items.length;
  }, [autoScrollToBottom, items.length]);

  // ── Row height function ────────────────────────────────────────────────────
  const getItemSize = useCallback((index: number): number => {
    const item = items[index];
    if (!item) return ROW_COLLAPSED;
    if (item.type === 'group-header') return ROW_GROUP;
    if (item.type === 'entry' && expandedIds.has(item.entry.id)) return ROW_EXPANDED;
    return ROW_COLLAPSED;
  }, [items, expandedIds]);

  // Reset list size cache on expand change
  const prevExpanded = useRef(expandedIds);
  useEffect(() => {
    if (prevExpanded.current !== expandedIds) {
      listRef.current?.resetAfterIndex(0);
      prevExpanded.current = expandedIds;
    }
  }, [expandedIds]);

  // ── Toggle helpers ─────────────────────────────────────────────────────────
  const toggleExpand = useCallback((id: string, listIndex: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    listRef.current?.resetAfterIndex(listIndex);
  }, []);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      // Remove both auto and manual keys, then add manual toggle
      const wasCollapsed = next.has(`auto:${key}`) || next.has(`manual:${key}`);
      next.delete(`auto:${key}`);
      next.delete(`manual:${key}`);
      if (!wasCollapsed) next.add(`manual:${key}`);
      return next;
    });
    listRef.current?.resetAfterIndex(0);
  }, []);

  // ── Keyboard navigation ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIdx(prev => {
          const pos = entryIndices.indexOf(prev);
          const next = entryIndices[Math.min(pos + 1, entryIndices.length - 1)] ?? prev;
          listRef.current?.scrollToItem(next, 'smart');
          return next;
        });
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIdx(prev => {
          const pos = entryIndices.indexOf(prev);
          const next = entryIndices[Math.max(pos - 1, 0)] ?? prev;
          listRef.current?.scrollToItem(next, 'smart');
          return next;
        });
      } else if (e.key === 'Enter' || e.key === 'ArrowRight') {
        if (focusedIdx >= 0) {
          const item = items[focusedIdx];
          if (item?.type === 'entry') toggleExpand(item.entry.id, focusedIdx);
        }
      } else if (e.key === 'Escape' || e.key === 'ArrowLeft') {
        if (focusedIdx >= 0) {
          const item = items[focusedIdx];
          if (item?.type === 'entry') {
            setExpandedIds(prev => {
              const next = new Set(prev);
              next.delete(item.entry.id);
              return next;
            });
          }
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [items, entryIndices, focusedIdx, toggleExpand]);

  // ── Row renderer ──────────────────────────────────────────────────────────
  const Row = useCallback(({ index, style }: { index: number; style: React.CSSProperties }) => {
    const item = items[index];
    if (!item) return null;

    if (item.type === 'group-header') {
      return (
        <GroupHeader
          label={item.label}
          count={item.count}
          hasCritical={item.hasCritical}
          collapsed={item.collapsed}
          onToggle={() => toggleGroup(item.key)}
          style={style}
        />
      );
    }

    const isFocused = index === focusedIdx;
    return (
      <EntryRow
        entry={item.entry}
        expanded={expandedIds.has(item.entry.id)}
        onToggle={() => toggleExpand(item.entry.id, index)}
        onOpenDetails={onOpenDetails}
        searchQuery={searchQuery}
        style={{ ...style, ...(isFocused ? { outline: '1px solid var(--df-accent-30)' } : {}) }}
      />
    );
  }, [items, expandedIds, focusedIdx, searchQuery, onOpenDetails, toggleExpand, toggleGroup]);

  const handleScroll = useCallback(({
    scrollDirection,
    scrollUpdateWasRequested,
  }: { scrollOffset: number; scrollDirection: 'forward' | 'backward'; scrollUpdateWasRequested: boolean }) => {
    // Only fire when user physically scrolls up (not programmatic scrollToItem)
    if (scrollDirection === 'backward' && !scrollUpdateWasRequested) {
      onUserScrollUp?.();
    }
  }, [onUserScrollUp]);

  return (
    <div ref={containerRef} className="logs-entry-list">
      <VariableSizeList
        ref={listRef}
        height={height}
        itemCount={items.length}
        itemSize={getItemSize}
        width="100%"
        overscanCount={8}
        onScroll={handleScroll}
      >
        {Row}
      </VariableSizeList>
    </div>
  );
}
