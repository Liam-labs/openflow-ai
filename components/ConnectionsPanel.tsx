'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Connection, McpServerEntry, ConnectionsData } from '@/lib/types';
import { ConnectionCard } from './ConnectionCard';
import { ConnectionDetailModal } from './modals/ConnectionDetailModal';

// ─── Category filter pills ────────────────────────────────────────────────────

const ALL_CATEGORIES = [
  'ai', 'infrastructure', 'database', 'google', 'seo',
  'media', 'payments', 'ecommerce', 'automation', 'design',
  'creative', 'email', 'security', 'productivity', 'backup',
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  ai: 'AI', infrastructure: 'Infra', database: 'DB', google: 'Google',
  seo: 'SEO', media: 'Media', payments: 'Payments', ecommerce: 'E-comm',
  automation: 'Auto', design: 'Design', creative: 'Creative', email: 'Email',
  security: 'Security', productivity: 'Productivity', backup: 'Backup',
};

// ─── Component ────────────────────────────────────────────────────────────────

export function ConnectionsPanel() {
  const [data, setData] = useState<ConnectionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [modalState, setModalState] = useState<{
    connection: Connection | McpServerEntry;
    isMcp: boolean;
  } | null>(null);

  useEffect(() => {
    fetch('/api/connections')
      .then(r => r.json() as Promise<ConnectionsData>)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const openModal = useCallback((connection: Connection | McpServerEntry, isMcp: boolean) => {
    setModalState({ connection, isMcp });
  }, []);

  const closeModal = useCallback(() => setModalState(null), []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', color: '#71717a', fontSize: '0.8rem' }}>
        Loading connections…
      </div>
    );
  }

  if (!data) return null;

  const connections = data.connections ?? [];
  const mcpServers = data.mcp_servers ?? [];

  // Determine which categories are present
  const presentCategories = ALL_CATEGORIES.filter(c => connections.some(conn => conn.category === c));

  // Filter connections
  const filtered = filter === 'all' ? connections : connections.filter(c => c.category === filter);

  // Summary counts
  const activeCount = connections.filter(c => c.status === 'active').length;
  const configuredCount = connections.filter(c => c.status === 'configured').length;

  return (
    <>
      <div>
        {/* Summary row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px 0', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.72rem', color: '#71717a' }}>
            <span style={{ color: '#22c55e', fontWeight: 600 }}>{activeCount}</span> active
            {' · '}
            <span style={{ color: '#eab308', fontWeight: 600 }}>{configuredCount}</span> configured
            {' · '}
            <span style={{ color: '#fbbf24', fontWeight: 600 }}>{mcpServers.length}</span> MCP
          </span>
        </div>

        {/* Filter pills */}
        <div style={{ display: 'flex', gap: 4, padding: '8px 16px', overflowX: 'auto', flexWrap: 'nowrap' }}>
          {(['all', ...presentCategories] as string[]).map(cat => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              style={{
                fontSize: '0.68rem',
                fontWeight: 600,
                color: filter === cat ? '#e4e4e7' : '#71717a',
                background: filter === cat ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${filter === cat ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.06)'}`,
                borderRadius: 4,
                padding: '3px 8px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                transition: 'all 0.1s',
              }}
            >
              {cat === 'all' ? 'All' : (CATEGORY_LABELS[cat] ?? cat)}
            </button>
          ))}
        </div>

        {/* Connections grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 8,
          padding: '4px 16px 16px',
        }}>
          {filtered.map(conn => (
            <ConnectionCard
              key={conn.id}
              connection={conn}
              isMcp={false}
              onOpenModal={openModal}
            />
          ))}
        </div>

        {/* MCP sub-section */}
        {mcpServers.length > 0 && (
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', margin: '0 16px' }}>
            <button
              onClick={() => setMcpExpanded(p => !p)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '10px 0',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: '#71717a',
                fontSize: '0.78rem',
                fontWeight: 600,
                textAlign: 'left',
              }}
            >
              <span style={{ marginLeft: 'auto' /* push toggle icon right */, display: 'none' }} />
              <span>🔌 MCP Servers ({mcpServers.length})</span>
              <span style={{ marginLeft: 'auto', fontSize: '0.8rem', transition: 'transform 0.15s', transform: mcpExpanded ? 'rotate(180deg)' : 'none' }}>
                ▾
              </span>
            </button>
            {mcpExpanded && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 8,
                paddingBottom: 16,
              }}>
                {mcpServers.map(mcp => (
                  <ConnectionCard
                    key={mcp.id}
                    connection={mcp}
                    isMcp
                    onOpenModal={openModal}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {modalState && (
        <ConnectionDetailModal
          connection={modalState.connection}
          isMcp={modalState.isMcp}
          onClose={closeModal}
        />
      )}
    </>
  );
}
