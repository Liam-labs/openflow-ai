'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { Cpu, RefreshCw, Check, Minus, X, AlertCircle } from 'lucide-react';
import type { SystemsNavState } from './systems-types';
import type { CapabilityLevel, ModelEntry } from '@/lib/model-registry';
import { providerNames } from '@/lib/model-provider-names';

// Sprint M Phase 2 — Beckett, 2026-05-27.
// Consumes GET /api/models?includeIntegration=true. Read-only list view; the
// detail route owns API key + override editing. Re-detect-all wires to
// POST /api/models/detect (Reynolds' Phase 1 endpoint).

interface UIModelEntry extends ModelEntry {
  provider?: string;
  label?: string;
  description?: string;
  classification?: string;
  tier?: string;
}

interface ApiResponse {
  models: UIModelEntry[];
  providers?: string[] | Record<string, unknown>;
  total?: number;
}

const CAPABILITY_SLUGS = [
  'hooks', 'scaffolding', 'harness', 'feed',
  'skills', 'mcp', 'memory', 'telemetry',
] as const;

const CAPABILITY_LABELS: Record<string, string> = {
  hooks: 'Hooks',
  scaffolding: 'Scaffolding',
  harness: 'Harness',
  feed: 'Feed',
  skills: 'Skills',
  mcp: 'MCP',
  memory: 'Memory',
  telemetry: 'Telemetry',
};

const STATUS_LABEL: Record<CapabilityLevel, string> = {
  full: 'full',
  partial: 'partial',
  none: 'none',
};

function CapabilityGlyph({ level }: { level: CapabilityLevel | undefined }) {
  if (level === 'full') {
    return <span className="ms-cap ms-cap--full" aria-label="full"><Check size={11} strokeWidth={3} /></span>;
  }
  if (level === 'partial') {
    return <span className="ms-cap ms-cap--partial" aria-label="partial"><Minus size={11} strokeWidth={3} /></span>;
  }
  return <span className="ms-cap ms-cap--none" aria-label="none"><X size={11} strokeWidth={3} /></span>;
}

function StatusDot({ level }: { level: CapabilityLevel | undefined }) {
  const cls = level ? `ms-dot ms-dot--${level}` : 'ms-dot ms-dot--unknown';
  return <span className={cls} aria-label={level ?? 'unknown'} />;
}

interface ModelsSectionProps {
  onNavigate: (partial: Partial<SystemsNavState>) => void;
}

export function ModelsSection({ onNavigate }: ModelsSectionProps) {
  const [models, setModels] = useState<UIModelEntry[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectMessage, setDetectMessage] = useState<string | null>(null);

  // Filters
  const [filterProvider, setFilterProvider] = useState<string>('all');
  const [filterInterface, setFilterInterface] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | CapabilityLevel>('all');
  const [filterCapability, setFilterCapability] = useState<string>('all');
  const [filterCapabilityLevel, setFilterCapabilityLevel] = useState<CapabilityLevel>('full');

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/models?includeIntegration=true', { cache: 'no-store' });
      if (!r.ok) {
        setError(`Failed to load models (${r.status})`);
        return;
      }
      const j = (await r.json()) as ApiResponse;
      setModels(j.models ?? []);
      setProviders(providerNames(j));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const interfaces = useMemo(
    () => Array.from(new Set(models.map(m => m.integration?.interfaceType).filter((s): s is string => Boolean(s)))).sort(),
    [models]
  );

  const filtered = useMemo(() => {
    return models.filter(m => {
      if (filterProvider !== 'all' && m.provider !== filterProvider) return false;
      if (filterInterface !== 'all' && m.integration?.interfaceType !== filterInterface) return false;
      if (filterStatus !== 'all' && m.integration?.status !== filterStatus) return false;
      if (filterCapability !== 'all') {
        const level = m.integration?.capabilities?.[filterCapability];
        if (level !== filterCapabilityLevel) return false;
      }
      return true;
    });
  }, [models, filterProvider, filterInterface, filterStatus, filterCapability, filterCapabilityLevel]);

  const counts = useMemo(() => {
    const c = { full: 0, partial: 0, none: 0, unknown: 0 };
    for (const m of models) {
      const s = m.integration?.status;
      if (s === 'full') c.full++;
      else if (s === 'partial') c.partial++;
      else if (s === 'none') c.none++;
      else c.unknown++;
    }
    return c;
  }, [models]);

  const redetectAll = useCallback(async () => {
    setDetecting(true);
    setDetectMessage(null);
    try {
      const r = await fetch('/api/models/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const txt = await r.text();
        setDetectMessage(`Detection failed (${r.status}): ${txt.slice(0, 140)}`);
        return;
      }
      const j = await r.json() as { data?: { totalModels?: number; changed?: number; wrote?: boolean } };
      const totalModels = j.data?.totalModels ?? 0;
      const changed = j.data?.changed ?? 0;
      setDetectMessage(`Re-detected ${totalModels} models — ${changed} changed${j.data?.wrote === false ? ' (no write)' : ''}`);
      await refresh();
    } catch (err) {
      setDetectMessage(err instanceof Error ? err.message : 'Detection failed');
    } finally {
      setDetecting(false);
    }
  }, [refresh]);

  const openDetail = useCallback((modelId: string) => {
    onNavigate({ section: 'models', entityId: modelId, entityType: 'model', tab: 'overview' });
  }, [onNavigate]);

  return (
    <div className="ms-section">
      <header className="ms-header">
        <div className="ms-header-text">
          <div className="ms-eyebrow">Systems · AI Infrastructure</div>
          <h1 className="ms-title"><Cpu size={18} /> Models</h1>
          <p className="ms-sub">
            Auto-detected integration depth for each registered model. The 8-capability checklist
            reflects what infrastructure exists (hooks, scaffolding, harness, feed, skills, MCP, memory,
            telemetry) — not whether a given run succeeded.
          </p>
        </div>
        <button
          className="ms-btn-primary"
          onClick={redetectAll}
          disabled={detecting || loading}
        >
          <RefreshCw size={14} className={detecting ? 'ms-spin' : ''} />
          {detecting ? 'Detecting…' : 'Re-detect All'}
        </button>
      </header>

      {/* Status summary */}
      <div className="ms-stat-row">
        <div className="ms-stat"><span className="ms-stat-label">Total</span><span className="ms-stat-value">{models.length}</span></div>
        <div className="ms-stat ms-stat--full"><span className="ms-stat-label">Full</span><span className="ms-stat-value">{counts.full}</span></div>
        <div className="ms-stat ms-stat--partial"><span className="ms-stat-label">Partial</span><span className="ms-stat-value">{counts.partial}</span></div>
        <div className="ms-stat ms-stat--none"><span className="ms-stat-label">None</span><span className="ms-stat-value">{counts.none}</span></div>
        {counts.unknown > 0 && (
          <div className="ms-stat ms-stat--unknown"><span className="ms-stat-label">Undetected</span><span className="ms-stat-value">{counts.unknown}</span></div>
        )}
      </div>

      {detectMessage && (
        <div className="ms-notice"><AlertCircle size={13} />{detectMessage}</div>
      )}
      {error && (
        <div className="ms-notice ms-notice--err"><AlertCircle size={13} />{error}</div>
      )}

      {/* Filter bar */}
      <div className="ms-filters" role="group" aria-label="Filter models">
        <label className="ms-filter">
          <span className="ms-filter-label">Provider</span>
          <select
            className="ms-select"
            value={filterProvider}
            onChange={(e) => setFilterProvider(e.target.value)}
          >
            <option value="all">All</option>
            {providers.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="ms-filter">
          <span className="ms-filter-label">Interface</span>
          <select
            className="ms-select"
            value={filterInterface}
            onChange={(e) => setFilterInterface(e.target.value)}
          >
            <option value="all">All</option>
            {interfaces.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
        </label>
        <label className="ms-filter">
          <span className="ms-filter-label">Status</span>
          <select
            className="ms-select"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as 'all' | CapabilityLevel)}
          >
            <option value="all">All</option>
            <option value="full">Full</option>
            <option value="partial">Partial</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className="ms-filter">
          <span className="ms-filter-label">Capability</span>
          <select
            className="ms-select"
            value={filterCapability}
            onChange={(e) => setFilterCapability(e.target.value)}
          >
            <option value="all">— any —</option>
            {CAPABILITY_SLUGS.map(slug => (
              <option key={slug} value={slug}>{CAPABILITY_LABELS[slug]}</option>
            ))}
          </select>
        </label>
        {filterCapability !== 'all' && (
          <label className="ms-filter">
            <span className="ms-filter-label">Must be</span>
            <select
              className="ms-select"
              value={filterCapabilityLevel}
              onChange={(e) => setFilterCapabilityLevel(e.target.value as CapabilityLevel)}
            >
              <option value="full">Full</option>
              <option value="partial">Partial</option>
              <option value="none">None</option>
            </select>
          </label>
        )}
        <span className="ms-filter-count">
          {filtered.length} of {models.length}
        </span>
      </div>

      {/* Grid of model cards */}
      {loading ? (
        <div className="ms-loading">Loading models…</div>
      ) : filtered.length === 0 ? (
        <div className="ms-empty">No models match the current filters.</div>
      ) : (
        <div className="ms-grid">
          {filtered.map(m => (
            <ModelCard key={m.id} model={m} onOpen={() => openDetail(m.id)} />
          ))}
        </div>
      )}

      <style jsx>{`
        .ms-section { padding: 24px 28px 48px; max-width: 1280px; }
        .ms-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
        .ms-header-text { min-width: 0; max-width: 720px; }
        .ms-eyebrow { font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--df-text-muted, #71717a); font-weight: 600; }
        .ms-title { display: flex; align-items: center; gap: 8px; font-size: 22px; font-weight: 600; margin: 4px 0 6px; color: var(--df-text, #fafafa); letter-spacing: -0.3px; }
        .ms-sub { font-size: 13px; color: var(--df-text-secondary, #a1a1aa); line-height: 1.55; margin: 0; }

        .ms-btn-primary { display: inline-flex; align-items: center; gap: 6px; padding: 9px 14px; min-height: 38px; background: var(--df-accent-10, rgba(59,130,246,0.1)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.25)); border-radius: 8px; color: var(--df-text, #fafafa); font-size: 12px; font-weight: 500; cursor: pointer; transition: all 140ms ease; flex-shrink: 0; }
        .ms-btn-primary:hover:not(:disabled) { background: var(--df-accent-20, rgba(59,130,246,0.2)); border-color: var(--df-accent, #3b82f6); }
        .ms-btn-primary:focus-visible { outline: 2px solid var(--df-accent, #3b82f6); outline-offset: 2px; }
        .ms-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

        .ms-stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 16px 0 20px; }
        .ms-stat { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; background: var(--df-bg-glass, rgba(15,25,50,0.4)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.1)); border-radius: 10px; min-width: 0; }
        .ms-stat-label { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--df-text-muted, #71717a); font-weight: 600; }
        .ms-stat-value { font-size: 22px; font-weight: 600; color: var(--df-text, #fafafa); font-family: var(--font-mono, ui-monospace, monospace); line-height: 1; }
        .ms-stat--full { border-left: 2px solid #22c55e; }
        .ms-stat--partial { border-left: 2px solid #eab308; }
        .ms-stat--none { border-left: 2px solid #ef4444; }
        .ms-stat--unknown { border-left: 2px solid #71717a; }

        .ms-notice { display: flex; align-items: center; gap: 8px; padding: 10px 14px; margin-bottom: 14px; background: var(--df-accent-8, rgba(59,130,246,0.08)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.18)); border-radius: 8px; color: var(--df-text-secondary, #a1a1aa); font-size: 12px; }
        .ms-notice--err { background: rgba(239,68,68,0.08); border-color: rgba(239,68,68,0.3); color: #f87171; }

        .ms-filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 16px; padding: 14px 16px; background: var(--df-bg-glass, rgba(15,25,50,0.3)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.1)); border-radius: 10px; margin-bottom: 18px; }
        .ms-filter { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .ms-filter-label { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--df-text-muted, #71717a); font-weight: 600; }
        .ms-select { padding: 7px 10px; min-height: 32px; background: rgba(0,0,0,0.3); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.18)); border-radius: 6px; color: var(--df-text, #fafafa); font-size: 12px; cursor: pointer; min-width: 130px; }
        .ms-select:focus-visible { outline: 2px solid var(--df-accent, #3b82f6); outline-offset: 1px; border-color: var(--df-accent, #3b82f6); }
        .ms-filter-count { margin-left: auto; align-self: center; font-size: 11px; color: var(--df-text-muted, #71717a); font-family: var(--font-mono, ui-monospace, monospace); }

        .ms-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
        .ms-loading, .ms-empty { padding: 32px; text-align: center; color: var(--df-text-muted, #71717a); font-size: 13px; background: var(--df-bg-glass, rgba(15,25,50,0.3)); border: 1px dashed var(--df-border-subtle, rgba(59,130,246,0.15)); border-radius: 10px; }

        .ms-spin { animation: ms-spin 1s linear infinite; }
        @keyframes ms-spin { to { transform: rotate(360deg); } }

        :global(.ms-cap) { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0; }
        :global(.ms-cap--full) { background: rgba(34,197,94,0.15); color: #22c55e; }
        :global(.ms-cap--partial) { background: rgba(234,179,8,0.18); color: #eab308; }
        :global(.ms-cap--none) { background: rgba(239,68,68,0.15); color: #ef4444; }

        :global(.ms-dot) { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        :global(.ms-dot--full) { background: #22c55e; box-shadow: 0 0 8px rgba(34,197,94,0.5); }
        :global(.ms-dot--partial) { background: #eab308; box-shadow: 0 0 8px rgba(234,179,8,0.45); }
        :global(.ms-dot--none) { background: #ef4444; }
        :global(.ms-dot--unknown) { background: #71717a; }
      `}</style>
    </div>
  );
}

// ─── Model Card ──────────────────────────────────────────────────────────────

function ModelCard({ model, onOpen }: { model: UIModelEntry; onOpen: () => void }) {
  const status = model.integration?.status;
  const caps = model.integration?.capabilities ?? {};
  const displayLabel = model.label ?? model.id;
  const provider = model.provider ?? 'unknown';
  const interfaceType = model.integration?.interfaceType ?? '—';

  return (
    <button
      type="button"
      className="ms-card"
      onClick={onOpen}
      aria-label={`Open ${displayLabel} details`}
    >
      <div className="ms-card-top">
        <div className="ms-card-title-row">
          <span className="ms-card-name" title={displayLabel}>{displayLabel}</span>
          <span className="ms-card-status">
            <StatusDot level={status} />
            <span className="ms-card-status-label">{status ? STATUS_LABEL[status] : 'unknown'}</span>
          </span>
        </div>
        <div className="ms-card-meta">
          <span className="ms-card-provider" title={provider}>{provider}</span>
          <span className="ms-card-dot-sep">·</span>
          <span className="ms-card-interface" title={interfaceType}>{interfaceType}</span>
        </div>
      </div>

      <div className="ms-card-divider" />

      <ul className="ms-card-caps">
        {CAPABILITY_SLUGS.map(slug => (
          <li key={slug} className="ms-card-cap-row">
            <span className="ms-card-cap-label">{CAPABILITY_LABELS[slug]}</span>
            <CapabilityGlyph level={caps[slug] as CapabilityLevel | undefined} />
          </li>
        ))}
      </ul>

      <style jsx>{`
        .ms-card { text-align: left; display: flex; flex-direction: column; padding: 14px 14px 10px; background: var(--df-bg-glass, rgba(15,25,50,0.45)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.12)); border-radius: 10px; cursor: pointer; transition: border-color 140ms ease, transform 140ms ease, background 140ms ease; min-width: 0; font-family: inherit; }
        .ms-card:hover { border-color: var(--df-accent, #3b82f6); background: var(--df-bg-glass-hover, rgba(15,25,50,0.6)); transform: translateY(-1px); }
        .ms-card:focus-visible { outline: 2px solid var(--df-accent, #3b82f6); outline-offset: 2px; }

        .ms-card-top { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .ms-card-title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
        .ms-card-name { font-size: 14px; font-weight: 600; color: var(--df-text, #fafafa); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
        .ms-card-status { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; }
        .ms-card-status-label { font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase; color: var(--df-text-muted, #71717a); font-weight: 600; }

        .ms-card-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--df-text-secondary, #a1a1aa); min-width: 0; }
        .ms-card-provider { font-weight: 500; text-transform: capitalize; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 50%; min-width: 0; }
        .ms-card-dot-sep { color: var(--df-text-muted, #71717a); flex-shrink: 0; }
        .ms-card-interface { font-family: var(--font-mono, ui-monospace, monospace); font-size: 10.5px; color: var(--df-text-muted, #71717a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

        .ms-card-divider { height: 1px; background: var(--df-border-subtle, rgba(59,130,246,0.1)); margin: 10px 0 10px; }

        .ms-card-caps { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }
        .ms-card-cap-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; color: var(--df-text-secondary, #a1a1aa); min-width: 0; }
        .ms-card-cap-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      `}</style>
    </button>
  );
}
