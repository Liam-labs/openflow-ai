'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, RotateCcw, Bug } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LoggingConfig {
  retentionDays: number;
  memoryTimelineHours: number;
  oomEventMax: number;
  errorBufferSize: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  verboseModules: Record<string, boolean>;
}

const DEFAULT_CONFIG: LoggingConfig = {
  retentionDays:       90,
  memoryTimelineHours: 24,
  oomEventMax:         100,
  errorBufferSize:     500,
  logLevel:            'info',
  verboseModules:      {},
};

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'critical'] as const;

const KNOWN_MODULES: readonly string[] = [
  'log-writer', 'log-reader', 'event-bus',
  'error-tracker', 'stability-alerts', 'process-health', 'error-rate-tracker',
];

const LEVEL_CLASSES: Record<string, string> = {
  debug:    'logs-cfg-level-btn--debug',
  info:     'logs-cfg-level-btn--info',
  warn:     'logs-cfg-level-btn--warn',
  error:    'logs-cfg-level-btn--error',
  critical: 'logs-cfg-level-btn--critical',
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface LogsConfigPanelProps {
  open: boolean;
  onClose: () => void;
  onConfigChange?: (config: LoggingConfig) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LogsConfigPanel({ open, onClose, onConfigChange }: LogsConfigPanelProps) {
  const [config,   setConfig]   = useState<LoggingConfig>(DEFAULT_CONFIG);
  const [draft,    setDraft]    = useState<LoggingConfig>(DEFAULT_CONFIG);
  const [loading,  setLoading]  = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [saveMsg,  setSaveMsg]  = useState<{ text: string; ok: boolean } | null>(null);
  const [mounted,  setMounted]  = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const loadConfig = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const res = await fetch('/api/logs/config');
      if (res.ok) {
        const data = await res.json() as LoggingConfig;
        setConfig(data);
        setDraft(data);
      }
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, [open]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch('/api/logs/config', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(draft),
      });
      if (res.ok) {
        const updated = await res.json() as LoggingConfig;
        setConfig(updated);
        setDraft(updated);
        setSaveMsg({ text: 'Saved', ok: true });
        onConfigChange?.(updated);
        setTimeout(() => setSaveMsg(null), 2000);
      } else {
        setSaveMsg({ text: 'Save failed', ok: false });
      }
    } catch {
      setSaveMsg({ text: 'Network error', ok: false });
    } finally {
      setSaving(false);
    }
  }, [draft, onConfigChange]);

  const resetToDefaults = useCallback(() => {
    setDraft(DEFAULT_CONFIG);
  }, []);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(config);

  if (!mounted || !open) return null;

  const panel = (
    <>
      <div className="logs-cfg-overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="logs-cfg-panel"
        role="dialog"
        aria-label="Logging configuration"
        aria-modal="true"
      >
        {/* Header */}
        <div className="logs-cfg-panel__header">
          <div className="logs-cfg-panel__title-row">
            <Bug size={13} className="logs-cfg-panel__title-icon" />
            <span className="logs-cfg-panel__title">Log Config</span>
          </div>
          <button
            className="logs-cfg-panel__close"
            onClick={onClose}
            aria-label="Close log config"
          >
            <X size={13} />
          </button>
        </div>

        {loading ? (
          <div className="logs-cfg-panel__loading">Loading config…</div>
        ) : (
          <div className="logs-cfg-panel__body">

            {/* ── Global log level ─────────────────────────────────────── */}
            <section className="logs-cfg-section">
              <h3 className="logs-cfg-section__title">Global Log Level</h3>
              <div className="logs-cfg-level-group">
                {LOG_LEVELS.map(level => (
                  <button
                    key={level}
                    className={`logs-cfg-level-btn ${LEVEL_CLASSES[level]} ${draft.logLevel === level ? 'logs-cfg-level-btn--active' : ''}`}
                    onClick={() => setDraft(d => ({ ...d, logLevel: level }))}
                  >
                    {level}
                  </button>
                ))}
              </div>
              <p className="logs-cfg-section__hint">
                Entries below this level are suppressed on the server.
              </p>
            </section>

            {/* ── Per-module verbose overrides ─────────────────────────── */}
            <section className="logs-cfg-section">
              <h3 className="logs-cfg-section__title">Verbose Modules</h3>
              <p className="logs-cfg-section__hint">
                Enable debug output for specific modules regardless of global level.
              </p>
              <div className="logs-cfg-modules">
                {KNOWN_MODULES.map(mod => {
                  const enabled = !!draft.verboseModules[mod];
                  return (
                    <button
                      key={mod}
                      className={`logs-cfg-module-btn ${enabled ? 'logs-cfg-module-btn--on' : ''}`}
                      onClick={() => setDraft(d => ({
                        ...d,
                        verboseModules: { ...d.verboseModules, [mod]: !enabled },
                      }))}
                      aria-pressed={enabled}
                    >
                      <span className="logs-cfg-module-btn__dot" aria-hidden="true" />
                      {mod}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* ── Retention ────────────────────────────────────────────── */}
            <section className="logs-cfg-section">
              <h3 className="logs-cfg-section__title">Retention</h3>
              <div className="logs-cfg-fields">
                <NumField
                  label="Event log"
                  unit="days"
                  value={draft.retentionDays}
                  min={1} max={365}
                  onChange={v => setDraft(d => ({ ...d, retentionDays: v }))}
                />
                <NumField
                  label="Memory timeline"
                  unit="hours"
                  value={draft.memoryTimelineHours}
                  min={1} max={168}
                  onChange={v => setDraft(d => ({ ...d, memoryTimelineHours: v }))}
                />
                <NumField
                  label="OOM events"
                  unit="max"
                  value={draft.oomEventMax}
                  min={10} max={10000}
                  onChange={v => setDraft(d => ({ ...d, oomEventMax: v }))}
                />
              </div>
            </section>

            {/* ── Buffers ──────────────────────────────────────────────── */}
            <section className="logs-cfg-section">
              <h3 className="logs-cfg-section__title">Buffers</h3>
              <div className="logs-cfg-fields">
                <NumField
                  label="Error tracker"
                  unit="entries"
                  value={draft.errorBufferSize}
                  min={50} max={5000}
                  onChange={v => setDraft(d => ({ ...d, errorBufferSize: v }))}
                />
              </div>
            </section>

          </div>
        )}

        {/* Footer */}
        <div className="logs-cfg-panel__footer">
          <button
            className="logs-cfg-reset-btn"
            onClick={resetToDefaults}
            title="Reset all fields to defaults"
          >
            <RotateCcw size={11} />
            Defaults
          </button>
          <div className="logs-cfg-panel__footer-right">
            {saveMsg && (
              <span className={`logs-cfg-save-msg ${saveMsg.ok ? 'logs-cfg-save-msg--ok' : 'logs-cfg-save-msg--err'}`}>
                {saveMsg.text}
              </span>
            )}
            <button
              className="logs-cfg-save-btn"
              onClick={save}
              disabled={saving || !isDirty}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </>
  );

  return createPortal(panel, document.body);
}

// ─── NumField helper ──────────────────────────────────────────────────────────

function NumField({
  label, unit, value, min, max, onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="logs-cfg-field">
      <span className="logs-cfg-field__label">{label}</span>
      <div className="logs-cfg-field__input-wrap">
        <input
          type="number"
          className="logs-cfg-field__input"
          value={value}
          min={min}
          max={max}
          onChange={e => {
            const n = Number(e.target.value);
            if (!isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
          }}
        />
        <span className="logs-cfg-field__unit">{unit}</span>
      </div>
    </label>
  );
}
