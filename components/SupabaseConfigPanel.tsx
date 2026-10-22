'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  X, Plus, Trash2, Pencil, CheckCircle2, XCircle,
  HelpCircle, Cloud, HardDrive, Loader2, FlaskConical,
  Zap, ChevronRight,
} from 'lucide-react';
import type { SupabaseInstance, SupabaseInstanceType } from '@/lib/supabase-types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FormState {
  id?: string;        // set when editing
  name: string;
  type: SupabaseInstanceType;
  url: string;
  projectId: string;
  anonKeyEnvVar: string;
  serviceRoleKeyEnvVar: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: '', type: 'hosted', url: '', projectId: '',
  anonKeyEnvVar: '', serviceRoleKeyEnvVar: '', notes: '',
};

interface TestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

interface SupabaseConfigPanelProps {
  onClose: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: SupabaseInstance['status'] }) {
  const cls: Record<string, string> = {
    online:  'bg-[#3ECF8E]',
    offline: 'bg-red-400',
    error:   'bg-red-400',
    unknown: 'bg-white/20',
  };
  return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${cls[status] ?? cls.unknown}`} />;
}

// ─── Instance List Item ───────────────────────────────────────────────────────

function InstanceItem({
  instance,
  onEdit,
  onDelete,
  onCancelDelete,
  onTest,
  testResult,
  testing,
  confirmingDelete,
  deleting: isDeleting,
}: {
  instance: SupabaseInstance;
  onEdit: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  onTest: () => void;
  testResult: TestResult | null;
  testing: boolean;
  confirmingDelete: boolean;
  deleting: boolean;
}) {
  const urlDisplay = instance.connection.url.replace(/^https?:\/\//, '');

  return (
    <div className="scp-instance">
      <div className="scp-instance__row">
        <StatusDot status={instance.status} />
        <div className="scp-instance__info">
          <div className="scp-instance__name">{instance.name}</div>
          <div className="scp-instance__meta">
            <span className={`scp-type-chip scp-type-chip--${instance.type}`}>
              {instance.type === 'hosted' ? <Cloud size={9} /> : <HardDrive size={9} />}
              {instance.type}
            </span>
            <span className="scp-instance__url" title={instance.connection.url}>{urlDisplay}</span>
          </div>
        </div>
        <div className="scp-instance__actions">
          <button
            className="scp-action-btn"
            onClick={onTest}
            disabled={testing}
            title="Test connection"
            aria-label="Test connection"
          >
            {testing ? <Loader2 size={12} className="scp-spin" /> : <Zap size={12} />}
          </button>
          <button
            className="scp-action-btn"
            onClick={onEdit}
            title="Edit"
            aria-label="Edit instance"
          >
            <Pencil size={12} />
          </button>
          {!confirmingDelete ? (
            <button
              className="scp-action-btn scp-action-btn--danger"
              onClick={onDelete}
              disabled={isDeleting}
              title="Delete"
              aria-label="Delete instance"
            >
              {isDeleting ? <Loader2 size={12} className="scp-spin" /> : <Trash2 size={12} />}
            </button>
          ) : null}
        </div>
      </div>
      {confirmingDelete && (
        <div className="scp-del-confirm">
          <span className="scp-del-confirm__msg">Delete <strong>{instance.name}</strong>? This cannot be undone.</span>
          <div className="scp-del-confirm__actions">
            <button className="scp-btn scp-btn--ghost scp-btn--sm" onClick={onCancelDelete}>Cancel</button>
            <button className="scp-btn scp-btn--danger scp-btn--sm" onClick={onDelete}>Delete</button>
          </div>
        </div>
      )}
      {testResult && (
        <div className={`scp-test-result ${testResult.ok ? 'scp-test-result--ok' : 'scp-test-result--err'}`}>
          {testResult.ok ? (
            <>
              <CheckCircle2 size={11} />
              Connected
              {testResult.latencyMs !== undefined && (
                <span className="scp-test-latency">{testResult.latencyMs}ms</span>
              )}
            </>
          ) : (
            <>
              <XCircle size={11} />
              {testResult.error ?? 'Connection failed'}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Form ─────────────────────────────────────────────────────────────────────

function InstanceForm({
  form,
  onChange,
  onSubmit,
  onCancel,
  saving,
  error,
}: {
  form: FormState;
  onChange: (f: FormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const set = (key: keyof FormState, value: string) => onChange({ ...form, [key]: value });

  return (
    <div className="scp-form">
      <div className="scp-form__title">
        {form.id ? 'Edit Instance' : 'Add Instance'}
      </div>

      {/* Type toggle */}
      <div className="scp-form__field">
        <label className="scp-form__label">Type</label>
        <div className="scp-type-toggle">
          {(['hosted', 'local'] as SupabaseInstanceType[]).map(t => (
            <button
              key={t}
              type="button"
              className={`scp-type-toggle__btn${form.type === t ? ' scp-type-toggle__btn--active' : ''}`}
              onClick={() => set('type', t)}
            >
              {t === 'hosted' ? <Cloud size={11} /> : <HardDrive size={11} />}
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="scp-form__row">
        <div className="scp-form__field">
          <label className="scp-form__label">Name <span className="scp-form__required">*</span></label>
          <input
            className="scp-input"
            placeholder="Production"
            value={form.name}
            onChange={e => set('name', e.target.value)}
          />
        </div>
        <div className="scp-form__field">
          <label className="scp-form__label">Project Ref</label>
          <input
            className="scp-input scp-input--mono"
            placeholder="qqtnarwcseqr…"
            value={form.projectId}
            onChange={e => set('projectId', e.target.value)}
          />
        </div>
      </div>

      <div className="scp-form__field">
        <label className="scp-form__label">URL <span className="scp-form__required">*</span></label>
        <input
          className="scp-input scp-input--mono"
          placeholder={form.type === 'hosted' ? 'https://xyz.supabase.co' : 'http://localhost:54321'}
          value={form.url}
          onChange={e => set('url', e.target.value)}
        />
      </div>

      <div className="scp-form__row">
        <div className="scp-form__field">
          <label className="scp-form__label">Anon Key Env Var <span className="scp-form__required">*</span></label>
          <input
            className="scp-input scp-input--mono"
            placeholder="SUPABASE_ANON_KEY"
            value={form.anonKeyEnvVar}
            onChange={e => set('anonKeyEnvVar', e.target.value)}
          />
        </div>
        <div className="scp-form__field">
          <label className="scp-form__label">Service Role Env Var <span className="scp-form__required">*</span></label>
          <input
            className="scp-input scp-input--mono"
            placeholder="SUPABASE_SERVICE_KEY"
            value={form.serviceRoleKeyEnvVar}
            onChange={e => set('serviceRoleKeyEnvVar', e.target.value)}
          />
        </div>
      </div>

      <div className="scp-form__field">
        <label className="scp-form__label">Notes</label>
        <input
          className="scp-input"
          placeholder="Optional description"
          value={form.notes}
          onChange={e => set('notes', e.target.value)}
        />
      </div>

      {error && <div className="scp-form__error">{error}</div>}

      <div className="scp-form__footer">
        <button className="scp-btn scp-btn--ghost" onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className="scp-btn scp-btn--primary"
          onClick={onSubmit}
          disabled={saving || !form.name.trim() || !form.url.trim() || !form.anonKeyEnvVar.trim() || !form.serviceRoleKeyEnvVar.trim()}
          type="button"
        >
          {saving ? <Loader2 size={13} className="scp-spin" /> : null}
          {form.id ? 'Save Changes' : 'Add Instance'}
        </button>
      </div>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function SupabaseConfigPanel({ onClose }: SupabaseConfigPanelProps) {
  const [instances, setInstances] = useState<SupabaseInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Map<string, TestResult>>(new Map());

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchInstances = useCallback(async () => {
    try {
      const res = await fetch('/api/supabase/instances');
      const data = await res.json();
      if (data.success && data.data?.instances) {
        setInstances(data.data.instances as SupabaseInstance[]);
      }
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchInstances(); }, [fetchInstances]);

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!form.name.trim() || !form.url.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch('/api/supabase/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(form.id ? { id: form.id } : {}),
          name: form.name.trim(),
          type: form.type,
          url: form.url.trim(),
          projectId: form.projectId.trim() || undefined,
          anonKeyEnvVar: form.anonKeyEnvVar.trim(),
          serviceRoleKeyEnvVar: form.serviceRoleKeyEnvVar.trim(),
          notes: form.notes.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setFormError(data.error ?? 'Failed to save instance');
        return;
      }
      setShowForm(false);
      setForm(EMPTY_FORM);
      await fetchInstances();
    } catch {
      setFormError('Request failed');
    } finally {
      setSaving(false);
    }
  };

  // ── Delete ─────────────────────────────────────────────────────────────────

  const handleDelete = async (id: string) => {
    if (deleteConfirm !== id) { setDeleteConfirm(id); return; }
    setDeleting(id);
    setDeleteConfirm(null);
    try {
      await fetch(`/api/supabase/instances?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      await fetchInstances();
    } catch { /* silent */ }
    finally { setDeleting(null); }
  };

  // ── Test ───────────────────────────────────────────────────────────────────

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const res = await fetch('/api/supabase/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', id }),
      });
      const data = await res.json();
      setTestResults(prev => {
        const next = new Map(prev);
        next.set(id, {
          ok: data.data?.ok === true,
          latencyMs: data.data?.latencyMs,
          error: data.data?.error ?? data.error,
        });
        return next;
      });
      await fetchInstances();
    } catch {
      setTestResults(prev => {
        const next = new Map(prev);
        next.set(id, { ok: false, error: 'Request failed' });
        return next;
      });
    } finally {
      setTesting(null);
    }
  };

  // ── Edit ───────────────────────────────────────────────────────────────────

  const handleEdit = (instance: SupabaseInstance) => {
    setForm({
      id: instance.id,
      name: instance.name,
      type: instance.type,
      url: instance.connection.url,
      projectId: instance.connection.projectId ?? '',
      anonKeyEnvVar: instance.connection.anonKeyEnvVar,
      serviceRoleKeyEnvVar: instance.connection.serviceRoleKeyEnvVar,
      notes: instance.notes ?? '',
    });
    setFormError(null);
    setShowForm(true);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="max-w-2xl w-full mx-4 glass-card rounded-2xl flex flex-col overflow-hidden"
        style={{ background: 'rgba(8, 14, 28, 0.97)', backdropFilter: 'none', maxHeight: '85vh' }}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-white/8 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-[#3ECF8E]/10 border border-[#3ECF8E]/20">
              <FlaskConical className="w-5 h-5 text-[#3ECF8E]" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Supabase Instances</h2>
              <p className="text-xs text-white/40 mt-0.5">Register and manage Supabase project connections</p>
            </div>
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
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Instance list */}
          {loading ? (
            <div className="flex items-center justify-center py-12 gap-2 text-white/30 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading instances…
            </div>
          ) : instances.length === 0 && !showForm ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="p-3 rounded-2xl bg-[#3ECF8E]/8 border border-[#3ECF8E]/15">
                <HelpCircle className="w-7 h-7 text-[#3ECF8E]/40" />
              </div>
              <p className="text-sm text-white/40">No instances registered</p>
              <p className="text-xs text-white/25 text-center max-w-xs">
                Add a Supabase project to monitor its health and database from the Systems panel.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {instances.map(inst => (
                <InstanceItem
                  key={inst.id}
                  instance={inst}
                  onEdit={() => handleEdit(inst)}
                  onDelete={() => handleDelete(inst.id)}
                  onCancelDelete={() => setDeleteConfirm(null)}
                  onTest={() => handleTest(inst.id)}
                  testResult={testResults.get(inst.id) ?? null}
                  testing={testing === inst.id}
                  confirmingDelete={deleteConfirm === inst.id}
                  deleting={deleting === inst.id}
                />
              ))}
            </div>
          )}

          {/* Inline form */}
          {showForm && (
            <div className="border-t border-white/8">
              <InstanceForm
                form={form}
                onChange={setForm}
                onSubmit={handleSave}
                onCancel={() => { setShowForm(false); setForm(EMPTY_FORM); setFormError(null); }}
                saving={saving}
                error={formError}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        {!showForm && (
          <div className="px-6 py-4 border-t border-white/8 flex-shrink-0">
            <button
              className="scp-btn scp-btn--add"
              onClick={() => { setForm(EMPTY_FORM); setFormError(null); setShowForm(true); }}
            >
              <Plus size={14} />
              Add Instance
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
