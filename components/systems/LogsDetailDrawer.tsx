'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { X, Copy, Check, Clock, Hash } from 'lucide-react';
import type { UnifiedLogEntry, LogSource, LogSeverity } from '@/lib/log-types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LogsDetailDrawerProps {
  entry: UnifiedLogEntry | null;
  onClose: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SEV_COLORS: Record<LogSeverity, string> = {
  critical: 'var(--df-error)',
  high:     '#f97316',
  medium:   'var(--df-warning)',
  low:      'var(--df-text-muted)',
  info:     'var(--df-accent)',
  debug:    'rgba(148,163,184,0.6)',
};

const SRC_COLORS: Record<LogSource, string> = {
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

const SEV_LABELS: Record<LogSeverity, string> = {
  critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', info: 'INFO', debug: 'DBG',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFull(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return iso; }
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const today = now.toDateString() === d.toDateString();
    if (today) return d.toTimeString().slice(0, 8);
    return `${d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })} ${d.toTimeString().slice(0, 5)}`;
  } catch { return iso; }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LogsDetailDrawer({ entry, onClose }: LogsDetailDrawerProps) {
  const [relatedEntries, setRelatedEntries]   = useState<UnifiedLogEntry[]>([]);
  const [relatedLoading, setRelatedLoading]   = useState(false);
  const [copied, setCopied]                   = useState(false);

  // Fetch related events (±10s) when entry changes
  useEffect(() => {
    if (!entry) { setRelatedEntries([]); return; }
    setRelatedLoading(true);
    const t = new Date(entry.timestamp).getTime();
    const from = new Date(t - 10_000).toISOString();
    const to   = new Date(t + 10_000).toISOString();
    fetch(`/api/logs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=20`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { entries?: UnifiedLogEntry[] } | null) => {
        if (data?.entries) {
          setRelatedEntries(data.entries.filter(e => e.id !== entry.id));
        }
      })
      .catch(() => {})
      .finally(() => setRelatedLoading(false));
  }, [entry]);

  const handleCopy = useCallback(() => {
    if (!entry) return;
    navigator.clipboard.writeText(JSON.stringify(entry, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [entry]);

  if (!entry) return null;

  const sevColor = SEV_COLORS[entry.severity] ?? 'var(--df-text-muted)';
  const srcColor = SRC_COLORS[entry.source]   ?? 'var(--df-text-muted)';
  const allMeta  = Object.entries(entry.metadata).filter(([, v]) => v !== undefined && v !== null);

  return (
    <aside className="logs-drawer" aria-label="Log entry details">
      {/* Header */}
      <div className="logs-drawer__header">
        <div className="logs-drawer__badges">
          <span
            className="logs-drawer__badge"
            style={{ color: sevColor, borderColor: `${sevColor}44`, background: `${sevColor}14` }}
          >
            {SEV_LABELS[entry.severity]}
          </span>
          <span
            className="logs-drawer__badge"
            style={{ color: srcColor, borderColor: `${srcColor}44`, background: `${srcColor}14` }}
          >
            {entry.source}
          </span>
        </div>
        <button className="logs-drawer__close" onClick={onClose} aria-label="Close details">
          <X size={14} />
        </button>
      </div>

      <div className="logs-drawer__title">{entry.title}</div>

      <div className="logs-drawer__ts">
        <Clock size={11} />
        {formatFull(entry.timestamp)}
      </div>

      {/* Scroll body */}
      <div className="logs-drawer__body">

        {/* All metadata */}
        <section className="logs-drawer__section">
          <h4 className="logs-drawer__section-title">Event Details</h4>
          <div className="logs-drawer__meta">
            <DrawerRow label="ID">
              <span className="logs-drawer__mono">{entry.id.slice(0, 16)}…</span>
            </DrawerRow>
            <DrawerRow label="Source">{entry.source}</DrawerRow>
            <DrawerRow label="Severity">{entry.severity}</DrawerRow>
            {allMeta.map(([k, v]) => (
              <DrawerRow key={k} label={k}>
                <span className="logs-drawer__mono logs-drawer__val-wrap">
                  {String(v)}
                </span>
              </DrawerRow>
            ))}
            {entry.details && (
              <DrawerRow label="Details">
                <pre className="logs-drawer__pre">{entry.details}</pre>
              </DrawerRow>
            )}
          </div>
        </section>

        {/* Related events */}
        <section className="logs-drawer__section">
          <h4 className="logs-drawer__section-title">
            Related Events <span className="logs-drawer__section-hint">(±10s)</span>
          </h4>
          {relatedLoading ? (
            <div className="logs-drawer__related-loading">Loading…</div>
          ) : relatedEntries.length === 0 ? (
            <div className="logs-drawer__related-empty">No related events</div>
          ) : (
            <div className="logs-drawer__related-list">
              {relatedEntries.map(r => {
                const rc = SRC_COLORS[r.source] ?? 'var(--df-text-muted)';
                const sc = SEV_COLORS[r.severity] ?? 'var(--df-text-muted)';
                return (
                  <div key={r.id} className="logs-drawer__related-row">
                    <span className="logs-drawer__related-ts">{formatTs(r.timestamp)}</span>
                    <span
                      className="logs-drawer__badge logs-drawer__badge--sm"
                      style={{ color: sc, borderColor: `${sc}44`, background: `${sc}14` }}
                    >
                      {SEV_LABELS[r.severity]}
                    </span>
                    <span
                      className="logs-drawer__badge logs-drawer__badge--sm"
                      style={{ color: rc, borderColor: `${rc}44`, background: `${rc}14` }}
                    >
                      {r.source}
                    </span>
                    <span className="logs-drawer__related-title">{r.title}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

      </div>

      {/* Actions */}
      <div className="logs-drawer__actions">
        <button className="logs-drawer__action-btn" onClick={handleCopy} title="Copy event as JSON">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied!' : 'Copy JSON'}
        </button>
        <button
          className="logs-drawer__action-btn"
          onClick={() => {
            const t = new Date(entry.timestamp).getTime();
            const url = new URL(window.location.href);
            url.searchParams.set('logFrom', new Date(t - 60_000).toISOString());
            url.searchParams.set('logTo',   new Date(t + 60_000).toISOString());
            window.history.pushState({}, '', url.toString());
          }}
          title="Show events ±1 minute around this entry"
        >
          <Hash size={12} />
          ±1 min
        </button>
      </div>
    </aside>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DrawerRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="logs-drawer__row">
      <span className="logs-drawer__key">{label}</span>
      <span className="logs-drawer__val">{children}</span>
    </div>
  );
}
