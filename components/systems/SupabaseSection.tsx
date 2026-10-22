'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Database, RefreshCw, Cloud, HardDrive,
  ExternalLink, Copy,
  MoreHorizontal, Plus, Edit2, Trash2,
  CheckCircle, XCircle, Loader2, ChevronDown, Wifi, Search,
} from 'lucide-react';
import type { SupabaseInstance, SupabaseInstanceStatus, SupabaseInstanceType } from '@/lib/supabase-types';
import { DatabaseBrowserPanel } from './DatabaseBrowserPanel';
import { InstanceRail } from './InstanceRail';
import { BackupManagementPanel } from './BackupManagementPanel';
import { SqlEditorPanel } from './SqlEditorPanel';
import { TableDataBrowser } from './TableDataBrowser';
import { SupabaseOverviewPanel } from './SupabaseOverviewPanel';
import { SupabaseAuthPanel } from './SupabaseAuthPanel';
import { getSupabaseStudioUrl } from '@/lib/supabase-instance-links';
import { PRODUCT_NAME } from '@/lib/brand';

// ─── Types ────────────────────────────────────────────────────────────────────

type TabKey = 'overview' | 'data' | 'sql' | 'schema' | 'backups' | 'auth';

interface InstanceFormData {
  name: string;
  type: SupabaseInstanceType;
  url: string;
  projectId: string;
  serviceRoleKeyEnvVar: string;
  anonKeyEnvVar: string;
  notes: string;
}

type ModalState =
  | null
  | { mode: 'add' }
  | { mode: 'edit'; instance: SupabaseInstance };

interface TestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

const MAX_VISIBLE_PILLS = 5;

// ─── Status Pulse ─────────────────────────────────────────────────────────────

function StatusPulse({ status }: { status: SupabaseInstanceStatus }) {
  return (
    <span className={`sdb-pulse sdb-pulse--${status}`} role="img" aria-label={status}>
      <span className="sdb-pulse__ring" />
      <span className="sdb-pulse__dot" />
    </span>
  );
}

// ─── Context Menu ─────────────────────────────────────────────────────────────

function InstanceContextMenu({ onEdit, onTest, onDelete, onClose }: {
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="sdb-ctx-menu" role="menu">
      <button className="sdb-ctx-menu__item" role="menuitem" onClick={() => { onEdit(); onClose(); }}>
        <Edit2 size={11} /> Edit
      </button>
      <button className="sdb-ctx-menu__item" role="menuitem" onClick={() => { onTest(); onClose(); }}>
        <Wifi size={11} /> Test Connection
      </button>
      <div className="sdb-ctx-menu__sep" />
      <button className="sdb-ctx-menu__item sdb-ctx-menu__item--danger" role="menuitem" onClick={() => { onDelete(); onClose(); }}>
        <Trash2 size={11} /> Delete
      </button>
    </div>
  );
}

// ─── Overflow Dropdown ────────────────────────────────────────────────────────

function OverflowDropdown({ instances, selectedId, onSelect, onClose }: {
  instances: SupabaseInstance[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!dropRef.current?.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return (
    <div ref={dropRef} className="sdb-overflow-drop" role="listbox">
      {instances.map(inst => (
        <button
          key={inst.id}
          role="option"
          aria-selected={selectedId === inst.id}
          className={`sdb-overflow-drop__item${selectedId === inst.id ? ' sdb-overflow-drop__item--active' : ''}`}
          onClick={() => { onSelect(inst.id); onClose(); }}
        >
          <StatusPulse status={inst.status} />
          <span className="sdb-overflow-drop__name">{inst.name}</span>
          <span className="sdb-overflow-drop__type">
            {inst.type === 'hosted' ? <Cloud size={9} /> : <HardDrive size={9} />}
          </span>
        </button>
      ))}
    </div>
  );
}

// ─── Add/Edit Modal ───────────────────────────────────────────────────────────

function AddEditModal({ initialData, onSave, onClose }: {
  initialData?: SupabaseInstance;
  onSave: (data: InstanceFormData) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<InstanceFormData>({
    name: initialData?.name ?? '',
    type: initialData?.type ?? 'hosted',
    url: initialData?.connection.url ?? '',
    projectId: initialData?.connection.projectId ?? '',
    serviceRoleKeyEnvVar: initialData?.connection.serviceRoleKeyEnvVar ?? 'SUPABASE_SECRET_KEY',
    anonKeyEnvVar: initialData?.connection.anonKeyEnvVar ?? 'SUPABASE_PUBLISHABLE_KEY',
    notes: initialData?.notes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof InstanceFormData, string>>>({});

  // Auto-populate URL on type change when URL is empty or default
  const prevType = useRef(form.type);
  useEffect(() => {
    if (prevType.current === form.type) return;
    prevType.current = form.type;
    const localDefault = 'http://127.0.0.1:54321';
    const isDefault = form.url === '' || form.url === localDefault || form.url === 'https://';
    if (isDefault) {
      setForm(f => ({ ...f, url: f.type === 'local' ? localDefault : 'https://' }));
    }
  }, [form.type, form.url]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  function validate(): boolean {
    const errs: Partial<Record<keyof InstanceFormData, string>> = {};
    if (!form.name.trim()) errs.name = 'Name is required';
    if (!form.url.trim()) {
      errs.url = 'URL is required';
    } else {
      try { new URL(form.url); } catch { errs.url = 'Must be a valid URL'; }
    }
    if (!form.serviceRoleKeyEnvVar.trim()) errs.serviceRoleKeyEnvVar = 'Required';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleTest() {
    if (!validate()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = {
        action: 'test-connection',
        url: form.url,
        serviceRoleKeyEnvVar: form.serviceRoleKeyEnvVar,
      };
      if (initialData?.id) body.id = initialData.id;
      const res = await fetch('/api/supabase/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setTestResult({ ok: true, latencyMs: data.data?.latencyMs });
      } else {
        setTestResult({ ok: false, error: data.error?.message ?? 'Connection failed' });
      }
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!validate()) return;
    setSaving(true);
    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="sdb-modal-overlay"
      role="presentation"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="sdb-modal" role="dialog" aria-modal="true"
        aria-label={initialData ? 'Edit Instance' : 'Add Instance'}>
        <header className="sdb-modal__header">
          <h3 className="sdb-modal__title">
            {initialData ? 'Edit Instance' : 'Add Supabase Instance'}
          </h3>
          <button className="sdb-modal__close" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="sdb-modal__body">
          <label className="sdb-form-field">
            <span className="sdb-form-label">Name</span>
            <input
              className={`sdb-form-input${errors.name ? ' sdb-form-input--error' : ''}`}
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Production"
              autoFocus
            />
            {errors.name && <span className="sdb-form-error">{errors.name}</span>}
          </label>

          <fieldset className="sdb-form-field">
            <legend className="sdb-form-label">Type</legend>
            <div className="sdb-form-radio-group">
              {(['hosted', 'local'] as SupabaseInstanceType[]).map(t => (
                <label key={t} className="sdb-form-radio">
                  <input
                    type="radio"
                    name="instance-type"
                    value={t}
                    checked={form.type === t}
                    onChange={() => setForm(f => ({ ...f, type: t }))}
                  />
                  <span>{t === 'hosted' ? 'Hosted' : 'Local'}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="sdb-form-field">
            <span className="sdb-form-label">URL</span>
            <input
              className={`sdb-form-input${errors.url ? ' sdb-form-input--error' : ''}`}
              value={form.url}
              onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
              placeholder={form.type === 'local' ? 'http://127.0.0.1:54321' : 'https://xxx.supabase.co'}
            />
            {errors.url && <span className="sdb-form-error">{errors.url}</span>}
          </label>

          {form.type === 'hosted' && (
            <label className="sdb-form-field">
              <span className="sdb-form-label">Project Ref</span>
              <input
                className="sdb-form-input sdb-form-input--mono"
                value={form.projectId}
                onChange={e => setForm(f => ({ ...f, projectId: e.target.value }))}
                placeholder="qqtnarwcseqrykricaug"
              />
            </label>
          )}

          <label className="sdb-form-field">
            <span className="sdb-form-label">Service Role Key Env Var</span>
            <input
              className={`sdb-form-input sdb-form-input--mono${errors.serviceRoleKeyEnvVar ? ' sdb-form-input--error' : ''}`}
              value={form.serviceRoleKeyEnvVar}
              onChange={e => setForm(f => ({ ...f, serviceRoleKeyEnvVar: e.target.value }))}
              placeholder="SUPABASE_SECRET_KEY"
            />
            <span className="sdb-form-hint">Reads from ~/.secrets at runtime</span>
            {errors.serviceRoleKeyEnvVar && <span className="sdb-form-error">{errors.serviceRoleKeyEnvVar}</span>}
          </label>
        </div>

        <footer className="sdb-modal__footer">
          <div className="sdb-modal__test-area">
            <button className="sdb-modal__test-btn" onClick={handleTest} disabled={testing}>
              {testing
                ? <Loader2 size={11} className="sdb-spin" />
                : <Wifi size={11} />}
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
            {testResult && (
              <span className={`sdb-modal__test-result sdb-modal__test-result--${testResult.ok ? 'ok' : 'fail'}`}>
                {testResult.ok ? (
                  <><CheckCircle size={11} /> Connected{testResult.latencyMs != null ? ` (${testResult.latencyMs}ms)` : ''}</>
                ) : (
                  <><XCircle size={11} /> {testResult.error ?? 'Failed'}</>
                )}
              </span>
            )}
          </div>
          <div className="sdb-modal__actions">
            <button className="sdb-modal__cancel-btn" onClick={onClose}>Cancel</button>
            <button className="sdb-modal__save-btn" onClick={handleSave} disabled={saving}>
              {saving && <Loader2 size={11} className="sdb-spin" />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ─── Instance Selector ────────────────────────────────────────────────────────

function InstanceSelector({
  instances,
  selectedId,
  discoverLoading,
  onSelect,
  onEdit,
  onDeleteStart,
  onTest,
  onDiscover,
  onAdd,
}: {
  instances: SupabaseInstance[];
  selectedId: string | null;
  discoverLoading: boolean;
  onSelect: (id: string) => void;
  onEdit: (inst: SupabaseInstance) => void;
  onDeleteStart: (inst: SupabaseInstance) => void;
  onTest: (id: string) => void;
  onDiscover: () => void;
  onAdd: () => void;
}) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [activeCtxId, setActiveCtxId] = useState<string | null>(null);

  const sorted = [...instances].sort((a, b) =>
    a.type === b.type ? 0 : a.type === 'local' ? -1 : 1
  );
  const visible = sorted.slice(0, MAX_VISIBLE_PILLS);
  const overflow = sorted.slice(MAX_VISIBLE_PILLS);

  function toggleCtx(id: string) {
    setActiveCtxId(prev => prev === id ? null : id);
  }

  return (
    <div className="sdb-sel-bar" role="group" aria-label="Supabase instances">
      <div className="sdb-sel-bar__pills">
        {visible.map((inst, idx) => {
          const isActive = inst.id === selectedId;
          const isCtxOpen = activeCtxId === inst.id;
          const prevType = idx > 0 ? visible[idx - 1].type : null;
          const showLocalLabel  = inst.type === 'local'  && idx === 0;
          const showHostedGroup = inst.type === 'hosted' && prevType === 'local';

          return (
            <React.Fragment key={inst.id}>
              {showLocalLabel && (
                <span className="sdb-sel-group-label sdb-sel-group-label--local" aria-hidden>Local</span>
              )}
              {showHostedGroup && (
                <>
                  <span className="sdb-sel-group-divider" aria-hidden />
                  <span className="sdb-sel-group-label sdb-sel-group-label--hosted" aria-hidden>Hosted</span>
                </>
              )}
            <div className="sdb-sel-pill-wrap">
              <button
                role="tab"
                aria-selected={isActive}
                className={`sdb-sel-btn sdb-sel-btn--${inst.type}${isActive ? ' sdb-sel-btn--active' : ''}`}
                onClick={() => onSelect(inst.id)}
              >
                <StatusPulse status={inst.status} />
                {inst.type === 'hosted'
                  ? <Cloud size={10} className="sdb-sel-btn__type-icon" />
                  : <HardDrive size={10} className="sdb-sel-btn__type-icon" />}
                <span className="sdb-sel-btn__name">{inst.name}</span>
              </button>
              <button
                className={`sdb-sel-ctx-btn${isCtxOpen ? ' sdb-sel-ctx-btn--open' : ''}`}
                onClick={e => { e.stopPropagation(); toggleCtx(inst.id); }}
                aria-label={`Options for ${inst.name}`}
                aria-expanded={isCtxOpen}
              >
                <MoreHorizontal size={11} />
              </button>
              {isCtxOpen && (
                <InstanceContextMenu
                  onEdit={() => { onEdit(inst); setActiveCtxId(null); }}
                  onTest={() => { onTest(inst.id); setActiveCtxId(null); }}
                  onDelete={() => { onDeleteStart(inst); setActiveCtxId(null); }}
                  onClose={() => setActiveCtxId(null)}
                />
              )}
            </div>
            </React.Fragment>
          );
        })}

        {overflow.length > 0 && (
          <div className="sdb-sel-pill-wrap">
            <button
              className={`sdb-sel-overflow-btn${overflowOpen ? ' sdb-sel-overflow-btn--open' : ''}`}
              onClick={() => setOverflowOpen(o => !o)}
              aria-expanded={overflowOpen}
            >
              <ChevronDown size={10} />
              +{overflow.length} more
            </button>
            {overflowOpen && (
              <OverflowDropdown
                instances={overflow}
                selectedId={selectedId}
                onSelect={onSelect}
                onClose={() => setOverflowOpen(false)}
              />
            )}
          </div>
        )}
      </div>

      <div className="sdb-sel-bar__actions">
        <button
          className="sdb-sel-discover-btn"
          onClick={onDiscover}
          disabled={discoverLoading}
          title="Auto-discover Supabase projects"
        >
          {discoverLoading
            ? <Loader2 size={11} className="sdb-spin" />
            : <Search size={11} />}
          Discover
        </button>
        <button className="sdb-sel-add-btn" onClick={onAdd}>
          <Plus size={11} />
          Add Instance
        </button>
      </div>
    </div>
  );
}

// ─── Instance Detail ──────────────────────────────────────────────────────────

const TAB_LABELS: Record<TabKey, string> = {
  overview: 'Overview',
  data:     'Data',
  sql:      'SQL',
  schema:   'Schema',
  backups:  'Backups',
  auth:     'Auth',
};

function InstanceDetail({
  instance, activeTab, onTabChange,
}: {
  instance: SupabaseInstance;
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
}) {
  return (
    <div className="sdb-detail">
      <div className="sdb-tabs" role="tablist" aria-label={`${instance.name} details`}>
        {(['overview', 'data', 'sql', 'schema', 'backups', 'auth'] as TabKey[]).map(tab => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            className={`sdb-tab${activeTab === tab ? ' sdb-tab--active' : ''}`}
            onClick={() => onTabChange(tab)}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      <div className="sdb-detail__panel">
        {activeTab === 'overview' && (
          <div className="sdb-tab-inner"><SupabaseOverviewPanel instanceId={instance.id} /></div>
        )}
        {activeTab === 'data' && (
          <div className="sdb-tab-inner sdb-tab-inner--fill"><TableDataBrowser instanceId={instance.id} /></div>
        )}
        {activeTab === 'sql' && (
          <div className="sdb-tab-inner sdb-tab-inner--fill"><SqlEditorPanel instanceId={instance.id} /></div>
        )}
        {activeTab === 'schema' && (
          <div className="sdb-tab-inner"><DatabaseBrowserPanel instanceId={instance.id} /></div>
        )}
        {activeTab === 'backups' && (
          <div className="sdb-tab-inner"><BackupManagementPanel instanceId={instance.id} /></div>
        )}
        {activeTab === 'auth' && (
          <div className="sdb-tab-inner"><SupabaseAuthPanel instanceId={instance.id} /></div>
        )}
      </div>
    </div>
  );
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="sdb-skeleton">
      {[200, 260, 180].map((w, i) => (
        <div key={i} className="sdb-skeleton__card" style={{ animationDelay: `${i * 70}ms` }}>
          <div className="sdb-skeleton__dot" />
          <div className="sdb-skeleton__lines">
            <div className="sdb-skeleton__name" style={{ width: w }} />
            <div className="sdb-skeleton__sub" style={{ width: w * 0.7 }} />
          </div>
          <div style={{ flex: 1 }} />
          <div className="sdb-skeleton__chip" />
          <div className="sdb-skeleton__chip" style={{ width: 38 }} />
        </div>
      ))}
    </div>
  );
}

// ─── Instance Info Bar ───────────────────────────────────────────────────────

function InstanceInfoBar({ instance }: { instance: SupabaseInstance }) {
  const [copied, setCopied] = useState(false);

  const launchUrl = getSupabaseStudioUrl(instance);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(instance.connection.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* silent */ }
  }

  return (
    <div className="sdb-info-bar">
      <div className="sdb-info-bar__left">
        <StatusPulse status={instance.status} />
        <span className={`sdb-info-bar__status sdb-info-bar__status--${instance.status}`}>
          {instance.status}
        </span>
        <span className="sdb-info-bar__sep">·</span>
        <code className="sdb-info-bar__url">{instance.connection.url}</code>
        <button
          className={`sdb-info-bar__copy${copied ? ' sdb-info-bar__copy--done' : ''}`}
          onClick={handleCopy}
          title="Copy URL"
          aria-label="Copy URL"
        >
          {copied ? <CheckCircle size={11} /> : <Copy size={11} />}
        </button>
      </div>
      <div className="sdb-info-bar__right">
        <a
          href={launchUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`sdb-info-bar__launch sdb-info-bar__launch--${instance.type}`}
        >
          <ExternalLink size={11} strokeWidth={2.5} />
          {instance.type === 'local' ? 'Studio' : 'Dashboard'}
        </a>
      </div>
    </div>
  );
}

// ─── Delete Confirm Modal ─────────────────────────────────────────────────────

function DeleteConfirmModal({
  instanceName,
  onConfirm,
  onCancel,
}: {
  instanceName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="sdb-modal-overlay"
      role="presentation"
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="sdb-modal sdb-modal--danger" role="dialog" aria-modal="true">
        <header className="sdb-modal__header">
          <h3 className="sdb-modal__title">Delete Instance</h3>
          <button className="sdb-modal__close" onClick={onCancel} aria-label="Close">✕</button>
        </header>
        <div className="sdb-modal__body sdb-modal__body--danger">
          <div className="sdb-delete-warning">
            <Trash2 size={28} className="sdb-delete-warning__icon" />
            <p className="sdb-delete-warning__text">
              Remove <strong>{instanceName}</strong> from {PRODUCT_NAME}?
            </p>
            <p className="sdb-delete-warning__sub">
              This only removes the registration. Your Supabase project and data are unaffected.
            </p>
          </div>
        </div>
        <footer className="sdb-modal__footer">
          <div style={{ flex: 1 }} />
          <div className="sdb-modal__actions">
            <button className="sdb-modal__cancel-btn" onClick={onCancel}>Cancel</button>
            <button className="sdb-modal__delete-btn" onClick={onConfirm}>
              <Trash2 size={11} /> Delete
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ─── Panel Error ──────────────────────────────────────────────────────────────

export function PanelError({
  title = 'Failed to load',
  detail,
  onRetry,
}: {
  title?: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="sdb-panel-error">
      <XCircle size={32} className="sdb-panel-error__icon" />
      <p className="sdb-panel-error__title">{title}</p>
      {detail && <p className="sdb-panel-error__detail">{detail}</p>}
      {onRetry && (
        <button className="sdb-panel-error__retry" onClick={onRetry}>
          <RefreshCw size={11} /> Retry
        </button>
      )}
    </div>
  );
}

// ─── Slug helpers ─────────────────────────────────────────────────────────────

/**
 * Mirror of the slug derivation used by `scripts/supabase-daily-backup.sh`.
 * Lowercase → replace spaces with dashes → strip everything except a-z0-9 and '-'.
 * Exported for testing.
 */
export function supabaseInstanceSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/ /g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Resolve an id-or-slug token against a loaded instance list.
 * Used by the navTarget handler so ServiceAlertsPanel can pass either the
 * real instance UUID or the backup-script-derived slug as entityId and we
 * still land on the right instance. Returns null if neither matches.
 */
export function resolveSupabaseInstanceToken(
  instances: { id: string; name: string }[],
  token: string,
): string | null {
  if (!token) return null;
  const byId = instances.find(i => i.id === token);
  if (byId) return byId.id;
  const bySlug = instances.find(i => supabaseInstanceSlug(i.name) === token);
  return bySlug?.id ?? null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export interface SupabaseSectionProps {
  /** Pre-select an instance on mount (accepts either the UUID or the backup-script slug). */
  initialInstanceId?: string;
  /** Pre-open a tab for the selected instance on mount. */
  initialTab?: TabKey;
}

export function SupabaseSection({ initialInstanceId, initialTab }: SupabaseSectionProps = {}) {
  const [instances, setInstances] = useState<SupabaseInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Map<string, TabKey>>(new Map());
  // Tracks whether we've already applied the initial nav deep-link. Without
  // this, a subsequent instance refresh or the auto-select effect would
  // overwrite the user's navigation target.
  const [initialNavApplied, setInitialNavApplied] = useState(false);

  // Instance management state
  const [modalState, setModalState] = useState<ModalState>(null);
  const [deleteModal, setDeleteModal] = useState<{ id: string; name: string } | null>(null);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverResult, setDiscoverResult] = useState<{ discovered: number; registered: number } | null>(null);

  // ── Fetch instances ──────────────────────────────────────────────────────

  const fetchInstances = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const res = await fetch('/api/supabase/instances');
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.data?.instances) {
        setInstances(data.data.instances as SupabaseInstance[]);
      }
    } catch { /* silent */ }
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchInstances(); }, [fetchInstances]);

  // ── Apply initial nav deep-link (once) ───────────────────────────────────
  // Triggered by ServiceAlertsPanel navTarget {section:'supabase', entityId, tab}.
  // Runs once after instances are loaded so the resolver has data to match against.

  useEffect(() => {
    if (initialNavApplied) return;
    if (instances.length === 0) return;
    if (!initialInstanceId) return;
    const resolvedId = resolveSupabaseInstanceToken(instances, initialInstanceId);
    if (resolvedId) {
      setSelectedId(resolvedId);
      if (initialTab) {
        setTabs(prev => { const n = new Map(prev); n.set(resolvedId, initialTab); return n; });
      }
    }
    setInitialNavApplied(true);
  }, [instances, initialInstanceId, initialTab, initialNavApplied]);

  // ── Auto-select first instance ───────────────────────────────────────────
  // Only kicks in if the initial nav either wasn't provided or failed to resolve —
  // the `initialNavApplied` gate prevents clobbering a successful deep link.

  useEffect(() => {
    if (initialInstanceId && !initialNavApplied) return;
    if (instances.length > 0 && selectedId === null) {
      setSelectedId(instances[0].id);
    }
  }, [instances, selectedId, initialInstanceId, initialNavApplied]);

  // ── Selection / tabs ─────────────────────────────────────────────────────

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const handleTabChange = useCallback((id: string, tab: TabKey) => {
    setTabs(prev => { const n = new Map(prev); n.set(id, tab); return n; });
  }, []);

  // ── Instance CRUD ────────────────────────────────────────────────────────

  const handleEdit = useCallback((inst: SupabaseInstance) => {
    setModalState({ mode: 'edit', instance: inst });
  }, []);

  const handleDeleteStart = useCallback((inst: SupabaseInstance) => {
    setDeleteModal({ id: inst.id, name: inst.name });
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteModal) return;
    const { id } = deleteModal;
    setDeleteModal(null);
    try {
      await fetch(`/api/supabase/instances?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      setInstances(prev => prev.filter(i => i.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch { /* silent */ }
  }, [deleteModal, selectedId]);

  const handleTestContext = useCallback(async (id: string) => {
    try {
      await fetch('/api/supabase/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', id }),
      });
      fetchInstances(false);
    } catch { /* silent */ }
  }, [fetchInstances]);

  const handleDiscover = useCallback(async () => {
    setDiscoverLoading(true);
    setDiscoverResult(null);
    try {
      const res = await fetch('/api/supabase/discover', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const result = { discovered: data.data?.discovered ?? 0, registered: data.data?.registered ?? 0 };
        setDiscoverResult(result);
        if (result.registered > 0) fetchInstances(false);
      }
    } catch { /* silent */ }
    finally { setDiscoverLoading(false); }
  }, [fetchInstances]);

  const handleSaveInstance = useCallback(async (formData: InstanceFormData) => {
    const existingId = modalState?.mode === 'edit' ? modalState.instance.id : undefined;
    const body: Record<string, unknown> = {
      name: formData.name,
      type: formData.type,
      url: formData.url,
      serviceRoleKeyEnvVar: formData.serviceRoleKeyEnvVar,
      anonKeyEnvVar: formData.anonKeyEnvVar,
    };
    if (formData.projectId) body.projectId = formData.projectId;
    if (formData.notes) body.notes = formData.notes;
    if (existingId) body.id = existingId;

    try {
      const res = await fetch('/api/supabase/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setModalState(null);
        fetchInstances(false);
      }
    } catch { /* silent */ }
  }, [modalState, fetchInstances]);

  // ── Derived ──────────────────────────────────────────────────────────────

  const onlineCount  = instances.filter(i => i.status === 'online').length;
  const localCount   = instances.filter(i => i.type === 'local').length;
  const hostedCount  = instances.filter(i => i.type === 'hosted').length;
  const selectedInstance = instances.find(i => i.id === selectedId) ?? instances[0] ?? null;

  const modalInstance = modalState?.mode === 'edit' ? modalState.instance : undefined;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <section className="sdb-page sdb-page--split">
      {/* Header */}
      <header className="sdb-header">
        <div className="sdb-header__left">
          <Database size={14} className="sdb-header__icon" />
          <h2 className="sdb-header__title">Supabase</h2>
          {!loading && instances.length > 0 && (
            <div className="sdb-header__counts">
              {localCount > 0 && (
                <>
                  <span className="sdb-header__count sdb-header__count--local">{localCount} local</span>
                  <span className="sdb-header__count-sep">·</span>
                </>
              )}
              {hostedCount > 0 && (
                <>
                  <span className="sdb-header__count sdb-header__count--hosted">{hostedCount} hosted</span>
                  <span className="sdb-header__count-sep">·</span>
                </>
              )}
              <span className="sdb-header__count sdb-header__count--online">{onlineCount} online</span>
            </div>
          )}
        </div>
        <div className="sdb-header__right">
          <button
            className="sdb-refresh"
            onClick={() => { fetchInstances(true); setSelectedId(null); }}
            disabled={refreshing}
            aria-label="Refresh instances"
          >
            <RefreshCw size={12} className={refreshing ? 'sdb-refresh--spinning' : ''} />
          </button>
        </div>
      </header>

      {/* Discover result toast */}
      {discoverResult && (
        <div className="sdb-discover-toast" role="status">
          {discoverResult.registered > 0
            ? <><CheckCircle size={12} /> Registered {discoverResult.registered} new instance{discoverResult.registered !== 1 ? 's' : ''}</>
            : <><CheckCircle size={12} /> No new instances found</>}
        </div>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : instances.length === 0 ? (
        <div className="sdb-empty">
          <Database size={32} className="sdb-empty__icon" />
          <p className="sdb-empty__title">No instances registered</p>
          <p className="sdb-empty__hint">
            Discover or add a Supabase instance to monitor it here.
          </p>
          <div className="sdb-empty__actions">
            <button className="sdb-sel-discover-btn" onClick={handleDiscover} disabled={discoverLoading}>
              {discoverLoading ? <Loader2 size={11} className="sdb-spin" /> : <Search size={11} />}
              Discover
            </button>
            <button className="sdb-sel-add-btn" onClick={() => setModalState({ mode: 'add' })}>
              <Plus size={11} /> Add Instance
            </button>
          </div>
        </div>
      ) : (
        <div className="sdb-split">
          {/* Left: instance rail */}
          <InstanceRail
            instances={instances}
            selectedId={selectedId}
            discoverLoading={discoverLoading}
            onSelect={handleSelect}
            onEdit={handleEdit}
            onDelete={handleDeleteStart}
            onTest={handleTestContext}
            onDiscover={handleDiscover}
            onAdd={() => setModalState({ mode: 'add' })}
          />

          {/* Right: detail area */}
          <div className="sdb-detail-area">
            {selectedInstance ? (
              <>
                <InstanceInfoBar instance={selectedInstance} />
                <InstanceDetail
                  instance={selectedInstance}
                  activeTab={tabs.get(selectedInstance.id) ?? 'overview'}
                  onTabChange={tab => handleTabChange(selectedInstance.id, tab)}
                />
              </>
            ) : (
              <div className="sdb-detail-empty">
                <Database size={24} className="sdb-detail-empty__icon" />
                <p>Select an instance</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add/Edit Modal */}
      {modalState !== null && (
        <AddEditModal
          initialData={modalInstance}
          onSave={handleSaveInstance}
          onClose={() => setModalState(null)}
        />
      )}

      {/* Delete Confirm Modal */}
      {deleteModal !== null && (
        <DeleteConfirmModal
          instanceName={deleteModal.name}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteModal(null)}
        />
      )}
    </section>
  );
}
