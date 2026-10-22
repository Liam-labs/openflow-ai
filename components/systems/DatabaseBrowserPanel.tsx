'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  Table2, ChevronRight, ChevronDown, RefreshCw,
  Search, Shield, AlertCircle, Loader2, RotateCcw,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DbTable {
  id: number;
  schema: string;
  name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  live_rows_estimate: number;
  size: string;
  comment: string | null;
}

interface DbColumn {
  id: string;
  name: string;
  ordinal_position: number;
  data_type: string;
  format: string;
  is_nullable: boolean;
  is_identity: boolean;
  is_unique: boolean;
  default_value: string | null;
  comment: string | null;
}

interface IntrospectTablesResponse {
  tables?: DbTable[];
  error?: string;
}

interface IntrospectColumnsResponse {
  columns?: DbColumn[];
  error?: string;
}

// Sentinel value for column fetch errors
const COLUMN_FETCH_ERROR = '__ERROR__';

export interface DatabaseBrowserPanelProps {
  instanceId: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Semantic color class by column type
const TYPE_CLASS_MAP: Record<string, string> = {
  uuid: 'sdb-db__type--uuid',
  text: 'sdb-db__type--text',
  varchar: 'sdb-db__type--text',
  'character varying': 'sdb-db__type--text',
  char: 'sdb-db__type--text',
  bpchar: 'sdb-db__type--text',
  int2: 'sdb-db__type--int',
  int4: 'sdb-db__type--int',
  int8: 'sdb-db__type--int',
  integer: 'sdb-db__type--int',
  bigint: 'sdb-db__type--int',
  smallint: 'sdb-db__type--int',
  numeric: 'sdb-db__type--int',
  float4: 'sdb-db__type--int',
  float8: 'sdb-db__type--int',
  bool: 'sdb-db__type--bool',
  boolean: 'sdb-db__type--bool',
  timestamptz: 'sdb-db__type--time',
  timestamp: 'sdb-db__type--time',
  'timestamp with time zone': 'sdb-db__type--time',
  'timestamp without time zone': 'sdb-db__type--time',
  date: 'sdb-db__type--time',
  time: 'sdb-db__type--time',
  timetz: 'sdb-db__type--time',
  jsonb: 'sdb-db__type--json',
  json: 'sdb-db__type--json',
};

function getTypeClass(format: string, dataType: string): string {
  const key = (format || dataType).toLowerCase();
  return TYPE_CLASS_MAP[key] || 'sdb-db__type--default';
}

function shortType(format: string, dataType: string): string {
  const display = format || dataType;
  const overrides: Record<string, string> = {
    'character varying': 'varchar',
    'timestamp with time zone': 'timestamptz',
    'timestamp without time zone': 'timestamp',
    'double precision': 'float8',
  };
  return overrides[display.toLowerCase()] || display;
}

function formatRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─── Column Row ───────────────────────────────────────────────────────────────

function ColumnRow({ col }: { col: DbColumn }) {
  const typeClass = getTypeClass(col.format, col.data_type);
  const typeLabel = shortType(col.format, col.data_type);

  return (
    <div className="sdb-db__col" role="row">
      <span className="sdb-db__col-order">{col.ordinal_position}</span>
      <span className="sdb-db__col-name">
        {col.name}
        {col.is_identity && (
          <span className="sdb-db__col-badge sdb-db__col-badge--pk" title="Primary Key / Identity">PK</span>
        )}
        {col.is_unique && !col.is_identity && (
          <span className="sdb-db__col-badge sdb-db__col-badge--uq" title="Unique constraint">UQ</span>
        )}
      </span>
      <span className={`sdb-db__type ${typeClass}`} title={col.data_type}>
        {typeLabel}
      </span>
      <span
        className={`sdb-db__nullable ${col.is_nullable ? 'sdb-db__nullable--yes' : 'sdb-db__nullable--no'}`}
        title={col.is_nullable ? 'nullable' : 'not null'}
      >
        {col.is_nullable ? 'null' : 'not null'}
      </span>
      {col.default_value && (
        <span className="sdb-db__col-default" title={col.default_value}>
          = {col.default_value.length > 22 ? col.default_value.slice(0, 20) + '…' : col.default_value}
        </span>
      )}
      {col.comment && (
        <span className="sdb-db__col-comment" title={col.comment}>
          {col.comment}
        </span>
      )}
    </div>
  );
}

// ─── Table Row ────────────────────────────────────────────────────────────────

function TableRow({
  table,
  expanded,
  columns,
  loadingCols,
  onToggle,
  onRetryColumns,
}: {
  table: DbTable;
  expanded: boolean;
  columns: DbColumn[] | typeof COLUMN_FETCH_ERROR | null;
  loadingCols: boolean;
  onToggle: () => void;
  onRetryColumns: () => void;
}) {
  return (
    <div
      className={`sdb-db__table${expanded ? ' sdb-db__table--expanded' : ''}`}
      role="treeitem"
      aria-expanded={expanded}
    >
      <button
        className="sdb-db__table-header"
        onClick={onToggle}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} table ${table.name}`}
      >
        <span className="sdb-db__table-chevron" aria-hidden="true">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>

        <span className="sdb-db__table-name">{table.name}</span>

        {table.schema !== 'public' && (
          <span className="sdb-db__table-schema" title={`Schema: ${table.schema}`}>
            {table.schema}
          </span>
        )}

        {table.rls_enabled && (
          <span className="sdb-db__table-rls" title={`RLS enabled${table.rls_forced ? ' (forced)' : ''}`}>
            <Shield size={10} />
          </span>
        )}

        <span className="sdb-db__table-spacer" aria-hidden="true" />

        <span className="sdb-db__table-rows" title="Estimated row count">
          {formatRows(table.live_rows_estimate)} rows
        </span>
        <span className="sdb-db__table-size" title="Table size on disk">
          {table.size}
        </span>
      </button>

      {expanded && (
        <div className="sdb-db__cols-list" role="group" aria-label={`Columns of ${table.name}`}>
          {loadingCols ? (
            <div className="sdb-db__cols-loading" aria-live="polite">
              <Loader2 size={12} className="sdb-db__spinner" aria-hidden="true" />
              <span>Loading columns…</span>
            </div>
          ) : columns === COLUMN_FETCH_ERROR ? (
            <div className="sdb-db__cols-empty sdb-db__cols-empty--error" role="alert">
              <AlertCircle size={11} aria-hidden="true" />
              <span>Failed to load columns</span>
              <button
                className="sdb-db__cols-retry"
                onClick={onRetryColumns}
                aria-label="Retry loading columns"
              >
                <RotateCcw size={10} aria-hidden="true" />
                Retry
              </button>
            </div>
          ) : columns && columns.length > 0 ? (
            <div role="rowgroup">
              <div className="sdb-db__col-header" role="row" aria-hidden="true">
                <span className="sdb-db__col-order">#</span>
                <span className="sdb-db__col-name">Name</span>
                <span>Type</span>
                <span>Nullability</span>
              </div>
              {columns.map(col => (
                <ColumnRow key={col.id} col={col} />
              ))}
            </div>
          ) : (
            <div className="sdb-db__cols-empty">No columns found</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function DatabaseBrowserPanel({ instanceId }: DatabaseBrowserPanelProps) {
  const [tables, setTables] = useState<DbTable[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedTables, setExpandedTables] = useState<Set<number>>(new Set());
  const [columns, setColumns] = useState<Map<number, DbColumn[] | typeof COLUMN_FETCH_ERROR>>(new Map());
  const [loadingCols, setLoadingCols] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');

  // ── Fetch table list ────────────────────────────────────────────────────────

  const fetchTables = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/supabase/introspect?instanceId=${encodeURIComponent(instanceId)}&type=tables`
      );
      const data: IntrospectTablesResponse = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setTables(data.tables ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tables');
      setTables(null);
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    fetchTables();
    // Reset state when instanceId changes
    setColumns(new Map());
    setExpandedTables(new Set());
    setSearch('');
  }, [fetchTables]);

  // ── Fetch column list ───────────────────────────────────────────────────────

  const fetchColumns = useCallback(async (tableId: number) => {
    setLoadingCols(prev => new Set(prev).add(tableId));
    try {
      const res = await fetch(
        `/api/supabase/introspect?instanceId=${encodeURIComponent(instanceId)}&type=columns&tableId=${tableId}`
      );
      const data: IntrospectColumnsResponse = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const sorted = (data.columns ?? []).sort(
        (a, b) => a.ordinal_position - b.ordinal_position
      );
      setColumns(prev => new Map(prev).set(tableId, sorted));
    } catch {
      setColumns(prev => new Map(prev).set(tableId, COLUMN_FETCH_ERROR));
    } finally {
      setLoadingCols(prev => {
        const next = new Set(prev);
        next.delete(tableId);
        return next;
      });
    }
  }, [instanceId]);

  // ── Toggle expand ───────────────────────────────────────────────────────────

  const toggleTable = useCallback((tableId: number) => {
    setExpandedTables(prev => {
      const next = new Set(prev);
      if (next.has(tableId)) {
        next.delete(tableId);
      } else {
        next.add(tableId);
        if (!columns.has(tableId)) {
          fetchColumns(tableId);
        }
      }
      return next;
    });
  }, [columns, fetchColumns]);

  // ── Refresh ─────────────────────────────────────────────────────────────────

  const handleRefresh = useCallback(() => {
    setColumns(new Map());
    setExpandedTables(new Set());
    fetchTables();
  }, [fetchTables]);

  // ── Filtered tables ─────────────────────────────────────────────────────────

  const filtered = tables
    ? tables.filter(t => {
        if (!search) return true;
        const q = search.toLowerCase();
        return t.name.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q);
      })
    : [];

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="sdb-db" role="tree" aria-label="Database tables">

      {/* Header */}
      <div className="sdb-db__header">
        <div className="sdb-db__header-left">
          <Table2 size={13} className="sdb-db__header-icon" aria-hidden="true" />
          <span className="sdb-db__header-title">Tables</span>
          {tables !== null && (
            <span className="sdb-db__header-count" aria-label={`${tables.length} tables`}>
              {tables.length}
            </span>
          )}
        </div>
        <button
          className="sdb-db__header-refresh"
          onClick={handleRefresh}
          disabled={loading}
          aria-label="Refresh tables"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? 'sdb-db__spinner' : ''} aria-hidden="true" />
        </button>
      </div>

      {/* Search */}
      {!loading && !error && (
        <div className="sdb-db__search">
          <Search size={11} aria-hidden="true" />
          <input
            className="sdb-db__search-input"
            type="search"
            placeholder="Filter by name or schema…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Filter tables"
          />
        </div>
      )}

      {/* Body */}
      <div className="sdb-db__body">
        {loading ? (
          <div className="sdb-db__state-row" aria-live="polite">
            <Loader2 size={13} className="sdb-db__spinner" aria-hidden="true" />
            <span>Loading tables…</span>
          </div>
        ) : error ? (
          <div className="sdb-db__state-row sdb-db__state-row--error" role="alert">
            <AlertCircle size={13} aria-hidden="true" />
            <span>{error}</span>
            <button
              className="sdb-db__retry-btn"
              onClick={handleRefresh}
              aria-label="Retry"
            >
              <RotateCcw size={11} aria-hidden="true" />
              Retry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="sdb-db__state-row">
            {search
              ? `No tables match "${search}"`
              : 'No tables found.'}
          </div>
        ) : (
          filtered.map(table => (
            <TableRow
              key={table.id}
              table={table}
              expanded={expandedTables.has(table.id)}
              columns={columns.get(table.id) ?? null}
              loadingCols={loadingCols.has(table.id)}
              onToggle={() => toggleTable(table.id)}
              onRetryColumns={() => fetchColumns(table.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
