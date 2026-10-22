'use client';

import './BackupManagementPanel.css';
import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  HardDrive, RefreshCw, RotateCcw, AlertTriangle,
  CheckCircle2, XCircle, Loader2, Shield,
  AlertCircle, Terminal, Zap, Database, Download,
  ArrowUpDown, Trash2, GitCompare, ChevronDown, ChevronRight,
  Plus, Minus,
} from 'lucide-react';
import {
  heroTier,
  formatHeroElapsed,
  formatRelativeNow,
  formatTimestamp,
  applySort,
  applyFilter,
  confirmMatchState,
  buildDiffCandidates,
  defaultDiffTarget,
  diffIsEmpty,
} from '@/lib/supabase-backup-helpers';
import type { SortOrder, FilterBucket } from '@/lib/supabase-backup-helpers';
import type { SchemaDiffResult, ParsedTable, ModifiedTable } from '@/lib/supabase-backup-diff';
import type { SupabaseInstance } from '@/lib/supabase-types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BackupEntry {
  id: number;
  project_id?: string;
  status: string;
  inserted_at: string;
  updated_at: string;
  isPhysicalBackup?: boolean;
}

interface LocalBackupEntry {
  filename: string;
  sizeMb: number;
  createdAt: string;
}

interface BackupsResponse {
  instanceId: string | null;
  instanceType?: 'local' | 'hosted';
  projectRef?: string;
  pitr_enabled: boolean;
  backups: BackupEntry[] | LocalBackupEntry[];
  error?: string;
  planLimited?: boolean;
  notFound?: boolean;
}

export interface BackupManagementPanelProps {
  instanceId: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeStatus(status: string): 'success' | 'failed' | 'pending' | 'unknown' {
  const s = status.toLowerCase();
  if (s === 'completed' || s === 'success' || s === 'done') return 'success';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'creating' || s === 'in_progress' || s === 'pending') return 'pending';
  return 'unknown';
}

// ─── Hero Status ──────────────────────────────────────────────────────────────

function HeroStatus({ latestDate, now }: { latestDate: string; now: number }) {
  const ms = Math.max(0, now - new Date(latestDate).getTime());
  const tier = heroTier(ms);
  return (
    <div className={`sdb-bk__hero sdb-bk__hero--${tier}`}>
      <span className="sdb-bk__hero-label">Last backup</span>
      <span className="sdb-bk__hero-time" aria-live="polite" aria-atomic="true">
        {formatHeroElapsed(ms)}
      </span>
      <time className="sdb-bk__hero-sub" dateTime={latestDate}>
        {formatTimestamp(latestDate)}
      </time>
    </div>
  );
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function BackupStatusBadge({ status }: { status: string }) {
  const norm = normalizeStatus(status);
  const configs = {
    success: { icon: <CheckCircle2 size={10} aria-hidden="true" />, label: 'Complete'    },
    failed:  { icon: <XCircle      size={10} aria-hidden="true" />, label: 'Failed'      },
    pending: { icon: <Loader2      size={10} className="sdb-db__spinner" aria-hidden="true" />, label: 'In Progress' },
    unknown: { icon: <AlertCircle  size={10} aria-hidden="true" />, label: status        },
  } as const;
  const { icon, label } = configs[norm];
  return (
    <span className={`sdb-bk__status-badge sdb-bk__status-badge--${norm}`}>
      {icon}
      {label}
    </span>
  );
}

// ─── Local Backup Card ────────────────────────────────────────────────────────

function LocalBackupCard({
  backup, now, onRestore, onRestoreToOther, onCompare, restoring, instanceId, selectMode, selected, onSelect,
}: {
  backup: LocalBackupEntry;
  now: number;
  onRestore: (filename: string) => void;
  onRestoreToOther: (backup: LocalBackupEntry) => void;
  onCompare: (backup: LocalBackupEntry) => void;
  restoring: boolean;
  instanceId: string;
  selectMode: boolean;
  selected: boolean;
  onSelect: (filename: string, checked: boolean) => void;
}) {
  return (
    <article
      className={`sdb-bk__card${selected ? ' sdb-bk__card--selected' : ''}`}
      onClick={selectMode ? () => onSelect(backup.filename, !selected) : undefined}
      style={selectMode ? { cursor: 'pointer' } : undefined}
    >
      {selectMode && (
        <input
          type="checkbox"
          className="sdb-bk__card-checkbox"
          checked={selected}
          onChange={e => onSelect(backup.filename, e.target.checked)}
          onClick={e => e.stopPropagation()}
          aria-label={`Select ${backup.filename}`}
        />
      )}
      <div className="sdb-bk__card-main">
        <div className="sdb-bk__card-top">
          <span className="sdb-bk__card-name" title={backup.filename}>
            {backup.filename}
          </span>
          <span className="sdb-bk__card-restorable" aria-label="Restorable">
            <CheckCircle2 size={8} aria-hidden="true" />
            Restorable
          </span>
          <span className="sdb-bk__card-size">{backup.sizeMb} MB</span>
        </div>
        <div className="sdb-bk__card-meta">
          <time className="sdb-bk__card-abs" dateTime={backup.createdAt}>
            {formatTimestamp(backup.createdAt)}
          </time>
          <span className="sdb-bk__card-sep" aria-hidden="true">·</span>
          <span className="sdb-bk__card-rel">{formatRelativeNow(backup.createdAt, now)}</span>
        </div>
        <div className="sdb-bk__card-hover-meta">
          <Database size={9} aria-hidden="true" />
          <span>SQL dump</span>
        </div>
      </div>
      {!selectMode && (
        <div className="sdb-bk__card-actions">
          <button
            className="sdb-bk__card-restore"
            onClick={() => onRestore(backup.filename)}
            disabled={restoring}
            aria-label={`Restore from ${backup.filename}`}
            title="Restore database from this dump"
          >
            {restoring
              ? <Loader2 size={11} className="sdb-db__spinner" aria-hidden="true" />
              : <RotateCcw size={11} aria-hidden="true" />
            }
            Restore
          </button>
          <button
            className="sdb-bk__card-restore-other"
            onClick={() => onRestoreToOther(backup)}
            disabled={restoring}
            aria-label={`Restore ${backup.filename} into a different instance`}
            title="Restore into a different local instance"
          >
            <AlertTriangle size={10} aria-hidden="true" />
            To other…
          </button>
          <button
            className="sdb-bk__card-compare"
            onClick={() => onCompare(backup)}
            disabled={restoring}
            aria-label={`Compare schema changes in ${backup.filename}`}
            title="View schema diff against another backup"
          >
            <GitCompare size={10} aria-hidden="true" />
            Compare
          </button>
        </div>
      )}
    </article>
  );
}

// ─── Hosted Backup Card ───────────────────────────────────────────────────────

function HostedBackupCard({
  backup, now, onRestore, restoring,
}: {
  backup: BackupEntry;
  now: number;
  onRestore: (id: number) => void;
  restoring: boolean;
}) {
  const norm = normalizeStatus(backup.status);
  const canRestore = norm === 'success';
  return (
    <article className="sdb-bk__card">
      <div className="sdb-bk__card-main">
        <div className="sdb-bk__card-top">
          <BackupStatusBadge status={backup.status} />
          <span className="sdb-bk__card-size">
            {backup.isPhysicalBackup
              ? <><HardDrive size={9} aria-hidden="true" /> physical</>
              : <><Shield   size={9} aria-hidden="true" /> logical</>
            }
          </span>
        </div>
        <div className="sdb-bk__card-meta">
          <time className="sdb-bk__card-abs" dateTime={backup.inserted_at}>
            {formatTimestamp(backup.inserted_at)}
          </time>
          <span className="sdb-bk__card-sep" aria-hidden="true">·</span>
          <span className="sdb-bk__card-rel">{formatRelativeNow(backup.inserted_at, now)}</span>
        </div>
        <div className="sdb-bk__card-hover-meta">
          <span>ID #{backup.id}</span>
        </div>
      </div>
      <div className="sdb-bk__card-actions">
        <button
          className="sdb-bk__card-restore"
          onClick={() => onRestore(backup.id)}
          disabled={!canRestore || restoring}
          aria-label={`Restore from backup ${backup.id}`}
          title={canRestore ? 'Restore from this backup' : 'Backup not available for restore'}
        >
          {restoring
            ? <Loader2 size={11} className="sdb-db__spinner" aria-hidden="true" />
            : <RotateCcw size={11} aria-hidden="true" />
          }
          Restore
        </button>
      </div>
    </article>
  );
}

// ─── Restore-to-Other Modal ───────────────────────────────────────────────────

function instancePort(instance: SupabaseInstance): string {
  if (instance.portMap?.api) return `:${instance.portMap.api}`;
  try { return `:${new URL(instance.connection.url).port}`; } catch { return ''; }
}

function RestoreToOtherModal({
  backup, sourceInstanceId, now, onClose, onSuccess,
}: {
  backup: LocalBackupEntry;
  sourceInstanceId: string;
  now: number;
  onClose: () => void;
  onSuccess: (result: { targetInstanceName: string; safetyDump: string }) => void;
}) {
  const [candidates, setCandidates]           = useState<SupabaseInstance[]>([]);
  const [sourceInstanceName, setSourceName]   = useState(sourceInstanceId);
  const [fetchingList, setFetchingList]       = useState(true);
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [typedInput, setTypedInput]           = useState('');
  const [submitting, setSubmitting]           = useState(false);
  const [modalError, setModalError]           = useState<string | null>(null);
  const [serverHint, setServerHint]           = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/supabase/instances')
      .then(r => r.json())
      .then((d: { instances?: SupabaseInstance[] }) => {
        const all = d.instances ?? [];
        const source = all.find(i => i.id === sourceInstanceId);
        if (source) setSourceName(source.name);
        setCandidates(all.filter(i => i.type === 'local' && i.id !== sourceInstanceId));
      })
      .catch(() => setCandidates([]))
      .finally(() => setFetchingList(false));
  }, [sourceInstanceId]);

  // Escape-to-close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const selectedTarget = candidates.find(i => i.id === selectedTargetId) ?? null;
  const matchState     = confirmMatchState(typedInput, selectedTarget?.name ?? '');
  const canSubmit      = !!selectedTargetId && matchState === 'exact' && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setModalError(null);
    setServerHint(null);
    try {
      const res  = await fetch('/api/supabase/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId: sourceInstanceId,
          action: 'restore-to-other',
          sourceBackupFile: backup.filename,
          targetInstanceId: selectedTargetId,
          confirmTargetName: typedInput,
        }),
      });
      const json = await res.json() as {
        success?: boolean;
        safetyDump?: string;
        targetInstanceName?: string;
        error?: string;
        expected?: string;
      };
      if (res.ok && json.success) {
        onSuccess({ targetInstanceName: json.targetInstanceName ?? '', safetyDump: json.safetyDump ?? '' });
      } else if (!res.ok && json.expected) {
        // Gate 6 mismatch — server-side typed-confirm rejected
        setServerHint(`Server expected: "${json.expected}"`);
      } else {
        setModalError(json.error || `Error ${res.status}`);
      }
    } catch {
      setModalError('Network error — check connection and try again');
    } finally {
      setSubmitting(false);
    }
  }

  const noCandidates = !fetchingList && candidates.length === 0;

  return (
    <div className="sdb-bk__confirm sdb-bk__confirm--rto" role="alertdialog" aria-modal="true" aria-label="Restore to a different instance">
      {/* Header */}
      <div className="sdb-bk__rto-header">
        <AlertTriangle size={14} className="sdb-bk__rto-header-icon" aria-hidden="true" />
        <span className="sdb-bk__rto-header-title">Restore to a different instance</span>
      </div>

      {/* Top-level modal error */}
      {modalError && (
        <div className="sdb-bk__rto-alert" role="alert">
          <XCircle size={11} aria-hidden="true" />
          {modalError}
        </div>
      )}

      {/* Source summary */}
      <div className="sdb-bk__rto-source">
        <span className="sdb-bk__rto-label">From</span>
        <code className="sdb-bk__rto-from">
          {sourceInstanceName} — {backup.filename} ({backup.sizeMb} MB, {formatRelativeNow(backup.createdAt, now)})
        </code>
      </div>

      {/* Instance selector */}
      <div className="sdb-bk__rto-field">
        <label className="sdb-bk__rto-label" htmlFor="rto-target-select">Target instance</label>
        {fetchingList ? (
          <div className="sdb-bk__rto-loading">
            <Loader2 size={11} className="sdb-db__spinner" aria-hidden="true" />
            Loading instances…
          </div>
        ) : noCandidates ? (
          <p className="sdb-bk__rto-no-candidates">
            No other local instances available — add one and start its stack first.
          </p>
        ) : (
          <select
            id="rto-target-select"
            className="sdb-bk__rto-select"
            value={selectedTargetId}
            onChange={e => { setSelectedTargetId(e.target.value); setTypedInput(''); setServerHint(null); }}
            disabled={submitting}
          >
            <option value="">— select target —</option>
            {candidates.map(inst => (
              <option key={inst.id} value={inst.id}>
                {inst.name}{instancePort(inst)}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Danger banner — shown after target selected */}
      {selectedTarget && (
        <div className="sdb-bk__rto-danger-banner" role="alert">
          <AlertTriangle size={10} aria-hidden="true" />
          This will overwrite target DB &ldquo;<strong>{selectedTarget.name}</strong>&rdquo;.
          A safety dump of the target will be captured first. Verify you have additional backups before proceeding.
        </div>
      )}

      {/* Typed-confirm input */}
      {selectedTarget && (
        <div className="sdb-bk__rto-field">
          <label className="sdb-bk__rto-label" htmlFor="rto-confirm-input">
            Type <code className="sdb-bk__rto-expected">{selectedTarget.name}</code> to confirm
          </label>
          <input
            id="rto-confirm-input"
            type="text"
            className={`sdb-bk__rto-input${matchState === 'mismatch' ? ' sdb-bk__rto-input--mismatch' : matchState === 'exact' ? ' sdb-bk__rto-input--exact' : ''}`}
            value={typedInput}
            onChange={e => { setTypedInput(e.target.value); setServerHint(null); }}
            placeholder={selectedTarget.name}
            disabled={submitting}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={matchState === 'mismatch' || serverHint ? 'rto-confirm-hint' : undefined}
          />
          {(matchState === 'mismatch' || serverHint) && (
            <span id="rto-confirm-hint" className="sdb-bk__rto-hint" role="alert">
              {serverHint ?? 'Does not match'}
            </span>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="sdb-bk__confirm-actions">
        <button className="sdb-bk__btn sdb-bk__btn--cancel" onClick={onClose} disabled={submitting}>
          Cancel
        </button>
        <button
          className="sdb-bk__btn sdb-bk__btn--danger"
          onClick={handleSubmit}
          disabled={!canSubmit}
          style={!canSubmit ? { opacity: 0.35, cursor: 'not-allowed' } : undefined}
          aria-disabled={!canSubmit}
        >
          {submitting
            ? <><Loader2 size={11} className="sdb-db__spinner" aria-hidden="true" /> Restoring…</>
            : <><RotateCcw size={11} aria-hidden="true" /> Restore</>
          }
        </button>
      </div>
    </div>
  );
}

// ─── Backup Diff Modal ────────────────────────────────────────────────────────

interface DiffApiResponse {
  success?: boolean;
  diff?: SchemaDiffResult;
  error?: string;
}

function DiffTableRow({
  table, variant, expanded, onToggle,
}: {
  table: ParsedTable | ModifiedTable;
  variant: 'added' | 'removed' | 'modified';
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const isModified = variant === 'modified';
  const mod = isModified ? (table as ModifiedTable) : null;
  return (
    <div className={`sdb-bk__diff-table sdb-bk__diff-table--${variant}`}>
      <div className="sdb-bk__diff-table-row">
        {isModified && onToggle ? (
          <button className="sdb-bk__diff-table-toggle" onClick={onToggle} aria-expanded={expanded}>
            {expanded
              ? <ChevronDown size={10} aria-hidden="true" />
              : <ChevronRight size={10} aria-hidden="true" />
            }
          </button>
        ) : (
          <span className="sdb-bk__diff-table-icon">
            {variant === 'added'   ? <Plus  size={10} aria-hidden="true" /> : null}
            {variant === 'removed' ? <Minus size={10} aria-hidden="true" /> : null}
          </span>
        )}
        <code className="sdb-bk__diff-table-name">{table.name}</code>
        {!isModified && (
          <span className="sdb-bk__diff-col-count">
            {(table as ParsedTable).columns.length} col{(table as ParsedTable).columns.length !== 1 ? 's' : ''}
          </span>
        )}
        {isModified && mod && (
          <span className="sdb-bk__diff-col-count">
            {mod.addedColumns.length > 0 && `+${mod.addedColumns.length}`}
            {mod.removedColumns.length > 0 && ` -${mod.removedColumns.length}`}
            {mod.modifiedColumns.length > 0 && ` ~${mod.modifiedColumns.length}`}
          </span>
        )}
      </div>
      {isModified && expanded && mod && (
        <div className="sdb-bk__diff-columns">
          {mod.addedColumns.map(c => (
            <div key={`+${c.name}`} className="sdb-bk__diff-col sdb-bk__diff-col--added">
              <Plus size={8} aria-hidden="true" />
              <code className="sdb-bk__diff-col-name">{c.name}</code>
              <code className="sdb-bk__diff-col-def">{c.definition}</code>
            </div>
          ))}
          {mod.removedColumns.map(c => (
            <div key={`-${c.name}`} className="sdb-bk__diff-col sdb-bk__diff-col--removed">
              <Minus size={8} aria-hidden="true" />
              <code className="sdb-bk__diff-col-name">{c.name}</code>
              <code className="sdb-bk__diff-col-def">{c.definition}</code>
            </div>
          ))}
          {mod.modifiedColumns.map(c => (
            <div key={`~${c.name}`} className="sdb-bk__diff-col sdb-bk__diff-col--modified">
              <GitCompare size={8} aria-hidden="true" />
              <code className="sdb-bk__diff-col-name">{c.name}</code>
              <span className="sdb-bk__diff-col-defs">
                <code className="sdb-bk__diff-col-def sdb-bk__diff-col-def--before">{c.before}</code>
                <code className="sdb-bk__diff-col-def sdb-bk__diff-col-def--after">{c.after}</code>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BackupDiffModal({
  backup, allBackups, instanceId, now, onClose,
}: {
  backup: LocalBackupEntry;
  allBackups: LocalBackupEntry[];
  instanceId: string;
  now: number;
  onClose: () => void;
}) {
  const candidates = buildDiffCandidates(allBackups, backup.filename);
  const [selectedFileB, setSelectedFileB] = useState(
    () => defaultDiffTarget(allBackups, backup.filename),
  );
  const [diffResult, setDiffResult]     = useState<SchemaDiffResult | null>(null);
  const [loading, setLoading]           = useState(false);
  const [fetchError, setFetchError]     = useState<string | null>(null);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());

  // Escape-to-close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Fetch diff whenever fileB changes (and is non-empty)
  useEffect(() => {
    if (!selectedFileB) { setDiffResult(null); return; }
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    setDiffResult(null);
    setExpandedTables(new Set());
    fetch(
      `/api/supabase/backups/diff?instanceId=${encodeURIComponent(instanceId)}&fileA=${encodeURIComponent(backup.filename)}&fileB=${encodeURIComponent(selectedFileB)}`,
    )
      .then(r => r.json() as Promise<DiffApiResponse>)
      .then(json => {
        if (cancelled) return;
        if (json.diff) setDiffResult(json.diff);
        else setFetchError(json.error || 'Unknown error');
      })
      .catch(() => { if (!cancelled) setFetchError('Network error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [instanceId, backup.filename, selectedFileB]);

  function toggleTable(name: string) {
    setExpandedTables(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  const isEmpty = diffResult ? diffIsEmpty(diffResult) : false;

  return (
    <div
      className="sdb-bk__confirm sdb-bk__confirm--diff"
      role="dialog"
      aria-modal="true"
      aria-label="Schema diff viewer"
    >
      {/* Header */}
      <div className="sdb-bk__diff-header">
        <GitCompare size={13} className="sdb-bk__diff-header-icon" aria-hidden="true" />
        <span className="sdb-bk__diff-header-title">Schema Diff</span>
        <button className="sdb-bk__diff-close" onClick={onClose} aria-label="Close diff viewer">
          <XCircle size={13} aria-hidden="true" />
        </button>
      </div>

      {/* File picker */}
      <div className="sdb-bk__diff-picker">
        <span className="sdb-bk__diff-picker-file">
          <code>{backup.filename}</code>
          <span className="sdb-bk__diff-picker-vs" aria-hidden="true">vs</span>
        </span>
        {candidates.length === 0 ? (
          <p className="sdb-bk__diff-no-candidates">
            No other backups available to compare against.
          </p>
        ) : (
          <select
            className="sdb-bk__diff-select"
            value={selectedFileB}
            onChange={e => setSelectedFileB(e.target.value)}
            aria-label="Select backup to compare against"
          >
            {candidates.map(b => (
              <option key={b.filename} value={b.filename}>
                {b.filename} ({formatRelativeNow(b.createdAt, now)})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Diff body */}
      <div className="sdb-bk__diff-body" aria-live="polite">
        {loading ? (
          <div className="sdb-bk__diff-state">
            <Loader2 size={13} className="sdb-db__spinner" aria-hidden="true" />
            <span>Computing diff…</span>
          </div>
        ) : fetchError ? (
          <div className="sdb-bk__diff-state sdb-bk__diff-state--error" role="alert">
            <AlertCircle size={13} aria-hidden="true" />
            <span>{fetchError}</span>
          </div>
        ) : !diffResult ? null : isEmpty ? (
          <div className="sdb-bk__diff-empty">
            <CheckCircle2 size={13} aria-hidden="true" />
            <span>Schemas are identical — no table changes detected.</span>
          </div>
        ) : (
          <div className="sdb-bk__diff-sections">
            {diffResult.addedTables.length > 0 && (
              <div className="sdb-bk__diff-section">
                <div className="sdb-bk__diff-section-header sdb-bk__diff-section-header--added">
                  <Plus size={10} aria-hidden="true" />
                  Added tables ({diffResult.addedTables.length})
                </div>
                {diffResult.addedTables.map(t => (
                  <DiffTableRow key={t.name} table={t} variant="added" />
                ))}
              </div>
            )}
            {diffResult.removedTables.length > 0 && (
              <div className="sdb-bk__diff-section">
                <div className="sdb-bk__diff-section-header sdb-bk__diff-section-header--removed">
                  <Minus size={10} aria-hidden="true" />
                  Removed tables ({diffResult.removedTables.length})
                </div>
                {diffResult.removedTables.map(t => (
                  <DiffTableRow key={t.name} table={t} variant="removed" />
                ))}
              </div>
            )}
            {diffResult.modifiedTables.length > 0 && (
              <div className="sdb-bk__diff-section">
                <div className="sdb-bk__diff-section-header sdb-bk__diff-section-header--modified">
                  <GitCompare size={10} aria-hidden="true" />
                  Modified tables ({diffResult.modifiedTables.length})
                </div>
                {diffResult.modifiedTables.map(t => (
                  <DiffTableRow
                    key={t.name}
                    table={t}
                    variant="modified"
                    expanded={expandedTables.has(t.name)}
                    onToggle={() => toggleTable(t.name)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="sdb-bk__confirm-actions">
        <button className="sdb-bk__btn sdb-bk__btn--cancel" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

// ─── Confirm Restore Modal (hosted) ──────────────────────────────────────────

function ConfirmRestoreModal({
  backupId, backupDate, onConfirm, onCancel, restoring,
}: {
  backupId: number;
  backupDate: string;
  onConfirm: () => void;
  onCancel: () => void;
  restoring: boolean;
}) {
  return (
    <div className="sdb-bk__confirm" role="alertdialog" aria-modal="true" aria-label="Confirm restore">
      <div className="sdb-bk__confirm-icon"><AlertTriangle size={18} /></div>
      <div className="sdb-bk__confirm-body">
        <p className="sdb-bk__confirm-title">Restore from backup?</p>
        <p className="sdb-bk__confirm-detail">
          Backup <strong>#{backupId}</strong> — {backupDate}
        </p>
        <p className="sdb-bk__confirm-warn">
          This will overwrite your current database. All data written after this backup will be lost.
          The project will be briefly unavailable during restore.
        </p>
      </div>
      <div className="sdb-bk__confirm-actions">
        <button className="sdb-bk__btn sdb-bk__btn--cancel" onClick={onCancel} disabled={restoring}>
          Cancel
        </button>
        <button className="sdb-bk__btn sdb-bk__btn--confirm" onClick={onConfirm} disabled={restoring}>
          {restoring
            ? <><Loader2 size={11} className="sdb-db__spinner" aria-hidden="true" /> Restoring…</>
            : <><RotateCcw size={11} aria-hidden="true" /> Confirm Restore</>
          }
        </button>
      </div>
    </div>
  );
}

// ─── Local Confirm Restore Modal ──────────────────────────────────────────────

function LocalConfirmRestoreModal({
  filename, onConfirm, onCancel, restoring,
}: {
  filename: string;
  onConfirm: () => void;
  onCancel: () => void;
  restoring: boolean;
}) {
  return (
    <div className="sdb-bk__confirm" role="alertdialog" aria-modal="true" aria-label="Confirm restore">
      <div className="sdb-bk__confirm-icon"><AlertTriangle size={18} /></div>
      <div className="sdb-bk__confirm-body">
        <p className="sdb-bk__confirm-title">Restore from local dump?</p>
        <p className="sdb-bk__confirm-detail">File: <strong>{filename}</strong></p>
        <p className="sdb-bk__confirm-warn">
          This will overwrite your local database. A safety backup will be created first.
          All data written after this dump was taken will be lost.
        </p>
      </div>
      <div className="sdb-bk__confirm-actions">
        <button className="sdb-bk__btn sdb-bk__btn--cancel" onClick={onCancel} disabled={restoring}>
          Cancel
        </button>
        <button className="sdb-bk__btn sdb-bk__btn--confirm" onClick={onConfirm} disabled={restoring}>
          {restoring
            ? <><Loader2 size={11} className="sdb-db__spinner" aria-hidden="true" /> Restoring…</>
            : <><RotateCcw size={11} aria-hidden="true" /> Confirm Restore</>
          }
        </button>
      </div>
    </div>
  );
}

// ─── Confirm Delete Modal ─────────────────────────────────────────────────────

function ConfirmDeleteModal({
  count, onConfirm, onCancel, deleting,
}: {
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
  deleting: boolean;
}) {
  return (
    <div className="sdb-bk__confirm" role="alertdialog" aria-modal="true" aria-label="Confirm delete">
      <div className="sdb-bk__confirm-icon sdb-bk__confirm-icon--danger"><Trash2 size={18} /></div>
      <div className="sdb-bk__confirm-body">
        <p className="sdb-bk__confirm-title">
          Delete {count} backup{count !== 1 ? 's' : ''}?
        </p>
        <p className="sdb-bk__confirm-warn">
          This is permanent and cannot be undone. The selected dump files will be removed from disk.
        </p>
      </div>
      <div className="sdb-bk__confirm-actions">
        <button className="sdb-bk__btn sdb-bk__btn--cancel" onClick={onCancel} disabled={deleting}>
          Cancel
        </button>
        <button className="sdb-bk__btn sdb-bk__btn--danger" onClick={onConfirm} disabled={deleting}>
          {deleting
            ? <><Loader2 size={11} className="sdb-db__spinner" aria-hidden="true" /> Deleting…</>
            : <><Trash2 size={11} aria-hidden="true" /> Delete {count}</>
          }
        </button>
      </div>
    </div>
  );
}

// ─── Plan-Limited Placeholder ─────────────────────────────────────────────────

function PlanLimitedPanel({ projectRef }: { projectRef: string }) {
  return (
    <div className="sdb-bk__plan-limited">
      <div className="sdb-bk__plan-icon"><Zap size={16} /></div>
      <p className="sdb-bk__plan-title">Backups require Pro plan</p>
      <p className="sdb-bk__plan-detail">
        Point-in-time recovery and backup management are available on Supabase Pro plans and above.
        Your project is on the Free plan.
      </p>
      <div className="sdb-bk__manual">
        <div className="sdb-bk__manual-title">
          <Terminal size={11} aria-hidden="true" />
          Manual backup via CLI
        </div>
        <div className="sdb-bk__manual-cmd">
          <code>supabase db dump --project-ref {projectRef} -f backup.sql</code>
        </div>
        <div className="sdb-bk__manual-cmd">
          <code>supabase db dump --project-ref {projectRef} --data-only -f data.sql</code>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const FILTER_LABELS: Record<FilterBucket, string> = {
  all:   'All',
  today: 'Today',
  week:  'Week',
  month: 'Month',
};

export function BackupManagementPanel({ instanceId }: BackupManagementPanelProps) {
  const [data, setData]               = useState<BackupsResponse | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [confirmId, setConfirmId]     = useState<number | null>(null);
  const [confirmFilename, setConfirmFilename] = useState<string | null>(null);
  const [restoring, setRestoring]     = useState(false);
  const [dumping, setDumping]         = useState(false);
  const [restoreResult, setRestoreResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [now, setNow]                 = useState(Date.now());

  // S4.4 — Sort, filter, bulk-delete
  const [sortOrder, setSortOrder]           = useState<SortOrder>('newest');
  const [filterBucket, setFilterBucket]     = useState<FilterBucket>('all');
  const [selectedFilenames, setSelectedFilenames] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete]   = useState(false);
  const [deleting, setDeleting]             = useState(false);

  // S3.2-ui — restore to other instance
  const [restoreToOtherBackup, setRestoreToOtherBackup] = useState<LocalBackupEntry | null>(null);

  // S3.3-ui — diff viewer
  const [compareBackup, setCompareBackup] = useState<LocalBackupEntry | null>(null);

  // Animated hero counter — tick every second
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // ── Fetch ───────────────────────────────────────────────────────────────────

  const fetchBackups = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRestoreResult(null);
    setSelectedFilenames(new Set());
    try {
      const res  = await fetch(`/api/supabase/backups?instanceId=${encodeURIComponent(instanceId)}`);
      const json = await res.json() as BackupsResponse;
      if (!res.ok && !json.planLimited && !json.notFound) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load backups');
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => { fetchBackups(); }, [fetchBackups]);

  // ── Hosted restore ──────────────────────────────────────────────────────────

  const handleRestore = useCallback(async () => {
    if (confirmId === null) return;
    setRestoring(true);
    try {
      const res  = await fetch('/api/supabase/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId, action: 'restore', backupId: confirmId }),
      });
      const json = await res.json() as { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setRestoreResult({ ok: true, message: 'Restore initiated — your project will restart shortly.' });
    } catch (err) {
      setRestoreResult({ ok: false, message: err instanceof Error ? err.message : 'Restore failed' });
    } finally {
      setRestoring(false);
      setConfirmId(null);
    }
  }, [confirmId, instanceId]);

  // ── Create local dump ───────────────────────────────────────────────────────

  const handleDump = useCallback(async () => {
    setDumping(true);
    setRestoreResult(null);
    try {
      const res  = await fetch('/api/supabase/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId, action: 'dump' }),
      });
      const json = await res.json() as { error?: string; filename?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setRestoreResult({ ok: true, message: `Backup created: ${json.filename}` });
      fetchBackups();
    } catch (err) {
      setRestoreResult({ ok: false, message: err instanceof Error ? err.message : 'Dump failed' });
    } finally {
      setDumping(false);
    }
  }, [instanceId, fetchBackups]);

  // ── Local restore ───────────────────────────────────────────────────────────

  const handleLocalRestore = useCallback(async () => {
    if (!confirmFilename) return;
    setRestoring(true);
    try {
      const res  = await fetch('/api/supabase/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId, action: 'restore', filename: confirmFilename }),
      });
      const json = await res.json() as { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setRestoreResult({ ok: true, message: `Restored from ${confirmFilename}` });
      fetchBackups();
    } catch (err) {
      setRestoreResult({ ok: false, message: err instanceof Error ? err.message : 'Restore failed' });
    } finally {
      setRestoring(false);
      setConfirmFilename(null);
    }
  }, [confirmFilename, instanceId, fetchBackups]);

  // ── Bulk delete ─────────────────────────────────────────────────────────────

  const handleBulkDelete = useCallback(async () => {
    if (selectedFilenames.size === 0) return;
    setDeleting(true);
    try {
      const res  = await fetch('/api/supabase/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId, action: 'delete', filenames: [...selectedFilenames] }),
      });
      const json = await res.json() as { error?: string; deleted?: number };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setRestoreResult({ ok: true, message: `Deleted ${json.deleted} backup${json.deleted !== 1 ? 's' : ''}` });
      setSelectedFilenames(new Set());
      setConfirmDelete(false);
      fetchBackups();
    } catch (err) {
      setRestoreResult({ ok: false, message: err instanceof Error ? err.message : 'Delete failed' });
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }, [selectedFilenames, instanceId, fetchBackups]);

  // ── Selection handlers ──────────────────────────────────────────────────────

  const handleSelect = useCallback((filename: string, checked: boolean) => {
    setSelectedFilenames(prev => {
      const next = new Set(prev);
      if (checked) next.add(filename); else next.delete(filename);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback((allFilenames: string[]) => {
    setSelectedFilenames(prev =>
      prev.size === allFilenames.length ? new Set() : new Set(allFilenames)
    );
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────────

  const isLocal        = data?.instanceType === 'local';
  const localBackups   = isLocal  ? (data?.backups as LocalBackupEntry[]) : [];
  const hostedBackups  = !isLocal ? (data?.backups as BackupEntry[])      : [];
  const confirmBackup  = confirmId !== null && !isLocal
    ? hostedBackups.find(b => b.id === confirmId) ?? null
    : null;

  // Sort + filter: recomputes on raw backups / sort / filter changes, not on 1s tick
  const displayedLocalBackups = useMemo(() => {
    const filtered = applyFilter(localBackups, filterBucket);
    return applySort(filtered, sortOrder);
  }, [localBackups, filterBucket, sortOrder]);

  // Count per bucket for filter pills
  const bucketCounts = useMemo(() => ({
    all:   localBackups.length,
    today: applyFilter(localBackups, 'today').length,
    week:  applyFilter(localBackups, 'week').length,
    month: applyFilter(localBackups, 'month').length,
  }), [localBackups]);

  const selectMode           = selectedFilenames.size > 0;
  const allVisibleFilenames  = displayedLocalBackups.map(b => b.filename);
  const allSelected          = allVisibleFilenames.length > 0 &&
                               allVisibleFilenames.every(fn => selectedFilenames.has(fn));

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="sdb-bk">

      {/* Header */}
      <div className="sdb-bk__header">
        <div className="sdb-bk__header-left">
          <HardDrive size={13} className="sdb-bk__header-icon" aria-hidden="true" />
          <span className="sdb-bk__header-title">Backups</span>
          {data && !data.planLimited && data.backups.length > 0 && (
            <span className="sdb-bk__header-count" aria-label={`${data.backups.length} backups`}>
              {data.backups.length}
            </span>
          )}
          {data?.pitr_enabled && (
            <span className="sdb-bk__pitr-badge" title="Point-in-Time Recovery enabled">
              <Zap size={9} aria-hidden="true" />
              PITR
            </span>
          )}
        </div>
        <div className="sdb-bk__header-actions">
          {data?.instanceType === 'local' && (
            <button
              className="sdb-bk__dump-btn"
              onClick={handleDump}
              disabled={dumping || loading}
              aria-label="Create backup"
              title="Create a new SQL dump"
            >
              {dumping
                ? <Loader2 size={11} className="sdb-db__spinner" aria-hidden="true" />
                : <HardDrive size={11} aria-hidden="true" />
              }
              {dumping ? 'Dumping…' : 'Create Backup'}
            </button>
          )}
          <button
            className="sdb-bk__header-refresh"
            onClick={fetchBackups}
            disabled={loading}
            aria-label="Refresh backups"
            title="Refresh"
          >
            <RefreshCw size={12} className={loading ? 'sdb-db__spinner' : ''} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Result banner */}
      {restoreResult && (
        <div
          className={`sdb-bk__result ${restoreResult.ok ? 'sdb-bk__result--ok' : 'sdb-bk__result--err'}`}
          role="alert"
        >
          {restoreResult.ok
            ? <CheckCircle2 size={12} aria-hidden="true" />
            : <XCircle      size={12} aria-hidden="true" />
          }
          {restoreResult.message}
          <button className="sdb-bk__result-dismiss" onClick={() => setRestoreResult(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {/* Confirm modals */}
      {confirmBackup && (
        <ConfirmRestoreModal
          backupId={confirmBackup.id}
          backupDate={formatTimestamp(confirmBackup.inserted_at)}
          onConfirm={handleRestore}
          onCancel={() => setConfirmId(null)}
          restoring={restoring}
        />
      )}
      {confirmFilename && (
        <LocalConfirmRestoreModal
          filename={confirmFilename}
          onConfirm={handleLocalRestore}
          onCancel={() => setConfirmFilename(null)}
          restoring={restoring}
        />
      )}
      {confirmDelete && (
        <ConfirmDeleteModal
          count={selectedFilenames.size}
          onConfirm={handleBulkDelete}
          onCancel={() => setConfirmDelete(false)}
          deleting={deleting}
        />
      )}
      {compareBackup && data?.instanceType === 'local' && (
        <BackupDiffModal
          backup={compareBackup}
          allBackups={localBackups}
          instanceId={instanceId}
          now={now}
          onClose={() => setCompareBackup(null)}
        />
      )}
      {restoreToOtherBackup && data?.instanceType === 'local' && (
        <RestoreToOtherModal
          backup={restoreToOtherBackup}
          sourceInstanceId={instanceId}
          now={now}
          onClose={() => setRestoreToOtherBackup(null)}
          onSuccess={({ targetInstanceName, safetyDump }) => {
            setRestoreToOtherBackup(null);
            setRestoreResult({
              ok: true,
              message: `Restored into ${targetInstanceName}. Safety dump saved: ${safetyDump}`,
            });
            fetchBackups();
          }}
        />
      )}

      {/* Body */}
      <div className="sdb-bk__body">
        {loading ? (
          <div className="sdb-bk__state-row" aria-live="polite">
            <Loader2 size={13} className="sdb-db__spinner" aria-hidden="true" />
            <span>Loading backups…</span>
          </div>
        ) : error ? (
          <div className="sdb-bk__state-row sdb-bk__state-row--error" role="alert">
            <AlertCircle size={13} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : isLocal ? (
          localBackups.length === 0 ? (
            <div className="sdb-bk__state-row">
              <HardDrive size={13} aria-hidden="true" />
              <span>No local backups yet. Click &quot;Create Backup&quot; to dump your database.</span>
            </div>
          ) : (
            <>
              <HeroStatus latestDate={localBackups[0].createdAt} now={now} />

              {/* Sort + filter toolbar */}
              <div className="sdb-bk__toolbar">
                <div className="sdb-bk__filter-pills" role="group" aria-label="Filter backups by age">
                  {(['all', 'today', 'week', 'month'] as FilterBucket[]).map(bucket => (
                    <button
                      key={bucket}
                      className={`sdb-bk__filter-pill${filterBucket === bucket ? ' sdb-bk__filter-pill--active' : ''}`}
                      onClick={() => setFilterBucket(bucket)}
                      aria-pressed={filterBucket === bucket}
                    >
                      {FILTER_LABELS[bucket]}
                      <span className="sdb-bk__filter-count">{bucketCounts[bucket]}</span>
                    </button>
                  ))}
                </div>
                <button
                  className="sdb-bk__sort-btn"
                  onClick={() => setSortOrder(o => o === 'newest' ? 'oldest' : 'newest')}
                  aria-label={`Currently ${sortOrder} first — click to reverse`}
                  title="Toggle sort order"
                >
                  <ArrowUpDown size={10} aria-hidden="true" />
                  {sortOrder === 'newest' ? 'Newest' : 'Oldest'}
                </button>
              </div>

              {/* Bulk action bar — visible when any item is selected */}
              {selectMode && (
                <div className="sdb-bk__bulk-bar" role="toolbar" aria-label="Bulk actions">
                  <div className="sdb-bk__bulk-bar-left">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => handleSelectAll(allVisibleFilenames)}
                      aria-label="Select all visible backups"
                    />
                    <span className="sdb-bk__bulk-count">
                      {selectedFilenames.size} selected
                    </span>
                    <button
                      className="sdb-bk__bulk-clear"
                      onClick={() => setSelectedFilenames(new Set())}
                      aria-label="Clear selection"
                    >
                      Clear
                    </button>
                  </div>
                  <button
                    className="sdb-bk__bulk-delete"
                    onClick={() => setConfirmDelete(true)}
                    disabled={deleting}
                    aria-label={`Delete ${selectedFilenames.size} selected backups`}
                  >
                    <Trash2 size={10} aria-hidden="true" />
                    Delete {selectedFilenames.size}
                  </button>
                </div>
              )}

              {displayedLocalBackups.length === 0 ? (
                <div className="sdb-bk__state-row">
                  <HardDrive size={13} aria-hidden="true" />
                  <span>No backups in this time range.</span>
                </div>
              ) : (
                <div className="sdb-bk__timeline" role="list" aria-label="Local backup history">
                  {displayedLocalBackups.map(backup => (
                    <LocalBackupCard
                      key={backup.filename}
                      backup={backup}
                      now={now}
                      onRestore={fn => setConfirmFilename(fn)}
                      onRestoreToOther={b => setRestoreToOtherBackup(b)}
                      onCompare={b => setCompareBackup(b)}
                      restoring={restoring && confirmFilename === backup.filename}
                      instanceId={instanceId}
                      selectMode={selectMode}
                      selected={selectedFilenames.has(backup.filename)}
                      onSelect={handleSelect}
                    />
                  ))}
                </div>
              )}
            </>
          )
        ) : data?.planLimited ? (
          <PlanLimitedPanel projectRef={data.projectRef ?? instanceId} />
        ) : data?.notFound ? (
          <div className="sdb-bk__state-row sdb-bk__state-row--error" role="alert">
            <AlertCircle size={13} aria-hidden="true" />
            <span>Project not found — verify the project ref in the instance registry.</span>
          </div>
        ) : !data || hostedBackups.length === 0 ? (
          <div className="sdb-bk__state-row">
            <HardDrive size={13} aria-hidden="true" />
            <span>No backups available yet.</span>
          </div>
        ) : (
          <>
            <HeroStatus latestDate={hostedBackups[0].inserted_at} now={now} />
            <div className="sdb-bk__timeline" role="list" aria-label="Backup history">
              {hostedBackups.map(backup => (
                <HostedBackupCard
                  key={backup.id}
                  backup={backup}
                  now={now}
                  onRestore={id => setConfirmId(id)}
                  restoring={restoring && confirmId === backup.id}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
