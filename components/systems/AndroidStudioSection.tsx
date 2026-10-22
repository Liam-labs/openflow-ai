'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Smartphone, Plus, Play, Square, RefreshCw, Settings, Trash2,
  Loader2, CheckCircle2, Terminal, Hammer, Package, SatelliteDish,
  ArrowRight,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────

interface AndroidProject {
  id: string;
  name: string;
  projectPath: string;
  androidProjectPath: string;
  emulatorName: string;
  enabled: boolean;
  liveReloadActive: boolean;
  liveReloadPid: number | null;
  devServerPid: number | null;
  lastBuild: string | null;
  lastSync: string | null;
  lastOutput: string | null;
  lastCommand: string | null;
  createdAt: string;
  updatedAt: string;
}

type AndroidCommand = 'build-web' | 'cap-sync' | 'build-apk' | 'start-emulator' | 'start-live-reload' | 'stop-live-reload';

// ─── Helpers ─────────────────────────────────────────────────────

function formatTimestamp(ts: string | null): string {
  if (!ts) return 'Never';
  const d = new Date(ts);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function truncatePath(p: string, maxLen: number): string {
  if (p.length <= maxLen) return p;
  const keep = Math.floor((maxLen - 3) / 2);
  return p.slice(0, keep) + '…' + p.slice(p.length - keep);
}

// ─── Component ───────────────────────────────────────────────────

export function AndroidStudioSection() {
  const [projects, setProjects] = useState<AndroidProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyCmd, setBusyCmd] = useState<string | null>(null); // "{id}:{command}"
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showDelete, setShowDelete] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<Record<string, string>>({});

  // Create/edit form
  const [fName, setFName] = useState('');
  const [fProjectPath, setFProjectPath] = useState('');
  const [fAndroidPath, setFAndroidPath] = useState('');
  const [fEmulatorName, setFEmulatorName] = useState('');
  const [fBusy, setFBusy] = useState(false);
  const [fError, setFError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/android-studio', { cache: 'no-store' });
      const j = await r.json();
      if (j.success) setProjects((j.projects ?? []) as AndroidProject[]);
      else setError(j.error ?? 'Failed to load');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  async function apiCall(body: Record<string, unknown>) {
    const r = await fetch('/api/android-studio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  async function runCommand(id: string, command: AndroidCommand) {
    const key = `${id}:${command}`;
    setBusyCmd(key);
    try {
      const j = await apiCall({ action: 'execute', id, command });
      if (j.success && j.output) {
        setOutputs(prev => ({ ...prev, [id]: j.output as string }));
      } else {
        setError(j.error ?? 'Command failed');
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Command error');
    } finally {
      setBusyCmd(null);
    }
  }

  function openEdit(proj: AndroidProject) {
    setEditId(proj.id);
    setFName(proj.name);
    setFProjectPath(proj.projectPath);
    setFAndroidPath(proj.androidProjectPath);
    setFEmulatorName(proj.emulatorName);
    setFError(null);
  }

  async function handleCreate() {
    setFBusy(true); setFError(null);
    try {
      const j = await apiCall({
        action: 'create',
        name: fName,
        projectPath: fProjectPath,
        androidProjectPath: fAndroidPath,
        emulatorName: fEmulatorName,
      });
      if (j.success) {
        setShowCreate(false);
        resetForm();
        refresh();
      } else {
        setFError(j.error ?? 'Create failed');
      }
    } catch { setFError('Network error'); }
    finally { setFBusy(false); }
  }

  async function handleEditSave(id: string) {
    const j = await apiCall({
      action: 'update', id,
      name: fName, projectPath: fProjectPath,
      androidProjectPath: fAndroidPath, emulatorName: fEmulatorName,
    });
    if (j.success) { setEditId(null); resetForm(); refresh(); }
    else setFError(j.error ?? 'Update failed');
  }

  async function handleDelete(id: string) {
    setBusyCmd(`delete:${id}`);
    try {
      const j = await apiCall({ action: 'delete', id });
      if (!j.success) setError(j.error ?? 'Delete failed');
      setShowDelete(null);
      await refresh();
    } finally { setBusyCmd(null); }
  }

  function resetForm() {
    setFName(''); setFProjectPath(''); setFAndroidPath(''); setFEmulatorName(''); setFError(null);
  }

  function renderForm(saveLabel: string, onSave: () => void) {
    return (
      <div className="as-form">
        {fError && <div className="as-error">{fError}</div>}
        <div className="as-form-grid">
          <div className="as-field">
            <label className="as-label">Project Name</label>
            <input className="as-input" value={fName} onChange={e => setFName(e.target.value)} placeholder="e.g. NeuroStride" />
          </div>
          <div className="as-field">
            <label className="as-label">Emulator AVD Name</label>
            <input className="as-input" value={fEmulatorName} onChange={e => setFEmulatorName(e.target.value)} placeholder="e.g. Pixel_6_API_34" />
          </div>
          <div className="as-field as-field--wide">
            <label className="as-label">Web Project Path (WSL)</label>
            <input className="as-input" value={fProjectPath} onChange={e => setFProjectPath(e.target.value)} placeholder="/home/you/my-project" spellCheck={false} />
          </div>
          <div className="as-field as-field--wide">
            <label className="as-label">Android Project Path</label>
            <input className="as-input" value={fAndroidPath} onChange={e => setFAndroidPath(e.target.value)} placeholder="/home/you/my-project/android" spellCheck={false} />
          </div>
        </div>
        <div className="as-form-actions">
          <button className="as-btn-ghost" onClick={() => { setShowCreate(false); setEditId(null); resetForm(); }} disabled={fBusy}>Cancel</button>
          <button className="as-btn-primary" onClick={onSave} disabled={fBusy || !fName || !fProjectPath}>
            {fBusy ? <><Loader2 size={12} className="as-spin" /> Saving…</> : onSave === handleCreate ? <><Plus size={12} /> Create</> : <><CheckCircle2 size={12} /> Save</>}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="as-section">
      {/* Header */}
      <header className="as-header">
        <div>
          <div className="as-eyebrow">Systems · Development</div>
          <h1 className="as-title"><Smartphone size={18} /> Android Studio App</h1>
          <p className="as-sub">
            Configure Android/Capacitor projects for build pipeline, live reload, and emulator management.
          </p>
        </div>
        <div className="as-header-actions">
          <button className="as-btn-ghost" onClick={refresh} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'as-spin' : ''} /> Refresh
          </button>
          <button className="as-btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={14} /> Add Project
          </button>
        </div>
      </header>

      {error && <div className="as-error">{error}</div>}

      {/* Empty state */}
      {!loading && projects.length === 0 && !showCreate && (
        <div className="as-empty">
          <Smartphone size={32} className="as-empty-icon" />
          <div className="as-empty-title">No Android projects configured</div>
          <p className="as-empty-desc">Add an Android/Capacitor project to manage builds, live reload, and emulators from one place.</p>
          <button className="as-btn-primary" onClick={() => setShowCreate(true)}><Plus size={14} /> Add your first project</button>
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="as-card" style={{ marginBottom: 12 }}>
          <div className="as-card-body">
            <div className="as-card-title"><Plus size={14} /> New Android Project</div>
            {renderForm('Create Project', handleCreate)}
          </div>
        </div>
      )}

      {/* Project cards */}
      <div className="as-cards">
        {projects.map(proj => {
          const output = outputs[proj.id] ?? proj.lastOutput;
          return (
            <div key={proj.id} className={`as-card ${!proj.enabled ? 'as-card--disabled' : ''}`}>
              <div className="as-card-main" onClick={() => setExpandedId(expandedId === proj.id ? null : proj.id)}>
                <div className="as-card-info">
                  <div className="as-card-name">
                    <Smartphone size={14} />
                    {proj.name}
                    {proj.liveReloadActive && (
                      <span className="as-live-badge"><SatelliteDish size={10} /> LIVE</span>
                    )}
                  </div>
                  <div className="as-card-paths">
                    <span className="as-path-text" title={proj.projectPath}>{truncatePath(proj.projectPath, 42)}</span>
                    <ArrowRight size={10} className="as-path-arrow" />
                    <span className="as-path-text" title={proj.androidProjectPath}>{truncatePath(proj.androidProjectPath, 42)}</span>
                  </div>
                </div>
                <div className="as-card-meta">
                  <span className="as-meta-label">Build</span>
                  <span className="as-meta-value">{formatTimestamp(proj.lastBuild)}</span>
                </div>
                <div className="as-card-meta">
                  <span className="as-meta-label">Sync</span>
                  <span className="as-meta-value">{formatTimestamp(proj.lastSync)}</span>
                </div>
                <div className="as-card-actions" onClick={e => e.stopPropagation()}>
                  <button className="as-icon-btn" title="Edit" onClick={() => openEdit(proj)}><Settings size={13} /></button>
                  <button className="as-icon-btn as-icon-btn--danger" title="Delete" onClick={() => setShowDelete(proj.id)}><Trash2 size={13} /></button>
                </div>
              </div>

              {expandedId === proj.id && (
                <div className="as-detail">
                  {editId === proj.id ? (
                    /* Edit form */
                    <div>
                      <div className="as-card-title"><Settings size={14} /> Edit {proj.name}</div>
                      {renderForm('Save Changes', () => handleEditSave(proj.id))}
                    </div>
                  ) : (
                    /* Actions */
                    <>
                      {/* Pipeline */}
                      <div className="as-pipeline">
                        <div className="as-pipeline-label">Build Pipeline</div>
                        <div className="as-pipeline-steps">
                          <button
                            className="as-step-btn"
                            disabled={!!busyCmd}
                            onClick={() => runCommand(proj.id, 'build-web')}
                          >
                            {busyCmd === `${proj.id}:build-web` ? <Loader2 size={14} className="as-spin" /> : <Hammer size={14} />}
                            <div className="as-step-text">
                              <div className="as-step-title">1. Build Web</div>
                              <div className="as-step-desc">npm run build</div>
                            </div>
                          </button>

                          <ArrowRight size={16} className="as-step-arrow" />

                          <button
                            className="as-step-btn"
                            disabled={!!busyCmd}
                            onClick={() => runCommand(proj.id, 'cap-sync')}
                          >
                            {busyCmd === `${proj.id}:cap-sync` ? <Loader2 size={14} className="as-spin" /> : <Package size={14} />}
                            <div className="as-step-text">
                              <div className="as-step-title">2. Cap Sync</div>
                              <div className="as-step-desc">npx cap sync</div>
                            </div>
                          </button>

                          <ArrowRight size={16} className="as-step-arrow" />

                          <button
                            className="as-step-btn"
                            disabled={!!busyCmd}
                            onClick={() => runCommand(proj.id, 'build-apk')}
                          >
                            {busyCmd === `${proj.id}:build-apk` ? <Loader2 size={14} className="as-spin" /> : <Smartphone size={14} />}
                            <div className="as-step-text">
                              <div className="as-step-title">3. Build APK</div>
                              <div className="as-step-desc">gradlew assembleDebug</div>
                            </div>
                          </button>
                        </div>
                      </div>

                      {/* Live Reload + Emulator row */}
                      <div className="as-toolbar">
                        <div className="as-toolbar-group">
                          <button
                            className="as-btn-ghost"
                            disabled={!!busyCmd}
                            onClick={() => runCommand(proj.id, 'start-emulator')}
                          >
                            {busyCmd === `${proj.id}:start-emulator` ? <Loader2 size={12} className="as-spin" /> : <Play size={12} />}
                            Start Emulator{proj.emulatorName ? ` (${proj.emulatorName})` : ''}
                          </button>
                        </div>
                        <div className="as-toolbar-group">
                          {proj.liveReloadActive ? (
                            <button
                              className="as-btn-danger-soft"
                              disabled={!!busyCmd}
                              onClick={() => runCommand(proj.id, 'stop-live-reload')}
                            >
                              {busyCmd === `${proj.id}:stop-live-reload` ? <Loader2 size={12} className="as-spin" /> : <Square size={12} />}
                              Stop Live Reload
                            </button>
                          ) : (
                            <button
                              className="as-btn-accent"
                              disabled={!!busyCmd || !proj.emulatorName}
                              onClick={() => runCommand(proj.id, 'start-live-reload')}
                            >
                              {busyCmd === `${proj.id}:start-live-reload` ? <Loader2 size={12} className="as-spin" /> : <SatelliteDish size={12} />}
                              Start Live Reload
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Output */}
                      {output && (
                        <div className="as-output">
                          <div className="as-output-header">
                            <Terminal size={12} />
                            <span>Last Output</span>
                            <span className="as-output-cmd">({proj.lastCommand ?? 'command'})</span>
                          </div>
                          <pre className="as-output-pre">{output}</pre>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Delete confirm */}
      {showDelete && (
        <div className="as-modal-backdrop" onClick={() => setShowDelete(null)}>
          <div className="as-modal" onClick={e => e.stopPropagation()}>
            <div className="as-modal-title">Delete project?</div>
            <div className="as-modal-body">
              Remove <strong>{projects.find(p => p.id === showDelete)?.name ?? showDelete}</strong> from Android Studio management. No project files are deleted.
            </div>
            <div className="as-modal-actions">
              <button className="as-btn-ghost" onClick={() => setShowDelete(null)}>Cancel</button>
              <button className="as-btn-danger" onClick={() => handleDelete(showDelete)} disabled={busyCmd === `delete:${showDelete}`}>
                {busyCmd === `delete:${showDelete}` ? <><Loader2 size={12} className="as-spin" /> Deleting…</> : <><Trash2 size={12} /> Delete</>}
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .as-section { padding: 24px 28px 48px; max-width: 1280px; }

        /* Header */
        .as-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
        .as-header-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
        .as-eyebrow { font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--df-text-muted); font-weight: 600; }
        .as-title { display: flex; align-items: center; gap: 8px; font-size: 22px; font-weight: 600; margin: 4px 0 6px; color: var(--df-text); letter-spacing: -0.3px; }
        .as-sub { font-size: 13px; color: var(--df-text-secondary); max-width: 720px; line-height: 1.5; margin: 0; }

        /* Buttons */
        .as-btn-primary {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 7px 14px; background: var(--df-accent); color: #fff;
          border: none; border-radius: 6px; font-size: 12px; font-weight: 600;
          cursor: pointer; transition: all 140ms ease;
        }
        .as-btn-primary:hover { background: var(--df-accent-hover); }
        .as-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .as-btn-ghost {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 7px 12px; background: transparent;
          border: 1px solid var(--df-border-subtle); border-radius: 6px;
          color: var(--df-text-secondary); font-size: 12px; cursor: pointer;
          transition: all 140ms ease;
        }
        .as-btn-ghost:hover { background: var(--df-accent-10); color: var(--df-text); }
        .as-btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
        .as-btn-accent {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 7px 14px; background: rgba(34,197,94,0.15); color: #4ade80;
          border: 1px solid rgba(34,197,94,0.3); border-radius: 6px;
          font-size: 12px; font-weight: 600; cursor: pointer; transition: all 140ms ease;
        }
        .as-btn-accent:hover { background: rgba(34,197,94,0.25); }
        .as-btn-accent:disabled { opacity: 0.5; cursor: not-allowed; }
        .as-btn-danger-soft {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 7px 14px; background: rgba(239,68,68,0.12); color: #f87171;
          border: 1px solid rgba(239,68,68,0.25); border-radius: 6px;
          font-size: 12px; font-weight: 600; cursor: pointer; transition: all 140ms ease;
        }
        .as-btn-danger-soft:hover { background: rgba(239,68,68,0.22); }
        .as-btn-danger-soft:disabled { opacity: 0.5; cursor: not-allowed; }
        .as-btn-danger {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 7px 14px; background: rgba(239,68,68,0.15);
          border: 1px solid rgba(239,68,68,0.3); border-radius: 6px;
          color: #f87171; font-size: 12px; font-weight: 600; cursor: pointer;
        }
        .as-btn-danger:hover { background: rgba(239,68,68,0.25); }

        .as-error { padding: 12px 16px; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 8px; color: #f87171; font-size: 12px; margin-bottom: 16px; }

        /* Icon button */
        .as-icon-btn {
          background: transparent; border: 1px solid var(--df-border-subtle);
          border-radius: 6px; width: 26px; height: 26px;
          display: flex; align-items: center; justify-content: center;
          color: var(--df-text-secondary); cursor: pointer; transition: all 140ms ease;
        }
        .as-icon-btn:hover { background: var(--df-accent-10); color: var(--df-text); border-color: var(--df-accent); }
        .as-icon-btn--danger:hover { background: rgba(239,68,68,0.1); color: #f87171; border-color: rgba(239,68,68,0.4); }

        /* Empty state */
        .as-empty { text-align: center; padding: 64px 24px; }
        .as-empty-icon { color: var(--df-text-muted); margin-bottom: 12px; opacity: 0.5; }
        .as-empty-title { font-size: 16px; font-weight: 600; color: var(--df-text); margin-bottom: 6px; }
        .as-empty-desc { font-size: 12px; color: var(--df-text-secondary); max-width: 420px; margin: 0 auto 20px; line-height: 1.5; }

        /* Cards */
        .as-cards { display: flex; flex-direction: column; gap: 8px; }
        .as-card {
          background: rgba(15,25,50,0.3); border: 1px solid var(--df-border-subtle);
          border-radius: 8px; overflow: hidden; transition: border-color 150ms ease;
        }
        .as-card:hover { border-color: var(--df-border-hover); }
        .as-card--disabled { opacity: 0.55; }
        .as-card-main {
          display: grid;
          grid-template-columns: 1.8fr 0.8fr 0.8fr 56px;
          gap: 12px; padding: 12px 14px; align-items: center; font-size: 12px;
          cursor: pointer; transition: background 120ms ease;
        }
        .as-card-main:hover { background: var(--df-accent-5); }
        .as-card-body { padding: 18px; }
        .as-card-title { font-size: 15px; font-weight: 600; color: var(--df-text); margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
        .as-card-info { min-width: 0; }
        .as-card-name { font-weight: 600; color: var(--df-text); display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
        .as-card-paths { display: flex; align-items: center; gap: 5px; min-width: 0; }
        .as-path-text {
          font-family: var(--font-mono, monospace); font-size: 10px;
          color: var(--df-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px;
        }
        .as-path-arrow { color: var(--df-text-dim); flex-shrink: 0; }
        .as-card-meta { display: flex; flex-direction: column; gap: 1px; }
        .as-meta-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--df-text-muted); }
        .as-meta-value { font-size: 11px; color: var(--df-text-secondary); }
        .as-card-actions { display: flex; gap: 4px; }

        .as-live-badge {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 600;
          background: rgba(34,197,94,0.18); color: #4ade80;
        }

        /* Detail */
        .as-detail { padding: 16px 18px; background: rgba(0,0,0,0.25); border-top: 1px solid var(--df-border-subtle); }

        /* Pipeline */
        .as-pipeline { margin-bottom: 20px; }
        .as-pipeline-label { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--df-text-muted); font-weight: 600; margin-bottom: 10px; }
        .as-pipeline-steps { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .as-step-btn {
          display: flex; align-items: center; gap: 10px;
          padding: 10px 14px; background: rgba(15,25,50,0.5);
          border: 1px solid var(--df-border-subtle); border-radius: 8px;
          color: var(--df-text); cursor: pointer; transition: all 140ms ease; text-align: left;
        }
        .as-step-btn:hover { background: rgba(59,130,246,0.1); border-color: rgba(59,130,246,0.3); }
        .as-step-btn:disabled { opacity: 0.5; cursor: wait; }
        .as-step-title { font-size: 12px; font-weight: 600; }
        .as-step-desc { font-size: 10px; color: var(--df-text-muted); font-family: var(--font-mono, monospace); margin-top: 1px; }
        .as-step-arrow { color: var(--df-text-dim); flex-shrink: 0; }

        /* Toolbar */
        .as-toolbar { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
        .as-toolbar-group { display: flex; gap: 6px; }

        /* Output */
        .as-output {
          margin-top: 4px; background: rgba(0,0,0,0.4); border: 1px solid var(--df-border-subtle);
          border-radius: 6px; overflow: hidden;
        }
        .as-output-header {
          display: flex; align-items: center; gap: 6px; padding: 6px 10px;
          background: rgba(0,0,0,0.3); font-size: 10px; font-weight: 600;
          color: var(--df-text-muted); text-transform: uppercase; letter-spacing: 0.5px;
          border-bottom: 1px solid var(--df-border-subtle);
        }
        .as-output-cmd { font-weight: 400; text-transform: none; color: var(--df-text-dim); }
        .as-output-pre {
          margin: 0; padding: 10px 12px; font-family: var(--font-mono, monospace);
          font-size: 11px; color: var(--df-text-secondary); line-height: 1.5;
          max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
        }

        /* Forms */
        .as-form { }
        .as-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .as-field { display: flex; flex-direction: column; gap: 4px; }
        .as-field--wide { grid-column: span 2; }
        .as-label { font-size: 11px; font-weight: 500; color: var(--df-text-secondary); }
        .as-input {
          height: 32px; padding: 0 10px; background: rgba(10,20,40,0.4);
          border: 1px solid var(--df-border-subtle); border-radius: 6px;
          color: var(--df-text); font-size: 12px; font-family: var(--font-mono, monospace);
          transition: border-color 150ms ease;
        }
        .as-input:focus { outline: none; border-color: var(--df-accent); }
        .as-input::placeholder { color: var(--df-text-dim); }
        .as-form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

        /* Modal */
        .as-modal-backdrop {
          position: fixed; inset: 0; z-index: 100;
          background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
          display: flex; align-items: center; justify-content: center;
        }
        .as-modal {
          background: #18181d; border: 1px solid var(--df-border);
          border-radius: 10px; padding: 24px; max-width: 400px; width: 90%;
          box-shadow: 0 16px 48px rgba(0,0,0,0.6);
        }
        .as-modal-title { font-size: 15px; font-weight: 600; color: var(--df-text); margin-bottom: 8px; }
        .as-modal-body { font-size: 12px; color: var(--df-text-secondary); line-height: 1.5; margin-bottom: 16px; }
        .as-modal-body strong { color: var(--df-text); }
        .as-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }

        /* Spinner */
        .as-spin { animation: as-spin 1s linear infinite; }
        @keyframes as-spin { to { transform: rotate(360deg); } }

        /* Responsive */
        @media (max-width: 900px) {
          .as-header { flex-direction: column; }
          .as-card-main { grid-template-columns: 1fr auto; }
          .as-card-meta, .as-card-actions { display: none; }
          .as-form-grid { grid-template-columns: 1fr; }
          .as-field--wide { grid-column: span 1; }
          .as-pipeline-steps { flex-direction: column; align-items: stretch; }
          .as-step-arrow { display: none; }
        }

        .as-btn-primary:focus-visible,
        .as-btn-ghost:focus-visible,
        .as-btn-accent:focus-visible,
        .as-btn-danger-soft:focus-visible,
        .as-btn-danger:focus-visible { outline: 2px solid var(--df-accent); outline-offset: 2px; }
        .as-input:focus-visible { outline: 2px solid var(--df-accent); outline-offset: 0; }
        .as-icon-btn:focus-visible { outline: 2px solid var(--df-accent); outline-offset: 1px; }
      `}</style>
    </div>
  );
}
