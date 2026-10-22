'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, Wand2, RotateCcw, Check, ShieldAlert, Cpu } from 'lucide-react';

interface EnhanceModel {
  id: string;
  label: string;
  hint: string;
}

interface EnhanceConfig {
  enabled: boolean;
  model: string;
  systemPrompt: string;
}

interface EnhanceDefaults {
  systemPrompt: string;
  model: string;
}

/** Notify open ColabPanel instances that the enhance config changed. */
function broadcastConfigChanged() {
  window.dispatchEvent(new CustomEvent('devflow:enhance-config-changed'));
}

export function StructurePromptPanel() {
  const [config, setConfig] = useState<EnhanceConfig | null>(null);
  const [defaults, setDefaults] = useState<EnhanceDefaults | null>(null);
  const [models, setModels] = useState<EnhanceModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Prompt editing state — independent of the instant-save toggle/model
  const [promptDraft, setPromptDraft] = useState('');
  const [promptDirty, setPromptDirty] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  useEffect(() => {
    fetch('/api/collab/enhance-prompt')
      .then(r => r.json())
      .then(d => {
        if (d.success && d.config) {
          setConfig(d.config);
          setDefaults(d.defaults || null);
          setModels(Array.isArray(d.models) ? d.models : []);
          setPromptDraft(d.config.systemPrompt || '');
        } else {
          setError(d.error || 'Failed to load Enhance settings');
        }
      })
      .catch(() => setError('Network error — could not load Enhance settings'))
      .finally(() => setLoading(false));
  }, []);

  /** PUT a partial config update. Returns the saved config on success, null on failure. */
  const putConfig = useCallback(async (patch: Partial<EnhanceConfig>): Promise<EnhanceConfig | null> => {
    try {
      const res = await fetch('/api/collab/enhance-prompt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const d = await res.json();
      if (d.success && d.config) {
        setError(null);
        broadcastConfigChanged();
        return d.config as EnhanceConfig;
      }
      setError(d.error || 'Save failed');
      return null;
    } catch {
      setError('Network error — could not save');
      return null;
    }
  }, []);

  // Toggle saves immediately — no Save button involved
  const handleToggle = useCallback(async () => {
    if (!config) return;
    const next = !config.enabled;
    setConfig(prev => prev ? { ...prev, enabled: next } : prev); // optimistic
    const saved = await putConfig({ enabled: next });
    if (saved) setConfig(saved);
    else setConfig(prev => prev ? { ...prev, enabled: !next } : prev); // revert on failure
  }, [config, putConfig]);

  // Model change saves immediately
  const handleModelChange = useCallback(async (model: string) => {
    if (!config) return;
    const previous = config.model;
    setConfig(prev => prev ? { ...prev, model } : prev); // optimistic
    const saved = await putConfig({ model });
    if (saved) setConfig(saved);
    else setConfig(prev => prev ? { ...prev, model: previous } : prev); // revert on failure
  }, [config, putConfig]);

  const handleSavePrompt = useCallback(async () => {
    setSavingPrompt(true);
    setSaveMsg('');
    const saved = await putConfig({ systemPrompt: promptDraft });
    if (saved) {
      setConfig(saved);
      setPromptDirty(false);
      setSaveMsg('Saved');
      setTimeout(() => setSaveMsg(''), 2500);
    }
    setSavingPrompt(false);
  }, [promptDraft, putConfig]);

  // Reset fills the textarea with the default guide — marks dirty, does NOT save
  const handleResetToDefault = useCallback(() => {
    if (!defaults) return;
    setPromptDraft(defaults.systemPrompt);
    setPromptDirty(true);
    setSaveMsg('');
  }, [defaults]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-white/40 py-6 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading Enhance settings...
      </div>
    );
  }

  if (error && !config) {
    return (
      <div className="flex items-start gap-2.5 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
        <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
        {error}
      </div>
    );
  }

  if (!config) return null;

  const selectedModel = models.find(m => m.id === config.model);

  return (
    <div className="space-y-3">

      {/* Inline error row (non-fatal request failures) */}
      {error && (
        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* ── Enable toggle card ── */}
      <div className="flex items-center justify-between px-4 py-4 rounded-xl bg-white/[0.05] border border-white/10 hover:bg-white/[0.08] transition-colors">
        <div className="flex items-center gap-4">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
            config.enabled
              ? 'bg-violet-500/15 border border-violet-500/25'
              : 'bg-white/5 border border-white/10'
          }`}>
            <Wand2 style={{ width: 18, height: 18 }} className={config.enabled ? 'text-violet-300' : 'text-white/40'} />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Enable Enhance button</p>
            <p className="text-[12px] text-white/55 mt-0.5">Show the Enhance button next to the chat input</p>
          </div>
        </div>
        <button
          onClick={handleToggle}
          className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${config.enabled ? 'bg-violet-500' : 'bg-white/20'}`}
          aria-label={config.enabled ? 'Disable Structure button' : 'Enable Enhance button'}
        >
          <span className={`absolute top-0.5 left-0 w-5 h-5 rounded-full bg-white shadow transition-transform ${config.enabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
        </button>
      </div>

      {/* ── Model card ── */}
      <div className="px-4 py-4 rounded-xl bg-white/[0.05] border border-white/10">
        <div className="flex items-center gap-4">
          <div className="w-9 h-9 rounded-xl bg-sky-500/15 border border-sky-500/25 flex items-center justify-center flex-shrink-0">
            <Cpu style={{ width: 18, height: 18 }} className="text-sky-300" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">Model</p>
            <p className="text-[12px] text-white/55 mt-0.5">Which model runs the enhancement pass</p>
          </div>
          <select
            value={config.model}
            onChange={e => handleModelChange(e.target.value)}
            className="bg-white/[0.06] border border-white/15 rounded-lg px-3 py-2 text-sm text-white/85 focus:outline-none focus:border-sky-500/40 transition-colors flex-shrink-0 max-w-[260px] [&>option]:bg-[#0a1428]"
          >
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>
        {selectedModel?.hint && (
          <p className="text-[11px] text-white/40 mt-2.5 ml-[52px] leading-relaxed">{selectedModel.hint}</p>
        )}
        <p className="text-[11px] text-white/35 mt-1.5 ml-[52px] leading-relaxed">
          Runs on an always-on cloud API — Flash is the fast tier.
        </p>
      </div>

      {/* ── Enhancement guide card ── */}
      <div className="px-4 py-4 rounded-xl bg-white/[0.05] border border-white/10">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div>
            <p className="text-sm font-semibold text-white">Enhancement guide</p>
            <p className="text-[12px] text-white/55 mt-0.5">The system prompt the model follows when restructuring your draft</p>
          </div>
          <button
            onClick={handleResetToDefault}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/50 hover:text-white/70 hover:bg-white/[0.07] text-xs transition-colors flex-shrink-0"
            title="Fill the editor with the default guide (you still need to save)"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset to default
          </button>
        </div>

        <textarea
          value={promptDraft}
          onChange={e => { setPromptDraft(e.target.value); setPromptDirty(true); setSaveMsg(''); }}
          spellCheck={false}
          className="w-full min-h-[280px] bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white/85 font-mono leading-relaxed resize-y focus:outline-none focus:border-violet-500/40 transition-colors"
          placeholder="Describe how the model should restructure draft messages..."
        />

        <div className="flex items-center justify-between mt-3">
          <span className="text-[11px]">
            {saveMsg && <span className="text-green-400">✓ {saveMsg}</span>}
            {promptDirty && !saveMsg && <span className="text-amber-400/70">Unsaved changes</span>}
          </span>
          <button
            onClick={handleSavePrompt}
            disabled={!promptDirty || savingPrompt}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-violet-500 hover:bg-violet-600 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {savingPrompt ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            {savingPrompt ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
