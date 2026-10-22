'use client';

import { useCallback, useEffect, useState } from 'react';
import { Info, ShieldCheck, RefreshCw, AlertTriangle, ChevronDown, ChevronRight, CheckCircle2, CircleHelp, Copy, Check, XCircle } from 'lucide-react';
import { DataTable } from './DataTable';
import type { ColumnDef } from './DataTable';
import {
  parseFirewall, countByExposure, sortPorts, describeBind, ruleSummary, firewallHeadline, needsAttention, defaultFilter, isTailnetOnly,
  EXPOSURE_LABEL, EXPOSURE_HELP, EXPOSURE_ORDER, INTENDED_LABEL,
} from '@/lib/firewall';
import type { ControlState, Exposure, FirewallControl, FirewallMachine, FirewallPort, FirewallResponse } from '@/lib/firewall';

const EXPOSURE_COLOR: Record<Exposure, string> = {
  open: '#ef4444',
  unknown: '#f59e0b',
  allowed: '#f59e0b',
  blocked: '#22c55e',
  'local-only': '#22c55e',
};

function ExposureBadge({ exposure, how, tailnet = false }: { exposure: Exposure; how?: string; tailnet?: boolean }) {
  const color = tailnet ? '#f59e0b' : EXPOSURE_COLOR[exposure];
  const help = tailnet ? 'Every device on your Tailscale network can connect. The internet cannot.' : EXPOSURE_HELP[exposure];
  return (
    <span
      title={[help, how].filter(Boolean).join(' ')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 999,
        fontSize: 11.5, fontWeight: 600, color, background: `${color}1f`, border: `1px solid ${color}40`, whiteSpace: 'nowrap',
      }}
    >
      {(exposure === 'open' || exposure === 'unknown') && !tailnet && <AlertTriangle size={11} />}
      {tailnet ? 'Open to the tailnet' : EXPOSURE_LABEL[exposure]}
    </span>
  );
}

const COLS: ColumnDef<FirewallPort>[] = [
  {
    key: 'service',
    header: 'Service',
    sortable: true,
    getValue: r => r.service,
    render: r => (
      <div>
        <div style={{ fontWeight: 500, fontSize: '12.5px' }}>
          {r.service}
          {r.runsIn && (
            <span title={r.runsIn === 'wsl' ? 'Runs inside WSL' : 'Runs on Windows'} style={{ marginLeft: 6, padding: '0 6px', borderRadius: 999, fontSize: 10, color: '#7dd3fc', border: '1px solid rgba(125,211,252,0.35)' }}>{r.runsIn === 'wsl' ? 'WSL' : 'Windows'}</span>
          )}
          {r.registered === false && (
            <span title="Nobody has named this port in the registry yet" style={{ marginLeft: 6, padding: '0 6px', borderRadius: 999, fontSize: 10, color: '#94a3b8', border: '1px solid rgba(148,163,184,0.35)' }}>Unregistered</span>
          )}
        </div>
        {r.process && r.process !== r.service && (
          <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{r.process}</div>
        )}
      </div>
    ),
  },
  {
    key: 'port',
    header: 'Port',
    sortable: true,
    width: '100px',
    getValue: r => r.port,
    render: r => (
      <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#60a5fa', fontSize: '12.5px' }}>
        {r.port}<span style={{ color: 'var(--muted)', fontWeight: 400 }}>/{r.proto}</span>
      </span>
    ),
  },
  {
    key: 'bind',
    header: 'Listening on',
    sortable: true,
    getValue: r => r.bind,
    render: r => <span style={{ fontSize: 12.5 }}>{describeBind(r.bind)}</span>,
  },
  {
    key: 'exposure',
    header: 'Who can connect',
    sortable: true,
    width: '190px',
    getValue: r => EXPOSURE_ORDER.indexOf(r.exposure),
    render: r => (
      <div style={{ display: 'grid', gap: 3, justifyItems: 'start' }}>
        <ExposureBadge exposure={r.exposure} how={r.how} tailnet={isTailnetOnly(r)} />
        {r.drift && (
          <span title="The firewall lets in more than this port is meant for" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', borderRadius: 999, fontSize: 10.5, fontWeight: 600, color: '#fca5a5', background: 'rgba(239,68,68,0.14)', border: '1px solid rgba(239,68,68,0.4)' }}>
            <AlertTriangle size={10} /> Allows more than intended
          </span>
        )}
        {r.intended && INTENDED_LABEL[r.intended] && (
          <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>Meant for: {INTENDED_LABEL[r.intended]}</span>
        )}
      </div>
    ),
  },
  {
    key: 'allowedFrom',
    header: 'Allowed from',
    getValue: r => (r.allowedFrom ?? []).join(' '),
    render: r => r.allowedFrom?.length
      ? (
        <span style={{ fontSize: 12 }} title={r.allowedFrom.length > 2 ? r.allowedFrom.join('\n') : undefined}>
          {r.allowedFrom.slice(0, 2).join(', ')}
          {r.allowedFrom.length > 2 && <span style={{ color: 'var(--muted)' }}> +{r.allowedFrom.length - 2} more</span>}
        </span>
      )
      : <span style={{ color: 'var(--muted)' }}>—</span>,
  },
  {
    key: 'note',
    header: 'Note',
    getValue: r => r.note ?? '',
    render: r => <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.note ?? ''}</span>,
  },
];

const CONTROL_STYLE: Record<ControlState, { color: string; label: string }> = {
  ok: { color: '#22c55e', label: 'OK' },
  warn: { color: '#f59e0b', label: 'Needs a look' },
  off: { color: '#ef4444', label: 'Off' },
  unknown: { color: '#94a3b8', label: 'Not checked' },
};

function ControlIcon({ state }: { state: ControlState }) {
  const color = CONTROL_STYLE[state].color;
  if (state === 'ok') return <CheckCircle2 size={14} style={{ color }} />;
  if (state === 'warn') return <AlertTriangle size={14} style={{ color }} />;
  if (state === 'off') return <XCircle size={14} style={{ color }} />;
  return <CircleHelp size={14} style={{ color }} />;
}

/** "What's locked down": one chip per protection; click one for how it works and the command that proves it. */
function ControlsStrip({ controls }: { controls: FirewallControl[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (controls.length === 0) return null;
  const open = controls.find(c => c.id === openId);
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };
  return (
    <div style={{ margin: '4px 0 10px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>What&apos;s locked down</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {controls.map(c => {
          const { color } = CONTROL_STYLE[c.state] ?? CONTROL_STYLE.unknown;
          const selected = c.id === openId;
          return (
            <button
              key={c.id}
              type="button"
              aria-expanded={selected}
              onClick={() => setOpenId(selected ? null : c.id)}
              title={c.summary}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 8, fontSize: 12, cursor: 'pointer', color: 'inherit', background: selected ? `${color}22` : 'rgba(255,255,255,0.04)', border: `1px solid ${selected ? `${color}77` : `${color}40`}` }}
            >
              <ControlIcon state={c.state} />{c.title}
            </button>
          );
        })}
      </div>
      {open && (
        <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.45, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontWeight: 600, color: (CONTROL_STYLE[open.state] ?? CONTROL_STYLE.unknown).color }}>{(CONTROL_STYLE[open.state] ?? CONTROL_STYLE.unknown).label}</div>
          {open.summary && <p style={{ margin: '2px 0 0' }}>{open.summary}</p>}
          {open.how && <p style={{ margin: '6px 0 0', color: 'var(--muted)' }}>{open.how}</p>}
          {open.check && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <code style={{ flex: 1, padding: '6px 8px', borderRadius: 6, fontSize: 11.5, background: 'rgba(0,0,0,0.35)', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{open.check}</code>
              <button type="button" onClick={() => copy(open.check!)} title="Copy the command" aria-label="Copy the command" style={{ padding: 6, borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FirewallSection() {
  const [data, setData] = useState<FirewallResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [machineId, setMachineId] = useState<string>('');
  const [filter, setFilter] = useState<'all' | 'attention' | 'tailnet' | Exposure | null>(null);
  const [showRules, setShowRules] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/system/firewall', { cache: 'no-store' });
      const parsed = res.ok ? parseFirewall(await res.json()) : null;
      if (parsed) { setData(parsed); setState('ready'); } else { setState(prev => (prev === 'ready' ? prev : 'unavailable')); }
    } catch {
      setState(prev => (prev === 'ready' ? prev : 'unavailable'));
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const machines = data?.machines ?? [];
  const machine: FirewallMachine | undefined = machines.find(m => m.id === machineId) ?? machines[0];
  const counts = countByExposure(machine?.ports ?? []);
  const headline = machine ? firewallHeadline(machine) : null;
  // Until a filter is picked, a long list starts on what needs attention instead of 300 quiet rows.
  const activeFilter = filter ?? defaultFilter(machine?.ports ?? []);
  const attentionCount = (machine?.ports ?? []).filter(needsAttention).length;
  const rows = sortPorts(machine?.ports ?? []).filter(p => activeFilter === 'all'
    || (activeFilter === 'attention' ? needsAttention(p)
      : activeFilter === 'tailnet' ? isTailnetOnly(p)
      : activeFilter === 'open' ? p.exposure === 'open' && !isTailnetOnly(p)
      : p.exposure === activeFilter));

  if (state === 'loading') return <div className="systems-section__loading">Reading the firewall…</div>;

  return (
    <div className="systems-section">
      <div className="systems-section__header">
        <div className="systems-section__header-left">
          <ShieldCheck size={16} style={{ color: '#06b6d4', flexShrink: 0 }} />
          <h2 className="systems-section__title">Firewall</h2>
          {machine?.reachable && (
            <>
              {counts.open > 0 && (
                <span className="systems-stat-pill systems-stat-pill--error">
                  <AlertTriangle size={10} /><span className="systems-stat-pill__value">{counts.open}</span> open to anyone
                </span>
              )}
              {counts.tailnet > 0 && (
                <span className="systems-stat-pill systems-stat-pill--warning">
                  <span className="systems-stat-pill__value">{counts.tailnet}</span> open to the tailnet
                </span>
              )}
              {counts.unknown > 0 && (
                <span className="systems-stat-pill systems-stat-pill--warning">
                  <AlertTriangle size={10} /><span className="systems-stat-pill__value">{counts.unknown}</span> can&apos;t tell
                </span>
              )}
              {machine.ports.some(p => p.drift) && (
                <span className="systems-stat-pill systems-stat-pill--error">
                  <AlertTriangle size={10} /><span className="systems-stat-pill__value">{machine.ports.filter(p => p.drift).length}</span> allow more than intended
                </span>
              )}
              {machine.controls.some(c => c.state === 'warn' || c.state === 'off') && (
                <span className="systems-stat-pill systems-stat-pill--warning">
                  <AlertTriangle size={10} /><span className="systems-stat-pill__value">{machine.controls.filter(c => c.state === 'warn' || c.state === 'off').length}</span> protection needs a look
                </span>
              )}
              <span className="systems-stat-pill systems-stat-pill--warning">
                <span className="systems-stat-pill__value">{counts.allowed}</span> limited
              </span>
              <span className="systems-stat-pill systems-stat-pill--success">
                <span className="systems-stat-pill__value">{counts['local-only'] + counts.blocked}</span> locked down
              </span>
            </>
          )}
        </div>
        <button className="systems-filter-bar__action" onClick={load} title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      <p className="systems-section__desc">
        What each machine&apos;s firewall locks down and what it lets through, with the service behind every open port. Read-only: rules are changed on the machine itself.
      </p>

      {state === 'unavailable' || !machine ? (
        <div className="systems-section__loading">
          The firewall report isn&apos;t available yet. It will appear here as soon as the server provides it.
        </div>
      ) : (
        <>
          {machines.length > 1 && (
            <div className="systems-filter-bar">
              <div className="systems-filter-bar__group">
                <span className="systems-filter-bar__label">Machine</span>
                {machines.map(m => (
                  <button
                    key={m.id}
                    className={`systems-filter-bar__pill${m.id === machine.id ? ' systems-filter-bar__pill--active' : ''}`}
                    onClick={() => { setMachineId(m.id); setFilter(null); }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', margin: '8px 0', borderRadius: 8, fontSize: 12.5,
              border: `1px solid ${headline?.ok ? 'rgba(34,197,94,0.3)' : 'rgba(245,158,11,0.4)'}`,
              background: headline?.ok ? 'rgba(34,197,94,0.07)' : 'rgba(245,158,11,0.07)',
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 999, background: headline?.ok ? '#22c55e' : '#f59e0b' }} />
            <strong>{machine.label}</strong>
            <span style={{ color: 'var(--muted)' }}>{headline?.text}</span>
          </div>

          {machine.reachable && <ControlsStrip key={machine.id} controls={machine.controls} />}

          {machine.reachable && (
            <>
              <div className="systems-filter-bar">
                <div className="systems-filter-bar__group">
                  <span className="systems-filter-bar__label">Show</span>
                  <button className={`systems-filter-bar__pill${activeFilter === 'all' ? ' systems-filter-bar__pill--active' : ''}`} onClick={() => setFilter('all')}>
                    All <span style={{ opacity: 0.6, fontSize: 11 }}>{machine.ports.length}</span>
                  </button>
                  {attentionCount > 0 && (
                    <button className={`systems-filter-bar__pill systems-filter-bar__pill--error${activeFilter === 'attention' ? ' systems-filter-bar__pill--active' : ''}`} onClick={() => setFilter('attention')}>
                      <AlertTriangle size={11} /> Needs attention <span style={{ opacity: 0.6, fontSize: 11 }}>{attentionCount}</span>
                    </button>
                  )}
                  {counts.tailnet > 0 && (
                    <button className={`systems-filter-bar__pill${activeFilter === 'tailnet' ? ' systems-filter-bar__pill--active' : ''}`} onClick={() => setFilter('tailnet')} title="Open only because Tailscale lets every device on your tailnet in">
                      Open to the tailnet <span style={{ opacity: 0.6, fontSize: 11 }}>{counts.tailnet}</span>
                    </button>
                  )}
                  {EXPOSURE_ORDER.filter(e => e !== 'unknown' || counts.unknown > 0).map(e => (
                    <button
                      key={e}
                      className={`systems-filter-bar__pill${activeFilter === e ? ' systems-filter-bar__pill--active' : ''}`}
                      onClick={() => setFilter(e)}
                    >
                      {EXPOSURE_LABEL[e]} <span style={{ opacity: 0.6, fontSize: 11 }}>{counts[e]}</span>
                    </button>
                  ))}
                </div>
              </div>

              <DataTable<FirewallPort>
                columns={COLS}
                data={rows}
                rowKey={r => `${machine.id}-${r.proto}-${r.port}-${r.bind}`}
                pageSize={30}
                initialSort={{ key: 'exposure', direction: 'asc' }}
                emptyMessage="No listening ports."
              />
              {machine.omitted && machine.omitted.count > 0 && (
                <p style={{ margin: '8px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>
                  {machine.omitted.count} more sockets left out. {machine.omitted.note}
                </p>
              )}
              {machine.notes && machine.notes.length > 0 && (
                <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                  {machine.notes.map((n, i) => (
                    <li key={i} style={{ display: 'flex', gap: 6, fontSize: 11.5, color: 'var(--muted)' }}><Info size={13} style={{ flexShrink: 0, marginTop: 1 }} />{n}</li>
                  ))}
                </ul>
              )}

              <button
                className="systems-filter-bar__pill"
                style={{ marginTop: 14, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                onClick={() => setShowRules(v => !v)}
              >
                {showRules ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                Firewall rules <span style={{ opacity: 0.6, fontSize: 11 }}>{machine.rules.length}</span>
              </button>
              {showRules && (
                <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 6, maxHeight: 420, overflowY: 'auto' }}>
                  {machine.rules.length === 0 && <li style={{ color: 'var(--muted)', fontSize: 12.5 }}>No rules. Everything follows the default.</li>}
                  {machine.rules.map((r, i) => (
                    <li key={i} style={{ fontSize: 12.5, padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                      <span style={{ fontFamily: 'monospace' }}>{ruleSummary(r)}</span>
                      {r.comment && <span style={{ color: 'var(--muted)' }}> — {r.comment}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
