'use client';

import { useEffect, useState, useCallback } from 'react';
import { Link, CheckCircle2, AlertCircle, Clock, Tag, Globe, FileText, RefreshCw, FlaskConical } from 'lucide-react';
import { StatusBadge } from './DataTable';
import { ProviderKeyForm } from './connections/ProviderKeyForm';
import { keyProvider, PROVIDER_PREFIX } from './connections/provider-link';
import type { Connection, McpServerEntry, ConnectionsData, ConnectionHealthResult } from '@/lib/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConnectionDetailProps {
  connectionId: string;
  isMcp?: boolean;
}

type TabId = 'overview' | 'health';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normaliseStatus(status: string): string {
  if (status === 'active') return 'active';
  if (status === 'configured' || status === 'configured_not_active') return 'configured';
  if (status === 'pending') return 'pending';
  return 'unknown';
}

// ─── Sub-views ────────────────────────────────────────────────────────────────

function OverviewTab({ conn, envStatus }: { conn: Connection | McpServerEntry; envStatus: Record<string, boolean> | null }) {
  const status = normaliseStatus(conn.status);
  const c = conn as Connection;
  return (
    <div className="conn-detail__content">
      {/* Status row */}
      <div className="conn-detail__meta-row conn-detail__meta-row--hero">
        <StatusBadge status={status} />
        {c.category && (
          <span className="conn-detail__tag">
            <Tag size={11} />
            {c.category}
          </span>
        )}
        {c.connection_type && (
          <span className="conn-detail__tag" style={{ fontFamily: 'monospace' }}>
            {c.connection_type.replace(/_/g, ' ')}
          </span>
        )}
      </div>

      {/* Purpose */}
      <div className="conn-detail__section">
        <div className="conn-detail__section-label">Purpose</div>
        <div className="conn-detail__section-value">{conn.purpose}</div>
      </div>

      {/* Endpoint */}
      {conn.endpoint && (
        <div className="conn-detail__section">
          <div className="conn-detail__section-label"><Globe size={12} /> Endpoint</div>
          <div className="conn-detail__section-value conn-detail__section-value--mono">{conn.endpoint}</div>
        </div>
      )}

      {/* Env vars */}
      {conn.env_vars && conn.env_vars.length > 0 && (
        <div className="conn-detail__section">
          <div className="conn-detail__section-label">Environment Variables</div>
          <div className="conn-detail__env-list">
            {conn.env_vars.map(v => {
              const set = envStatus ? envStatus[v] : null;
              return (
                <div key={v} className="conn-detail__env-row">
                  <code className="conn-detail__env-name">{v}</code>
                  {set === null ? null : set ? (
                    <span className="conn-detail__env-badge conn-detail__env-badge--set">
                      <CheckCircle2 size={11} /> Set
                    </span>
                  ) : (
                    <span className="conn-detail__env-badge conn-detail__env-badge--missing">
                      <AlertCircle size={11} /> Missing
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Used in */}
      {c.used_in && c.used_in.length > 0 && (
        <div className="conn-detail__section">
          <div className="conn-detail__section-label">Used In</div>
          <div className="conn-detail__tag-list">
            {c.used_in.map(p => <span key={p} className="conn-detail__tag">{p}</span>)}
          </div>
        </div>
      )}

      {/* Notes */}
      {c.notes && (
        <div className="conn-detail__section">
          <div className="conn-detail__section-label"><FileText size={12} /> Notes</div>
          <div className="conn-detail__section-value conn-detail__notes">{c.notes}</div>
        </div>
      )}

      {/* MCP PM2 process */}
      {(conn as McpServerEntry).pm2_process && (
        <div className="conn-detail__section">
          <div className="conn-detail__section-label">PM2 Process</div>
          <div className="conn-detail__section-value conn-detail__section-value--mono">
            {(conn as McpServerEntry).pm2_process}
          </div>
        </div>
      )}
    </div>
  );
}

function HealthTab({ conn, onTest }: {
  conn: Connection | McpServerEntry;
  onTest: () => void;
}) {
  const [result, setResult] = useState<ConnectionHealthResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastTestedAt, setLastTestedAt] = useState<string | null>(null);

  const runTest = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', id: conn.id }),
      });
      const data: ConnectionHealthResult = await res.json();
      setResult(data);
      setLastTestedAt(new Date().toISOString());
    } catch {
      setResult({ id: conn.id, status: 'unknown', message: 'Request failed' });
    } finally {
      setIsLoading(false);
      onTest();
    }
  }, [conn.id, onTest]);

  return (
    <div className="conn-detail__content">
      <div className="conn-detail__health-header">
        <button className="conn-detail__test-btn" onClick={runTest} disabled={isLoading}>
          {isLoading
            ? <><RefreshCw size={13} className="conn-detail__spin" /> Testing…</>
            : <><FlaskConical size={13} /> Run Health Check</>}
        </button>
        {lastTestedAt && (
          <span className="conn-detail__health-meta">
            <Clock size={11} /> Tested {new Date(lastTestedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {result && (
        <div className="conn-detail__health-result" data-status={result.status}>
          <div className="conn-detail__health-result-header">
            <StatusBadge status={result.status === 'ok' ? 'active' : result.status === 'error' ? 'errored' : 'unknown'} label={result.status.toUpperCase()} />
            {result.latencyMs !== undefined && (
              <span className="conn-detail__health-latency">{result.latencyMs}ms</span>
            )}
          </div>
          {result.message && (
            <div className="conn-detail__health-message">{result.message}</div>
          )}
        </div>
      )}

      {!result && !isLoading && (
        <div className="conn-detail__health-empty">
          Click &quot;Run Health Check&quot; to test this connection live.
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ConnectionDetail(props: ConnectionDetailProps) {
  const provider = !props.isMcp && props.connectionId.startsWith(PROVIDER_PREFIX)
    ? keyProvider(props.connectionId.slice(PROVIDER_PREFIX.length)) : undefined;
  if (provider) return (
    <div className="conn-detail">
      <div className="conn-detail__header"><h2 className="conn-detail__name">{provider.label}</h2></div>
      <ProviderKeyForm key={provider.id} providerId={provider.id} />
    </div>
  );
  return <CatalogConnectionDetail {...props} />;
}

function CatalogConnectionDetail({ connectionId, isMcp = false }: ConnectionDetailProps) {
  const [conn, setConn] = useState<Connection | McpServerEntry | null>(null);
  const [envStatus, setEnvStatus] = useState<Record<string, boolean> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  const fetchConn = useCallback(async () => {
    try {
      const res = await fetch('/api/connections');
      const data: ConnectionsData = await res.json();
      const all = [...(data.connections ?? []), ...(data.mcp_servers ?? [])];
      const found = all.find(c => c.id === connectionId);
      if (found) {
        setConn(found);
        // Check env vars
        if (found.env_vars?.length) {
          const envRes = await fetch('/api/connections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_env', id: connectionId }),
          });
          if (envRes.ok) {
            const envData = await envRes.json();
            setEnvStatus(envData.envVars ?? null);
          }
        }
      }
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { fetchConn(); }, [fetchConn]);

  const TABS: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'health', label: 'Health' },
  ];

  if (isLoading) return <div className="systems-section__loading">Loading connection…</div>;
  if (!conn) return <div className="conn-detail__error">Connection not found: {connectionId}</div>;

  return (
    <div className="conn-detail">
      {/* Header */}
      <div className="conn-detail__header">
        <span className="conn-detail__header-icon">
          <Link size={16} style={{ color: '#3b82f6' }} />
        </span>
        <div>
          <h2 className="conn-detail__name">{conn.name}</h2>
          {isMcp && <div className="conn-detail__subtitle">MCP Server</div>}
        </div>
      </div>

      {/* Tabs */}
      <div className="conn-detail__tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`conn-detail__tab${activeTab === tab.id ? ' conn-detail__tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && <OverviewTab conn={conn} envStatus={envStatus} />}
      {activeTab === 'health' && <HealthTab conn={conn} onTest={fetchConn} />}
    </div>
  );
}
