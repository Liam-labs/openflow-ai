'use client';

import { useState, useEffect } from 'react';
import {
  X,
  ChevronRight,
  Cpu,
  Zap,
  Brain,
  Globe,
  Sparkles,
  Check,
  AlertCircle,
} from 'lucide-react';

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

interface ModelConfigPanelProps {
  onClose: () => void;
  onModelSelect: (model: ModelEntry) => void;
}

interface ProviderMeta {
  key: string;
  label: string;
  tagline: string;
  accent: string;
  comingSoon?: boolean;
}

const PROVIDERS: ProviderMeta[] = [
  { key: 'anthropic', label: 'Anthropic', tagline: 'Claude — reasoning & coding', accent: 'blue' },
  { key: 'google', label: 'Google DeepMind', tagline: 'Gemini — multimodal & long context', accent: 'indigo' },
  { key: 'xai', label: 'xAI', tagline: 'Grok — real-time knowledge', accent: 'amber' },
  { key: 'openai', label: 'OpenAI', tagline: 'GPT & o-series models', accent: 'emerald', comingSoon: true },
  { key: 'kimi', label: 'Kimi (Moonshot)', tagline: 'Long context specialist', accent: 'violet', comingSoon: true },
  { key: 'mistral', label: 'Mistral AI', tagline: 'Open & efficient models', accent: 'orange', comingSoon: true },
];

const ACCENT_CLASSES: Record<string, { text: string; border: string; bg: string; badgeBg: string }> = {
  blue:    { text: 'text-blue-400',    border: 'border-blue-500/40',    bg: 'bg-blue-500/10',    badgeBg: 'bg-blue-500/20' },
  indigo:  { text: 'text-indigo-400',  border: 'border-indigo-500/40',  bg: 'bg-indigo-500/10',  badgeBg: 'bg-indigo-500/20' },
  amber:   { text: 'text-amber-400',   border: 'border-amber-500/40',   bg: 'bg-amber-500/10',   badgeBg: 'bg-amber-500/20' },
  emerald: { text: 'text-emerald-400', border: 'border-emerald-500/40', bg: 'bg-emerald-500/10', badgeBg: 'bg-emerald-500/20' },
  violet:  { text: 'text-violet-400',  border: 'border-violet-500/40',  bg: 'bg-violet-500/10',  badgeBg: 'bg-violet-500/20' },
  orange:  { text: 'text-orange-400',  border: 'border-orange-500/40',  bg: 'bg-orange-500/10',  badgeBg: 'bg-orange-500/20' },
};

const TIER_CLASSES: Record<string, string> = {
  powerful: 'bg-purple-500/20 text-purple-300 border border-purple-500/30',
  balanced: 'bg-blue-500/20 text-blue-300 border border-blue-500/30',
  fast:     'bg-green-500/20 text-green-300 border border-green-500/30',
};

const PROVIDER_ICONS: Record<string, typeof Brain> = {
  anthropic: Brain,
  google:    Globe,
  xai:       Zap,
  openai:    Sparkles,
  kimi:      Cpu,
  mistral:   Cpu,
};

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-white/5 bg-white/3 p-4 animate-pulse">
      <div className="flex items-start justify-between mb-3">
        <div className="h-4 w-28 bg-white/10 rounded" />
        <div className="h-5 w-16 bg-white/10 rounded-full" />
      </div>
      <div className="h-3 w-full bg-white/5 rounded mb-1.5" />
      <div className="h-3 w-2/3 bg-white/5 rounded mb-4" />
      <div className="flex gap-1.5">
        <div className="h-5 w-14 bg-white/5 rounded-full" />
        <div className="h-5 w-14 bg-white/5 rounded-full" />
      </div>
    </div>
  );
}

function WelcomeState({ onProviderSelect }: { onProviderSelect: (key: string) => void }) {
  return (
    <div className="flex flex-col items-center pt-10 px-6">
      <div className="mb-2 p-3 rounded-2xl bg-blue-500/10 border border-blue-500/20">
        <Cpu className="w-7 h-7 text-blue-400" />
      </div>
      <h2 className="text-xl font-semibold text-white mt-3 mb-1">Select a Provider</h2>
      <p className="text-sm text-white/50 text-center mb-8">
        Choose an AI lab to view and configure their models
      </p>

      <div className="grid grid-cols-2 gap-3 w-full max-w-xl">
        {PROVIDERS.map((p) => {
          const Icon = PROVIDER_ICONS[p.key] ?? Cpu;
          const ac = ACCENT_CLASSES[p.accent];
          return (
            <button
              key={p.key}
              disabled={p.comingSoon}
              onClick={() => !p.comingSoon && onProviderSelect(p.key)}
              className={`
                relative flex flex-col items-start gap-2 p-4 rounded-xl border text-left
                transition-all duration-200 group
                ${p.comingSoon
                  ? 'border-white/5 bg-white/2 opacity-40 cursor-not-allowed'
                  : `${ac.border} ${ac.bg} hover:bg-white/10 cursor-pointer`
                }
              `}
            >
              <div className={`p-2 rounded-lg ${ac.badgeBg}`}>
                <Icon className={`w-5 h-5 ${ac.text}`} />
              </div>
              <div>
                <div className="text-sm font-medium text-white">{p.label}</div>
                <div className="text-xs text-white/50 mt-0.5">{p.tagline}</div>
              </div>
              {p.comingSoon && (
                <span className="absolute top-3 right-3 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 text-white/40">
                  Soon
                </span>
              )}
              {!p.comingSoon && (
                <ChevronRight className={`absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 ${ac.text} opacity-0 group-hover:opacity-100 transition-opacity`} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ModelCard({ model, onSelect }: { model: ModelEntry; onSelect: (m: ModelEntry) => void }) {
  const tierClass = TIER_CLASSES[model.tier] ?? TIER_CLASSES.balanced;

  return (
    <button
      onClick={() => onSelect(model)}
      className="relative flex flex-col gap-3 p-4 rounded-xl border border-white/8 bg-black/20
        hover:border-white/20 hover:bg-white/5 transition-all duration-200 text-left group"
    >
      {model.isDefault && (
        <span className="absolute top-3 right-3 flex items-center gap-1 text-[10px] font-semibold
          px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
          <Check className="w-2.5 h-2.5" />
          Default
        </span>
      )}

      <div className="flex items-start justify-between pr-16">
        <div className="text-sm font-semibold text-white">{model.label}</div>
      </div>

      <span className={`self-start text-[11px] font-medium px-2 py-0.5 rounded-full ${tierClass}`}>
        {model.classification}
      </span>

      {model.description && (
        <p className="text-xs text-white/50 leading-relaxed">{model.description}</p>
      )}

      {model.agentTypes.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-auto">
          {model.agentTypes.map((t) => (
            <span
              key={t}
              className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/8 text-white/40"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

export function ModelConfigPanel({ onClose, onModelSelect }: ModelConfigPanelProps) {
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchModels() {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch('/api/models');
        if (!res.ok) throw new Error(`Failed to fetch models (${res.status})`);
        const data = await res.json();
        setModels(Array.isArray(data) ? data : (data.models ?? []));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load models');
      } finally {
        setLoading(false);
      }
    }
    fetchModels();
  }, []);

  const modelsByProvider = models.reduce<Record<string, ModelEntry[]>>((acc, m) => {
    if (!acc[m.provider]) acc[m.provider] = [];
    acc[m.provider].push(m);
    return acc;
  }, {});

  const activeProviderModels = selectedProvider ? (modelsByProvider[selectedProvider] ?? []) : [];

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="max-w-4xl w-full mx-4 h-[85vh] glass-card rounded-2xl flex flex-col overflow-hidden" style={{ background: 'rgba(8, 14, 28, 0.97)', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}>

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-white/8 flex-shrink-0">
          <div>
            <h2 className="text-lg font-bold gradient-text">Model Configuration</h2>
            <p className="text-sm text-white/50 mt-0.5">Manage AI providers and model selection</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-all"
            aria-label="Close panel"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">

          {/* Sidebar */}
          <div className="w-60 flex-shrink-0 border-r border-white/8 py-3 overflow-y-auto">
            {PROVIDERS.map((p) => {
              const Icon = PROVIDER_ICONS[p.key] ?? Cpu;
              const ac = ACCENT_CLASSES[p.accent];
              const isActive = selectedProvider === p.key;
              const count = modelsByProvider[p.key]?.length ?? 0;

              return (
                <button
                  key={p.key}
                  disabled={p.comingSoon}
                  onClick={() => !p.comingSoon && setSelectedProvider(p.key)}
                  className={`
                    w-full flex items-center gap-3 px-4 py-3 text-left transition-all duration-150 group
                    ${p.comingSoon ? 'opacity-35 cursor-not-allowed' : 'cursor-pointer'}
                    ${isActive
                      ? `border-l-2 ${ac.border.replace('/40', '/70')} ${ac.bg} pl-[14px]`
                      : 'border-l-2 border-transparent hover:bg-white/5 hover:pl-[14px]'
                    }
                  `}
                >
                  <div className={`p-1.5 rounded-lg flex-shrink-0 ${isActive ? ac.badgeBg : 'bg-white/5'}`}>
                    <Icon className={`w-4 h-4 ${isActive ? ac.text : 'text-white/40'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium truncate ${isActive ? 'text-white' : 'text-white/70'}`}>
                      {p.label}
                    </div>
                    <div className="text-[11px] text-white/35 truncate">{p.tagline}</div>
                  </div>
                  <div className="flex-shrink-0 flex items-center gap-1.5">
                    {p.comingSoon ? (
                      <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-white/8 text-white/30">
                        Soon
                      </span>
                    ) : (
                      <span className={`
                        text-[11px] font-semibold px-1.5 py-0.5 rounded-full
                        ${isActive ? `${ac.badgeBg} ${ac.text}` : 'bg-white/8 text-white/30'}
                      `}>
                        {count}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right content */}
          <div className="flex-1 overflow-y-auto">
            {!selectedProvider ? (
              <WelcomeState onProviderSelect={setSelectedProvider} />
            ) : (
              <div className="p-5">
                {/* Provider heading */}
                {(() => {
                  const meta = PROVIDERS.find((p) => p.key === selectedProvider);
                  const ac = ACCENT_CLASSES[meta?.accent ?? 'blue'];
                  const Icon = PROVIDER_ICONS[selectedProvider] ?? Cpu;
                  return (
                    <div className={`flex items-center gap-3 mb-5 pb-4 border-b border-white/8`}>
                      <div className={`p-2 rounded-xl ${ac.bg} border ${ac.border}`}>
                        <Icon className={`w-5 h-5 ${ac.text}`} />
                      </div>
                      <div>
                        <div className="text-base font-semibold text-white">{meta?.label}</div>
                        <div className="text-xs text-white/45">{meta?.tagline}</div>
                      </div>
                    </div>
                  );
                })()}

                {/* Error */}
                {error && (
                  <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm mb-4">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                {/* Loading */}
                {loading && (
                  <div className="grid grid-cols-2 gap-3">
                    <SkeletonCard />
                    <SkeletonCard />
                    <SkeletonCard />
                  </div>
                )}

                {/* Models */}
                {!loading && !error && activeProviderModels.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-16 text-white/30">
                    <Cpu className="w-8 h-8 mb-3 opacity-40" />
                    <p className="text-sm">No models available for this provider</p>
                  </div>
                )}

                {!loading && !error && activeProviderModels.length > 0 && (
                  <div className="grid grid-cols-2 gap-3">
                    {activeProviderModels.map((m) => (
                      <ModelCard key={m.id} model={m} onSelect={onModelSelect} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
