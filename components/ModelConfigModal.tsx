'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X,
  Key,
  Terminal,
  Eye,
  EyeOff,
  Check,
  AlertCircle,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { PRODUCT_NAME } from '@/lib/brand';

// ─── Shared Types ────────────────────────────────────────────────────────────

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

interface ModelConfigModalProps {
  model: ModelEntry;
  onClose: () => void;
  onConfigured: (provider: string, authType: 'api-key' | 'subscription') => void;
}

// ─── Provider placeholder hints ──────────────────────────────────────────────

const PROVIDER_KEY_HINTS: Record<string, string> = {
  anthropic: 'sk-ant-api03-...',
  google:    'AIzaSy...',
  xai:       'xai-...',
  openai:    'sk-proj-...',
  mistral:   'mis-...',
  kimi:      'sk-...',
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  google:    'Google DeepMind',
  xai:       'xAI',
  openai:    'OpenAI',
  mistral:   'Mistral AI',
  kimi:      'Kimi (Moonshot)',
};

// ─── Tier styling ─────────────────────────────────────────────────────────────

const TIER_STYLES: Record<string, string> = {
  powerful: 'bg-purple-500/15 text-purple-300 border border-purple-500/30',
  balanced: 'bg-blue-500/15 text-blue-300 border border-blue-500/30',
  fast:     'bg-green-500/15 text-green-300 border border-green-500/30',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function AuthTypeCard({
  type,
  selected,
  onClick,
}: {
  type: 'api-key' | 'subscription';
  selected: boolean;
  onClick: () => void;
}) {
  const isKey = type === 'api-key';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        relative flex flex-col gap-2 p-4 rounded-xl border text-left transition-all duration-200 group
        ${selected
          ? 'border-blue-500/50 bg-blue-500/10 shadow-[0_0_20px_rgba(59,130,246,0.08)]'
          : 'border-white/8 bg-white/2 hover:border-white/15 hover:bg-white/5'
        }
      `}
      aria-pressed={selected}
    >
      <div className={`
        w-9 h-9 rounded-lg flex items-center justify-center transition-all
        ${selected
          ? 'bg-blue-500/25 text-blue-400'
          : 'bg-white/6 text-white/40 group-hover:bg-white/10 group-hover:text-white/60'
        }
      `}>
        {isKey ? <Key className="w-4 h-4" /> : <Terminal className="w-4 h-4" />}
      </div>
      <div>
        <div className={`text-sm font-semibold transition-colors ${selected ? 'text-white' : 'text-white/70'}`}>
          {isKey ? 'API Key' : 'Subscription'}
        </div>
        <div className="text-xs text-white/40 mt-0.5 leading-relaxed">
          {isKey
            ? 'Paste your provider API key'
            : 'Uses your existing subscription'}
        </div>
      </div>
      {selected && (
        <div className="absolute top-3 right-3 w-4 h-4 rounded-full bg-blue-500/30 border border-blue-500/60 flex items-center justify-center">
          <Check className="w-2.5 h-2.5 text-blue-400" />
        </div>
      )}
    </button>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ModelConfigModal({ model, onClose, onConfigured }: ModelConfigModalProps) {
  const [authType, setAuthType] = useState<'api-key' | 'subscription'>('api-key');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [successState, setSuccessState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentConfig, setCurrentConfig] = useState<ProviderConfig | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);

  const overlayRef = useRef<HTMLDivElement>(null);

  // Fetch existing config on mount
  const fetchConfig = useCallback(async () => {
    try {
      setLoadingConfig(true);
      const res = await fetch('/api/models/configured');
      if (!res.ok) throw new Error('Failed to load config');
      const data = await res.json() as {
        providers: Record<string, ProviderConfig>;
        overrides: Record<string, unknown>;
      };
      const config = data.providers?.[model.provider] ?? null;
      setCurrentConfig(config);
      // Pre-select the existing auth type if configured
      if (config?.authType) setAuthType(config.authType);
    } catch {
      // Non-fatal — just no pre-fill
      setCurrentConfig(null);
    } finally {
      setLoadingConfig(false);
    }
  }, [model.provider]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Keyboard escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleSave = async () => {
    if (authType === 'api-key' && !apiKey.trim()) {
      setError('API key is required');
      return;
    }
    setError(null);
    setSaving(true);

    try {
      const body: Record<string, string> = {
        action: 'configure',
        provider: model.provider,
        authType,
      };
      if (authType === 'api-key') body.apiKey = apiKey.trim();

      const res = await fetch('/api/models/configured', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json() as { success?: boolean; error?: string };

      if (!res.ok || !data.success) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      setSuccessState(true);
      onConfigured(model.provider, authType);

      // Auto-close after 1.5 s
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  // Current status badge data
  const statusBadge = (() => {
    if (loadingConfig) return null;
    if (!currentConfig?.configured) {
      return { label: 'Not configured', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' };
    }
    if (currentConfig.authType === 'api-key') {
      return { label: 'API Key', cls: 'bg-green-500/15 text-green-300 border-green-500/30' };
    }
    return { label: 'Subscription', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' };
  })();

  const tierClass = TIER_STYLES[model.tier] ?? TIER_STYLES.balanced;
  const providerLabel = PROVIDER_LABELS[model.provider] ?? model.provider;
  const keyHint = PROVIDER_KEY_HINTS[model.provider] ?? 'your-api-key-here';

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={`Configure ${model.label}`}
    >
      <div className="w-full max-w-lg bg-[#0a1628] rounded-2xl border border-white/[0.08] shadow-[0_24px_80px_rgba(0,0,0,0.7)] flex flex-col overflow-hidden">

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-white/[0.06]">
          <div className="flex-1 min-w-0 pr-4">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-base font-bold text-white leading-tight">{model.label}</h2>
              <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${tierClass}`}>
                {model.tier}
              </span>
              {statusBadge && (
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${statusBadge.cls}`}>
                  {statusBadge.label}
                </span>
              )}
            </div>
            <p className="text-sm text-white/45 mt-0.5">{providerLabel}</p>
          </div>
          <button
            onClick={onClose}
            className="flex-shrink-0 p-1.5 rounded-lg text-white/35 hover:text-white hover:bg-white/8 transition-all"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Body ───────────────────────────────────────────────────────────── */}
        <div className="px-6 py-5 space-y-5">

          {/* Success overlay */}
          {successState && (
            <div className="flex flex-col items-center justify-center gap-3 py-8">
              <div className="w-12 h-12 rounded-full bg-green-500/20 border border-green-500/30 flex items-center justify-center">
                <Check className="w-6 h-6 text-green-400" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-green-300">Configured successfully</p>
                <p className="text-xs text-white/40 mt-0.5">Closing in a moment…</p>
              </div>
            </div>
          )}

          {!successState && (
            <>
              {/* Auth type selector */}
              <div>
                <p className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2.5">
                  Authentication Method
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <AuthTypeCard type="api-key"      selected={authType === 'api-key'}      onClick={() => { setAuthType('api-key');      setError(null); }} />
                  <AuthTypeCard type="subscription" selected={authType === 'subscription'} onClick={() => { setAuthType('subscription'); setError(null); }} />
                </div>
              </div>

              {/* Divider */}
              <div className="border-t border-white/[0.05]" />

              {/* API Key panel */}
              {authType === 'api-key' && (
                <div className="space-y-3">
                  <div>
                    <label htmlFor="api-key-input" className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">
                      API Key
                    </label>
                    <div className="relative">
                      <input
                        id="api-key-input"
                        type={showKey ? 'text' : 'password'}
                        value={apiKey}
                        onChange={(e) => { setApiKey(e.target.value); setError(null); }}
                        placeholder={keyHint}
                        className={`glass-input pr-12 font-mono text-sm ${error ? 'error' : ''}`}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey((v) => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-white/35 hover:text-white/70 transition-colors"
                        aria-label={showKey ? 'Hide API key' : 'Show API key'}
                      >
                        {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-white/30">
                    <Sparkles className="w-3 h-3 text-blue-400/60 flex-shrink-0" />
                    <span>Key is stored securely in the vault and never logged</span>
                  </div>
                </div>
              )}

              {/* Subscription panel */}
              {authType === 'subscription' && (
                <div className="space-y-3">
                  <div className="p-4 rounded-xl bg-blue-500/5 border border-blue-500/15">
                    <p className="text-sm text-white/70 leading-relaxed">
                      Uses your existing {providerLabel} subscription. No API key required.
                    </p>
                    <p className="text-xs text-white/35 mt-2 leading-relaxed">
                      {PRODUCT_NAME} will use the CLI-based authentication already present on this machine.
                      Make sure you are logged in to the relevant CLI tool.
                    </p>
                  </div>
                </div>
              )}

              {/* Error banner */}
              {error && (
                <div className="flex items-start gap-2.5 px-3 py-3 rounded-xl bg-red-500/10 border border-red-500/20">
                  <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-300">{error}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────────── */}
        {!successState && (
          <div className="flex gap-3 px-6 pb-5 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="glass-button secondary flex-1 text-sm"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || (authType === 'api-key' && !apiKey.trim())}
              className="glass-button primary flex-1 flex items-center justify-center gap-2 text-sm"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Saving…</span>
                </>
              ) : authType === 'subscription' ? (
                <>
                  <Terminal className="w-4 h-4" />
                  <span>Confirm Subscription</span>
                </>
              ) : (
                <>
                  <Key className="w-4 h-4" />
                  <span>Save API Key</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
