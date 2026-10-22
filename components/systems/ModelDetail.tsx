'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { Cpu, ArrowLeft, RefreshCw, AlertCircle, Check, Minus, X as XIcon, Clock, Info } from 'lucide-react';
import type { ModelTab, SystemsNavState } from './systems-types';
import type { CapabilityLevel, ModelEntry, ModelCapabilities, ModelIntegration } from '@/lib/model-registry';

// Sprint M Phase 2 — Beckett, 2026-05-27.
// Per-model detail with Overview / Integration / Config tabs. Read-only —
// edits to overrides + API keys live in the existing ModelConfigModal flow
// (kept separate per CJack's "don't scope-creep" constraint).

interface UIModelEntry extends ModelEntry {
  provider?: string;
  label?: string;
  description?: string;
  classification?: string;
  tier?: string;
}

interface ModelsApiResponse {
  models: UIModelEntry[];
  roleDefaults?: Record<string, Record<string, string>>;
  overrides?: Record<string, { model: string; provider?: string }>;
}

interface ModelDetailProps {
  modelId: string;
  tab: ModelTab;
  onTabChange: (tab: ModelTab) => void;
  onBack: () => void;
  onNavigate?: (partial: Partial<SystemsNavState>) => void;
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

// Best-effort human description of where each capability is detected. The
// authoritative source list lives in lib/model-integration-detect.ts on the
// backend; this is the UX-facing summary, not a binding contract.
const CAPABILITY_SOURCES: Record<string, string> = {
  hooks: 'Read from data/scaffolding/manifest.json hook entries + per-model hook coverage matrix.',
  scaffolding: 'Whether data/scaffolding/masters/per-model/<model>/ exists and the sync.py adapter is wired.',
  harness: 'Wrapper script present under scripts/ (collab-<agent>.py) and registered in lib/collab-pty.ts.',
  feed: 'UserPromptSubmit context-injection hook installed and event log entries observed.',
  skills: '~/.claude/skills/ or per-model skills directory plus skill registry coverage.',
  mcp: 'MCP server discovery in ~/.<model>/.',
  memory: 'MEMORY.md + memory directory under data/scaffolding/masters/per-model/<model>/memory/.',
  telemetry: '_telemetry.py hook events emitted by this model in hook-events.jsonl.',
};

const STATUS_LABEL: Record<CapabilityLevel, string> = { full: 'Full', partial: 'Partial', none: 'None' };

function CapabilityGlyph({ level }: { level: CapabilityLevel | undefined }) {
  if (level === 'full') return <span className="md-cap md-cap--full"><Check size={11} strokeWidth={3} /></span>;
  if (level === 'partial') return <span className="md-cap md-cap--partial"><Minus size={11} strokeWidth={3} /></span>;
  return <span className="md-cap md-cap--none"><XIcon size={11} strokeWidth={3} /></span>;
}

function StatusBadge({ level }: { level: CapabilityLevel | undefined }) {
  const cls = level ? `md-status md-status--${level}` : 'md-status md-status--unknown';
  return <span className={cls}>{level ? STATUS_LABEL[level] : 'Unknown'}</span>;
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const dt = new Date(iso);
    const ageMs = Date.now() - dt.getTime();
    const mins = Math.floor(ageMs / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago · ${dt.toLocaleDateString()}`;
  } catch {
    return iso;
  }
}

function formatNumber(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export function ModelDetail({ modelId, tab, onTabChange, onBack }: ModelDetailProps) {
  const [data, setData] = useState<ModelsApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [redetecting, setRedetecting] = useState(false);
  const [redetectMessage, setRedetectMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/models?includeIntegration=true', { cache: 'no-store' });
      if (!r.ok) {
        setError(`Failed to load (${r.status})`);
        return;
      }
      const j = (await r.json()) as ModelsApiResponse;
      setData(j);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const model = useMemo<UIModelEntry | undefined>(
    () => data?.models.find(m => m.id === modelId),
    [data, modelId]
  );

  const roleDefaultEntries = useMemo<Array<{ roleSlug: string; agentType: string }>>(() => {
    if (!data?.roleDefaults || !model) return [];
    const out: Array<{ roleSlug: string; agentType: string }> = [];
    for (const [roleSlug, perAgent] of Object.entries(data.roleDefaults)) {
      for (const [agentType, modelIdValue] of Object.entries(perAgent)) {
        if (modelIdValue === modelId) out.push({ roleSlug, agentType });
      }
    }
    return out;
  }, [data, model, modelId]);

  const overrideEntries = useMemo<Array<{ agentName: string; provider?: string }>>(() => {
    if (!data?.overrides) return [];
    return Object.entries(data.overrides)
      .filter(([, v]) => v.model === modelId)
      .map(([agentName, v]) => ({ agentName, provider: v.provider }));
  }, [data, modelId]);

  const redetect = useCallback(async () => {
    setRedetecting(true);
    setRedetectMessage(null);
    try {
      const r = await fetch('/api/models/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const txt = await r.text();
        setRedetectMessage(`Failed (${r.status}): ${txt.slice(0, 120)}`);
        return;
      }
      const j = await r.json() as { data?: { changed?: number; totalModels?: number } };
      setRedetectMessage(`Re-detected ${j.data?.totalModels ?? 0} models — ${j.data?.changed ?? 0} changed.`);
      await refresh();
    } catch (err) {
      setRedetectMessage(err instanceof Error ? err.message : 'Detection failed');
    } finally {
      setRedetecting(false);
    }
  }, [refresh]);

  if (loading) return <div className="systems-section__loading">Loading model…</div>;

  if (error || !model) {
    return (
      <div className="md-section">
        <button className="md-back" onClick={onBack}><ArrowLeft size={14} /> Back to Models</button>
        <div className="md-error"><AlertCircle size={14} />{error ?? `Model "${modelId}" not found.`}</div>
        <style jsx>{`
          .md-section { padding: 24px 28px 48px; max-width: 1080px; }
          .md-back { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; min-height: 32px; background: transparent; border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.18)); border-radius: 8px; color: var(--df-text-secondary, #a1a1aa); font-size: 12px; cursor: pointer; margin-bottom: 20px; }
          .md-back:hover { background: var(--df-accent-10, rgba(59,130,246,0.1)); color: var(--df-text, #fafafa); }
          .md-error { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 8px; color: #f87171; font-size: 13px; }
        `}</style>
      </div>
    );
  }

  const integration = model.integration;
  const TABS: { id: ModelTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'integration', label: 'Integration' },
    { id: 'config', label: 'Config' },
  ];

  return (
    <div className="md-section">
      <button className="md-back" onClick={onBack}><ArrowLeft size={14} /> Back to Models</button>

      <header className="md-header">
        <div className="md-header-text">
          <div className="md-eyebrow">Systems · Models</div>
          <h1 className="md-title">
            <Cpu size={18} />
            <span className="md-title-name">{model.label ?? model.id}</span>
            <StatusBadge level={integration?.status} />
          </h1>
          <div className="md-header-meta">
            <span className="md-meta-item"><span className="md-meta-label">id</span><code>{model.id}</code></span>
            <span className="md-meta-item"><span className="md-meta-label">provider</span>{model.provider ?? '—'}</span>
            <span className="md-meta-item"><span className="md-meta-label">interface</span>{integration?.interfaceType ?? '—'}</span>
            <span className="md-meta-item"><span className="md-meta-label"><Clock size={10} /> detected</span>{formatTimestamp(integration?.detectedAt)}</span>
          </div>
        </div>
        <button className="md-btn-ghost" onClick={redetect} disabled={redetecting}>
          <RefreshCw size={13} className={redetecting ? 'md-spin' : ''} />
          {redetecting ? 'Detecting…' : 'Re-detect'}
        </button>
      </header>

      {redetectMessage && (
        <div className="md-notice"><Info size={13} />{redetectMessage}</div>
      )}

      <div className="md-tabs" role="tablist" aria-label="Model detail tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`md-tab${tab === t.id ? ' md-tab--active' : ''}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab model={model} />}
      {tab === 'integration' && <IntegrationTab integration={integration} />}
      {tab === 'config' && (
        <ConfigTab
          model={model}
          roleDefaults={roleDefaultEntries}
          overrides={overrideEntries}
        />
      )}

      <style jsx>{`
        .md-section { padding: 24px 28px 48px; max-width: 1080px; }
        .md-back { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; min-height: 32px; background: transparent; border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.18)); border-radius: 8px; color: var(--df-text-secondary, #a1a1aa); font-size: 12px; cursor: pointer; margin-bottom: 18px; }
        .md-back:hover { background: var(--df-accent-10, rgba(59,130,246,0.1)); color: var(--df-text, #fafafa); }
        .md-back:focus-visible { outline: 2px solid var(--df-accent, #3b82f6); outline-offset: 2px; }

        .md-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 14px; flex-wrap: wrap; }
        .md-header-text { min-width: 0; flex: 1; }
        .md-eyebrow { font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--df-text-muted, #71717a); font-weight: 600; }
        .md-title { display: flex; align-items: center; gap: 10px; font-size: 22px; font-weight: 600; margin: 4px 0 8px; color: var(--df-text, #fafafa); letter-spacing: -0.3px; min-width: 0; flex-wrap: wrap; }
        .md-title-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 100%; }
        .md-header-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12px; color: var(--df-text-secondary, #a1a1aa); }
        .md-meta-item { display: inline-flex; align-items: center; gap: 6px; }
        .md-meta-label { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--df-text-muted, #71717a); font-weight: 600; }
        .md-meta-item code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; padding: 1px 6px; background: rgba(0,0,0,0.3); border-radius: 4px; color: var(--df-text, #fafafa); }

        .md-btn-ghost { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; min-height: 32px; background: transparent; border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.18)); border-radius: 8px; color: var(--df-text-secondary, #a1a1aa); font-size: 12px; cursor: pointer; flex-shrink: 0; }
        .md-btn-ghost:hover:not(:disabled) { background: var(--df-accent-10, rgba(59,130,246,0.1)); color: var(--df-text, #fafafa); }
        .md-btn-ghost:focus-visible { outline: 2px solid var(--df-accent, #3b82f6); outline-offset: 2px; }
        .md-btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }

        .md-notice { display: flex; align-items: center; gap: 8px; padding: 10px 14px; margin-bottom: 14px; background: var(--df-accent-8, rgba(59,130,246,0.08)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.18)); border-radius: 8px; color: var(--df-text-secondary, #a1a1aa); font-size: 12px; }

        .md-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--df-border-subtle, rgba(59,130,246,0.12)); margin: 16px 0 20px; }
        .md-tab { padding: 9px 14px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--df-text-muted, #71717a); font-size: 13px; font-weight: 500; cursor: pointer; transition: color 140ms ease, border-color 140ms ease; min-height: 36px; }
        .md-tab:hover { color: var(--df-text-secondary, #a1a1aa); }
        .md-tab--active { color: var(--df-text, #fafafa); border-bottom-color: var(--df-accent, #3b82f6); }
        .md-tab:focus-visible { outline: 2px solid var(--df-accent, #3b82f6); outline-offset: 2px; border-radius: 6px 6px 0 0; }

        .md-spin { animation: md-spin 1s linear infinite; }
        @keyframes md-spin { to { transform: rotate(360deg); } }

        :global(.md-status) { display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 999px; font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase; font-weight: 600; }
        :global(.md-status--full) { background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid rgba(34,197,94,0.3); }
        :global(.md-status--partial) { background: rgba(234,179,8,0.15); color: #facc15; border: 1px solid rgba(234,179,8,0.3); }
        :global(.md-status--none) { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
        :global(.md-status--unknown) { background: rgba(161,161,170,0.1); color: var(--df-text-muted, #71717a); border: 1px solid rgba(161,161,170,0.25); }

        :global(.md-cap) { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0; }
        :global(.md-cap--full) { background: rgba(34,197,94,0.15); color: #22c55e; }
        :global(.md-cap--partial) { background: rgba(234,179,8,0.18); color: #eab308; }
        :global(.md-cap--none) { background: rgba(239,68,68,0.15); color: #ef4444; }
      `}</style>
    </div>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────────────────

function OverviewTab({ model }: { model: UIModelEntry }) {
  const caps = model.capabilities;
  const rows: Array<{ label: string; value: React.ReactNode }> = [
    { label: 'ID', value: <code>{model.id}</code> },
    { label: 'API ID', value: model.apiId ? <code>{model.apiId}</code> : '—' },
    { label: 'Label', value: model.label ?? '—' },
    { label: 'Provider', value: model.provider ?? '—' },
    { label: 'Tier', value: model.tier ?? '—' },
    { label: 'Classification', value: model.classification ?? '—' },
    { label: 'Agent Types', value: model.agentTypes.length > 0
      ? <span className="md-tag-list">{model.agentTypes.map(a => <code key={a}>{a}</code>)}</span>
      : '—' },
    { label: 'Default', value: model.isDefault ? <span className="md-badge md-badge--default">Default for provider</span> : '—' },
  ];

  return (
    <div className="md-tab-content">
      {model.description && (
        <p className="md-description">{model.description}</p>
      )}

      <section className="md-card">
        <h3 className="md-card-title">Metadata</h3>
        <dl className="md-dl">
          {rows.map(({ label, value }) => (
            <div key={label} className="md-dl-row">
              <dt className="md-dl-term">{label}</dt>
              <dd className="md-dl-def">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {caps && (
        <section className="md-card">
          <h3 className="md-card-title">Runtime Capabilities</h3>
          <dl className="md-dl">
            <CapRow label="Context window" value={caps.contextWindow !== undefined ? `${formatNumber(caps.contextWindow)} tokens` : '—'} />
            <CapRow label="Max output" value={caps.maxOutputTokens !== undefined ? `${formatNumber(caps.maxOutputTokens)} tokens` : '—'} />
            <BoolRow label="Reasoning" value={caps.reasoning} />
            <BoolRow label="Reasoning only" value={caps.reasoningOnly} />
            <BoolRow label="Vision" value={caps.vision} />
            <BoolRow label="Tool use" value={caps.toolUse} />
            <BoolRow label="Streaming" value={caps.supportsStreaming} />
            <BoolRow label="Temperature" value={caps.supportsTemperature} />
            {caps.preview && <CapRow label="Status" value={<span className="md-badge md-badge--preview">Preview</span>} />}
          </dl>
        </section>
      )}

      <style jsx>{`
        .md-tab-content { display: flex; flex-direction: column; gap: 16px; }
        .md-description { font-size: 13.5px; line-height: 1.6; color: var(--df-text-secondary, #a1a1aa); margin: 0; padding: 14px 16px; background: var(--df-bg-glass, rgba(15,25,50,0.3)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.1)); border-radius: 10px; max-width: 75ch; }

        .md-card { padding: 16px 18px; background: var(--df-bg-glass, rgba(15,25,50,0.3)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.1)); border-radius: 10px; }
        .md-card-title { font-size: 13px; font-weight: 600; color: var(--df-text, #fafafa); margin: 0 0 12px; letter-spacing: -0.1px; }

        .md-dl { display: grid; grid-template-columns: 200px 1fr; gap: 6px 18px; margin: 0; }
        .md-dl-row { display: contents; }
        .md-dl-term { font-size: 11px; letter-spacing: 0.5px; text-transform: uppercase; color: var(--df-text-muted, #71717a); font-weight: 600; padding: 6px 0; align-self: center; }
        .md-dl-def { font-size: 13px; color: var(--df-text, #fafafa); padding: 6px 0; margin: 0; overflow-wrap: break-word; min-width: 0; }
        .md-dl-def :global(code) { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; padding: 1px 6px; background: rgba(0,0,0,0.3); border-radius: 4px; }

        :global(.md-tag-list) { display: inline-flex; flex-wrap: wrap; gap: 4px; }
        :global(.md-badge) { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase; font-weight: 600; }
        :global(.md-badge--default) { background: rgba(59,130,246,0.15); color: #60a5fa; border: 1px solid rgba(59,130,246,0.3); }
        :global(.md-badge--preview) { background: rgba(234,179,8,0.15); color: #facc15; border: 1px solid rgba(234,179,8,0.3); }
        :global(.md-badge--yes) { background: rgba(34,197,94,0.12); color: #4ade80; }
        :global(.md-badge--no) { background: rgba(161,161,170,0.08); color: var(--df-text-muted, #71717a); }

        @media (max-width: 640px) {
          .md-dl { grid-template-columns: 1fr; gap: 2px 0; }
          .md-dl-term { padding-top: 10px; }
        }
      `}</style>
    </div>
  );
}

function CapRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="md-dl-row">
      <dt className="md-dl-term">{label}</dt>
      <dd className="md-dl-def">{value}</dd>
    </div>
  );
}

function BoolRow({ label, value }: { label: string; value: boolean | undefined }) {
  if (value === undefined) return <CapRow label={label} value={<span className="md-dl-muted">—</span>} />;
  return (
    <CapRow
      label={label}
      value={value
        ? <span className="md-badge md-badge--yes">Yes</span>
        : <span className="md-badge md-badge--no">No</span>
      }
    />
  );
}

// ─── Integration Tab ─────────────────────────────────────────────────────────

function IntegrationTab({ integration }: { integration: ModelIntegration | undefined }) {
  if (!integration) {
    return (
      <div className="md-empty-card">
        <Info size={14} />
        <span>No integration block detected yet. Run <strong>Re-detect</strong> above to populate.</span>
        <style jsx>{`
          .md-empty-card { display: flex; align-items: center; gap: 10px; padding: 16px 18px; background: var(--df-bg-glass, rgba(15,25,50,0.3)); border: 1px dashed var(--df-border-subtle, rgba(59,130,246,0.18)); border-radius: 10px; color: var(--df-text-secondary, #a1a1aa); font-size: 13px; }
          strong { color: var(--df-text, #fafafa); }
        `}</style>
      </div>
    );
  }

  const caps = integration.capabilities ?? {};
  const fullCount = CAPABILITY_SLUGS.filter(s => caps[s] === 'full').length;
  const partialCount = CAPABILITY_SLUGS.filter(s => caps[s] === 'partial').length;
  const noneCount = CAPABILITY_SLUGS.filter(s => !caps[s] || caps[s] === 'none').length;

  return (
    <div className="md-tab-content">
      <section className="md-card">
        <header className="md-int-header">
          <h3 className="md-card-title">Capability Breakdown</h3>
          <div className="md-int-counts">
            <span className="md-int-count"><span className="md-cap md-cap--full"><Check size={10} strokeWidth={3} /></span> {fullCount} full</span>
            <span className="md-int-count"><span className="md-cap md-cap--partial"><Minus size={10} strokeWidth={3} /></span> {partialCount} partial</span>
            <span className="md-int-count"><span className="md-cap md-cap--none"><XIcon size={10} strokeWidth={3} /></span> {noneCount} none</span>
          </div>
        </header>

        <ul className="md-int-list">
          {CAPABILITY_SLUGS.map(slug => {
            const level = caps[slug] as CapabilityLevel | undefined;
            return (
              <li key={slug} className="md-int-row">
                <div className="md-int-row-head">
                  <span className="md-int-row-name">{CAPABILITY_LABELS[slug]}</span>
                  <CapabilityGlyph level={level} />
                  <span className="md-int-row-level">{level ? STATUS_LABEL[level] : 'Unknown'}</span>
                </div>
                <p className="md-int-source">{CAPABILITY_SOURCES[slug]}</p>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="md-detect-note">
        <Clock size={12} />
        <span>Last detection pass: {formatTimestamp(integration.detectedAt)}</span>
      </div>

      <style jsx>{`
        .md-tab-content { display: flex; flex-direction: column; gap: 14px; }
        .md-card { padding: 16px 18px; background: var(--df-bg-glass, rgba(15,25,50,0.3)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.1)); border-radius: 10px; }
        .md-card-title { font-size: 13px; font-weight: 600; color: var(--df-text, #fafafa); margin: 0; letter-spacing: -0.1px; }

        .md-int-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
        .md-int-counts { display: flex; gap: 12px; font-size: 11px; color: var(--df-text-secondary, #a1a1aa); }
        .md-int-count { display: inline-flex; align-items: center; gap: 5px; }

        .md-int-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
        .md-int-row { padding: 12px 14px; background: rgba(0,0,0,0.18); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.08)); border-radius: 8px; }
        .md-int-row-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
        .md-int-row-name { font-size: 13px; font-weight: 600; color: var(--df-text, #fafafa); flex: 1; min-width: 0; }
        .md-int-row-level { font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase; color: var(--df-text-muted, #71717a); font-weight: 600; }
        .md-int-source { font-size: 11.5px; line-height: 1.5; color: var(--df-text-muted, #71717a); margin: 0; max-width: 75ch; overflow-wrap: break-word; }

        .md-detect-note { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; background: var(--df-accent-8, rgba(59,130,246,0.08)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.15)); border-radius: 8px; color: var(--df-text-secondary, #a1a1aa); font-size: 11px; align-self: flex-start; }
      `}</style>
    </div>
  );
}

// ─── Config Tab ──────────────────────────────────────────────────────────────

function ConfigTab({
  model,
  roleDefaults,
  overrides,
}: {
  model: UIModelEntry;
  roleDefaults: Array<{ roleSlug: string; agentType: string }>;
  overrides: Array<{ agentName: string; provider?: string }>;
}) {
  return (
    <div className="md-tab-content">
      <section className="md-card">
        <h3 className="md-card-title">Provider Default</h3>
        <p className="md-card-body">
          {model.isDefault ? (
            <>
              <span className="md-badge md-badge--default">Default</span>{' '}
              This model is the <code>isDefault</code> for provider <strong>{model.provider}</strong>.
              Spawns that don't match a role default fall back to this model.
            </>
          ) : (
            <>Not the provider default. Selected only via role defaults or per-agent overrides.</>
          )}
        </p>
      </section>

      <section className="md-card">
        <h3 className="md-card-title">Role Defaults <span className="md-count">({roleDefaults.length})</span></h3>
        {roleDefaults.length === 0 ? (
          <p className="md-card-body md-muted">No role assigns this model as its default.</p>
        ) : (
          <ul className="md-list">
            {roleDefaults.map((r, i) => (
              <li key={`${r.roleSlug}-${r.agentType}-${i}`} className="md-list-row">
                <code className="md-mono">{r.roleSlug}</code>
                <span className="md-arrow">→</span>
                <code className="md-mono">{r.agentType}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="md-card">
        <h3 className="md-card-title">Per-Agent Overrides <span className="md-count">({overrides.length})</span></h3>
        {overrides.length === 0 ? (
          <p className="md-card-body md-muted">No agents have an explicit override pointing at this model.</p>
        ) : (
          <ul className="md-list">
            {overrides.map(o => (
              <li key={o.agentName} className="md-list-row">
                <code className="md-mono">{o.agentName}</code>
                {o.provider && (
                  <>
                    <span className="md-arrow">·</span>
                    <span className="md-muted">{o.provider}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="md-card">
        <h3 className="md-card-title">API Key</h3>
        <p className="md-card-body md-muted">
          Provider credentials are managed via <code>~/.secrets</code> on the host. Per-provider key
          status is not exposed by this view — check the <strong>Local AI</strong> or provider-specific
          panel for connection tests.
        </p>
      </section>

      <style jsx>{`
        .md-tab-content { display: flex; flex-direction: column; gap: 14px; }
        .md-card { padding: 16px 18px; background: var(--df-bg-glass, rgba(15,25,50,0.3)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.1)); border-radius: 10px; }
        .md-card-title { font-size: 13px; font-weight: 600; color: var(--df-text, #fafafa); margin: 0 0 10px; letter-spacing: -0.1px; }
        .md-count { font-weight: 400; color: var(--df-text-muted, #71717a); font-size: 11px; margin-left: 6px; }
        .md-card-body { font-size: 13px; line-height: 1.55; color: var(--df-text-secondary, #a1a1aa); margin: 0; max-width: 75ch; overflow-wrap: break-word; }
        .md-card-body code, .md-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; padding: 1px 6px; background: rgba(0,0,0,0.3); border-radius: 4px; color: var(--df-text, #fafafa); }
        .md-card-body strong { color: var(--df-text, #fafafa); font-weight: 600; }
        .md-muted { color: var(--df-text-muted, #71717a); }

        .md-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
        .md-list-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: rgba(0,0,0,0.18); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.06)); border-radius: 6px; font-size: 12px; min-width: 0; overflow-wrap: break-word; }
        .md-arrow { color: var(--df-text-muted, #71717a); font-family: var(--font-mono); }
      `}</style>
    </div>
  );
}
