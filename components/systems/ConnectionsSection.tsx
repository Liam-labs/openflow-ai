'use client';

import { useEffect, useState, useCallback } from 'react';
import { Link, RefreshCw, Server, Search, FlaskConical, ChevronDown, ChevronRight as ChevronRightIcon } from 'lucide-react';
import { DataTable, StatusBadge } from './DataTable';
import type { ColumnDef } from './DataTable';
import type { Connection, McpServerEntry, ConnectionsData, ConnectionHealthResult } from '@/lib/types';
import type { SystemsNavState } from './systems-types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConnectionRow {
  id: string;
  name: string;
  category: string;
  connection_type: string;
  status: string;
  purpose: string;
  isMcp: boolean;
}

interface ConnectionsSectionProps {
  onNavigate?: (state: Partial<SystemsNavState>) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normaliseStatus(status: string): string {
  if (status === 'active') return 'active';
  if (status === 'configured' || status === 'configured_not_active') return 'configured';
  if (status === 'pending') return 'pending';
  return 'unknown';
}

function toRow(item: Connection | McpServerEntry, isMcp: boolean): ConnectionRow {
  return {
    id: item.id,
    name: item.name,
    category: isMcp ? 'mcp' : (item as Connection).category ?? '—',
    connection_type: item.connection_type,
    status: normaliseStatus(item.status),
    purpose: item.purpose,
    isMcp,
  };
}

// ─── Columns ──────────────────────────────────────────────────────────────────

function buildCols(onTest: (id: string, isMcp: boolean) => void, testing: Set<string>, testResults: Map<string, ConnectionHealthResult>): ColumnDef<ConnectionRow>[] {
  return [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      getValue: r => r.name,
      render: r => (
        <div>
          <div style={{ fontWeight: 500, fontSize: '12.5px' }}>{r.name}</div>
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: 1 }}>{r.purpose}</div>
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      sortable: true,
      width: '110px',
      getValue: r => r.category,
      render: r => (
        <span style={{ fontSize: '11.5px', color: '#94a3b8', textTransform: 'capitalize' }}>
          {r.isMcp ? <><Server size={11} style={{ marginRight: 4, display: 'inline', verticalAlign: 'middle' }} />MCP</> : r.category}
        </span>
      ),
    },
    {
      key: 'connection_type',
      header: 'Type',
      sortable: true,
      width: '130px',
      getValue: r => r.connection_type,
      render: r => (
        <span style={{ fontSize: '11px', color: 'var(--muted)', fontFamily: 'monospace' }}>
          {r.connection_type.replace(/_/g, ' ')}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      width: '120px',
      getValue: r => r.status,
      render: r => <StatusBadge status={r.status} />,
    },
    {
      key: '_test',
      header: 'Health',
      width: '110px',
      align: 'center',
      getValue: r => testResults.get(r.id)?.status ?? '',
      render: r => {
        const result = testResults.get(r.id);
        const isLoading = testing.has(r.id);
        if (isLoading) {
          return <span style={{ color: 'var(--muted)', fontSize: '11px' }}>Testing…</span>;
        }
        if (result) {
          return (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'center' }}>
              <StatusBadge status={result.status === 'ok' ? 'active' : result.status === 'error' ? 'errored' : 'unknown'} label={result.status} />
              {result.latencyMs !== undefined && (
                <span style={{ fontSize: '11px', color: 'var(--muted)' }}>{result.latencyMs}ms</span>
              )}
            </span>
          );
        }
        return (
          <button
            className="systems-conn__test-btn"
            onClick={(e) => { e.stopPropagation(); onTest(r.id, r.isMcp); }}
            title="Test connection"
          >
            <FlaskConical size={12} />
            Test
          </button>
        );
      },
    },
  ];
}

// ─── Component ────────────────────────────────────────────────────────────────

// ─── Category health strip ────────────────────────────────────────────────────

function CategoryHealthStrip({ rows, testResults }: {
  rows: ConnectionRow[];
  testResults: Map<string, ConnectionHealthResult>;
}) {
  const [expanded, setExpanded] = useState(false);

  const byCategory = new Map<string, { total: number; active: number; tested_ok: number; tested_err: number }>();
  for (const r of rows) {
    if (r.isMcp) continue;
    const cat = r.category;
    if (!byCategory.has(cat)) byCategory.set(cat, { total: 0, active: 0, tested_ok: 0, tested_err: 0 });
    const entry = byCategory.get(cat)!;
    entry.total++;
    if (r.status === 'active') entry.active++;
    const testResult = testResults.get(r.id);
    if (testResult?.status === 'ok') entry.tested_ok++;
    if (testResult?.status === 'error') entry.tested_err++;
  }

  const cats = [...byCategory.entries()].sort((a, b) => b[1].total - a[1].total);
  if (cats.length === 0) return null;

  return (
    <div className="conn-health-strip">
      <button className="conn-health-strip__toggle" onClick={() => setExpanded(e => !e)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRightIcon size={12} />}
        <span>Category Health</span>
        <span style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: 4 }}>
          {cats.length} categories
        </span>
      </button>
      {expanded && (
        <div className="conn-health-strip__grid">
          {cats.map(([cat, data]) => {
            const healthPct = data.total > 0 ? Math.round((data.active / data.total) * 100) : 0;
            const variant = healthPct === 100 ? '#22c55e' : healthPct >= 50 ? '#eab308' : '#ef4444';
            return (
              <div key={cat} className="conn-health-strip__card">
                <div className="conn-health-strip__cat-name">{cat}</div>
                <div className="conn-health-strip__bar-track">
                  <div
                    className="conn-health-strip__bar-fill"
                    style={{ width: `${healthPct}%`, background: variant }}
                  />
                </div>
                <div className="conn-health-strip__stats">
                  <span style={{ color: variant, fontWeight: 600 }}>{healthPct}%</span>
                  <span style={{ color: 'var(--muted)' }}>{data.active}/{data.total}</span>
                  {data.tested_err > 0 && <span style={{ color: '#ef4444', fontSize: '10.5px' }}>✗{data.tested_err}</span>}
                  {data.tested_ok > 0 && <span style={{ color: '#22c55e', fontSize: '10.5px' }}>✓{data.tested_ok}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ConnectionsSection({ onNavigate }: ConnectionsSectionProps) {
  const [data, setData] = useState<ConnectionsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'api' | 'mcp'>('all');
  const [search, setSearch] = useState('');
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Map<string, ConnectionHealthResult>>(new Map());

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/connections');
      const json = await res.json() as ConnectionsData;
      setData(json);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleTest = useCallback(async (id: string, _isMcp: boolean) => {
    setTesting(prev => new Set(prev).add(id));
    try {
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', id }),
      });
      const result: ConnectionHealthResult = await res.json();
      setTestResults(prev => new Map(prev).set(id, result));
    } catch {
      setTestResults(prev => new Map(prev).set(id, { id, status: 'unknown' }));
    } finally {
      setTesting(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }, []);

  if (isLoading) return <div className="systems-section__loading">Loading connections…</div>;
  if (!data) return null;

  const apiRows = (data.connections ?? []).map(c => toRow(c, false));
  const mcpRows = (data.mcp_servers ?? []).map(m => toRow(m, true));
  const allRows = [...apiRows, ...mcpRows];

  // Filters
  const categories = [...new Set(apiRows.map(r => r.category))].sort();
  let filtered = allRows;
  if (typeFilter === 'api') filtered = filtered.filter(r => !r.isMcp);
  if (typeFilter === 'mcp') filtered = filtered.filter(r => r.isMcp);
  if (categoryFilter !== 'all') filtered = filtered.filter(r => r.category === categoryFilter);
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(r => r.name.toLowerCase().includes(q) || r.purpose.toLowerCase().includes(q) || r.category.toLowerCase().includes(q));
  }

  const activeCount = allRows.filter(r => r.status === 'active').length;
  const configuredCount = allRows.filter(r => r.status === 'configured').length;
  const mcpCount = mcpRows.length;

  const cols = buildCols(handleTest, testing, testResults);

  return (
    <div className="systems-section">
      {/* Header with inline stat pills */}
      <div className="systems-section__header">
        <div className="systems-section__header-left">
          <Link size={16} style={{ color: '#3b82f6', flexShrink: 0 }} />
          <h2 className="systems-section__title">Connections</h2>
          <span className="systems-stat-pill systems-stat-pill--success">
            <span className="systems-stat-pill__value">{activeCount}</span> active
          </span>
          <span className="systems-stat-pill systems-stat-pill--warning">
            <span className="systems-stat-pill__value">{configuredCount}</span> configured
          </span>
          <span className="systems-stat-pill systems-stat-pill--info">
            <Server size={11} /><span className="systems-stat-pill__value">{mcpCount}</span> MCP
          </span>
          <span className="systems-stat-pill systems-stat-pill--muted">
            <span className="systems-stat-pill__value">{allRows.length}</span> total
          </span>
        </div>
        <button className="systems-filter-bar__action" onClick={fetchData} title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Filter bar */}
      <p className="systems-section__desc">API integrations, webhooks, and MCP server connections. Test connectivity and verify environment variable status.</p>
      <div className="systems-filter-bar">
        {/* Type filter */}
        <div className="systems-filter-bar__group">
          <span className="systems-filter-bar__label">Type</span>
          <button className={`systems-filter-bar__pill${typeFilter === 'all' ? ' systems-filter-bar__pill--active' : ''}`} onClick={() => setTypeFilter('all')}>All</button>
          <button className={`systems-filter-bar__pill${typeFilter === 'api' ? ' systems-filter-bar__pill--active' : ''}`} onClick={() => setTypeFilter('api')}>API</button>
          <button className={`systems-filter-bar__pill${typeFilter === 'mcp' ? ' systems-filter-bar__pill--active' : ''}`} onClick={() => setTypeFilter('mcp')}>MCP</button>
        </div>
        {typeFilter !== 'mcp' && categories.length > 0 && (
          <>
            <div className="systems-filter-bar__divider" />
            <div className="systems-filter-bar__group">
              <span className="systems-filter-bar__label">Category</span>
              <button className={`systems-filter-bar__pill${categoryFilter === 'all' ? ' systems-filter-bar__pill--active' : ''}`} onClick={() => setCategoryFilter('all')}>All</button>
              {categories.map(cat => (
                <button key={cat} className={`systems-filter-bar__pill${categoryFilter === cat ? ' systems-filter-bar__pill--active' : ''}`} onClick={() => setCategoryFilter(cat)}>
                  {cat}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="systems-filter-bar__spacer" />
        {/* Search */}
        <div className="systems-filter-bar__search">
          <Search size={12} />
          <input
            className="systems-filter-bar__search-input"
            placeholder="Search connections…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Category health aggregate */}
      <CategoryHealthStrip rows={allRows} testResults={testResults} />

      <DataTable<ConnectionRow>
        columns={cols}
        data={filtered}
        rowKey={r => r.id}
        pageSize={25}
        initialSort={{ key: 'name', direction: 'asc' }}
        onRowClick={onNavigate ? (r) => onNavigate({ section: r.isMcp ? 'mcp' : 'connections', entityId: r.id, entityType: r.isMcp ? 'mcp-server' : 'connection' }) : undefined}
        emptyMessage="No connections found."
      />
    </div>
  );
}
