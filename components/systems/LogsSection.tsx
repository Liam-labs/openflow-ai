'use client';

import React, {
  useState, useEffect, useCallback, useRef, useDeferredValue,
} from 'react';
import {
  ScrollText, Search, RefreshCw, X, ChevronDown, Radio, Settings, Bug,
} from 'lucide-react';
import type { UnifiedLogEntry, LogSource, LogSeverity } from '@/lib/log-types';
import { useLogsTail } from '@/lib/hooks/useLogsTail';
import dynamic from 'next/dynamic';
import { LogsConfigPanel } from './LogsConfigPanel';
import type { LoggingConfig } from './LogsConfigPanel';
const LogsEntryList = dynamic(
  () => import('./LogsEntryList').then(m => ({ default: m.LogsEntryList })),
  { ssr: false }
);
const LogsTimeline = dynamic(
  () => import('./LogsTimeline').then(m => ({ default: m.LogsTimeline })),
  { ssr: false }
);
const MemoryChart = dynamic(
  () => import('./MemoryChart').then(m => ({ default: m.MemoryChart })),
  { ssr: false }
);
import { LogsDetailDrawer } from './LogsDetailDrawer';

// ─── Constants ────────────────────────────────────────────────────────────────

export type TimePreset = '1h' | '6h' | '24h' | '7d' | '30d';

const TIME_PRESETS: { id: TimePreset; label: string }[] = [
  { id: '1h',  label: '1h'  },
  { id: '6h',  label: '6h'  },
  { id: '24h', label: '24h' },
  { id: '7d',  label: '7d'  },
  { id: '30d', label: '30d' },
];

const SOURCE_CONFIG: {
  id: LogSource;
  label: string;
  color: string;
  activeClass: string;
}[] = [
  { id: 'agent',   label: 'Agent',   color: 'var(--df-accent)',   activeClass: 'logs-pill--agent'   },
  { id: 'api',     label: 'API',     color: 'var(--df-success)',  activeClass: 'logs-pill--api'     },
  { id: 'cron',    label: 'Cron',    color: 'var(--df-warning)',  activeClass: 'logs-pill--cron'    },
  { id: 'service', label: 'Service', color: 'var(--df-purple)',   activeClass: 'logs-pill--service' },
  { id: 'build',   label: 'Build',   color: 'var(--df-info)',     activeClass: 'logs-pill--build'   },
  { id: 'error',   label: 'Error',   color: 'var(--df-error)',    activeClass: 'logs-pill--error'   },
  { id: 'tools',   label: 'Tools',   color: 'var(--df-pink)',     activeClass: 'logs-pill--tools'   },
  { id: 'crash',   label: 'Crash',   color: '#b91c1c',            activeClass: 'logs-pill--crash'   },
];

const SEVERITY_CONFIG: {
  id: LogSeverity;
  label: string;
  activeClass: string;
}[] = [
  { id: 'critical', label: 'Crit',   activeClass: 'logs-pill--sev-critical' },
  { id: 'high',     label: 'High',   activeClass: 'logs-pill--sev-high'     },
  { id: 'medium',   label: 'Med',    activeClass: 'logs-pill--sev-medium'   },
  { id: 'low',      label: 'Low',    activeClass: 'logs-pill--sev-low'      },
  { id: 'info',     label: 'Info',   activeClass: 'logs-pill--sev-info'     },
  { id: 'debug',    label: 'Debug',  activeClass: 'logs-pill--sev-debug'    },
];

const VERBOSE_LS_KEY = 'logs-verbose-mode';

function presetToMs(preset: TimePreset): number {
  switch (preset) {
    case '1h':  return 60 * 60 * 1000;
    case '6h':  return 6 * 60 * 60 * 1000;
    case '24h': return 24 * 60 * 60 * 1000;
    case '7d':  return 7 * 24 * 60 * 60 * 1000;
    case '30d': return 30 * 24 * 60 * 60 * 1000;
  }
}

function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LogsSection() {
  const [entries, setEntries]               = useState<UnifiedLogEntry[]>([]);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState<string | null>(null);
  const [sourcesActive, setSourcesActive]   = useState<Set<LogSource>>(new Set());
  const [severitiesActive, setSevActive]    = useState<Set<LogSeverity>>(new Set());
  const [timePreset, setTimePreset]         = useState<TimePreset>('24h');
  const [rangeFrom, setRangeFrom]           = useState(() => Date.now() - presetToMs('24h'));
  const [rangeTo, setRangeTo]               = useState(() => Date.now());
  const [searchRaw, setSearchRaw]           = useState('');
  const [toolsMenuOpen, setToolsMenuOpen]   = useState(false);
  const [toolFilter, setToolFilter]         = useState<string | null>(null);
  const [drawerEntry, setDrawerEntry]       = useState<UnifiedLogEntry | null>(null);
  const [sourceCounts, setSourceCounts]     = useState<Partial<Record<LogSource, number>>>({});
  const [timePickerOpen, setTimePickerOpen]     = useState(false);
  const [customFromInput, setCustomFromInput]   = useState('');
  const [customToInput, setCustomToInput]       = useState('');
  const [appliedFrom, setAppliedFrom]           = useState('');
  const [appliedTo, setAppliedTo]               = useState('');
  const [verboseMode, setVerboseMode]           = useState(false);
  const [verboseToggling, setVerboseToggling]   = useState(false);
  const [configPanelOpen, setConfigPanelOpen]   = useState(false);
  const toolsMenuRef    = useRef<HTMLDivElement>(null);
  const timePickerRef   = useRef<HTMLDivElement>(null);
  const timeFromInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef  = useRef<HTMLInputElement>(null);
  const searchDebounce  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Live tail ──────────────────────────────────────────────────────────────
  const {
    tailEntries,
    isLive,
    pendingCount,
    enableLive,
    disableLive,
    clearEntries: clearTailEntries,
  } = useLogsTail();
  const [searchQuery, setSearchQuery]       = useState('');
  const deferredSearch = useDeferredValue(searchQuery);

  // ── Verbose mode init from localStorage ────────────────────────────────────
  useEffect(() => {
    try {
      const stored = localStorage.getItem(VERBOSE_LS_KEY);
      if (stored === 'true') setVerboseMode(true);
    } catch { /* SSR guard */ }
  }, []);

  // ── Verbose toggle ──────────────────────────────────────────────────────────
  const toggleVerboseMode = useCallback(async () => {
    const next = !verboseMode;
    setVerboseMode(next);
    try { localStorage.setItem(VERBOSE_LS_KEY, String(next)); } catch { /* SSR guard */ }
    setVerboseToggling(true);
    try {
      await fetch('/api/logs/config', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ logLevel: next ? 'debug' : 'info' }),
      });
    } catch { /* non-fatal — UI state already toggled */ }
    finally { setVerboseToggling(false); }
  }, [verboseMode]);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchLogs = useCallback(async () => {
    try {
      const now    = Date.now();
      const fromMs = appliedFrom ? new Date(appliedFrom).getTime() : (now - presetToMs(timePreset));
      const toMs   = appliedTo   ? new Date(appliedTo).getTime()   : now;
      setRangeFrom(fromMs);
      setRangeTo(toMs);

      const params = new URLSearchParams();
      params.set('from', new Date(fromMs).toISOString());
      params.set('to',   new Date(toMs).toISOString());
      params.set('limit', '1000');
      if (sourcesActive.size > 0) {
        [...sourcesActive].forEach(s => params.append('sources', s));
      }
      if (severitiesActive.size > 0) {
        [...severitiesActive].forEach(s => params.append('severity', s));
      }
      if (deferredSearch) params.set('search', deferredSearch);

      const res = await fetch(`/api/logs?${params}`);
      if (res.status === 404) {
        setError('pending');
        return;
      }
      if (!res.ok) { setError('fetch'); return; }

      const data = await res.json() as {
        entries: UnifiedLogEntry[];
        sources: Partial<Record<LogSource, number>>;
      };
      setEntries(data.entries ?? []);
      setSourceCounts(data.sources ?? {});
      setError(null);
    } catch {
      setError('fetch');
    } finally {
      setLoading(false);
    }
  }, [timePreset, sourcesActive, severitiesActive, deferredSearch, appliedFrom, appliedTo]);

  useEffect(() => {
    clearTailEntries();
    fetchLogs();
  }, [fetchLogs, clearTailEntries]);

  // ── Search debounce ────────────────────────────────────────────────────────
  const handleSearchChange = useCallback((val: string) => {
    setSearchRaw(val);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => setSearchQuery(val), 300);
  }, []);

  // ── Time picker helpers ────────────────────────────────────────────────────
  const handleOpenTimePicker = useCallback(() => {
    setCustomFromInput(appliedFrom);
    setCustomToInput(appliedTo);
    setTimePickerOpen(true);
  }, [appliedFrom, appliedTo]);

  const applyCustomRange = useCallback(() => {
    setAppliedFrom(customFromInput);
    setAppliedTo(customToInput);
    setTimePickerOpen(false);
  }, [customFromInput, customToInput]);

  const clearCustomRange = useCallback(() => {
    setCustomFromInput('');
    setCustomToInput('');
    setAppliedFrom('');
    setAppliedTo('');
    setTimePickerOpen(false);
  }, []);

  // Focus from-input when picker opens
  useEffect(() => {
    if (timePickerOpen) {
      const t = setTimeout(() => timeFromInputRef.current?.focus(), 16);
      return () => clearTimeout(t);
    }
  }, [timePickerOpen]);

  // ── Tools sub-menu close on outside click ──────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(e.target as Node)) {
        setToolsMenuOpen(false);
      }
      if (timePickerRef.current && !timePickerRef.current.contains(e.target as Node)) {
        setTimePickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Keyboard shortcuts (j/k/Enter/Esc handled inside LogsEntryList) ────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      if (inInput) return;

      if (e.key === '1') { e.preventDefault(); setTimePreset('1h');  setAppliedFrom(''); setAppliedTo(''); return; }
      if (e.key === '6') { e.preventDefault(); setTimePreset('6h');  setAppliedFrom(''); setAppliedTo(''); return; }
      if (e.key === 'd') { e.preventDefault(); setTimePreset('24h'); setAppliedFrom(''); setAppliedTo(''); return; }
      if (e.key === 'w') { e.preventDefault(); setTimePreset('7d');  setAppliedFrom(''); setAppliedTo(''); return; }
      if (e.key === 'g') { e.preventDefault(); handleOpenTimePicker(); return; }
      if (e.key === '/') { e.preventDefault(); searchInputRef.current?.focus(); return; }
      if (e.key === 'L') { e.preventDefault(); isLive ? disableLive() : enableLive(); return; }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isLive, enableLive, disableLive, handleOpenTimePicker]);

  // ── Toggle helpers ─────────────────────────────────────────────────────────
  const toggleSource = useCallback((id: LogSource) => {
    setSourcesActive(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSeverity = useCallback((id: LogSeverity) => {
    setSevActive(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setSourcesActive(new Set());
    setSevActive(new Set());
    setToolFilter(null);
    setSearchRaw('');
    setSearchQuery('');
    setTimePreset('24h');
    setAppliedFrom('');
    setAppliedTo('');
    setTimePickerOpen(false);
  }, []);

  const hasFilters =
    sourcesActive.size > 0 || severitiesActive.size > 0 || !!deferredSearch || timePreset !== '24h' || !!appliedFrom;

  // ── Discover tools in data ─────────────────────────────────────────────────
  const toolNames = Array.from(
    new Set(
      entries
        .filter(e => e.source === 'tools')
        .map(e => (e.metadata as { tool?: string }).tool ?? 'unknown')
    )
  );

  // ── Filter entries client-side for tool sub-filter + verbose mode ─────────
  const filteredEntries = entries.filter(e => {
    if (!verboseMode && (e.severity as string) === 'debug') return false;
    if (toolFilter && e.source === 'tools') {
      return (e.metadata as { tool?: string }).tool === toolFilter;
    }
    return true;
  });

  // ── Merge live tail entries (deduplicate by id) ────────────────────────────
  const fetchedIds = new Set(filteredEntries.map(e => e.id));
  const newTailEntries = tailEntries.filter(e => !fetchedIds.has(e.id));
  const visibleEntries = newTailEntries.length > 0
    ? [...filteredEntries, ...newTailEntries]
    : filteredEntries;

  // ── Header counts ──────────────────────────────────────────────────────────
  const criticalCount = entries.filter(e => e.severity === 'critical').length;
  const highCount     = entries.filter(e => e.severity === 'high').length;

  // ── Events/hr sparkline — last 12 hourly buckets from fetched entries ──────
  const eventsPerHour = React.useMemo(() => {
    const now = Date.now();
    const buckets = Array.from({ length: 12 }, (_, i) => ({
      start: now - (12 - i) * 3_600_000,
      end:   now - (11 - i) * 3_600_000,
      count: 0,
    }));
    for (const e of entries) {
      const t = new Date(e.timestamp).getTime();
      const b = buckets.find(b => t >= b.start && t < b.end);
      if (b) b.count++;
    }
    return buckets.map(b => b.count);
  }, [entries]);

  return (
    <div className={`logs-section${drawerEntry ? ' logs-section--drawer-open' : ''}`}>
      {/* ── Stat pills ───────────────────────────────────────────────────── */}
      <div className="logs-stats">
        <span className="logs-stat-pill logs-stat-pill--total">
          {entries.length.toLocaleString()} events
        </span>
        {criticalCount > 0 && (
          <span className="logs-stat-pill logs-stat-pill--crit">
            {criticalCount} critical
          </span>
        )}
        {highCount > 0 && (
          <span className="logs-stat-pill logs-stat-pill--high">
            {highCount} high
          </span>
        )}
        <span className="logs-stat-pill logs-stat-pill--spark" aria-label="Events per hour (last 12h)">
          <EventsSparkline data={eventsPerHour} />
          <span className="logs-stat-pill__spark-label">events/hr</span>
        </span>
        <span className="logs-stats__spacer" />

        {/* Resume button — shown when paused with pending entries */}
        {!isLive && pendingCount > 0 && (
          <button
            className="logs-resume-btn"
            onClick={enableLive}
            aria-label={`Resume live tail, ${pendingCount} new entries waiting`}
          >
            ↓ Resume ({pendingCount} new)
          </button>
        )}

        {/* Verbose mode toggle */}
        <button
          className={`logs-verbose-btn ${verboseMode ? 'logs-verbose-btn--active' : ''}`}
          onClick={toggleVerboseMode}
          disabled={verboseToggling}
          title={verboseMode ? 'Disable verbose mode' : 'Enable verbose mode — shows debug entries'}
          aria-label={verboseMode ? 'Disable verbose mode' : 'Enable verbose mode'}
          aria-pressed={verboseMode}
        >
          {verboseMode && <span className="logs-verbose-dot" aria-hidden="true" />}
          <Bug size={12} />
          {verboseMode ? 'Verbose' : 'Verbose'}
        </button>

        {/* Live tail toggle */}
        <button
          className={`logs-live-btn ${isLive ? 'logs-live-btn--active' : ''}`}
          onClick={() => isLive ? disableLive() : enableLive()}
          title={isLive ? 'Pause live tail (L)' : 'Enable live tail (L)'}
          aria-label={isLive ? 'Pause live tail' : 'Enable live tail'}
          aria-pressed={isLive}
        >
          {isLive && <span className="logs-live-dot" aria-hidden="true" />}
          <Radio size={12} />
          {isLive ? 'Live' : 'Tail'}
        </button>

        <button
          className="logs-refresh-btn"
          onClick={fetchLogs}
          title="Refresh logs"
          aria-label="Refresh log entries"
        >
          <RefreshCw size={12} />
        </button>

        <button
          className={`logs-refresh-btn ${configPanelOpen ? 'logs-refresh-btn--active' : ''}`}
          onClick={() => setConfigPanelOpen(v => !v)}
          title="Log config settings"
          aria-label="Open log config settings"
          aria-expanded={configPanelOpen}
        >
          <Settings size={12} />
        </button>
      </div>

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="logs-toolbar">
        {/* Source pills row */}
        <div className="logs-toolbar__row">
          <div className="logs-pill-group">
            {SOURCE_CONFIG.map(src => {
              const active = sourcesActive.has(src.id);
              const count  = sourceCounts[src.id];
              const isTools = src.id === 'tools';

              if (isTools) {
                return (
                  <div key="tools" className="logs-tools-wrap" ref={toolsMenuRef}>
                    <button
                      className={`logs-pill ${active ? `logs-pill--active ${src.activeClass}` : ''}`}
                      onClick={() => {
                        toggleSource(src.id);
                        if (!active) setToolsMenuOpen(false);
                      }}
                    >
                      {src.label}
                      {count !== undefined && <span className="logs-pill__count">{count}</span>}
                    </button>
                    {toolNames.length > 0 && (
                      <button
                        className="logs-tools-caret"
                        onClick={() => setToolsMenuOpen(v => !v)}
                        aria-label="Filter by specific tool"
                      >
                        <ChevronDown size={10} />
                      </button>
                    )}
                    {toolsMenuOpen && toolNames.length > 0 && (
                      <div className="logs-tools-menu">
                        <button
                          className={`logs-tools-menu__item ${!toolFilter ? 'logs-tools-menu__item--active' : ''}`}
                          onClick={() => { setToolFilter(null); setToolsMenuOpen(false); }}
                        >
                          All tools
                          <span className="logs-pill__count">{count ?? 0}</span>
                        </button>
                        {toolNames.map(tool => (
                          <button
                            key={tool}
                            className={`logs-tools-menu__item ${toolFilter === tool ? 'logs-tools-menu__item--active' : ''}`}
                            onClick={() => { setToolFilter(tool); setToolsMenuOpen(false); }}
                          >
                            {tool}
                            <span className="logs-pill__count">
                              {entries.filter(e => (e.metadata as { tool?: string }).tool === tool).length}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <button
                  key={src.id}
                  className={`logs-pill ${active ? `logs-pill--active ${src.activeClass}` : ''}`}
                  onClick={() => toggleSource(src.id)}
                >
                  {src.label}
                  {count !== undefined && <span className="logs-pill__count">{count}</span>}
                </button>
              );
            })}
          </div>

          <div className="logs-toolbar__sep" />

          {/* Severity pills */}
          <div className="logs-pill-group">
            {SEVERITY_CONFIG.map(sev => {
              const active = severitiesActive.has(sev.id);
              return (
                <button
                  key={sev.id}
                  className={`logs-pill ${active ? `logs-pill--active ${sev.activeClass}` : ''}`}
                  onClick={() => toggleSeverity(sev.id)}
                >
                  {sev.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Time range + search row */}
        <div className="logs-toolbar__row logs-toolbar__row--bottom">
          {/* Time presets */}
          <div className="logs-time-group">
            {TIME_PRESETS.map(p => (
              <button
                key={p.id}
                className={`logs-time-btn ${!appliedFrom && timePreset === p.id ? 'logs-time-btn--active' : ''}`}
                onClick={() => { setTimePreset(p.id); setAppliedFrom(''); setAppliedTo(''); }}
              >
                {p.label}
              </button>
            ))}

            {/* Crashes compound preset */}
            {(() => {
              const active = !appliedFrom && timePreset === '30d' &&
                sourcesActive.size === 1 && sourcesActive.has('crash') &&
                severitiesActive.size === 1 && severitiesActive.has('critical');
              return (
                <button
                  className={`logs-time-btn logs-time-btn--crashes ${active ? 'logs-time-btn--active logs-time-btn--crashes-active' : ''}`}
                  onClick={() => {
                    setTimePreset('30d');
                    setSourcesActive(new Set<LogSource>(['crash']));
                    setSevActive(new Set<LogSeverity>(['critical']));
                    setAppliedFrom('');
                    setAppliedTo('');
                  }}
                  title="Crashes: crash source + critical severity, last 30d"
                >
                  Crashes
                </button>
              );
            })()}

            {/* Go to time picker */}
            <div className="logs-go-wrap" ref={timePickerRef}>
              <button
                className={`logs-time-btn logs-go-btn ${appliedFrom ? 'logs-time-btn--active' : ''}`}
                onClick={() => timePickerOpen ? setTimePickerOpen(false) : handleOpenTimePicker()}
                title="Go to time (g)"
                aria-expanded={timePickerOpen}
                aria-haspopup="true"
              >
                go
              </button>
              {timePickerOpen && (
                <div className="logs-go-picker" role="dialog" aria-label="Custom time range">
                  <label className="logs-go-picker__label">
                    From
                    <input
                      ref={timeFromInputRef}
                      type="datetime-local"
                      className="logs-go-picker__input"
                      value={customFromInput}
                      onChange={e => setCustomFromInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') applyCustomRange();
                        if (e.key === 'Escape') setTimePickerOpen(false);
                      }}
                    />
                  </label>
                  <label className="logs-go-picker__label">
                    To
                    <input
                      type="datetime-local"
                      className="logs-go-picker__input"
                      value={customToInput}
                      onChange={e => setCustomToInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') applyCustomRange();
                        if (e.key === 'Escape') setTimePickerOpen(false);
                      }}
                    />
                  </label>
                  <div className="logs-go-picker__actions">
                    <button
                      className="logs-go-picker__apply"
                      onClick={applyCustomRange}
                      disabled={!customFromInput}
                    >
                      Apply
                    </button>
                    {appliedFrom && (
                      <button className="logs-go-picker__clear" onClick={clearCustomRange}>
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="logs-toolbar__sep" />

          {/* Search */}
          <div className="logs-search">
            <Search size={12} className="logs-search__icon" />
            <input
              ref={searchInputRef}
              className="logs-search__input"
              type="text"
              placeholder="Search logs… (/)"
              value={searchRaw}
              onChange={e => handleSearchChange(e.target.value)}
              aria-label="Search log entries"
            />
            {searchRaw && (
              <button
                className="logs-search__clear"
                onClick={() => handleSearchChange('')}
                aria-label="Clear search"
              >
                <X size={11} />
              </button>
            )}
          </div>

          {hasFilters && (
            <button className="logs-clear-btn" onClick={clearFilters}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Timeline scrubber ────────────────────────────────────────────── */}
      <LogsTimeline
        from={rangeFrom}
        to={rangeTo}
        onBrushChange={(f, t) => {
          setAppliedFrom(toDatetimeLocal(f));
          setAppliedTo(toDatetimeLocal(t));
        }}
        onBrushClear={() => {
          setAppliedFrom('');
          setAppliedTo('');
        }}
      />

      {/* ── Memory usage chart ───────────────────────────────────────────── */}
      <MemoryChart from={rangeFrom} to={rangeTo} />

      {/* ── Log entry list + drawer row ──────────────────────────────────── */}
      <div className="logs-main-row">
        <div className="logs-list-wrap">
          {loading ? (
            <LogsSkeleton />
          ) : error === 'pending' ? (
            <LogsPending />
          ) : error ? (
            <LogsError onRetry={fetchLogs} />
          ) : visibleEntries.length === 0 ? (
            <LogsEmpty hasFilters={hasFilters} />
          ) : (
            <LogsEntryList
              entries={visibleEntries}
              searchQuery={deferredSearch}
              autoScrollToBottom={isLive}
              onUserScrollUp={disableLive}
              onOpenDetails={setDrawerEntry}
            />
          )}
        </div>

        <LogsDetailDrawer
          entry={drawerEntry}
          onClose={() => setDrawerEntry(null)}
        />
      </div>

      <LogsConfigPanel
        open={configPanelOpen}
        onClose={() => setConfigPanelOpen(false)}
        onConfigChange={(cfg) => {
          // Sync verbose mode state if config panel changes the log level
          const isDebug = cfg.logLevel === 'debug';
          setVerboseMode(isDebug);
          try { localStorage.setItem(VERBOSE_LS_KEY, String(isDebug)); } catch { /* SSR guard */ }
        }}
      />
    </div>
  );
}

// ─── Events sparkline ─────────────────────────────────────────────────────────

function EventsSparkline({ data }: { data: number[] }) {
  const W = 36, H = 14;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - (v / max) * (H - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.7"
      />
    </svg>
  );
}

// ─── States ───────────────────────────────────────────────────────────────────

function LogsSkeleton() {
  return (
    <div className="logs-skeleton">
      {[...Array(8)].map((_, i) => (
        <div key={i} className="logs-skeleton__row" style={{ opacity: 1 - i * 0.1 }} />
      ))}
    </div>
  );
}

function LogsPending() {
  return (
    <div className="logs-empty-state">
      <ScrollText size={28} className="logs-empty-state__icon" />
      <span className="logs-empty-state__title">Backend building</span>
      <span className="logs-empty-state__hint">
        The /api/logs endpoint is being built.
        Events are already flowing to disk — data will appear here when the API is ready.
      </span>
    </div>
  );
}

function LogsError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="logs-empty-state">
      <span className="logs-empty-state__title">Failed to load logs</span>
      <button className="logs-retry-btn" onClick={onRetry}>Retry</button>
    </div>
  );
}

function LogsEmpty({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="logs-empty-state">
      <ScrollText size={28} className="logs-empty-state__icon" />
      <span className="logs-empty-state__title">
        {hasFilters ? 'No matching entries' : 'No log entries'}
      </span>
      {hasFilters && (
        <span className="logs-empty-state__hint">Try adjusting filters or time range</span>
      )}
    </div>
  );
}
