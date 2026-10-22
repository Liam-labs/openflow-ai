'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, ExternalLink } from 'lucide-react';
import type { Connection, McpServerEntry, ConnectionEnvCheckResult } from '@/lib/types';

// ─── Category Icons ───────────────────────────────────────────────────────────

const CATEGORY_ICONS: Record<string, string> = {
  ai: '🤖', infrastructure: '🏗️', database: '🗄️', google: '🔍',
  seo: '📊', media: '🎬', payments: '💳', ecommerce: '🛒',
  automation: '⚙️', design: '🎨', creative: '✨', email: '📧',
  security: '🔒', productivity: '📝', backup: '💾', mcp: '🔌',
};

// ─── Status Badge ─────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  active:                { label: 'Active',          color: '#22c55e', bg: 'rgba(34,197,94,0.1)'  },
  configured:            { label: 'Configured',      color: '#eab308', bg: 'rgba(234,179,8,0.1)'  },
  configured_not_active: { label: 'Not Active',      color: '#71717a', bg: 'rgba(113,113,122,0.1)'},
  pending:               { label: 'Pending',         color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
};

// ─── Section Heading ──────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 10px' }}>
      <div style={{ height: 1, flex: 1, background: 'rgba(255,255,255,0.06)' }} />
      <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>
        {children}
      </span>
      <div style={{ height: 1, flex: 1, background: 'rgba(255,255,255,0.06)' }} />
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface ConnectionDetailModalProps {
  connection: Connection | McpServerEntry;
  isMcp: boolean;
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ConnectionDetailModal({ connection, isMcp, onClose }: ConnectionDetailModalProps) {
  const [envCheck, setEnvCheck] = useState<ConnectionEnvCheckResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ status: string; message?: string; latencyMs?: number } | null>(null);

  const category = (connection as Connection).category || 'mcp';
  const icon = CATEGORY_ICONS[isMcp ? 'mcp' : category] || '🔗';
  const statusCfg = STATUS_LABELS[connection.status] || STATUS_LABELS.configured;

  // Check env vars on open
  useEffect(() => {
    if (!connection.env_vars?.length) return;
    fetch('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check_env', id: connection.id }),
    })
      .then(r => r.json() as Promise<ConnectionEnvCheckResult>)
      .then(setEnvCheck)
      .catch(() => null);
  }, [connection.id, connection.env_vars]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', id: connection.id }),
      });
      setTestResult(await res.json());
    } catch {
      setTestResult({ status: 'error', message: 'Request failed' });
    } finally {
      setTesting(false);
    }
  }, [connection.id]);

  const copyToClipboard = (text: string) => navigator.clipboard.writeText(text);

  const panelStyle: React.CSSProperties = {
    background: '#0a1628',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 16,
    width: '100%',
    maxWidth: 540,
    maxHeight: '85vh',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={panelStyle}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          <span style={{ fontSize: '1.4rem', lineHeight: 1 }}>{icon}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#f4f4f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {connection.name}
            </div>
          </div>
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: statusCfg.color, background: statusCfg.bg, border: `1px solid ${statusCfg.color}30`, borderRadius: 6, padding: '2px 8px', flexShrink: 0 }}>
            {statusCfg.label}
          </span>
          <button
            onClick={onClose}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, border: 'none', background: 'rgba(255,255,255,0.06)', color: '#71717a', cursor: 'pointer', flexShrink: 0 }}
          >
            <X size={14} />
          </button>
        </div>

        {/* ── Body ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 16px' }}>

          {/* About */}
          <SectionHeading>About</SectionHeading>
          <p style={{ fontSize: '0.8rem', color: '#a1a1aa', lineHeight: 1.5, margin: '0 0 10px' }}>
            {connection.purpose}
          </p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {!isMcp && (connection as Connection).category && (
              <span style={{ fontSize: '0.7rem', color: '#71717a', background: 'rgba(113,113,122,0.12)', border: '1px solid rgba(113,113,122,0.2)', borderRadius: 4, padding: '2px 7px' }}>
                {(connection as Connection).category}
              </span>
            )}
            {isMcp && (
              <span style={{ fontSize: '0.7rem', color: '#fbbf24', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 4, padding: '2px 7px' }}>
                MCP Server
              </span>
            )}
            <span style={{ fontSize: '0.7rem', color: '#71717a', background: 'rgba(113,113,122,0.12)', border: '1px solid rgba(113,113,122,0.2)', borderRadius: 4, padding: '2px 7px' }}>
              {connection.connection_type.replace(/_/g, ' ')}
            </span>
          </div>

          {/* Env Vars */}
          {connection.env_vars && connection.env_vars.length > 0 && (
            <>
              <SectionHeading>Environment Variables</SectionHeading>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {connection.env_vars.map(varName => {
                  const isSet = envCheck ? envCheck.envVars[varName] : null;
                  return (
                    <div key={varName} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 6 }}>
                      <code style={{ fontSize: '0.72rem', color: '#a1a1aa', fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {varName}
                      </code>
                      <span style={{ fontSize: '0.68rem', fontWeight: 600, flexShrink: 0,
                        color: isSet === null ? '#71717a' : isSet ? '#22c55e' : '#ef4444',
                        background: isSet === null ? 'transparent' : isSet ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                        border: `1px solid ${isSet === null ? 'transparent' : isSet ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                        borderRadius: 4, padding: '1px 6px',
                      }}>
                        {isSet === null ? '●●●●●●' : isSet ? 'Set ✓' : 'Missing ✗'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Endpoint */}
          {connection.endpoint && (
            <>
              <SectionHeading>Endpoint</SectionHeading>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 6 }}>
                <code style={{ fontSize: '0.72rem', color: '#a1a1aa', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                  {connection.endpoint}
                </code>
                <button
                  onClick={() => copyToClipboard(connection.endpoint!)}
                  style={{ fontSize: '0.68rem', color: '#71717a', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 4, padding: '2px 7px', cursor: 'pointer' }}
                >
                  Copy
                </button>
              </div>
            </>
          )}

          {/* Service Account */}
          {(connection as Connection).service_account && (
            <>
              <SectionHeading>Service Account</SectionHeading>
              <code style={{ fontSize: '0.72rem', color: '#a1a1aa', display: 'block', padding: '8px 10px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 6, wordBreak: 'break-all' }}>
                {(connection as Connection).service_account}
              </code>
            </>
          )}

          {/* Used In */}
          {(connection as Connection).used_in && (connection as Connection).used_in!.length > 0 && (
            <>
              <SectionHeading>Used In</SectionHeading>
              <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {(connection as Connection).used_in!.map(item => (
                  <li key={item} style={{ fontSize: '0.78rem', color: '#a1a1aa', lineHeight: 1.4 }}>{item}</li>
                ))}
              </ul>
            </>
          )}

          {/* Notes */}
          {(connection as Connection).notes && (
            <>
              <SectionHeading>Notes</SectionHeading>
              <p style={{ fontSize: '0.78rem', color: '#71717a', lineHeight: 1.5, margin: 0 }}>
                {(connection as Connection).notes}
              </p>
            </>
          )}

          {/* Test result */}
          {testResult && (
            <>
              <SectionHeading>Test Result</SectionHeading>
              <div style={{ padding: '8px 10px', background: testResult.status === 'ok' ? 'rgba(34,197,94,0.08)' : testResult.status === 'error' ? 'rgba(239,68,68,0.08)' : 'rgba(113,113,122,0.08)', border: `1px solid ${testResult.status === 'ok' ? 'rgba(34,197,94,0.2)' : testResult.status === 'error' ? 'rgba(239,68,68,0.2)' : 'rgba(113,113,122,0.2)'}`, borderRadius: 6 }}>
                <span style={{ fontSize: '0.78rem', fontWeight: 600, color: testResult.status === 'ok' ? '#22c55e' : testResult.status === 'error' ? '#ef4444' : '#71717a' }}>
                  {testResult.status === 'ok' ? '✓ OK' : testResult.status === 'error' ? '✗ Error' : '? Unknown'}
                  {testResult.latencyMs !== undefined && ` · ${testResult.latencyMs}ms`}
                </span>
                {testResult.message && (
                  <span style={{ fontSize: '0.72rem', color: '#71717a', marginLeft: 8 }}>{testResult.message}</span>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          {(connection as Connection).docs && (
            <a
              href={(connection as Connection).docs}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.78rem', color: '#71717a', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: '6px 12px', textDecoration: 'none', marginRight: 'auto' }}
            >
              <ExternalLink size={12} />
              Docs
            </a>
          )}
          <button
            onClick={handleTest}
            disabled={testing}
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.78rem', fontWeight: 600, color: testing ? '#52525b' : '#a1a1aa', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: '6px 14px', cursor: testing ? 'not-allowed' : 'pointer' }}
          >
            {testing ? (
              <span style={{ display: 'inline-block', width: 10, height: 10, border: '1.5px solid #52525b', borderTopColor: '#a1a1aa', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
            ) : '▶'}
            Test Connection
          </button>
          <button
            onClick={onClose}
            style={{ fontSize: '0.78rem', fontWeight: 600, color: '#e4e4e7', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '6px 16px', cursor: 'pointer' }}
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
}
