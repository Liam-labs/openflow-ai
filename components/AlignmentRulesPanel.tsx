'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X, Save, RefreshCw, AlertTriangle, CheckCircle2,
  Loader2, ChevronRight, Shield, FileText, Clock,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AlignmentFile {
  model: string;
  filename: string;
  path: string;
  sizeBytes: number;
  updatedAt: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface AlignmentRulesPanelProps {
  onClose: () => void;
}

// ─── Model Config ─────────────────────────────────────────────────────────────

interface ModelMeta {
  label: string;
  tagline: string;
  color: string;
  border: string;
  bg: string;
  dot: string;
}

const MODEL_META: Record<string, ModelMeta> = {
  claude:    { label: 'Claude',    tagline: 'Anthropic — SG-1 team models',      color: '#60a5fa', border: 'rgba(96,165,250,0.3)',  bg: 'rgba(96,165,250,0.08)',  dot: '#60a5fa' },
  gemini:    { label: 'Gemini',    tagline: 'Google DeepMind — multimodal',       color: '#818cf8', border: 'rgba(129,140,248,0.3)', bg: 'rgba(129,140,248,0.08)', dot: '#818cf8' },
  grok:      { label: 'Grok',      tagline: 'xAI — real-time knowledge',          color: '#fbbf24', border: 'rgba(251,191,36,0.3)',  bg: 'rgba(251,191,36,0.07)',  dot: '#fbbf24' },
  codex:     { label: 'Codex',     tagline: 'OpenAI — agentic coding model',      color: '#34d399', border: 'rgba(52,211,153,0.3)',  bg: 'rgba(52,211,153,0.07)',  dot: '#34d399' },
  deepseek:  { label: 'DeepSeek',  tagline: 'DeepSeek — Anthropic-compat backbone', color: '#2dd4bf', border: 'rgba(45,212,191,0.3)',  bg: 'rgba(45,212,191,0.07)',  dot: '#2dd4bf' },
};

const FALLBACK_META: ModelMeta = {
  label: '', tagline: 'Language model',
  color: 'rgba(255,255,255,0.5)', border: 'rgba(255,255,255,0.15)',
  bg: 'rgba(255,255,255,0.04)', dot: 'rgba(255,255,255,0.4)',
};

function getModelMeta(model: string): ModelMeta {
  return MODEL_META[model] ?? { ...FALLBACK_META, label: model.charAt(0).toUpperCase() + model.slice(1) };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(1)} KB`;
}

function formatRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
  } catch { return ''; }
}

function countLines(text: string): number {
  return text ? text.split('\n').length : 0;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AlignmentRulesPanel({ onClose }: AlignmentRulesPanelProps) {
  const [files, setFiles] = useState<AlignmentFile[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const [loadingContent, setLoadingContent] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isDirty = content !== originalContent;

  // Load file list
  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch('/api/settings/alignment');
      const data = await res.json() as { success: boolean; data?: { files: AlignmentFile[] } };
      if (data.success && data.data) {
        setFiles(data.data.files);
        // Auto-select first model
        if (data.data.files.length > 0 && !selectedModel) {
          setSelectedModel(data.data.files[0].model);
        }
      }
    } catch { /* non-fatal */ }
    finally { setLoadingList(false); }
  }, [selectedModel]);

  useEffect(() => { loadList(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load content when selection changes
  useEffect(() => {
    if (!selectedModel) return;
    setLoadingContent(true);
    setSaveState('idle');
    setSaveError('');
    fetch(`/api/settings/alignment/${selectedModel}`)
      .then(r => r.json())
      .then((data: { success: boolean; data?: { content: string } }) => {
        if (data.success && data.data) {
          setContent(data.data.content);
          setOriginalContent(data.data.content);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingContent(false));
  }, [selectedModel]);

  const handleSave = useCallback(async () => {
    if (!selectedModel || saveState === 'saving') return;
    setSaveState('saving');
    setSaveError('');
    try {
      const res = await fetch(`/api/settings/alignment/${selectedModel}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json() as { success: boolean; error?: string };
      if (data.success) {
        setOriginalContent(content);
        setSaveState('saved');
        // Update the file size in the list
        setFiles(prev => prev.map(f =>
          f.model === selectedModel
            ? { ...f, sizeBytes: new TextEncoder().encode(content).length, updatedAt: new Date().toISOString() }
            : f
        ));
        setTimeout(() => setSaveState('idle'), 3000);
      } else {
        setSaveError(data.error ?? 'Save failed');
        setSaveState('error');
        setTimeout(() => setSaveState('idle'), 4000);
      }
    } catch {
      setSaveError('Network error');
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 4000);
    }
  }, [selectedModel, content, saveState]);

  // Keyboard shortcut: Ctrl+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && isDirty) {
        e.preventDefault();
        handleSave();
      }
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleSave, isDirty, onClose]);

  const selectedFile = files.find(f => f.model === selectedModel);
  const selectedMeta = selectedModel ? getModelMeta(selectedModel) : null;
  const lineCount = countLines(content);
  const charCount = content.length;

  return (
    <div className="arp-overlay" role="dialog" aria-modal="true" aria-label="Alignment Rules Editor">
      {/* Backdrop */}
      <div className="arp-backdrop" onClick={onClose} aria-hidden="true" />

      {/* Panel */}
      <div className="arp-panel" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="arp-header">
          <div className="arp-header-left">
            <div className="arp-header-icon" aria-hidden="true">
              <Shield className="w-4 h-4" style={{ color: '#60a5fa' }} />
            </div>
            <div>
              <h2 className="arp-header-title">Alignment Rules</h2>
              <p className="arp-header-sub">Behavioral guardrails — edit master files, then sync to agents</p>
            </div>
          </div>
          <button
            className="arp-close-btn"
            onClick={onClose}
            aria-label="Close alignment rules panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="arp-body">
          {/* Left: model list */}
          <aside className="arp-sidebar" aria-label="Model list">
            <div className="arp-sidebar-heading">Models</div>

            {loadingList ? (
              <div className="arp-sidebar-loading">
                <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'rgba(255,255,255,0.25)' }} />
              </div>
            ) : files.length === 0 ? (
              <div className="arp-sidebar-empty">No files found</div>
            ) : (
              <ul className="arp-model-list" role="listbox" aria-label="Select model">
                {files.map((file) => {
                  const meta = getModelMeta(file.model);
                  const active = file.model === selectedModel;
                  return (
                    <li key={file.model} role="option" aria-selected={active}>
                      <button
                        className={`arp-model-item${active ? ' arp-model-item--active' : ''}`}
                        style={active ? { borderColor: meta.border, background: meta.bg } : {}}
                        onClick={() => {
                          if (file.model !== selectedModel) {
                            setSelectedModel(file.model);
                          }
                        }}
                        aria-label={`Edit ${meta.label} alignment rules`}
                      >
                        {/* Color indicator */}
                        <span
                          className="arp-model-dot"
                          style={{ background: meta.dot }}
                          aria-hidden="true"
                        />

                        <div className="arp-model-info">
                          <span
                            className="arp-model-name"
                            style={active ? { color: meta.color } : {}}
                          >
                            {meta.label}
                          </span>
                          <span className="arp-model-tagline">{meta.tagline}</span>
                          <div className="arp-model-meta">
                            <span className="arp-model-size">{formatBytes(file.sizeBytes)}</span>
                            <span className="arp-model-sep" aria-hidden="true">·</span>
                            <span className="arp-model-age">{formatRelative(file.updatedAt)}</span>
                          </div>
                        </div>

                        {active && (
                          <ChevronRight
                            className="w-3.5 h-3.5 flex-shrink-0"
                            style={{ color: meta.color, opacity: 0.7 }}
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          {/* Right: editor */}
          <div className="arp-editor-area">
            {!selectedModel || !selectedMeta ? (
              <div className="arp-editor-empty">
                <FileText className="w-8 h-8" style={{ color: 'rgba(255,255,255,0.1)' }} aria-hidden="true" />
                <p>Select a model to edit its alignment rules</p>
              </div>
            ) : (
              <>
                {/* Editor header */}
                <div className="arp-editor-header">
                  <div className="arp-editor-header-left">
                    <span
                      className="arp-editor-model-badge"
                      style={{ color: selectedMeta.color, background: selectedMeta.bg, border: `1px solid ${selectedMeta.border}` }}
                    >
                      {selectedMeta.label}
                    </span>
                    <span className="arp-editor-filename">
                      {selectedFile?.filename ?? `alignment-${selectedModel}.md`}
                    </span>
                    {isDirty && (
                      <span className="arp-editor-dirty" title="Unsaved changes" aria-label="Unsaved changes">●</span>
                    )}
                  </div>
                  <div className="arp-editor-meta">
                    {selectedFile && (
                      <>
                        <Clock className="w-3 h-3" aria-hidden="true" style={{ color: 'rgba(255,255,255,0.2)' }} />
                        <span>{formatRelative(selectedFile.updatedAt)}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Textarea */}
                <div className="arp-editor-wrap">
                  {loadingContent ? (
                    <div className="arp-editor-loading" aria-live="polite">
                      <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'rgba(255,255,255,0.2)' }} />
                    </div>
                  ) : (
                    <textarea
                      ref={textareaRef}
                      className="arp-textarea"
                      value={content}
                      onChange={e => setContent(e.target.value)}
                      spellCheck={false}
                      aria-label={`${selectedMeta.label} alignment rules content`}
                      aria-multiline="true"
                    />
                  )}
                </div>

                {/* Footer: stats + save */}
                <div className="arp-editor-footer">
                  <div className="arp-editor-stats" aria-label="File statistics">
                    <span>{lineCount} lines</span>
                    <span className="arp-editor-stats-sep" aria-hidden="true">·</span>
                    <span>{charCount.toLocaleString()} chars</span>
                    <span className="arp-editor-stats-sep" aria-hidden="true">·</span>
                    <span>Markdown</span>
                  </div>

                  <div className="arp-footer-right">
                    {/* Sync notice (shown after save) */}
                    {saveState === 'saved' && (
                      <div className="arp-sync-notice" role="status">
                        <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                        <span>Sync scaffolding to deploy to agents</span>
                      </div>
                    )}

                    {/* Error */}
                    {saveState === 'error' && (
                      <div className="arp-save-error" role="alert">
                        <X className="w-3 h-3" aria-hidden="true" />
                        <span>{saveError}</span>
                      </div>
                    )}

                    {/* Save button */}
                    <button
                      className={`arp-save-btn${!isDirty ? ' arp-save-btn--disabled' : ''}${saveState === 'saved' ? ' arp-save-btn--saved' : ''}${saveState === 'error' ? ' arp-save-btn--error' : ''}`}
                      onClick={handleSave}
                      disabled={!isDirty || saveState === 'saving' || loadingContent}
                      aria-label={`Save ${selectedMeta.label} alignment rules`}
                      title="Save (Ctrl+S)"
                    >
                      {saveState === 'saving' ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Saving…</>
                      ) : saveState === 'saved' ? (
                        <><CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> Saved</>
                      ) : (
                        <><Save className="w-3.5 h-3.5" aria-hidden="true" /> Save</>
                      )}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
