'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plug, RefreshCw, CheckCircle2, XCircle, Circle, Cloud, Terminal, Radio, ExternalLink, Cpu, Power, RotateCw } from 'lucide-react';

import { getHomeDir } from '@/lib/home-dir';
import { PRODUCT_NAME } from '@/lib/brand';
interface McpServer {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  url: string | null;
  command: string | null;
  args: string[];
  configSources: string[];
  pm2: { name: string; status: string; pid: number | null; mem: number; cpu: number; uptime: number | null } | null;
  port: number | null;
  health: 'ok' | 'fail' | 'unknown';
  enabled: boolean;
  enabledProjects: string[];
  disabledProjects: string[];
  knownProjects: string[];
}

interface GatewayStatus {
  ok: boolean;
  name: string;
  version?: string;
  transport?: string;
  capabilities?: string[];
  jobs?: Record<string, number>;
  provider?: { ready: boolean; connected: boolean; detail: string; checkedAt: string };
  error?: string;
}

function shortProjectPath(p: string): string {
  const home = getHomeDir();
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function formatBytes(n: number): string {
  if (!n) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

function formatUptime(ms: number | null): string {
  if (!ms) return '—';
  const elapsed = Date.now() - ms;
  const s = Math.floor(elapsed / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function transportIcon(t: string) {
  if (t === 'stdio') return <Terminal size={14} />;
  if (t === 'sse') return <Radio size={14} />;
  return <Cloud size={14} />;
}

function healthBadge(h: 'ok' | 'fail' | 'unknown', transport: string) {
  if (transport === 'stdio') {
    return <span className="mcp-badge mcp-badge--neutral"><Circle size={10} /> per-agent</span>;
  }
  if (h === 'ok') return <span className="mcp-badge mcp-badge--ok"><CheckCircle2 size={12} /> healthy</span>;
  if (h === 'fail') return <span className="mcp-badge mcp-badge--fail"><XCircle size={12} /> down</span>;
  return <span className="mcp-badge mcp-badge--neutral"><Circle size={10} /> unknown</span>;
}

export function MCPServersSection() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [listResponse, gatewayResponse] = await Promise.all([
        fetch('/api/mcp?action=list', { cache: 'no-store' }),
        fetch('/api/mcp?action=gateway-status', { cache: 'no-store' }),
      ]);
      const [j, gatewayJson] = await Promise.all([listResponse.json(), gatewayResponse.json()]);
      setGateway(gatewayJson as GatewayStatus);
      if (j.ok) {
        setServers(j.servers as McpServer[]);
        setError(null);
      } else {
        setError(j.error ?? 'Failed to load');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function pm2Op(target: string, op: 'restart' | 'stop' | 'start') {
    setBusyTarget(target);
    try {
      await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pm2', target, op }),
      });
      await new Promise(r => setTimeout(r, 600));
      await refresh();
    } finally {
      setBusyTarget(null);
    }
  }

  async function setEnabled(name: string, enabled: boolean) {
    setBusyTarget(name);
    try {
      const r = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-enabled', name, enabled }),
      });
      const j = await r.json();
      if (!j.ok) setError(j.error ?? 'Toggle failed');
      await new Promise(res => setTimeout(res, 500));
      await refresh();
    } finally {
      setBusyTarget(null);
    }
  }

  async function setProjectEnabled(name: string, projectPath: string, enabled: boolean) {
    setBusyTarget(`${name}:${projectPath}`);
    try {
      const r = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-project-enabled', name, projectPath, enabled }),
      });
      const j = await r.json();
      if (!j.ok) setError(j.error ?? 'Project toggle failed');
      await refresh();
    } finally {
      setBusyTarget(null);
    }
  }

  const shared = servers.filter(s => s.transport !== 'stdio');
  const stdio = servers.filter(s => s.transport === 'stdio');
  const totalMem = shared.reduce((acc, s) => acc + (s.pm2?.mem ?? 0), 0);
  const onlineShared = shared.filter(s => s.pm2?.status === 'online').length;

  return (
    <div className="mcp-section">
      <header className="mcp-header">
        <div>
          <div className="mcp-eyebrow">Systems · MCP Gateway</div>
          <h1 className="mcp-title"><Plug size={18} /> Model-neutral {PRODUCT_NAME} MCP Gateway</h1>
          <p className="mcp-sub">
            One shared capability contract for every AgentChat runtime, with provider-specific servers,
            credentials, and workers kept behind {PRODUCT_NAME}. Manage the gateway&apos;s current MCP connections here.
          </p>
        </div>
        <button className="mcp-btn-ghost" onClick={refresh} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'mcp-spin' : ''} /> Refresh
        </button>
      </header>

      <div className="mcp-stat-row">
        <div className="mcp-stat">
          <div className="mcp-stat-label">Shared servers</div>
          <div className="mcp-stat-value">{onlineShared}<span className="mcp-stat-suffix">/{shared.length}</span></div>
        </div>
        <div className="mcp-stat">
          <div className="mcp-stat-label">Per-agent (stdio)</div>
          <div className="mcp-stat-value">{stdio.length}</div>
        </div>
        <div className="mcp-stat">
          <div className="mcp-stat-label">Shared mem total</div>
          <div className="mcp-stat-value">{formatBytes(totalMem)}</div>
        </div>
        <div className="mcp-stat">
          <div className="mcp-stat-label">Total configured</div>
          <div className="mcp-stat-value">{servers.length}</div>
        </div>
      </div>

      {error && <div className="mcp-error">{error}</div>}

      <section className={`mcp-gateway-card ${gateway?.ok ? 'mcp-gateway-card--ready' : 'mcp-gateway-card--down'}`}>
        <div className="mcp-gateway-summary">
          <div>
            <span className="mcp-detail-label">Gateway contract</span>
            <strong>{gateway?.ok ? 'Online' : 'Unavailable'}</strong>
            <span className="mcp-muted"> · {gateway?.transport ?? 'Streamable HTTP'}{gateway?.version ? ` · v${gateway.version}` : ''}</span>
          </div>
          <div>
            <span className="mcp-detail-label">Claude Design worker</span>
            <strong className={gateway?.provider?.ready ? 'mcp-ready-text' : 'mcp-down-text'}>
              {gateway?.provider?.ready ? 'Authenticated' : 'Not ready'}
            </strong>
            {gateway?.provider?.detail && <span className="mcp-muted"> · {gateway.provider.detail}</span>}
          </div>
          <div>
            <span className="mcp-detail-label">Durable jobs</span>
            <strong>{gateway?.jobs ? Object.values(gateway.jobs).reduce((sum, value) => sum + value, 0) : 0}</strong>
            {gateway?.jobs && <span className="mcp-muted"> · {gateway.jobs.queued ?? 0} queued · {gateway.jobs.running ?? 0} running</span>}
          </div>
        </div>
        <div className="mcp-capabilities">
          {(gateway?.capabilities ?? [
            'gateway_status',
            'design_session_create',
            'design_session_status',
            'design_session_feedback',
            'design_session_export',
            'design_system_prepare_sync',
          ]).map(capability => <code key={capability}>{capability}</code>)}
        </div>
        {!gateway?.ok && <div className="mcp-down-text">{gateway?.error ?? 'The local gateway service is not responding.'}</div>}
      </section>

      <section className="mcp-block">
        <h2 className="mcp-block-title">Shared servers <span className="mcp-block-hint">— one process for all agents</span></h2>
        <div className="mcp-table">
          <div className="mcp-row mcp-row--head">
            <div>Enabled</div>
            <div>Name</div>
            <div>Transport</div>
            <div>Endpoint</div>
            <div>Port</div>
            <div>Health</div>
            <div>PM2</div>
            <div>Memory</div>
            <div>Uptime</div>
            <div>Actions</div>
          </div>
          {shared.map(s => (
            <div key={s.name}>
              <div
                className={`mcp-row ${!s.enabled ? 'mcp-row--disabled' : ''}`}
                onClick={() => setExpanded(expanded === s.name ? null : s.name)}
                role="button"
                tabIndex={0}
              >
                <div onClick={e => e.stopPropagation()}>
                  <Toggle
                    checked={s.enabled}
                    onChange={(v) => setEnabled(s.name, v)}
                    busy={busyTarget === s.name}
                  />
                </div>
                <div className="mcp-name">{s.name}</div>
                <div className="mcp-cell-icon">{transportIcon(s.transport)} {s.transport.toUpperCase()}</div>
                <div className="mcp-mono">{s.url ?? '—'}</div>
                <div>{s.port ?? '—'}</div>
                <div>{healthBadge(s.health, s.transport)}</div>
                <div>{s.pm2 ? (
                  <span className={`mcp-pm2-status mcp-pm2-status--${s.pm2.status}`}>{s.pm2.status}</span>
                ) : <span className="mcp-muted">— cloud</span>}</div>
                <div>{s.pm2 ? formatBytes(s.pm2.mem) : '—'}</div>
                <div>{formatUptime(s.pm2?.uptime ?? null)}</div>
                <div className="mcp-actions" onClick={e => e.stopPropagation()}>
                  {s.pm2 && (
                    <button
                      className="mcp-icon-btn"
                      title="Restart"
                      disabled={busyTarget === s.pm2.name}
                      onClick={() => s.pm2 && pm2Op(s.pm2.name, 'restart')}
                    ><RotateCw size={13} /></button>
                  )}
                </div>
              </div>
              {expanded === s.name && (
                <div className="mcp-detail">
                  <div className="mcp-detail-grid">
                    <div><span className="mcp-detail-label">Config sources</span><div>{s.configSources.join(', ')}</div></div>
                    <div><span className="mcp-detail-label">PM2 PID</span><div>{s.pm2?.pid ?? '—'}</div></div>
                    <div><span className="mcp-detail-label">CPU</span><div>{s.pm2 ? `${s.pm2.cpu.toFixed(1)}%` : '—'}</div></div>
                  </div>
                  <ProjectMatrix
                    server={s}
                    busyKey={busyTarget}
                    onToggle={(proj, en) => setProjectEnabled(s.name, proj, en)}
                  />
                </div>
              )}
            </div>
          ))}
          {!loading && shared.length === 0 && <div className="mcp-empty">No shared servers configured.</div>}
        </div>
      </section>

      <section className="mcp-block">
        <h2 className="mcp-block-title">Per-agent (stdio) <span className="mcp-block-hint">— spawned per session, candidates for consolidation</span></h2>
        <div className="mcp-table">
          <div className="mcp-row mcp-row--head mcp-row--stdio">
            <div>Enabled</div>
            <div>Name</div>
            <div>Command</div>
            <div>Args</div>
            <div>Config source</div>
          </div>
          {stdio.map(s => (
            <div key={s.name} className={`mcp-row mcp-row--stdio ${!s.enabled ? 'mcp-row--disabled' : ''}`}>
              <div>
                <Toggle
                  checked={s.enabled}
                  onChange={(v) => setEnabled(s.name, v)}
                  busy={busyTarget === s.name}
                />
              </div>
              <div className="mcp-name">{s.name}</div>
              <div className="mcp-mono">{s.command ?? '—'}</div>
              <div className="mcp-mono mcp-truncate">{s.args.join(' ') || '—'}</div>
              <div>{s.configSources.join(', ')}</div>
            </div>
          ))}
          {!loading && stdio.length === 0 && <div className="mcp-empty">No stdio servers — fully consolidated.</div>}
        </div>
      </section>

      <div className="mcp-tip">
        <ExternalLink size={12} /> Pattern guide: <code>~/DevFlow/data/central-knowledge-base/platform/shared-mcp-pattern.md</code>
      </div>

      <style jsx>{`
        .mcp-section { padding: 24px 28px 48px; max-width: 1280px; }
        .mcp-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
        .mcp-eyebrow { font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--df-text-muted, #71717a); font-weight: 600; }
        .mcp-title { display: flex; align-items: center; gap: 8px; font-size: 22px; font-weight: 600; margin: 4px 0 6px; color: var(--df-text); letter-spacing: -0.3px; }
        .mcp-sub { font-size: 13px; color: var(--df-text-secondary, #a1a1aa); max-width: 720px; line-height: 1.5; margin: 0; }
        .mcp-btn-ghost { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; background: transparent; border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.15)); border-radius: 8px; color: var(--df-text-secondary); font-size: 12px; cursor: pointer; transition: all 140ms ease; }
        .mcp-btn-ghost:hover { background: var(--df-accent-10, rgba(59,130,246,0.1)); color: var(--df-text); }
        .mcp-btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }

        .mcp-stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 16px 0 28px; }
        .mcp-stat { padding: 14px 16px; background: var(--df-bg-glass, rgba(15,25,50,0.4)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.1)); border-radius: 10px; }
        .mcp-stat-label { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--df-text-muted); font-weight: 600; margin-bottom: 6px; }
        .mcp-stat-value { font-size: 20px; font-weight: 600; color: var(--df-text); font-family: var(--font-mono, monospace); }
        .mcp-stat-suffix { font-size: 13px; color: var(--df-text-muted); margin-left: 4px; }

        .mcp-block { margin-bottom: 28px; }
        .mcp-block-title { font-size: 13px; font-weight: 600; color: var(--df-text); margin: 0 0 10px; letter-spacing: -0.2px; }
        .mcp-block-hint { font-weight: 400; color: var(--df-text-muted); font-size: 12px; }

        .mcp-table { background: var(--df-bg-glass, rgba(15,25,50,0.3)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.1)); border-radius: 10px; overflow: hidden; }
        .mcp-row { display: grid; grid-template-columns: 56px 1.4fr 0.9fr 2fr 0.6fr 1fr 0.9fr 0.7fr 0.7fr 0.7fr; gap: 12px; padding: 10px 14px; align-items: center; font-size: 12px; border-top: 1px solid var(--df-border-subtle, rgba(59,130,246,0.06)); cursor: pointer; transition: background 120ms ease; }
        .mcp-row:first-child { border-top: none; }
        .mcp-row:hover { background: var(--df-accent-8, rgba(59,130,246,0.05)); }
        .mcp-row--head { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--df-text-muted); font-weight: 600; cursor: default; background: rgba(0,0,0,0.2); }
        .mcp-row--head:hover { background: rgba(0,0,0,0.2); }
        .mcp-row--stdio { grid-template-columns: 56px 1fr 1fr 2fr 1fr; cursor: default; }
        .mcp-row--stdio:hover { background: transparent; }

        .mcp-name { font-weight: 600; color: var(--df-text); }
        .mcp-mono { font-family: var(--font-mono, monospace); color: var(--df-text-secondary); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .mcp-truncate { max-width: 100%; }
        .mcp-cell-icon { display: inline-flex; align-items: center; gap: 6px; color: var(--df-text-secondary); font-size: 11px; }
        .mcp-muted { color: var(--df-text-muted); font-style: italic; }

        .mcp-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
        .mcp-badge--ok { background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid rgba(34,197,94,0.3); }
        .mcp-badge--fail { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
        .mcp-badge--neutral { background: rgba(161,161,170,0.1); color: var(--df-text-muted); border: 1px solid rgba(161,161,170,0.2); }

        .mcp-pm2-status { padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 500; }
        .mcp-pm2-status--online { background: rgba(34,197,94,0.15); color: #4ade80; }
        .mcp-pm2-status--stopped { background: rgba(239,68,68,0.15); color: #f87171; }
        .mcp-pm2-status--errored { background: rgba(239,68,68,0.15); color: #f87171; }

        .mcp-actions { display: flex; gap: 6px; }
        .mcp-icon-btn { background: transparent; border: 1px solid var(--df-border-subtle); border-radius: 6px; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; color: var(--df-text-secondary); cursor: pointer; transition: all 140ms ease; }
        .mcp-icon-btn:hover { background: var(--df-accent-10); color: var(--df-text); border-color: var(--df-accent, #3b82f6); }
        .mcp-icon-btn--danger:hover { background: rgba(239,68,68,0.1); color: #f87171; border-color: rgba(239,68,68,0.4); }
        .mcp-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        .mcp-detail { padding: 14px 18px; background: rgba(0,0,0,0.25); border-top: 1px solid var(--df-border-subtle); font-size: 12px; }
        .mcp-detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px 24px; }
        .mcp-detail-label { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--df-text-muted); font-weight: 600; display: block; margin-bottom: 4px; }

        .mcp-empty { padding: 18px; text-align: center; color: var(--df-text-muted); font-size: 12px; }
        .mcp-error { padding: 12px 16px; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 8px; color: #f87171; font-size: 12px; margin-bottom: 16px; }
        .mcp-gateway-card { padding: 16px; margin: 0 0 24px; border-radius: 10px; background: var(--df-bg-glass, rgba(15,25,50,0.4)); border: 1px solid var(--df-border-subtle, rgba(59,130,246,0.15)); }
        .mcp-gateway-card--ready { border-color: rgba(34,197,94,0.25); }
        .mcp-gateway-card--down { border-color: rgba(239,68,68,0.3); }
        .mcp-gateway-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px 24px; font-size: 12px; }
        .mcp-capabilities { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--df-border-subtle); }
        .mcp-capabilities code { padding: 3px 7px; border-radius: 5px; background: rgba(59,130,246,0.1); color: var(--df-text-secondary); font-family: var(--font-mono); font-size: 10px; }
        .mcp-ready-text { color: #4ade80; }
        .mcp-down-text { color: #f87171; font-size: 11px; margin-top: 8px; }
        .mcp-tip { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; background: var(--df-accent-8); border: 1px solid var(--df-border-subtle); border-radius: 8px; color: var(--df-text-secondary); font-size: 11px; margin-top: 8px; }
        .mcp-tip code { font-family: var(--font-mono); color: var(--df-text); background: rgba(0,0,0,0.3); padding: 1px 5px; border-radius: 3px; font-size: 10px; }

        .mcp-spin { animation: mcp-spin 1s linear infinite; }
        @keyframes mcp-spin { to { transform: rotate(360deg); } }

        .mcp-row--disabled { opacity: 0.55; }
        .mcp-row--disabled .mcp-name { color: var(--df-text-muted); }

        .mcp-toggle { position: relative; width: 36px; height: 20px; border-radius: 999px; background: rgba(161,161,170,0.25); border: 1px solid rgba(161,161,170,0.3); cursor: pointer; transition: all 180ms ease; padding: 0; flex-shrink: 0; }
        .mcp-toggle--on { background: rgba(34,197,94,0.45); border-color: rgba(34,197,94,0.6); }
        .mcp-toggle--busy { opacity: 0.5; cursor: wait; }
        .mcp-toggle-knob { position: absolute; top: 1px; left: 1px; width: 16px; height: 16px; background: white; border-radius: 50%; transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1); box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
        .mcp-toggle--on .mcp-toggle-knob { transform: translateX(16px); }

        .mcp-projects { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--df-border-subtle); }
        .mcp-projects-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .mcp-projects-title { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--df-text-muted); font-weight: 600; }
        .mcp-projects-count { font-size: 10px; color: var(--df-text-muted); }
        .mcp-project-list { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; padding-right: 4px; }
        .mcp-project-row { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 6px 10px; background: rgba(0,0,0,0.2); border: 1px solid var(--df-border-subtle); border-radius: 6px; font-size: 11px; }
        .mcp-project-path { font-family: var(--font-mono); color: var(--df-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .mcp-project-state { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 500; }
        .mcp-project-state--enabled { background: rgba(34,197,94,0.15); color: #4ade80; }
        .mcp-project-state--disabled { background: rgba(239,68,68,0.12); color: #f87171; }
        .mcp-project-state--unset { background: rgba(161,161,170,0.1); color: var(--df-text-muted); }
      `}</style>
    </div>
  );
}

function Toggle({ checked, onChange, busy }: { checked: boolean; onChange: (v: boolean) => void; busy?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={busy}
      onClick={() => onChange(!checked)}
      className={`mcp-toggle ${checked ? 'mcp-toggle--on' : ''} ${busy ? 'mcp-toggle--busy' : ''}`}
    >
      <span className="mcp-toggle-knob" />
    </button>
  );
}

function ProjectMatrix({
  server,
  busyKey,
  onToggle,
}: {
  server: McpServer;
  busyKey: string | null;
  onToggle: (projectPath: string, enabled: boolean) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const enabledSet = new Set(server.enabledProjects);
  const disabledSet = new Set(server.disabledProjects);
  const involved = server.knownProjects.filter(p => enabledSet.has(p) || disabledSet.has(p));
  const others = server.knownProjects.filter(p => !enabledSet.has(p) && !disabledSet.has(p));
  const visible = showAll ? [...involved, ...others] : involved;

  return (
    <div className="mcp-projects">
      <div className="mcp-projects-header">
        <span className="mcp-projects-title">Per-project enable</span>
        <span className="mcp-projects-count">
          {server.enabledProjects.length} enabled · {server.disabledProjects.length} disabled · {server.knownProjects.length} known projects
        </span>
      </div>
      <div className="mcp-project-list">
        {visible.length === 0 && (
          <div className="mcp-empty">No project-level overrides set.</div>
        )}
        {visible.map(projPath => {
          const isEnabled = enabledSet.has(projPath);
          const isDisabled = disabledSet.has(projPath);
          const state: 'enabled' | 'disabled' | 'unset' = isEnabled ? 'enabled' : isDisabled ? 'disabled' : 'unset';
          return (
            <div key={projPath} className="mcp-project-row">
              <span className="mcp-project-path" title={projPath}>{shortProjectPath(projPath)}</span>
              <span className={`mcp-project-state mcp-project-state--${state}`}>{state}</span>
              <Toggle
                checked={isEnabled}
                busy={busyKey === `${server.name}:${projPath}`}
                onChange={(v) => onToggle(projPath, v)}
              />
            </div>
          );
        })}
      </div>
      {!showAll && others.length > 0 && (
        <button className="mcp-btn-ghost" style={{ marginTop: 10, fontSize: 11 }} onClick={() => setShowAll(true)}>
          Show all {others.length} other projects
        </button>
      )}
    </div>
  );
}
