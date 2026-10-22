'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronLeft, ChevronRight, Plus, Trash2, Search, RefreshCw, Check, X, ChevronDown, TableProperties } from 'lucide-react';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  isPrimary?: boolean;
}

interface TableInfo {
  name: string;
  rowCount?: number;
}

type RowData = Record<string, unknown>;

interface EditCell { rowIndex: number; col: string; value: string; }

interface Props { instanceId: string; initialTable?: string; }

const PAGE_SIZE = 50;

// ─── SQL safety helpers ────────────────────────────────────────────────────────

/** Double-quote a Postgres identifier and escape any internal double quotes */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Defense-in-depth: reject identifiers that look malformed */
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

function isValidIdent(name: string): boolean {
  return IDENT_RE.test(name);
}

// ─── Type badge ────────────────────────────────────────────────────────────────

const TYPE_CLS: Record<string, string> = {
  int: 'int', bigint: 'int', smallint: 'int', serial: 'int', bigserial: 'int',
  text: 'txt', varchar: 'txt', char: 'txt', citext: 'txt', name: 'txt',
  boolean: 'bool', bool: 'bool',
  timestamp: 'date', timestamptz: 'date', date: 'date', time: 'date', timetz: 'date',
  uuid: 'uuid',
  jsonb: 'json', json: 'json',
  float4: 'num', float8: 'num', numeric: 'num', decimal: 'num', real: 'num', 'double precision': 'num',
};

function TypeBadge({ type }: { type: string }) {
  const base = (type || 'unknown').replace(/\(.*\)/, '').toLowerCase().trim();
  const cls = TYPE_CLS[base] ?? 'oth';
  const label = base.length > 7 ? base.slice(0, 6) + '…' : base;
  return <span className={`tdb-type tdb-type--${cls}`}>{label}</span>;
}

// ─── Cell renderer ─────────────────────────────────────────────────────────────

function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="tdb-null">NULL</span>;
  if (typeof value === 'boolean') return <span className={`tdb-bool${value ? ' tdb-bool--t' : ' tdb-bool--f'}`}>{String(value)}</span>;
  const s = String(value);
  return s.length > 72
    ? <span className="tdb-trunc" title={s}>{s.slice(0, 69)}…</span>
    : <>{s}</>;
}

// ─── Table List Sidebar ────────────────────────────────────────────────────────

function TableList({
  tables,
  active,
  onSelect,
  loading,
}: {
  tables: TableInfo[];
  active: string;
  onSelect: (name: string) => void;
  loading: boolean;
}) {
  const [search, setSearch] = useState('');
  const filtered = search
    ? tables.filter(t => t.name.toLowerCase().includes(search.toLowerCase()))
    : tables;

  return (
    <aside className="tdb-sidebar">
      <div className="tdb-sidebar-header">
        <TableProperties size={12} className="tdb-sidebar-icon" />
        <span className="tdb-sidebar-title">TABLES</span>
        <span className="tdb-sidebar-count">{tables.length}</span>
      </div>
      <div className="tdb-sidebar-search-wrap">
        <Search size={10} className="tdb-sidebar-search-icon" />
        <input
          className="tdb-sidebar-search"
          placeholder="Filter tables…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>
      <div className="tdb-sidebar-list">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="tdb-sidebar-skel" style={{ width: `${55 + (i * 17) % 35}%`, animationDelay: `${i * 60}ms` }} />
          ))
        ) : filtered.length === 0 ? (
          <div className="tdb-sidebar-empty">No tables</div>
        ) : (
          filtered.map(t => (
            <button
              key={t.name}
              className={`tdb-table-btn${t.name === active ? ' tdb-table-btn--active' : ''}`}
              onClick={() => onSelect(t.name)}
            >
              <span className="tdb-table-btn-name">{t.name}</span>
              {t.rowCount !== undefined && (
                <span className="tdb-table-btn-count">{t.rowCount.toLocaleString()}</span>
              )}
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export function TableDataBrowser({ instanceId, initialTable }: Props) {
  const [tables, setTables]         = useState<TableInfo[]>([]);
  const [tablesLoading, setTL]      = useState(true);
  const [activeTable, setActive]    = useState(initialTable ?? '');
  const [columns, setColumns]       = useState<ColumnDef[]>([]);
  const [rows, setRows]             = useState<RowData[]>([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [search, setSearch]         = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [dataLoading, setDL]        = useState(false);
  const [editCell, setEdit]         = useState<EditCell | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [addingRow, setAdding]      = useState(false);
  const [newRow, setNewRow]         = useState<Record<string, string>>({});
  const [deleteConfirmIdx, setDeleteConfirmIdx] = useState<number | null>(null);

  // Load table list
  useEffect(() => {
    if (!instanceId) return;
    setTL(true);
    fetch(`/api/supabase/introspect?instanceId=${instanceId}&type=tables`)
      .then(r => r.json())
      .then(d => {
        const list: TableInfo[] = (d.tables ?? []).map((t: { name: string; rowCount?: number }) => ({
          name: t.name,
          rowCount: t.rowCount,
        }));
        setTables(list);
        if (!activeTable && list.length > 0) setActive(list[0].name);
      })
      .catch(() => {})
      .finally(() => setTL(false));
  }, [instanceId]);

  // Load columns for active table
  useEffect(() => {
    if (!activeTable || !instanceId) return;
    fetch(`/api/supabase/introspect?instanceId=${instanceId}&type=columns&table=${encodeURIComponent(activeTable)}`)
      .then(r => r.json())
      .then(d => setColumns(d.columns ?? []))
      .catch(() => {});
  }, [activeTable, instanceId]);

  // Load rows
  const loadRows = useCallback(async (table: string, pg: number, srch: string) => {
    if (!table || !instanceId) return;
    if (!isValidIdent(table)) { setError(`Invalid table name: ${table}`); return; }
    setDL(true);
    setError(null);
    try {
      const offset = (pg - 1) * PAGE_SIZE;
      const searchParams = srch ? [`%${srch}%`] : [];
      const whereClause = srch ? ` WHERE ${quoteIdent(table)}::text ILIKE $1` : '';
      const [dataRes, countRes] = await Promise.allSettled([
        fetch('/api/supabase/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instanceId,
            sql: `SELECT * FROM ${quoteIdent(table)}${whereClause} LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
            params: searchParams,
          }),
        }),
        fetch('/api/supabase/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instanceId,
            sql: `SELECT COUNT(*)::int AS n FROM ${quoteIdent(table)}${whereClause}`,
            params: searchParams,
          }),
        }),
      ]);
      if (dataRes.status === 'fulfilled' && dataRes.value.ok) {
        const d = await dataRes.value.json();
        d.success ? setRows(d.rows ?? []) : setError(d.error ?? 'Query error');
      }
      if (countRes.status === 'fulfilled' && countRes.value.ok) {
        const d = await countRes.value.json();
        if (d.success) setTotal(Number(d.rows?.[0]?.n ?? 0));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally { setDL(false); }
  }, [instanceId]);

  // Debounce search input — 300ms delay before firing queries
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => { if (activeTable) loadRows(activeTable, page, debouncedSearch); }, [activeTable, page, debouncedSearch, loadRows]);

  const pkCol = columns.find(c => c.isPrimary);

  // Save inline edit
  const saveEdit = useCallback(async () => {
    if (!editCell || !pkCol) { setEdit(null); return; }
    if (!isValidIdent(activeTable) || !isValidIdent(editCell.col) || !isValidIdent(pkCol.name)) {
      setEdit(null);
      return;
    }
    const row = rows[editCell.rowIndex];
    const pkVal = row[pkCol.name];
    try {
      const res = await fetch('/api/supabase/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId,
          sql: `UPDATE ${quoteIdent(activeTable)} SET ${quoteIdent(editCell.col)} = $1 WHERE ${quoteIdent(pkCol.name)} = $2 RETURNING *`,
          params: [editCell.value, pkVal],
        }),
      });
      const d = await res.json();
      if (d.success && d.rows?.[0]) {
        setRows(prev => prev.map((r, i) => i === editCell.rowIndex ? d.rows[0] : r));
      }
    } catch { /* silent */ }
    setEdit(null);
  }, [editCell, rows, pkCol, activeTable, instanceId]);

  // Delete row
  const deleteRow = useCallback(async (row: RowData, rowIndex: number) => {
    if (!pkCol) return;
    if (!isValidIdent(activeTable) || !isValidIdent(pkCol.name)) return;
    const pkVal = row[pkCol.name];
    try {
      const res = await fetch('/api/supabase/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId,
          sql: `DELETE FROM ${quoteIdent(activeTable)} WHERE ${quoteIdent(pkCol.name)} = $1`,
          params: [pkVal],
        }),
      });
      const d = await res.json();
      if (d.success) {
        setRows(prev => prev.filter((_, i) => i !== rowIndex));
        setTotal(t => t - 1);
      }
    } catch { /* silent */ }
  }, [pkCol, activeTable, instanceId]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = (page - 1) * PAGE_SIZE + 1;
  const rangeEnd   = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="tdb-panel">
      <TableList
        tables={tables}
        active={activeTable}
        onSelect={t => { setActive(t); setPage(1); setSearch(''); setDebouncedSearch(''); setEdit(null); setDeleteConfirmIdx(null); }}
        loading={tablesLoading}
      />

      <div className="tdb-main">
        {/* Toolbar */}
        <div className="tdb-bar">
          <div className="tdb-search-wrap">
            <Search size={11} className="tdb-search-icon" />
            <input
              className="tdb-search"
              placeholder="Search rows…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
            />
            {search && (
              <button className="tdb-search-clear" onClick={() => setSearch('')} aria-label="Clear search">
                <X size={10} />
              </button>
            )}
          </div>

          <div className="tdb-bar-right">
            {activeTable && (
              <button
                className="tdb-add-btn"
                onClick={() => {
                  setAdding(a => !a);
                  setNewRow({});
                }}
              >
                <Plus size={11} />
                Add Row
              </button>
            )}
            <button
              className="tdb-refresh-btn"
              onClick={() => loadRows(activeTable, page, search)}
              disabled={dataLoading}
              aria-label="Refresh"
            >
              <RefreshCw size={11} className={dataLoading ? 'tdb-spin' : ''} />
            </button>
            <span className="tdb-page-info">
              {total > 0 ? `${rangeStart}–${rangeEnd} of ${total.toLocaleString()}` : '0 rows'}
            </span>
            <button
              className="tdb-page-btn"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              aria-label="Previous page"
            >
              <ChevronLeft size={12} />
            </button>
            <button
              className="tdb-page-btn"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              aria-label="Next page"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        </div>

        {/* Add row form */}
        {addingRow && columns.length > 0 && (
          <div className="tdb-add-row">
            <div className="tdb-add-row-fields">
              {columns.filter(c => !c.isPrimary).map(col => (
                <label key={col.name} className="tdb-add-field">
                  <span className="tdb-add-label">{col.name}</span>
                  <input
                    className="tdb-add-input"
                    placeholder={col.nullable ? 'NULL' : col.type}
                    value={newRow[col.name] ?? ''}
                    onChange={e => setNewRow(r => ({ ...r, [col.name]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
            <div className="tdb-add-actions">
              <button
                className="tdb-add-save"
                onClick={async () => {
                  const cols = Object.keys(newRow).filter(k => newRow[k] !== '');
                  if (cols.length === 0) { setAdding(false); return; }
                  if (!isValidIdent(activeTable) || cols.some(c => !isValidIdent(c))) {
                    setAdding(false);
                    return;
                  }
                  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
                  try {
                    const res = await fetch('/api/supabase/query', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        instanceId,
                        sql: `INSERT INTO ${quoteIdent(activeTable)} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders}) RETURNING *`,
                        params: cols.map(k => newRow[k] || null),
                      }),
                    });
                    const d = await res.json();
                    if (d.success && d.rows?.[0]) {
                      setRows(prev => [d.rows[0], ...prev]);
                      setTotal(t => t + 1);
                    }
                  } catch { /* silent */ }
                  setAdding(false);
                  setNewRow({});
                }}
              >
                <Check size={11} /> Insert
              </button>
              <button className="tdb-add-cancel" onClick={() => { setAdding(false); setNewRow({}); }}>
                <X size={11} /> Cancel
              </button>
            </div>
          </div>
        )}

        {/* Grid */}
        <div className="tdb-grid-wrap">
          {error ? (
            <div className="tdb-err">{error}</div>
          ) : !activeTable ? (
            <div className="tdb-placeholder">
              <TableProperties size={28} className="tdb-placeholder-icon" />
              <p>Select a table to browse data</p>
            </div>
          ) : dataLoading && rows.length === 0 ? (
            <div className="tdb-grid-loading">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="tdb-grid-skel-row" style={{ animationDelay: `${i * 40}ms` }}>
                  {Array.from({ length: Math.min(columns.length || 4, 6) }).map((__, j) => (
                    <div key={j} className="tdb-grid-skel-cell" style={{ width: `${60 + (j * 23) % 80}px` }} />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <table className="tdb-grid">
              <thead className="tdb-grid-head">
                <tr>
                  {columns.map(col => (
                    <th key={col.name} className="tdb-th">
                      <div className="tdb-th-inner">
                        <span className="tdb-col-name">{col.name}</span>
                        <TypeBadge type={col.type} />
                        {col.isPrimary && <span className="tdb-pk-badge">PK</span>}
                        {!col.nullable && <span className="tdb-nn-badge" title="NOT NULL">!</span>}
                      </div>
                    </th>
                  ))}
                  <th className="tdb-th tdb-th-del" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri} className="tdb-row">
                    {columns.map(col => {
                      const isEditing = editCell?.rowIndex === ri && editCell?.col === col.name;
                      return (
                        <td
                          key={col.name}
                          className={`tdb-cell${isEditing ? ' tdb-cell--edit' : ''}${col.isPrimary ? ' tdb-cell--pk' : ''}`}
                          onClick={() => {
                            if (!col.isPrimary && !isEditing) {
                              setEdit({ rowIndex: ri, col: col.name, value: row[col.name] == null ? '' : String(row[col.name]) });
                            }
                          }}
                        >
                          {isEditing ? (
                            <div className="tdb-edit">
                              <input
                                className="tdb-edit-inp"
                                value={editCell!.value}
                                onChange={e => setEdit({ ...editCell!, value: e.target.value })}
                                onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEdit(null); }}
                                autoFocus
                              />
                              <button className="tdb-edit-ok" onClick={saveEdit} aria-label="Save"><Check size={9} /></button>
                              <button className="tdb-edit-x" onClick={() => setEdit(null)} aria-label="Cancel"><X size={9} /></button>
                            </div>
                          ) : (
                            <Cell value={row[col.name]} />
                          )}
                        </td>
                      );
                    })}
                    <td className="tdb-cell tdb-cell-del">
                      {deleteConfirmIdx === ri ? (
                        <div className="tdb-del-confirm">
                          <button
                            className="tdb-del-confirm__yes"
                            onClick={() => { deleteRow(row, ri); setDeleteConfirmIdx(null); }}
                            aria-label="Confirm delete"
                          >
                            <Check size={9} />
                          </button>
                          <button
                            className="tdb-del-confirm__no"
                            onClick={() => setDeleteConfirmIdx(null)}
                            aria-label="Cancel delete"
                          >
                            <X size={9} />
                          </button>
                        </div>
                      ) : (
                        <button
                          className="tdb-del"
                          onClick={() => setDeleteConfirmIdx(ri)}
                          aria-label="Delete row"
                          title="Delete row"
                        >
                          <Trash2 size={10} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && !dataLoading && (
                  <tr>
                    <td colSpan={columns.length + 1} className="tdb-cell tdb-empty-cell">
                      {search ? 'No rows match your search' : 'This table is empty'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
