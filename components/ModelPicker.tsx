'use client';

/**
 * <ModelPicker /> — Sprint M Phase 3 T1 (2026-05-27).
 *
 * Reusable model selection dropdown. Drop-in for any DevFlow feature that
 * needs to pick a model. Fetches from GET /api/models?includeIntegration=true
 * and applies client-side filters from props.
 *
 * Two distinct namespace props per AMENDMENT #2:
 *   requiredModalCapabilities  — existing model-level caps (reasoning, toolUse,
 *                                 vision, contextWindow, maxOutputTokens)
 *   requiredIntegration        — Sprint M P1 integration caps (hooks,
 *                                 scaffolding, harness, feed, skills, mcp,
 *                                 memory, telemetry)
 *
 * Design references:
 *   - docs/plan-model-integration-framework.md §3.1
 *   - ColabRightPanel.tsx:517-525 (agentType→model filter pattern)
 *   - ModelsSection.tsx (ms-cap / ms-dot CSS classes + inline <style jsx>)
 */

import { useState, useEffect, useMemo } from 'react';
import { Check, Minus, X, ChevronDown } from 'lucide-react';
import type { CapabilityLevel } from '@/lib/model-registry';
import type { ModelCapabilities, ModelIntegration } from '@/lib/model-registry';

// ── Types ────────────────────────────────────────────────────────────────────

/** Subset of the model registry entry the picker needs from the API. */
interface PickerModel {
  id: string;
  aliases?: string[];
  provider: string;
  label: string;
  description?: string;
  tier: string;
  agentTypes: string[];
  isDefault?: boolean;
  apiId?: string;
  capabilities?: {
    reasoning?: boolean;
    reasoningOnly?: boolean;
    vision?: boolean;
    toolUse?: boolean;
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsStreaming?: boolean;
    supportsTemperature?: boolean;
    preview?: boolean;
  };
  integration?: {
    status: CapabilityLevel;
    interfaceType: string;
    detectedAt: string;
    capabilities: Record<string, CapabilityLevel>;
  };
}

interface InterfaceTypeEntry {
  id: string;
  label: string;
  description: string;
}

/** Modal (model-level) capability filters. These are properties of the model
 *  itself — reasoning support, vision, context window size, etc. Only apply
 *  when the model has the capability declared. */
interface RequiredModalCapabilities {
  reasoning?: boolean;
  toolUse?: boolean;
  vision?: boolean;
  contextWindowMin?: number;
  maxOutputTokensMin?: number;
}

export interface ModelPickerProps {
  /** Currently selected model ID (controlled). */
  value: string;
  /** Called when user selects a model. */
  onChange: (modelId: string) => void;
  /** Optional: also let user pick agentType (for models with multiple runtimes). */
  showAgentType?: boolean;
  agentTypeValue?: string;
  onAgentTypeChange?: (agentType: string) => void;
  /** Filter models by model-level capabilities (reasoning, toolUse, vision, etc.). */
  requiredModalCapabilities?: RequiredModalCapabilities;
  /** Filter models by integration capabilities (hooks, scaffolding, etc.). */
  requiredIntegration?: Partial<Record<string, CapabilityLevel>>;
  /** Filter by provider list. */
  providerFilter?: string[];
  /** Filter by interface type list. */
  interfaceFilter?: string[];
  /** Minimum aggregate integration status. */
  minIntegrationStatus?: CapabilityLevel;
  /** Placeholder text for the model dropdown. */
  placeholder?: string;
  /** CSS class overrides on the wrapper. */
  className?: string;
  /** Compact mode — smaller padding, tighter spacing (for inline use). */
  compact?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const CAP_RANK: Record<CapabilityLevel, number> = { none: 0, partial: 1, full: 2 };

const STATUS_DOT_CLASS: Record<string, string> = {
  full: 'ms-dot ms-dot--full',
  partial: 'ms-dot ms-dot--partial',
  none: 'ms-dot ms-dot--none',
};

/** Small coloured dot indicating integration status level. */
function StatusDot({ level }: { level: CapabilityLevel | undefined }) {
  const cls = level && STATUS_DOT_CLASS[level] ? STATUS_DOT_CLASS[level] : 'ms-dot ms-dot--unknown';
  return <span className={cls} aria-label={level ?? 'unknown'} />;
}

/** Compact check / minus / X glyph matching ModelsSection's CapabilityGlyph. */
function CapGlyph({ level }: { level: CapabilityLevel | undefined }) {
  if (level === 'full') {
    return <span className="mp-cap mp-cap--full" aria-label="full"><Check size={10} strokeWidth={3} /></span>;
  }
  if (level === 'partial') {
    return <span className="mp-cap mp-cap--partial" aria-label="partial"><Minus size={10} strokeWidth={3} /></span>;
  }
  return <span className="mp-cap mp-cap--none" aria-label="none"><X size={10} strokeWidth={3} /></span>;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ModelPicker({
  value,
  onChange,
  showAgentType = false,
  agentTypeValue = '',
  onAgentTypeChange,
  requiredModalCapabilities,
  requiredIntegration,
  providerFilter,
  interfaceFilter,
  minIntegrationStatus,
  placeholder = 'Select model...',
  className = '',
  compact = false,
}: ModelPickerProps) {
  const [models, setModels] = useState<PickerModel[]>([]);
  const [interfaceTypes, setInterfaceTypes] = useState<InterfaceTypeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Data fetch ─────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [modelsRes, ifaceRes] = await Promise.all([
          fetch('/api/models?includeIntegration=true', { cache: 'no-store' }),
          showAgentType || interfaceFilter
            ? fetch('/api/models/interface-types', { cache: 'no-store' })
            : Promise.resolve(null),
        ]);
        if (cancelled) return;

        if (!modelsRes.ok) {
          setError(`Failed to load models (${modelsRes.status})`);
          return;
        }
        const modelsJson = await modelsRes.json();
        setModels((modelsJson.models ?? []) as PickerModel[]);

        if (ifaceRes?.ok) {
          const ifaceJson = await ifaceRes.json();
          setInterfaceTypes((ifaceJson.interfaceTypes ?? []) as InterfaceTypeEntry[]);
        }
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Network error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [showAgentType, interfaceFilter]);

  // ── Filtering ──────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return models.filter(m => {
      // Provider filter
      if (providerFilter && providerFilter.length > 0) {
        if (!providerFilter.includes(m.provider)) return false;
      }
      // Interface filter
      if (interfaceFilter && interfaceFilter.length > 0) {
        if (!m.integration?.interfaceType || !interfaceFilter.includes(m.integration.interfaceType)) return false;
      }
      // Minimum aggregate integration status
      if (minIntegrationStatus) {
        const status = m.integration?.status ?? 'none';
        if (CAP_RANK[status] < CAP_RANK[minIntegrationStatus]) return false;
      }
      // Required integration capabilities (server pre-filters via API, but client-side for safety)
      if (requiredIntegration) {
        const caps = m.integration?.capabilities ?? {};
        for (const [slug, minLevel] of Object.entries(requiredIntegration)) {
          if (!minLevel) continue;
          const actual: CapabilityLevel = (caps[slug] as CapabilityLevel | undefined) ?? 'none';
          if (CAP_RANK[actual] < CAP_RANK[minLevel as CapabilityLevel]) return false;
        }
      }
      // Required modal capabilities
      if (requiredModalCapabilities) {
        const mc = m.capabilities;
        if (requiredModalCapabilities.reasoning && !mc?.reasoning) return false;
        if (requiredModalCapabilities.toolUse && !mc?.toolUse) return false;
        if (requiredModalCapabilities.vision && !mc?.vision) return false;
        if (requiredModalCapabilities.contextWindowMin != null && (mc?.contextWindow ?? 0) < requiredModalCapabilities.contextWindowMin) return false;
        if (requiredModalCapabilities.maxOutputTokensMin != null && (mc?.maxOutputTokens ?? 0) < requiredModalCapabilities.maxOutputTokensMin) return false;
      }
      return true;
    });
  }, [models, providerFilter, interfaceFilter, minIntegrationStatus, requiredIntegration, requiredModalCapabilities]);

  // Models grouped by provider for the dropdown (sorted: defaults first)
  const grouped = useMemo(() => {
    const groups: Map<string, PickerModel[]> = new Map();
    for (const m of filtered) {
      const list = groups.get(m.provider) ?? [];
      list.push(m);
      groups.set(m.provider, list);
    }
    // Sort each group: defaults first, then alphabetical
    for (const list of groups.values()) {
      list.sort((a, b) => {
        if (a.isDefault && !b.isDefault) return -1;
        if (!a.isDefault && b.isDefault) return 1;
        return a.label.localeCompare(b.label);
      });
    }
    return groups;
  }, [filtered]);

  const selectedModel = useMemo(() => {
    if (!value) return undefined;
    return models.find(model => model.id === value || model.aliases?.includes(value));
  }, [models, value]);

  // Available agent types for the selected model
  const availableAgentTypes = useMemo(() => {
    return selectedModel?.agentTypes ?? [];
  }, [selectedModel]);

  // Interface type label for the selected model (displayed inline)
  const selectedInterface = useMemo(() => {
    return selectedModel?.integration?.interfaceType ?? null;
  }, [selectedModel]);

  // Provider label for selected model
  const selectedProvider = useMemo(() => {
    return selectedModel?.provider ?? null;
  }, [selectedModel]);

  // ── Provider display name helper ──────────────────────────────────────────

  const providerLabel = (p: string) => {
    const map: Record<string, string> = {
      anthropic: 'Anthropic',
      deepseek: 'DeepSeek',
      google: 'Google',
      xai: 'xAI',
      openai: 'OpenAI',
      ollama: 'Ollama',
    };
    return map[p] ?? p;
  };

  // ── Custom dropdown arrow style (reuse pattern from AgentSpawnDropdown) ────

  const selectStyle: React.CSSProperties = {
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.3)' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 8px center',
    paddingRight: '28px',
    appearance: 'none' as React.CSSProperties['appearance'],
    cursor: 'pointer',
  };

  const inputClass = compact
    ? 'bg-black/20 border border-white/[0.06] rounded-lg px-2 py-1 text-xs text-white/70 focus:outline-none focus:border-blue-500/30 transition-colors min-w-0'
    : 'bg-black/20 border border-white/[0.06] rounded-lg px-2.5 py-2 text-sm text-white/80 focus:outline-none focus:border-blue-500/30 transition-colors min-w-0';

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className={`flex items-center gap-2 ${compact ? 'text-[10px]' : 'text-xs'} text-white/30 ${className}`}>
        <div className="w-3 h-3 rounded-full border border-white/[0.08] border-t-white/30 animate-spin" />
        Loading models...
      </div>
    );
  }

  if (error) {
    return (
      <div className={`${compact ? 'text-[10px]' : 'text-xs'} text-red-400/70 ${className}`}>
        {error}
      </div>
    );
  }

  return (
    <>
      <div className={`flex ${showAgentType ? 'gap-1.5' : ''} ${className}`}>
        {/* Model dropdown */}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
          style={selectStyle}
        >
          <option value="" className="bg-[#0e1c32]">{placeholder}</option>
          {value && selectedModel && value !== selectedModel.id && (
            <option value={value} className="bg-[#0e1c32]">
              {selectedModel.label} (legacy ID)
            </option>
          )}
          {Array.from(grouped.entries()).map(([provider, providerModels]) => (
            <optgroup key={provider} label={providerLabel(provider)}>
              {providerModels.map(m => (
                <option key={m.id} value={m.id} className="bg-[#0e1c32]">
                  {m.label}
                  {m.isDefault ? ' (default)' : ''}
                  {m.integration ? ` · ${m.integration.status}` : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        {/* Agent type picker (shown only when showAgentType is true) */}
        {showAgentType && onAgentTypeChange && (
          <select
            value={agentTypeValue}
            onChange={(e) => onAgentTypeChange(e.target.value)}
            className={inputClass}
            style={selectStyle}
            disabled={!value}
          >
            <option value="" className="bg-[#0e1c32]">
              {value ? 'Default runtime' : 'Pick a model first'}
            </option>
            {availableAgentTypes.map(at => (
              <option key={at} value={at} className="bg-[#0e1c32]">
                {at}
                {at === availableAgentTypes[0] ? ' (recommended)' : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Selected model info — integration status + interface, compact inline */}
      {value && selectedProvider && selectedInterface && (
        <div className={`flex items-center gap-2 ${compact ? 'mt-1 text-[10px]' : 'mt-1.5 text-[11px]'} text-white/40`}>
          <StatusDot level={
            (selectedModel?.integration?.status as CapabilityLevel | undefined)
          } />
          <span>{providerLabel(selectedProvider)}</span>
          <span className="text-white/20">·</span>
          <span>{selectedInterface}</span>
        </div>
      )}

      {/* Inline <style jsx> for mp-cap to avoid collisions with ms-cap in ModelsSection */}
      <style jsx>{`
        :global(.ms-dot) { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        :global(.ms-dot--full) { background: #22c55e; box-shadow: 0 0 4px rgba(34,197,94,0.4); }
        :global(.ms-dot--partial) { background: #eab308; box-shadow: 0 0 4px rgba(234,179,8,0.4); }
        :global(.ms-dot--none) { background: #ef4444; }
        :global(.ms-dot--unknown) { background: rgba(255,255,255,0.15); }
        :global(.mp-cap) { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 3px; flex-shrink: 0; }
        :global(.mp-cap--full) { background: rgba(34,197,94,0.15); color: #22c55e; }
        :global(.mp-cap--partial) { background: rgba(234,179,8,0.18); color: #eab308; }
        :global(.mp-cap--none) { background: rgba(239,68,68,0.15); color: #ef4444; }
      `}</style>
    </>
  );
}
