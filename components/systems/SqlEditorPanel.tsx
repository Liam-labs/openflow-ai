'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Play, Clock, History, Trash2, ChevronDown, X } from 'lucide-react';

// ─── SQL Tokenizer ─────────────────────────────────────────────────────────────

const SQL_KEYWORDS = new Set([
  'SELECT','FROM','WHERE','INSERT','INTO','UPDATE','DELETE','DROP','CREATE','TABLE',
  'ALTER','INDEX','AS','ON','JOIN','LEFT','RIGHT','INNER','OUTER','FULL','CROSS',
  'UNION','ALL','EXISTS','IN','NOT','AND','OR','IS','NULL','TRUE','FALSE','LIMIT',
  'OFFSET','ORDER','BY','GROUP','HAVING','SET','VALUES','DEFAULT','RETURNING','WITH',
  'CASE','WHEN','THEN','ELSE','END','BEGIN','COMMIT','ROLLBACK','TRANSACTION',
  'CONSTRAINT','PRIMARY','KEY','FOREIGN','REFERENCES','CASCADE','UNIQUE','CHECK',
  'DISTINCT','USING','LIKE','ILIKE','BETWEEN','OVER','PARTITION','SCHEMA','DATABASE',
  'EXTENSION','FUNCTION','PROCEDURE','TRIGGER','VIEW','MATERIALIZED','REFRESH',
  'EXPLAIN','ANALYZE','VERBOSE','GRANT','REVOKE','TO','PUBLIC','ROLE','USER',
  'SUPERUSER','INTEGER','TEXT','BOOLEAN','TIMESTAMP','TIMESTAMPTZ','DATE','TIME',
  'UUID','JSONB','JSON','BIGINT','SMALLINT','FLOAT','DOUBLE','DECIMAL','NUMERIC',
  'SERIAL','BIGSERIAL','RETURNS','LANGUAGE','DECLARE','RAISE','NOTICE','EXCEPTION',
  'IF','ELSIF','LOOP','WHILE','FOR','EACH','ROW','BEFORE','AFTER','INSTEAD','OF',
  'EXECUTE','PERFORM','RETURN','QUERY','DO','COALESCE','NULLIF',
]);

type TT = 'keyword' | 'fn' | 'str' | 'num' | 'cmt' | 'op' | 'plain';

interface Token { t: TT; v: string; }

function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    // -- comment
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const v = end === -1 ? sql.slice(i) : sql.slice(i, end);
      out.push({ t: 'cmt', v }); i += v.length; continue;
    }
    // /* block comment */
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const v = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
      out.push({ t: 'cmt', v }); i += v.length; continue;
    }
    // $$ dollar-quote
    if (sql[i] === '$' && sql[i + 1] === '$') {
      const end = sql.indexOf('$$', i + 2);
      const v = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
      out.push({ t: 'str', v }); i += v.length; continue;
    }
    // single-quote string
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === "'" && sql[j - 1] !== '\\') { j++; break; } j++; }
      out.push({ t: 'str', v: sql.slice(i, j) }); i = j; continue;
    }
    // number
    if (/[0-9]/.test(sql[i]) || (sql[i] === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i;
      while (j < sql.length && /[0-9.eExX_]/.test(sql[j])) j++;
      out.push({ t: 'num', v: sql.slice(i, j) }); i = j; continue;
    }
    // identifier / keyword
    if (/[a-zA-Z_]/.test(sql[i])) {
      let j = i;
      while (j < sql.length && /[a-zA-Z0-9_$]/.test(sql[j])) j++;
      const w = sql.slice(i, j);
      const rest = sql.slice(j).trimStart();
      const tt: TT = SQL_KEYWORDS.has(w.toUpperCase()) ? 'keyword' : rest[0] === '(' ? 'fn' : 'plain';
      out.push({ t: tt, v: w }); i = j; continue;
    }
    // operators
    if (/[=!<>+\-*/|&^~]/.test(sql[i])) {
      let j = i;
      while (j < sql.length && /[=!<>+\-*/|&^~]/.test(sql[j])) j++;
      out.push({ t: 'op', v: sql.slice(i, j) }); i = j; continue;
    }
    out.push({ t: 'plain', v: sql[i] }); i++;
  }
  return out;
}

function highlight(sql: string): string {
  return tokenize(sql).map(({ t, v }) => {
    const e = v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return t === 'plain' ? e : `<span class="sqe-${t}">${e}</span>`;
  }).join('');
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface QResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  error?: string;
}

interface HistEntry {
  sql: string;
  at: string;
  durationMs?: number;
  rowCount?: number;
  error?: string;
}

interface Props { instanceId: string; }

const HISTORY_CAP = 50;

function loadHistory(instanceId: string): HistEntry[] {
  try {
    const raw = localStorage.getItem(`sdb-sql-history-${instanceId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, HISTORY_CAP);
  } catch {
    return [];
  }
}

function saveHistory(instanceId: string, entries: HistEntry[]): void {
  try {
    localStorage.setItem(`sdb-sql-history-${instanceId}`, JSON.stringify(entries.slice(0, HISTORY_CAP)));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

// ─── Results Table ─────────────────────────────────────────────────────────────

function Results({ result }: { result: QResult }) {
  if (result.error) {
    return (
      <div className="sqe-error-box">
        <span className="sqe-error-label">ERROR</span>
        <span className="sqe-error-msg">{result.error}</span>
      </div>
    );
  }
  if (result.columns.length === 0) {
    return (
      <div className="sqe-ok-msg">
        Query executed. {result.rowCount > 0 ? `${result.rowCount} rows affected.` : 'No rows returned.'}
      </div>
    );
  }
  return (
    <div className="sqe-result-wrap">
      <div className="sqe-result-meta">
        <span className="sqe-result-count">{result.rowCount.toLocaleString()} rows</span>
        <span className="sqe-result-ms"><Clock size={10} />{result.durationMs}ms</span>
      </div>
      <div className="sqe-table-scroll">
        <table className="sqe-table">
          <thead>
            <tr>{result.columns.map(c => <th key={c} className="sqe-th">{c}</th>)}</tr>
          </thead>
          <tbody>
            {result.rows.map((row, ri) => (
              <tr key={ri} className="sqe-tr">
                {result.columns.map(c => (
                  <td key={c} className="sqe-td">
                    {row[c] === null
                      ? <span className="sqe-null">NULL</span>
                      : String(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── History Drawer ────────────────────────────────────────────────────────────

function HistoryDrawer({
  entries,
  onSelect,
  onClose,
  onClear,
}: {
  entries: HistEntry[];
  onSelect: (sql: string) => void;
  onClose: () => void;
  onClear: () => void;
}) {
  return (
    <div className="sqe-hist">
      <div className="sqe-hist-header">
        <span className="sqe-hist-title">Query History</span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {entries.length > 0 && (
            <button className="sqe-hist-close" onClick={onClear} aria-label="Clear history" title="Clear history">
              <Trash2 size={12} />
            </button>
          )}
          <button className="sqe-hist-close" onClick={onClose} aria-label="Close history"><X size={12} /></button>
        </div>
      </div>
      <div className="sqe-hist-list">
        {entries.length === 0
          ? <div className="sqe-hist-empty">No queries yet</div>
          : entries.map((h, i) => (
            <button key={i} className="sqe-hist-item" onClick={() => { onSelect(h.sql); onClose(); }}>
              <code className="sqe-hist-sql">{h.sql.replace(/\s+/g, ' ').slice(0, 80)}{h.sql.length > 80 ? '…' : ''}</code>
              <span className="sqe-hist-meta">
                {h.error
                  ? <span className="sqe-hist-err">error</span>
                  : <span className="sqe-hist-ok">{h.rowCount} rows · {h.durationMs}ms</span>
                }
              </span>
            </button>
          ))
        }
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export function SqlEditorPanel({ instanceId }: Props) {
  const [sql, setSql]           = useState('SELECT * FROM ');
  const [executing, setEx]      = useState(false);
  const [result, setResult]     = useState<QResult | null>(null);
  const [history, setHistory]   = useState<HistEntry[]>(() => loadHistory(instanceId));
  const [histOpen, setHistOpen] = useState(false);
  const taRef  = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  // Reload history when switching instances
  useEffect(() => {
    setHistory(loadHistory(instanceId));
  }, [instanceId]);

  const syncScroll = useCallback(() => {
    if (taRef.current && preRef.current) {
      preRef.current.scrollTop  = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  }, []);

  const execQuery = useCallback(async () => {
    const q = sql.trim();
    if (!q || executing) return;
    setEx(true);
    const t0 = Date.now();
    try {
      const res = await fetch('/api/supabase/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId, sql: q }),
      });
      const data = await res.json();
      const durationMs = Date.now() - t0;
      if (data.success) {
        const qr: QResult = {
          columns: data.columns ?? [],
          rows: data.rows ?? [],
          rowCount: data.rowCount ?? data.rows?.length ?? 0,
          durationMs,
        };
        setResult(qr);
        setHistory(p => {
          const next = [{ sql: q, at: new Date().toISOString(), durationMs, rowCount: qr.rowCount }, ...p].slice(0, HISTORY_CAP);
          saveHistory(instanceId, next);
          return next;
        });
      } else {
        const durationMs = Date.now() - t0;
        const qr: QResult = { columns: [], rows: [], rowCount: 0, durationMs, error: data.error ?? 'Query failed' };
        setResult(qr);
        setHistory(p => {
          const next = [{ sql: q, at: new Date().toISOString(), durationMs, error: data.error }, ...p].slice(0, HISTORY_CAP);
          saveHistory(instanceId, next);
          return next;
        });
      }
    } catch (err) {
      setResult({ columns: [], rows: [], rowCount: 0, durationMs: Date.now() - t0, error: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setEx(false);
    }
  }, [sql, instanceId, executing]);

  const handleKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = taRef.current!;
      const s = ta.selectionStart, end = ta.selectionEnd;
      const next = sql.slice(0, s) + '  ' + sql.slice(end);
      setSql(next);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) execQuery();
  }, [sql, execQuery]);

  return (
    <div className="sqe-panel">
      {/* Topbar */}
      <div className="sqe-topbar">
        <span className="sqe-topbar-title">SQL EDITOR</span>
        <div className="sqe-topbar-actions">
          <button
            className={`sqe-hist-btn${histOpen ? ' sqe-hist-btn--open' : ''}`}
            onClick={() => setHistOpen(o => !o)}
          >
            <History size={12} />
            History
            <ChevronDown size={9} className={histOpen ? 'sqe-chevron-open' : ''} />
          </button>
        </div>
      </div>

      {/* History drawer */}
      {histOpen && (
        <HistoryDrawer
          entries={history}
          onSelect={q => setSql(q)}
          onClose={() => setHistOpen(false)}
          onClear={() => { setHistory([]); saveHistory(instanceId, []); }}
        />
      )}

      {/* Editor */}
      <div className="sqe-editor-container">
        {/* Line numbers */}
        <div className="sqe-gutter" aria-hidden="true">
          {sql.split('\n').map((_, i) => (
            <div key={i} className="sqe-line-num">{i + 1}</div>
          ))}
        </div>

        {/* Editor body */}
        <div className="sqe-editor-body">
          <pre
            ref={preRef}
            className="sqe-pre"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: highlight(sql) + '\n' }}
          />
          <textarea
            ref={taRef}
            className="sqe-ta"
            value={sql}
            onChange={e => setSql(e.target.value)}
            onKeyDown={handleKey}
            onScroll={syncScroll}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="SQL query editor"
            placeholder="-- Write your query here&#10;SELECT * FROM ..."
          />
        </div>
      </div>

      {/* Toolbar */}
      <div className="sqe-toolbar">
        <button
          className={`sqe-exec-btn${executing ? ' sqe-exec-btn--running' : ''}`}
          onClick={execQuery}
          disabled={executing || !sql.trim()}
          aria-label="Execute query (Ctrl+Enter)"
        >
          <Play size={11} />
          {executing ? 'RUNNING…' : 'EXECUTE'}
        </button>
        <span className="sqe-hint">Ctrl+Enter</span>
        <div style={{ flex: 1 }} />
        {result && !result.error && (
          <span className="sqe-timing">
            <Clock size={10} />
            {result.durationMs}ms · {result.rowCount} rows
          </span>
        )}
        <button
          className="sqe-clear-btn"
          onClick={() => { setSql(''); setResult(null); taRef.current?.focus(); }}
          title="Clear"
          aria-label="Clear editor"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Results */}
      {result && (
        <div className="sqe-results-pane">
          <Results result={result} />
        </div>
      )}
    </div>
  );
}
