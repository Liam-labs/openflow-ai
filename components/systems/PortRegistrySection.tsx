'use client';

import { useEffect, useState, useCallback } from 'react';
import { Network, RefreshCw, Server, AlertTriangle } from 'lucide-react';
import { DataTable, StatusBadge } from './DataTable';
import type { ColumnDef } from './DataTable';
import type { PortInfo } from '@/lib/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RegisteredPort {
  port: number;
  name: string;
  category?: string;
  owner?: string;
}

interface PortRow {
  port: number;
  process: string;
  pid: number;
  status: 'listening' | 'established';
  registered: boolean;
  registeredName?: string;
  registeredCategory?: string;
  /** True when a PM2 process claims this port but a different process is detected on it */
  conflict: boolean;
  conflictWith?: string;
}

// ─── Columns ──────────────────────────────────────────────────────────────────

const COLS: ColumnDef<PortRow>[] = [
  {
    key: 'port',
    header: 'Port',
    sortable: true,
    width: '80px',
    align: 'right',
    getValue: r => r.port,
    render: r => (
      <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#60a5fa', fontSize: '12.5px' }}>
        {r.port}
      </span>
    ),
  },
  {
    key: 'registered',
    header: 'Registry',
    sortable: true,
    width: '110px',
    getValue: r => r.conflict ? 'conflict' : r.registered ? 'registered' : 'unregistered',
    render: r => {
      if (r.conflict) return (
        <span className="port-conflict-badge" title={r.conflictWith ? `PM2 expects "${r.conflictWith}" on this port` : 'Port ownership conflict'}>
          <AlertTriangle size={11} /> Conflict
        </span>
      );
      return <StatusBadge status={r.registered ? 'active' : 'unknown'} label={r.registered ? 'Registered' : 'Unregistered'} />;
    },
  },
  {
    key: 'process',
    header: 'Process',
    sortable: true,
    getValue: r => r.registeredName ?? r.process,
    render: r => (
      <div>
        <div style={{ fontWeight: 500, fontSize: '12.5px' }}>{r.registeredName ?? r.process}</div>
        {r.registeredName && r.process !== r.registeredName && (
          <div style={{ fontSize: '11px', color: r.conflict ? '#ef4444' : 'var(--muted)', fontFamily: 'monospace' }}>
            {r.conflict ? `⚠ detected: ${r.process}` : r.process}
          </div>
        )}
        {r.conflict && !r.registeredName && (
          <div style={{ fontSize: '11px', color: '#ef4444', fontFamily: 'monospace' }}>
            PM2 expects: {r.conflictWith}
          </div>
        )}
      </div>
    ),
  },
  {
    key: 'category',
    header: 'Category',
    sortable: true,
    width: '120px',
    getValue: r => r.registeredCategory ?? '',
    render: r => r.registeredCategory
      ? <span style={{ fontSize: '11.5px', color: '#94a3b8', textTransform: 'capitalize' }}>{r.registeredCategory}</span>
      : <span style={{ color: 'var(--muted)' }}>—</span>,
  },
  {
    key: 'pid',
    header: 'PID',
    sortable: true,
    width: '80px',
    align: 'right',
    getValue: r => r.pid,
    render: r => (
      <span style={{ fontFamily: 'monospace', color: 'var(--muted)', fontSize: '12px' }}>
        {r.pid || '—'}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    sortable: true,
    width: '110px',
    getValue: r => r.status,
    render: r => <StatusBadge status={r.status === 'listening' ? 'active' : 'configured'} label={r.status} />,
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export function PortRegistrySection() {
  const [rows, setRows] = useState<PortRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'registered' | 'unregistered' | 'conflict'>('all');

  const fetchPorts = useCallback(async () => {
    try {
      // Fetch detected ports + PM2 status in parallel
      const [portsRes, pm2Res, regRes] = await Promise.allSettled([
        fetch('/api/ports'),
        fetch('/api/pm2'),
        fetch('/api/ports/registry').catch(() => null),
      ]);

      const detected: PortInfo[] = portsRes.status === 'fulfilled' && portsRes.value.ok
        ? (await portsRes.value.json()).ports ?? []
        : [];

      // Build PM2 portsInUse map: port → pm2 process name
      const pm2PortsInUse = new Map<number, string>();
      if (pm2Res.status === 'fulfilled' && pm2Res.value.ok) {
        try {
          const pm2Data = await pm2Res.value.json();
          // /api/pm2 returns { portsInUse: Record<string, string> } — port numbers as string keys
          const portsInUse: Record<string, string> = pm2Data?.portsInUse ?? {};
          for (const [portStr, name] of Object.entries(portsInUse)) {
            const port = parseInt(portStr, 10);
            if (port && name) pm2PortsInUse.set(port, name as string);
          }
        } catch { /* ignore */ }
      }

      // Try registry endpoint; if it doesn't exist, fall back to empty
      let registered: RegisteredPort[] = [];
      if (regRes.status === 'fulfilled' && regRes.value && 'json' in regRes.value) {
        try {
          const data = await (regRes.value as Response).json();
          registered = data.ports ?? [];
        } catch { /* ignore */ }
      }

      const regMap = new Map(registered.map(r => [r.port, r]));

      const merged: PortRow[] = detected.map(p => {
        const reg = regMap.get(p.port);
        const pm2Owner = pm2PortsInUse.get(p.port);
        // Conflict: PM2 claims this port for process X, but detected process is something different
        const conflict = !!pm2Owner && !p.process.toLowerCase().includes(pm2Owner.toLowerCase())
          && !pm2Owner.toLowerCase().includes(p.process.toLowerCase());
        return {
          port: p.port,
          process: p.process,
          pid: p.pid,
          status: p.status,
          registered: !!reg || !!pm2Owner,
          registeredName: reg?.name ?? pm2Owner,
          registeredCategory: reg?.category,
          conflict,
          conflictWith: conflict ? pm2Owner : undefined,
        };
      });

      // Add PM2 registered ports not yet detected (service offline)
      for (const [port, name] of pm2PortsInUse) {
        if (!merged.find(m => m.port === port)) {
          merged.push({
            port,
            process: name,
            pid: 0,
            status: 'listening',
            registered: true,
            registeredName: name,
            conflict: false,
          });
        }
      }
      // Also add registry-only ports
      for (const r of registered) {
        if (!merged.find(m => m.port === r.port)) {
          merged.push({
            port: r.port,
            process: r.name,
            pid: 0,
            status: 'listening',
            registered: true,
            registeredName: r.name,
            registeredCategory: r.category,
            conflict: false,
          });
        }
      }

      merged.sort((a, b) => a.port - b.port);
      setRows(merged);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPorts();
    const id = setInterval(fetchPorts, 15_000);
    return () => clearInterval(id);
  }, [fetchPorts]);

  const registeredCount = rows.filter(r => r.registered && !r.conflict).length;
  const unregisteredCount = rows.filter(r => !r.registered).length;
  const conflictCount = rows.filter(r => r.conflict).length;

  const displayed = filter === 'all' ? rows
    : filter === 'registered' ? rows.filter(r => r.registered && !r.conflict)
    : filter === 'unregistered' ? rows.filter(r => !r.registered)
    : rows.filter(r => r.conflict);

  if (isLoading) return <div className="systems-section__loading">Scanning ports…</div>;

  return (
    <div className="systems-section">
      {/* Header with inline stat pills */}
      <div className="systems-section__header">
        <div className="systems-section__header-left">
          <Network size={16} style={{ color: '#06b6d4', flexShrink: 0 }} />
          <h2 className="systems-section__title">Port Registry</h2>
          <span className="systems-stat-pill systems-stat-pill--info">
            <span className="systems-stat-pill__value">{rows.length}</span> detected
          </span>
          <span className="systems-stat-pill systems-stat-pill--success">
            <span className="systems-stat-pill__value">{registeredCount}</span> registered
          </span>
          {unregisteredCount > 0 && (
            <span className="systems-stat-pill systems-stat-pill--warning">
              <span className="systems-stat-pill__value">{unregisteredCount}</span> unknown
            </span>
          )}
          {conflictCount > 0 && (
            <span className="systems-stat-pill systems-stat-pill--error">
              <AlertTriangle size={10} /><span className="systems-stat-pill__value">{conflictCount}</span> conflict{conflictCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <button className="systems-filter-bar__action" onClick={fetchPorts} title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Filter bar */}
      <p className="systems-section__desc">Maps all active TCP listeners to their registered owners. Flags unknown processes and PM2 ownership conflicts.</p>
      <div className="systems-filter-bar">
        <div className="systems-filter-bar__group">
          <span className="systems-filter-bar__label">Show</span>
          <button className={`systems-filter-bar__pill${filter === 'all' ? ' systems-filter-bar__pill--active' : ''}`} onClick={() => setFilter('all')}>
            All <span style={{ opacity: 0.6, fontSize: '11px' }}>{rows.length}</span>
          </button>
          <button className={`systems-filter-bar__pill${filter === 'registered' ? ' systems-filter-bar__pill--active' : ''}`} onClick={() => setFilter('registered')}>
            Registered <span style={{ opacity: 0.6, fontSize: '11px' }}>{registeredCount}</span>
          </button>
          <button className={`systems-filter-bar__pill${filter === 'unregistered' ? ' systems-filter-bar__pill--active' : ''}`} onClick={() => setFilter('unregistered')}>
            Unknown <span style={{ opacity: 0.6, fontSize: '11px' }}>{unregisteredCount}</span>
          </button>
          {conflictCount > 0 && (
            <button className={`systems-filter-bar__pill systems-filter-bar__pill--error${filter === 'conflict' ? ' systems-filter-bar__pill--active' : ''}`} onClick={() => setFilter('conflict' as typeof filter)}>
              <AlertTriangle size={11} /> Conflicts <span style={{ opacity: 0.6, fontSize: '11px' }}>{conflictCount}</span>
            </button>
          )}
        </div>
      </div>

      <DataTable<PortRow>
        columns={COLS}
        data={displayed}
        rowKey={r => `${r.port}`}
        pageSize={30}
        initialSort={{ key: 'port', direction: 'asc' }}
        emptyMessage="No ports detected."
      />
    </div>
  );
}
