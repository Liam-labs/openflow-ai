/**
 * Schema-level diff for Supabase backup dumps.
 *
 * Parses CREATE TABLE blocks out of a `pg_dump`/`supabase db dump` output
 * and computes the added/removed/modified tables between two dumps.
 * Intentionally NOT a full Postgres parser — just enough to give the
 * backup diff viewer a useful structured payload (S3.3).
 */

export interface ParsedColumn {
  name: string;
  /** Canonical column definition — everything after the column name on its line, whitespace-normalized. */
  definition: string;
}

export interface ParsedTable {
  /** Fully-qualified name: `schema.name` (falls back to just `name` if unqualified). */
  name: string;
  /** Column definitions in declaration order. */
  columns: ParsedColumn[];
}

export interface ModifiedColumn {
  name: string;
  before: string;
  after: string;
}

export interface ModifiedTable {
  name: string;
  addedColumns: ParsedColumn[];
  removedColumns: ParsedColumn[];
  modifiedColumns: ModifiedColumn[];
}

export interface SchemaDiffResult {
  addedTables: ParsedTable[];
  removedTables: ParsedTable[];
  modifiedTables: ModifiedTable[];
}

/**
 * Extract all `CREATE TABLE` blocks from a SQL dump.
 *
 * Matches both `CREATE TABLE name (...)` and `CREATE TABLE IF NOT EXISTS schema.name (...)`.
 * Handles single-line and multi-line column lists. Column parsing stops at
 * the first constraint keyword (CONSTRAINT/PRIMARY/UNIQUE/FOREIGN/CHECK) to
 * keep the diff focused on columns — constraints are out of scope for a
 * quick viewer and reporting them would produce a lot of noise.
 */
export function parseCreateTables(sql: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  // Match: CREATE TABLE [IF NOT EXISTS] <name> ( <body> );
  // Non-greedy body to avoid swallowing the next CREATE TABLE.
  const tableRegex = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([\w."]+)\s*\(([\s\S]*?)\)\s*(?:WITH\s*\([^)]*\)\s*)?;/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRegex.exec(sql)) !== null) {
    const rawName = m[1].replace(/"/g, '');
    const name = rawName;
    const body = m[2];
    const columns = parseColumnList(body);
    tables.push({ name, columns });
  }
  return tables;
}

/**
 * Split a CREATE TABLE body into columns.
 * Respects balanced parentheses so `type(precision, scale)` or
 * `NUMERIC(10,2)` doesn't get split mid-declaration.
 */
function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

const CONSTRAINT_KEYWORDS = /^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|EXCLUDE|LIKE)\b/i;

function parseColumnList(body: string): ParsedColumn[] {
  const columns: ParsedColumn[] = [];
  for (const rawLine of splitTopLevelCommas(body)) {
    const line = rawLine.trim().replace(/\s+/g, ' ');
    if (!line) continue;
    // Skip constraint rows — column-only diff
    if (CONSTRAINT_KEYWORDS.test(line)) continue;
    // Column name is the first identifier (quoted or bare)
    const nameMatch = line.match(/^("([^"]+)"|[A-Za-z_][\w]*)\s+(.*)$/);
    if (!nameMatch) continue;
    const name = (nameMatch[2] || nameMatch[1]).trim();
    const definition = nameMatch[3].trim();
    if (!name || !definition) continue;
    columns.push({ name, definition });
  }
  return columns;
}

/**
 * Compute the schema diff between two parsed dumps.
 * Table identity is the fully-qualified name. Column identity is the
 * column name. Definition comparison is case-sensitive whitespace-normalized
 * string equality on the text after the column name.
 */
export function diffSchemas(before: ParsedTable[], after: ParsedTable[]): SchemaDiffResult {
  const beforeByName = new Map(before.map(t => [t.name, t]));
  const afterByName = new Map(after.map(t => [t.name, t]));

  const addedTables: ParsedTable[] = [];
  const removedTables: ParsedTable[] = [];
  const modifiedTables: ModifiedTable[] = [];

  for (const [name, tableAfter] of afterByName) {
    if (!beforeByName.has(name)) {
      addedTables.push(tableAfter);
    }
  }
  for (const [name, tableBefore] of beforeByName) {
    const tableAfter = afterByName.get(name);
    if (!tableAfter) {
      removedTables.push(tableBefore);
      continue;
    }
    const colDiff = diffColumns(tableBefore.columns, tableAfter.columns);
    if (
      colDiff.addedColumns.length > 0 ||
      colDiff.removedColumns.length > 0 ||
      colDiff.modifiedColumns.length > 0
    ) {
      modifiedTables.push({ name, ...colDiff });
    }
  }

  // Stable ordering for deterministic output
  addedTables.sort((a, b) => a.name.localeCompare(b.name));
  removedTables.sort((a, b) => a.name.localeCompare(b.name));
  modifiedTables.sort((a, b) => a.name.localeCompare(b.name));

  return { addedTables, removedTables, modifiedTables };
}

function diffColumns(
  before: ParsedColumn[],
  after: ParsedColumn[],
): { addedColumns: ParsedColumn[]; removedColumns: ParsedColumn[]; modifiedColumns: ModifiedColumn[] } {
  const beforeByName = new Map(before.map(c => [c.name, c]));
  const afterByName = new Map(after.map(c => [c.name, c]));

  const addedColumns: ParsedColumn[] = [];
  const removedColumns: ParsedColumn[] = [];
  const modifiedColumns: ModifiedColumn[] = [];

  for (const [name, colAfter] of afterByName) {
    const colBefore = beforeByName.get(name);
    if (!colBefore) {
      addedColumns.push(colAfter);
    } else if (colBefore.definition !== colAfter.definition) {
      modifiedColumns.push({
        name,
        before: colBefore.definition,
        after: colAfter.definition,
      });
    }
  }
  for (const [name, colBefore] of beforeByName) {
    if (!afterByName.has(name)) {
      removedColumns.push(colBefore);
    }
  }

  addedColumns.sort((a, b) => a.name.localeCompare(b.name));
  removedColumns.sort((a, b) => a.name.localeCompare(b.name));
  modifiedColumns.sort((a, b) => a.name.localeCompare(b.name));

  return { addedColumns, removedColumns, modifiedColumns };
}

/**
 * Top-level convenience: take two SQL strings, return the schema diff.
 */
export function diffSqlDumps(sqlBefore: string, sqlAfter: string): SchemaDiffResult {
  const before = parseCreateTables(sqlBefore);
  const after = parseCreateTables(sqlAfter);
  return diffSchemas(before, after);
}
