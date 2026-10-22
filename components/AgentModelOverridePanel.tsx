'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Users,
  Trash2,
  Plus,
  ChevronDown,
  AlertCircle,
  Loader2,
  Check,
} from 'lucide-react';

// ─── Shared Types ─────────────────────────────────────────────────────────────

interface ModelEntry {
  id: string;
  provider: string;
  classification: string;
  label: string;
  description?: string;
  tier: string;
  agentTypes: string[];
  isDefault?: boolean;
}

interface ProviderConfig {
  authType: 'api-key' | 'subscription';
  configured: boolean;
  configuredAt?: string;
}

interface ModelOverride {
  model: string;
  provider?: string;
  setAt: string;
  setBy?: string;
}

// ─── Provider accent palette ──────────────────────────────────────────────────

const PROVIDER_BADGE: Record<string, { bg: string; text: string; border: string }> = {
  anthropic: { bg: 'bg-blue-500/15',   text: 'text-blue-300',   border: 'border-blue-500/25' },
  google:    { bg: 'bg-indigo-500/15', text: 'text-indigo-300', border: 'border-indigo-500/25' },
  xai:       { bg: 'bg-amber-500/15',  text: 'text-amber-300',  border: 'border-amber-500/25' },
  openai:    { bg: 'bg-emerald-500/15',text: 'text-emerald-300',border: 'border-emerald-500/25' },
  mistral:   { bg: 'bg-orange-500/15', text: 'text-orange-300', border: 'border-orange-500/25' },
  kimi:      { bg: 'bg-violet-500/15', text: 'text-violet-300', border: 'border-violet-500/25' },
};

const DEFAULT_BADGE = { bg: 'bg-white/10', text: 'text-white/50', border: 'border-white/15' };

const RUNTIME_BADGE: Record<string, { bg: string; text: string; border: string }> = {
  claude:      { bg: 'bg-blue-500/10',   text: 'text-blue-300',   border: 'border-blue-500/20' },
  antigravity: { bg: 'bg-amber-500/10',  text: 'text-amber-300',  border: 'border-amber-500/20' },
  gemini:      { bg: 'bg-indigo-500/10', text: 'text-indigo-300', border: 'border-indigo-500/20' },
  grok:        { bg: 'bg-emerald-500/10',text: 'text-emerald-300',border: 'border-emerald-500/20' },
};
const DEFAULT_RUNTIME_BADGE = { bg: 'bg-white/5', text: 'text-white/50', border: 'border-white/15' };

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  google:    'Google',
  xai:       'xAI',
  openai:    'OpenAI',
  mistral:   'Mistral',
  kimi:      'Kimi',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ProviderBadge({ provider }: { provider?: string }) {
  const badge: { bg: string; text: string; border: string } =
    (provider ? PROVIDER_BADGE[provider] : undefined) ?? DEFAULT_BADGE;
  return (
    <span className={`
      inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium border
      ${badge.bg} ${badge.text} ${badge.border}
    `}>
      {(provider && PROVIDER_LABELS[provider]) ?? provider ?? 'Unknown'}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="border border-dashed border-white/10 rounded-xl px-6 py-8 flex flex-col items-center text-center gap-2">
      <Users className="w-7 h-7 text-white/20" />
      <p className="text-sm text-white/35 leading-relaxed">
        No overrides configured — all agents use role defaults
      </p>
    </div>
  );
}

// ─── Grouped model dropdown ───────────────────────────────────────────────────

function ModelSelect({
  models,
  value,
  onChange,
  disabled,
}: {
  models: ModelEntry[];
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Group by provider
  const grouped = models.reduce<Record<string, ModelEntry[]>>((acc, m) => {
    if (!acc[m.provider]) acc[m.provider] = [];
    acc[m.provider].push(m);
    return acc;
  }, {});

  const selectedModel = models.find((m) => m.id === value);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className={`
          glass-input flex items-center justify-between gap-2 cursor-pointer text-left
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-blue-500/40'}
        `}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`flex-1 truncate text-sm ${selectedModel ? 'text-foreground' : 'text-muted'}`}>
          {selectedModel ? selectedModel.label : 'Select a model…'}
        </span>
        <ChevronDown className={`w-4 h-4 text-white/35 flex-shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          {/* Dropdown */}
          <div
            className="absolute top-full left-0 right-0 mt-1 z-20 max-h-60 overflow-y-auto rounded-xl border border-white/10 bg-[#080f20] shadow-[0_8px_32px_rgba(0,0,0,0.7)]"
            role="listbox"
          >
            {Object.entries(grouped).map(([provider, provModels]) => (
              <div key={provider}>
                <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-white/25 bg-white/2 sticky top-0">
                  {PROVIDER_LABELS[provider] ?? provider}
                </div>
                {provModels.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={m.id === value}
                    onClick={() => {
                      onChange(m.id);
                      setOpen(false);
                    }}
                    className={`
                      w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition-all
                      ${m.id === value
                        ? 'bg-blue-500/15 text-white'
                        : 'text-white/70 hover:bg-white/5 hover:text-white'
                      }
                    `}
                  >
                    <span className="truncate">{m.label}</span>
                    {m.id === value && <Check className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function AgentModelOverridePanel() {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [overrides, setOverrides] = useState<Record<string, ModelOverride>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add override form state
  const [agentName, setAgentName] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState(false);

  // Deleting state — tracks which agent name is being deleted
  const [deletingAgent, setDeletingAgent] = useState<string | null>(null);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [modelsRes, configRes] = await Promise.all([
        fetch('/api/models'),
        fetch('/api/models/configured'),
      ]);

      if (!modelsRes.ok) throw new Error(`Failed to load models (${modelsRes.status})`);

      const modelsData = await modelsRes.json() as { models: ModelEntry[] };
      setModels(Array.isArray(modelsData) ? modelsData : (modelsData.models ?? []));

      if (configRes.ok) {
        const configData = await configRes.json() as {
          providers: Record<string, ProviderConfig>;
          overrides: Record<string, ModelOverride>;
        };
        setOverrides(configData.overrides ?? {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleAddOverride = async () => {
    if (!agentName.trim() || !selectedModelId) {
      setAddError('Agent name and model are both required');
      return;
    }

    const model = models.find((m) => m.id === selectedModelId);
    if (!model) {
      setAddError('Selected model not found');
      return;
    }

    setAdding(true);
    setAddError(null);

    try {
      const res = await fetch('/api/models/configured', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action:    'setOverride',
          agentName: agentName.trim(),
          model:     selectedModelId,
          provider:  model.provider,
        }),
      });

      const data = await res.json() as { success?: boolean; error?: string };

      if (!res.ok || !data.success) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      // Brief success state, then refresh
      setAddSuccess(true);
      setTimeout(() => setAddSuccess(false), 1500);

      setAgentName('');
      setSelectedModelId('');
      await fetchData();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add override');
    } finally {
      setAdding(false);
    }
  };

  const handleDeleteOverride = async (agentNameKey: string) => {
    setDeletingAgent(agentNameKey);

    try {
      const res = await fetch('/api/models/configured', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action:    'removeOverride',
          agentName: agentNameKey,
        }),
      });

      const data = await res.json() as { success?: boolean; error?: string };

      if (!res.ok || !data.success) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove override');
    } finally {
      setDeletingAgent(null);
    }
  };

  // ── Derived data ───────────────────────────────────────────────────────────

  const overrideEntries = Object.entries(overrides);

  const getModelLabel = (modelId: string): { label: string; provider?: string } => {
    const found = models.find((m) => m.id === modelId);
    return found
      ? { label: found.label, provider: found.provider }
      : { label: modelId };
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="glass-card p-6 space-y-5">

      {/* ── Section Header ──────────────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20 flex-shrink-0">
          <Users className="w-4 h-4 text-blue-400" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white">Agent Model Overrides</h3>
          <p className="text-xs text-white/40 mt-0.5 leading-relaxed">
            Assign specific models to individual agents. Overrides take highest priority.
          </p>
        </div>
      </div>

      {/* ── Global error ────────────────────────────────────────────────────── */}
      {error && (
        <div className="flex items-start gap-2.5 px-3 py-3 rounded-xl bg-red-500/10 border border-red-500/20">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* ── Loading state ────────────────────────────────────────────────────── */}
      {loading && (
        <div className="flex items-center justify-center py-10 text-white/25">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      )}

      {/* ── Overrides table / empty state ───────────────────────────────────── */}
      {!loading && (
        <>
          {overrideEntries.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="rounded-xl overflow-hidden border border-white/[0.06]">
              {/* Table header */}
              <div className="grid grid-cols-[1.6fr_1.8fr_auto_auto_auto] gap-x-3 px-4 py-2.5 bg-black/30 border-b border-white/[0.05] text-[10px] font-bold uppercase tracking-widest text-white/25">
                <span>Agent</span>
                <span>Model</span>
                <span>Provider</span>
                <span>Set</span>
                <span aria-label="Actions" />
              </div>

              {/* Table body */}
              <div className="divide-y divide-white/[0.04]">
                {overrideEntries.map(([name, override]) => {
                  const { label: modelLabel, provider } = getModelLabel(override.model);
                  const isDeleting = deletingAgent === name;

                  return (
                    <div
                      key={name}
                      className="grid grid-cols-[1.6fr_1.8fr_auto_auto_auto] gap-x-3 items-center px-4 py-3 hover:bg-white/[0.03] transition-colors group"
                    >
                      {/* Agent name */}
                      <span className="font-mono text-sm text-white/90 truncate" title={name}>
                        {name}
                      </span>

                      {/* Model label */}
                      <span className="text-sm text-white/60 truncate" title={modelLabel}>
                        {modelLabel}
                      </span>

                      {/* Provider badge */}
                      <ProviderBadge provider={provider ?? override.provider} />

                      {/* Timestamp */}
                      <span className="text-xs text-white/30 whitespace-nowrap">
                        {timeAgo(override.setAt)}
                      </span>

                      {/* Delete */}
                      <button
                        onClick={() => handleDeleteOverride(name)}
                        disabled={isDeleting}
                        className="p-1.5 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-all opacity-0 group-hover:opacity-100 disabled:opacity-50"
                        aria-label={`Remove override for ${name}`}
                      >
                        {isDeleting
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Trash2 className="w-3.5 h-3.5" />
                        }
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Add override form ────────────────────────────────────────────────── */}
      {!loading && (
        <div className="bg-white/[0.03] rounded-xl p-4 border border-white/[0.05] space-y-3">
          <p className="text-xs font-semibold text-white/35 uppercase tracking-wider">
            Add Override
          </p>

          <div className="grid grid-cols-2 gap-3">
            {/* Agent name */}
            <div>
              <label htmlFor="override-agent-name" className="block text-xs text-white/40 mb-1.5">
                Agent Name
              </label>
              <input
                id="override-agent-name"
                type="text"
                value={agentName}
                onChange={(e) => { setAgentName(e.target.value); setAddError(null); }}
                placeholder="e.g. Teyla, Carter, Jones"
                className={`glass-input text-sm ${addError && !agentName.trim() ? 'error' : ''}`}
                autoComplete="off"
              />
            </div>

            {/* Model selector */}
            <div>
              <label className="block text-xs text-white/40 mb-1.5">
                Model
              </label>
              <ModelSelect
                models={models}
                value={selectedModelId}
                onChange={(id) => { setSelectedModelId(id); setAddError(null); }}
                disabled={models.length === 0}
              />
            </div>
          </div>

          {/* Runtime hint — surfaces which wrapper will run this model.
              Single-runtime: colored badge "Runs via X" (direct, unambiguous).
              Multi-runtime: text note listing default + alternatives. */}
          {selectedModelId && (() => {
            const m = models.find((x) => x.id === selectedModelId);
            if (!m || !m.agentTypes || m.agentTypes.length === 0) return null;
            const types = m.agentTypes;
            if (types.length === 1) {
              const badge = RUNTIME_BADGE[types[0]] ?? DEFAULT_RUNTIME_BADGE;
              return (
                <div className="flex items-center gap-1.5 px-1">
                  <span className="text-white/30 text-[10px]">↳</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium border ${badge.bg} ${badge.text} ${badge.border}`}>
                    Runs via {types[0]}
                  </span>
                </div>
              );
            }
            return (
              <div className="flex items-start gap-2 text-xs text-white/45 px-1">
                <span className="text-white/30 mt-px">↳</span>
                <span>
                  Default runtime:{' '}
                  <span className="font-mono text-white/70">{types[0]}</span>
                  {' — also supports '}
                  <span className="text-white/50">{types.slice(1).join(', ')}</span>
                </span>
              </div>
            );
          })()}

          {/* Form error */}
          {addError && (
            <div className="flex items-center gap-2 text-xs text-red-400">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{addError}</span>
            </div>
          )}

          {/* Submit */}
          <button
            type="button"
            onClick={handleAddOverride}
            disabled={adding || !agentName.trim() || !selectedModelId}
            className="glass-button primary flex items-center justify-center gap-2 w-full text-sm"
          >
            {adding ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Adding…</span>
              </>
            ) : addSuccess ? (
              <>
                <Check className="w-4 h-4 text-green-400" />
                <span>Added</span>
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" />
                <span>Add Override</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* ── Priority resolution note ─────────────────────────────────────────── */}
      <div className="text-xs text-white/25 leading-relaxed border-t border-white/[0.04] pt-4">
        <span className="font-semibold text-white/35">Resolution order:</span>{' '}
        <span className="text-white/40">Agent override</span>
        {' '}&rsaquo;{' '}
        <span>Role default</span>
        {' '}&rsaquo;{' '}
        <span>Global default</span>
        {'. '}
        Overrides here take highest priority and bypass all other settings.
      </div>
    </div>
  );
}
