'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Loader2, Plus, Pencil, Trash2, ChevronUp, ChevronDown,
  Check, Eye, X, ShieldAlert,
} from 'lucide-react';

interface AnchorRule {
  id: number;
  text: string;
  enabled: boolean;
}

interface AnchorData {
  version: string;
  rules: AnchorRule[];
}

function buildPreviewText(rules: AnchorRule[]): string {
  const enabled = rules.filter(r => r.enabled);
  if (enabled.length === 0) return '(No rules enabled — anchor will inject nothing.)';
  const lines = ['[BEHAVIORAL ANCHOR]'];
  enabled.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.text}`);
  });
  return lines.join('\n');
}

export function AnchorRulesPanel() {
  const [rules, setRules] = useState<AnchorRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');

  // Preview state
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    fetch('/api/settings/anchor')
      .then(r => r.json())
      .then(d => {
        if (d.success && d.rules) {
          setRules(d.rules);
        } else {
          setError(d.error || 'Failed to load anchor rules');
        }
      })
      .catch(() => setError('Network error — could not load anchor rules'))
      .finally(() => setLoading(false));
  }, []);

  const markDirty = useCallback(() => {
    setDirty(true);
    setSaveMsg('');
  }, []);

  const toggleRule = useCallback((id: number) => {
    setRules(prev => prev.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
    markDirty();
  }, [markDirty]);

  const moveRule = useCallback((index: number, direction: -1 | 1) => {
    const target = index + direction;
    setRules(prev => {
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    markDirty();
  }, [markDirty]);

  const deleteRule = useCallback((id: number) => {
    setRules(prev => prev.filter(r => r.id !== id));
    if (editingId === id) setEditingId(null);
    markDirty();
  }, [editingId, markDirty]);

  const startEdit = useCallback((rule: AnchorRule) => {
    setEditingId(rule.id);
    setEditText(rule.text);
    setShowPreview(false);
  }, []);

  const commitEdit = useCallback(() => {
    if (editingId === null) return;
    const trimmed = editText.trim();
    if (trimmed) {
      setRules(prev => prev.map(r => r.id === editingId ? { ...r, text: trimmed } : r));
      markDirty();
    }
    setEditingId(null);
  }, [editingId, editText, markDirty]);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const addRule = useCallback(() => {
    const maxId = rules.reduce((m, r) => Math.max(m, r.id), 0);
    const newRule: AnchorRule = { id: maxId + 1, text: 'New rule — click edit to fill in.', enabled: true };
    setRules(prev => [...prev, newRule]);
    setEditingId(newRule.id);
    setEditText(newRule.text);
    setShowPreview(false);
    markDirty();
  }, [rules, markDirty]);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      const res = await fetch('/api/settings/anchor', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      });
      const d = await res.json();
      if (d.success) {
        setSaveMsg('Saved');
        setDirty(false);
      } else {
        setSaveMsg(`Error: ${d.error || 'Save failed'}`);
      }
    } catch {
      setSaveMsg('Error: network failure');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-white/40 py-6 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading anchor rules...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-2.5 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
        <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
        {error}
      </div>
    );
  }

  const enabledCount = rules.filter(r => r.enabled).length;

  return (
    <div className="flex flex-col gap-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] text-white/35 leading-relaxed">
            Fires on every UserPromptSubmit. {enabledCount}/{rules.length} rules enabled.
          </p>
        </div>
        <button
          onClick={addRule}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 text-purple-400 border border-purple-500/20 text-xs font-medium transition-colors flex-shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Rule
        </button>
      </div>

      {/* Rules list */}
      <div className="space-y-1.5">
        {rules.length === 0 && (
          <p className="text-xs text-white/30 text-center py-4 italic">No rules. Add one above.</p>
        )}
        {rules.map((rule, index) => {
          const isEditing = editingId === rule.id;
          return (
            <div
              key={rule.id}
              className={`rounded-lg border transition-colors ${
                isEditing
                  ? 'bg-purple-500/[0.06] border-purple-500/20'
                  : rule.enabled
                  ? 'bg-white/[0.03] border-white/[0.06] hover:border-white/[0.1]'
                  : 'bg-transparent border-white/[0.04] opacity-50'
              }`}
            >
              {isEditing ? (
                /* Edit mode */
                <div className="p-2.5 space-y-2">
                  <textarea
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
                      if (e.key === 'Escape') cancelEdit();
                    }}
                    autoFocus
                    rows={3}
                    className="w-full bg-white/[0.08] border border-white/15 rounded-lg px-3 py-2 text-xs text-white/85 resize-none focus:outline-none focus:border-purple-500/40 leading-relaxed font-mono"
                  />
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      onClick={cancelEdit}
                      className="px-2.5 py-1 rounded text-xs text-white/40 hover:text-white/60 hover:bg-white/[0.05] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={commitEdit}
                      className="flex items-center gap-1 px-2.5 py-1 rounded bg-purple-500/15 hover:bg-purple-500/25 text-purple-400 text-xs font-medium transition-colors"
                    >
                      <Check className="w-3 h-3" />
                      Done
                    </button>
                  </div>
                </div>
              ) : (
                /* View mode */
                <div className="flex items-start gap-2.5 px-3 py-2.5">
                  {/* Toggle */}
                  <button
                    onClick={() => toggleRule(rule.id)}
                    className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                      rule.enabled
                        ? 'bg-purple-500/70 border-purple-500 hover:bg-purple-500/50'
                        : 'bg-black/30 border-white/[0.15] hover:border-white/30'
                    }`}
                    title={rule.enabled ? 'Disable rule' : 'Enable rule'}
                  >
                    {rule.enabled && <Check className="w-2.5 h-2.5 text-white" />}
                  </button>

                  {/* Text */}
                  <p className="flex-1 text-xs text-white/75 leading-relaxed min-w-0">
                    <span className="text-white/50 mr-1">{index + 1}.</span>
                    {rule.text}
                  </p>

                  {/* Actions */}
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <button
                      onClick={() => moveRule(index, -1)}
                      disabled={index === 0}
                      className="p-1 rounded text-white/25 hover:text-white/60 hover:bg-white/[0.06] transition-colors disabled:opacity-20 disabled:pointer-events-none"
                      title="Move up"
                    >
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => moveRule(index, 1)}
                      disabled={index === rules.length - 1}
                      className="p-1 rounded text-white/25 hover:text-white/60 hover:bg-white/[0.06] transition-colors disabled:opacity-20 disabled:pointer-events-none"
                      title="Move down"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => startEdit(rule)}
                      className="p-1 rounded text-white/25 hover:text-white/70 hover:bg-white/[0.06] transition-colors"
                      title="Edit rule"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => deleteRule(rule.id)}
                      className="p-1 rounded text-white/20 hover:text-red-400/70 hover:bg-red-500/[0.06] transition-colors"
                      title="Delete rule"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Preview panel */}
      {showPreview && (
        <div className="rounded-lg bg-black/40 border border-white/[0.08] overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.06]">
            <span className="text-[11px] text-white/40 font-medium uppercase tracking-wider">Anchor output preview</span>
            <button
              onClick={() => setShowPreview(false)}
              className="p-0.5 rounded hover:bg-white/[0.08] text-white/30 hover:text-white/60 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <pre className="px-3 py-3 text-[11px] text-white/60 font-mono leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-[200px] overflow-y-auto">
            {buildPreviewText(rules)}
          </pre>
          <div className="px-3 py-1.5 border-t border-white/[0.06] flex items-center justify-between">
            <span className="text-[10px] text-white/25">~{Math.ceil(buildPreviewText(rules).length / 4)} tokens</span>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px]">
          {saveMsg && (
            <span className={saveMsg.startsWith('Error') ? 'text-red-400' : 'text-green-400'}>
              {saveMsg.startsWith('Error') ? saveMsg : '✓ ' + saveMsg}
            </span>
          )}
          {dirty && !saveMsg && <span className="text-amber-400/70">Unsaved changes</span>}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowPreview(v => !v); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors border ${
              showPreview
                ? 'bg-blue-500/15 border-blue-500/25 text-blue-400'
                : 'bg-white/[0.04] border-white/[0.08] text-white/50 hover:text-white/70 hover:bg-white/[0.07]'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            Preview
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-purple-500 hover:bg-purple-600 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
