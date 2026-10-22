'use client';

import { useState } from 'react';
import type { Connection, McpServerEntry, ConnectionHealthResult, ConnectionType } from '@/lib/types';

// ─── Category icons ──────────────────────────────────────────────────────────

const CATEGORY_ICONS: Record<string, string> = {
  ai: '🤖',
  infrastructure: '🏗️',
  database: '🗄️',
  google: '🔍',
  seo: '📊',
  media: '🎬',
  payments: '💳',
  ecommerce: '🛒',
  automation: '⚙️',
  design: '🎨',
  creative: '✨',
  email: '📧',
  security: '🔒',
  productivity: '📝',
  backup: '💾',
  mcp: '🔌',
};

// ─── Connection type badge ───────────────────────────────────────────────────

const TYPE_BADGE: Record<ConnectionType | string, { label: string; color: string; bg: string }> = {
  api_key:                { label: 'API Key',          color: '#60a5fa', bg: 'rgba(59,130,246,0.12)' },
  api_token:              { label: 'API Token',        color: '#60a5fa', bg: 'rgba(59,130,246,0.12)' },
  personal_access_token:  { label: 'PAT',              color: '#60a5fa', bg: 'rgba(59,130,246,0.12)' },
  access_token:           { label: 'Token',            color: '#60a5fa', bg: 'rgba(59,130,246,0.12)' },
  oauth:                  { label: 'OAuth',            color: '#c084fc', bg: 'rgba(168,85,247,0.12)' },
  oauth_service_account:  { label: 'OAuth SA',         color: '#c084fc', bg: 'rgba(168,85,247,0.12)' },
  service_account:        { label: 'Service Account',  color: '#818cf8', bg: 'rgba(99,102,241,0.12)' },
  local_http:             { label: 'Local HTTP',       color: '#34d399', bg: 'rgba(16,185,129,0.12)' },
  api_key_local:          { label: 'Local API',        color: '#34d399', bg: 'rgba(16,185,129,0.12)' },
  pat_and_ssh:            { label: 'PAT + SSH',        color: '#22d3ee', bg: 'rgba(6,182,212,0.12)'  },
  url_and_keys:           { label: 'URL + Keys',       color: '#38bdf8', bg: 'rgba(14,165,233,0.12)' },
  credentials:            { label: 'Credentials',      color: '#fb923c', bg: 'rgba(249,115,22,0.12)' },
  stdio:                  { label: 'stdio',            color: '#fbbf24', bg: 'rgba(245,158,11,0.12)' },
  websocket:              { label: 'WebSocket',        color: '#fbbf24', bg: 'rgba(245,158,11,0.12)' },
  local:                  { label: 'Local',            color: '#fbbf24', bg: 'rgba(245,158,11,0.12)' },
  local_credentials:      { label: 'Local Creds',     color: '#a1a1aa', bg: 'rgba(113,113,122,0.12)' },
  encryption_key:         { label: 'Encryption Key',  color: '#a1a1aa', bg: 'rgba(113,113,122,0.12)' },
  api_key_and_webhook:    { label: 'API + Webhook',   color: '#60a5fa', bg: 'rgba(59,130,246,0.12)' },
};

// ─── Status dot ─────────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, { color: string; pulse: boolean }> = {
  active:                { color: '#22c55e', pulse: true  },
  configured:            { color: '#eab308', pulse: false },
  configured_not_active: { color: '#52525b', pulse: false },
  pending:               { color: '#3b82f6', pulse: false },
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface ConnectionCardProps {
  connection: Connection | McpServerEntry;
  isMcp?: boolean;
  onOpenModal: (connection: Connection | McpServerEntry, isMcp: boolean) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ConnectionCard({ connection, isMcp = false, onOpenModal }: ConnectionCardProps) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionHealthResult | null>(null);

  const category = (connection as Connection).category || 'mcp';
  const icon = CATEGORY_ICONS[isMcp ? 'mcp' : category] || '🔗';
  const typeBadge = TYPE_BADGE[connection.connection_type] || {
    label: connection.connection_type,
    color: '#a1a1aa',
    bg: 'rgba(113,113,122,0.12)',
  };
  const dotCfg = STATUS_DOT[connection.status] || STATUS_DOT.configured;

  const handleTest = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', id: connection.id }),
      });
      const data: ConnectionHealthResult = await res.json();
      setTestResult(data);
      setTimeout(() => setTestResult(null), 4000);
    } catch {
      setTestResult({ id: connection.id, status: 'error', message: 'Request failed' });
      setTimeout(() => setTestResult(null), 4000);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      onClick={() => onOpenModal(connection, isMcp)}
      style={{
        background: 'rgba(12,26,46,0.8)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: 12,
        padding: '12px 12px 10px',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        transition: 'border-color 0.15s, background 0.15s',
        userSelect: 'none',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.14)';
        (e.currentTarget as HTMLDivElement).style.background = 'rgba(20,40,80,0.6)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.07)';
        (e.currentTarget as HTMLDivElement).style.background = 'rgba(12,26,46,0.8)';
      }}
    >
      {/* Top row: icon + status dot */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '1.2rem', lineHeight: 1 }}>{icon}</span>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: dotCfg.color,
            boxShadow: dotCfg.pulse ? `0 0 6px ${dotCfg.color}` : 'none',
            animation: dotCfg.pulse ? 'pulse 2s infinite' : 'none',
            flexShrink: 0,
          }}
        />
      </div>

      {/* Name */}
      <div style={{
        fontSize: '0.8rem',
        fontWeight: 600,
        color: '#e4e4e7',
        lineHeight: 1.2,
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
      }}>
        {connection.name}
      </div>

      {/* Type badge */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <span style={{
          fontSize: '0.62rem',
          fontWeight: 600,
          color: typeBadge.color,
          background: typeBadge.bg,
          border: `1px solid ${typeBadge.color}30`,
          borderRadius: 4,
          padding: '1px 5px',
          letterSpacing: '0.02em',
          lineHeight: 1.6,
        }}>
          {typeBadge.label}
        </span>
        {isMcp && (
          <span style={{
            fontSize: '0.62rem',
            fontWeight: 600,
            color: '#fbbf24',
            background: 'rgba(245,158,11,0.1)',
            border: '1px solid rgba(245,158,11,0.2)',
            borderRadius: 4,
            padding: '1px 5px',
            letterSpacing: '0.02em',
            lineHeight: 1.6,
          }}>
            MCP
          </span>
        )}
      </div>

      {/* Purpose */}
      <div style={{
        fontSize: '0.72rem',
        color: '#71717a',
        lineHeight: 1.4,
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        flex: 1,
      }}>
        {connection.purpose}
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '0 -2px' }} />

      {/* Test button + result */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          onClick={handleTest}
          disabled={testing}
          style={{
            fontSize: '0.68rem',
            fontWeight: 600,
            color: testing ? '#52525b' : '#71717a',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 4,
            padding: '3px 8px',
            cursor: testing ? 'not-allowed' : 'pointer',
            transition: 'all 0.15s',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flexShrink: 0,
          }}
          onMouseEnter={e => {
            if (!testing) {
              (e.currentTarget as HTMLButtonElement).style.color = '#e4e4e7';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.12)';
            }
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.color = '#71717a';
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.06)';
          }}
        >
          {testing ? (
            <span style={{ display: 'inline-block', width: 8, height: 8, border: '1.5px solid #52525b', borderTopColor: '#a1a1aa', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
          ) : (
            '▶'
          )}
          Test
        </button>

        {testResult && (
          <span style={{
            fontSize: '0.68rem',
            fontWeight: 500,
            color: testResult.status === 'ok' ? '#22c55e' : testResult.status === 'error' ? '#ef4444' : '#71717a',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {testResult.status === 'ok' ? '✓' : testResult.status === 'error' ? '✗' : '?'}{' '}
            {testResult.message}
          </span>
        )}
      </div>
    </div>
  );
}
