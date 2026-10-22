'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SortDirection = 'asc' | 'desc';

export interface ColumnDef<T> {
  key: string;
  header: string;
  width?: string;
  sortable?: boolean;
  render?: (row: T) => React.ReactNode;
  getValue?: (row: T) => string | number;
  align?: 'left' | 'center' | 'right';
}

export interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  data: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  pageSize?: number;
  initialSort?: { key: string; direction: SortDirection };
  emptyMessage?: string;
  className?: string;
  /** Override footer — e.g. for section-level actions */
  footer?: React.ReactNode;
}

export type StatusVariant = 'online' | 'stopped' | 'errored' | 'warning' | 'launching' | 'pending' | 'unknown' | 'active' | 'configured';

export interface StatusBadgeProps {
  status: StatusVariant | string;
  label?: string;
}

// ─── StatusBadge ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { color: string; dot: string; bg: string; border: string }> = {
  online:     { color: '#22c55e', dot: '#22c55e', bg: 'rgba(34,197,94,0.10)',  border: 'rgba(34,197,94,0.25)'  },
  active:     { color: '#22c55e', dot: '#22c55e', bg: 'rgba(34,197,94,0.10)',  border: 'rgba(34,197,94,0.25)'  },
  stopped:    { color: '#71717a', dot: '#71717a', bg: 'rgba(113,113,122,0.10)',border: 'rgba(113,113,122,0.25)' },
  errored:    { color: '#ef4444', dot: '#ef4444', bg: 'rgba(239,68,68,0.10)',  border: 'rgba(239,68,68,0.25)'  },
  error:      { color: '#ef4444', dot: '#ef4444', bg: 'rgba(239,68,68,0.10)',  border: 'rgba(239,68,68,0.25)'  },
  warning:    { color: '#eab308', dot: '#eab308', bg: 'rgba(234,179,8,0.10)',  border: 'rgba(234,179,8,0.25)'  },
  launching:  { color: '#3b82f6', dot: '#3b82f6', bg: 'rgba(59,130,246,0.10)', border: 'rgba(59,130,246,0.25)' },
  pending:    { color: '#3b82f6', dot: '#3b82f6', bg: 'rgba(59,130,246,0.10)', border: 'rgba(59,130,246,0.25)' },
  configured: { color: '#eab308', dot: '#eab308', bg: 'rgba(234,179,8,0.10)',  border: 'rgba(234,179,8,0.25)'  },
  connected:  { color: '#22c55e', dot: '#22c55e', bg: 'rgba(34,197,94,0.10)',  border: 'rgba(34,197,94,0.25)'  },
  unknown:    { color: '#71717a', dot: '#71717a', bg: 'rgba(113,113,122,0.10)',border: 'rgba(113,113,122,0.25)' },
};

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.unknown;
  const display = label ?? status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className="dt-status-badge" style={{
      '--badge-color': cfg.color,
      '--badge-bg': cfg.bg,
      '--badge-border': cfg.border,
      '--badge-dot': cfg.dot,
    } as React.CSSProperties}>
      <span className="dt-status-badge__dot" aria-hidden="true" />
      {display}
    </span>
  );
}

// ─── MetricCard ───────────────────────────────────────────────────────────────

export interface MetricCardProps {
  label: string;
  value: string | number;
  sub?: string;
  variant?: 'default' | 'success' | 'error' | 'warning' | 'info';
  icon?: React.ReactNode;
}

const METRIC_ACCENT: Record<string, string> = {
  default: '#3b82f6',
  success: '#22c55e',
  error:   '#ef4444',
  warning: '#eab308',
  info:    '#06b6d4',
};

export function MetricCard({ label, value, sub, variant = 'default', icon }: MetricCardProps) {
  const accent = METRIC_ACCENT[variant];
  return (
    <div className="dt-metric-card" style={{ '--metric-accent': accent } as React.CSSProperties}>
      <div className="dt-metric-card__header">
        {icon && <span className="dt-metric-card__icon" aria-hidden="true">{icon}</span>}
        <span className="dt-metric-card__label">{label}</span>
      </div>
      <div className="dt-metric-card__value">{value}</div>
      {sub && <div className="dt-metric-card__sub">{sub}</div>}
    </div>
  );
}

// ─── DataTable ────────────────────────────────────────────────────────────────

export function DataTable<T>({
  columns,
  data,
  rowKey,
  onRowClick,
  pageSize = 20,
  initialSort,
  emptyMessage = 'No data available.',
  className = '',
  footer,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(initialSort?.key ?? null);
  const [sortDir, setSortDir] = useState<SortDirection>(initialSort?.direction ?? 'asc');
  const [page, setPage] = useState(0);

  const handleSort = useCallback((key: string) => {
    setSortKey(prev => {
      if (prev === key) {
        setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        return key;
      }
      setSortDir('asc');
      return key;
    });
    setPage(0);
  }, []);

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    const col = columns.find(c => c.key === sortKey);
    return [...data].sort((a, b) => {
      const av = col?.getValue ? col.getValue(a) : (a as Record<string, unknown>)[sortKey];
      const bv = col?.getValue ? col.getValue(b) : (b as Record<string, unknown>)[sortKey];
      const cmp = String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir, columns]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const clampedPage = Math.min(page, totalPages - 1);
  const visible = sorted.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize);

  return (
    <div className={`dt-table-wrap ${className}`}>
      <div className="dt-table-scroll">
        <table className="dt-table" role="grid">
          <thead>
            <tr className="dt-table__header-row">
              {columns.map(col => (
                <th
                  key={col.key}
                  className={`dt-table__th dt-table__th--${col.align ?? 'left'}${col.sortable ? ' dt-table__th--sortable' : ''}`}
                  style={col.width ? { width: col.width } : undefined}
                  onClick={col.sortable ? () => handleSort(col.key) : undefined}
                  aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <span className="dt-table__th-inner">
                    {col.header}
                    {col.sortable && (
                      <span className="dt-table__sort-icon" aria-hidden="true">
                        {sortKey === col.key
                          ? sortDir === 'asc'
                            ? <ChevronUp size={12} />
                            : <ChevronDown size={12} />
                          : <ChevronsUpDown size={12} />}
                      </span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="dt-table__empty">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              visible.map((row, i) => (
                <tr
                  key={rowKey(row)}
                  className={`dt-table__row${onRowClick ? ' dt-table__row--clickable' : ''}${i % 2 === 1 ? ' dt-table__row--alt' : ''}`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onRowClick(row); } : undefined}
                  role={onRowClick ? 'button' : undefined}
                >
                  {columns.map(col => (
                    <td
                      key={col.key}
                      className={`dt-table__td dt-table__td--${col.align ?? 'left'}`}
                    >
                      {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="dt-pagination" role="navigation" aria-label="Table pagination">
          <span className="dt-pagination__info">
            {clampedPage * pageSize + 1}–{Math.min((clampedPage + 1) * pageSize, sorted.length)} of {sorted.length}
          </span>
          <div className="dt-pagination__controls">
            <button
              className="dt-pagination__btn"
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={clampedPage === 0}
              aria-label="Previous page"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="dt-pagination__page">{clampedPage + 1} / {totalPages}</span>
            <button
              className="dt-pagination__btn"
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={clampedPage >= totalPages - 1}
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}

      {footer && <div className="dt-table__footer">{footer}</div>}
    </div>
  );
}
