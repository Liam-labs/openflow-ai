/**
 * CI guard tests for the structured-error sweep (audit task 276bc8cc, taxonomy §7.4).
 *
 * Two shape invariants that the sweep landed and must not regress:
 *   1. No bare `throw new Error(...)` in Computer Use surfaces — every thrown
 *      error must be a typed `ComputerUseError`.
 *   2. No code-less `{ success: false, ... }` response shape — every error
 *      response must carry a `code:` field.
 *
 * Files in lib/computer-use*.ts are owned by another agent — guarded as part
 * of the same sweep but in a separate PR; this guard currently covers the
 * files Geordi owns. Add lib paths to GUARDED_FILES once Architect lands her
 * portion.
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

const GUARDED_FILES = [
  'app/api/computer-use/route.ts',
  'app/api/agent/actions/computer-use.ts',
  'lib/computer-use.ts',
  'lib/computer-use-bridge.ts',
  'lib/computer-use-headless.ts',
];

async function readGuardedFiles(): Promise<Array<{ path: string; lines: string[] }>> {
  return Promise.all(
    GUARDED_FILES.map(async (rel) => {
      const abs = path.join(REPO_ROOT, rel);
      const text = await fs.readFile(abs, 'utf-8');
      return { path: rel, lines: text.split('\n') };
    }),
  );
}

/** Strip block comments and `//` line comments — best-effort, single-pass. */
function stripComments(src: string): string {
  // Remove /* ... */ block comments
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove // line comments — but not URLs like https://
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return out;
}

describe('Computer Use error-shape CI guards', () => {
  it('contains no bare `throw new Error(` in guarded files', async () => {
    const files = await readGuardedFiles();
    const violations: Array<{ file: string; line: number; text: string }> = [];
    for (const { path: p, lines } of files) {
      lines.forEach((line, idx) => {
        const stripped = stripComments(line);
        if (/\bthrow\s+new\s+Error\s*\(/.test(stripped)) {
          violations.push({ file: p, line: idx + 1, text: line.trim() });
        }
      });
    }
    expect(violations, `Bare \`throw new Error()\` is forbidden in Computer Use surfaces. Use \`throw new ComputerUseError(...)\` with a code instead. Violations:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
  });

  it('contains no code-less `success: false` JSON responses in guarded files', async () => {
    const files = await readGuardedFiles();
    const violations: Array<{ file: string; line: number; text: string }> = [];
    for (const { path: p, lines } of files) {
      // Walk the file as joined text so we can match across line breaks for
      // multi-line response objects, then map matches back to line numbers.
      const joined = stripComments(lines.join('\n'));
      // Match { success: false, ... } that does NOT contain code: within the same { ... }.
      // - Body must use comma separators (JS object literal). TS type aliases use
      //   semicolons (e.g. `{ success: false; error: string }`) — those are skipped.
      // - Skip `success: false |` (TS union literal in a return type).
      const re = /\{\s*success\s*:\s*false\s*,[^{}]*?\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(joined)) !== null) {
        const body = m[0];
        if (!/\bcode\s*:/.test(body) && !/fail\s*\(/.test(body)) {
          // Compute line number by counting newlines up to the match index.
          const upTo = joined.slice(0, m.index);
          const lineNumber = upTo.split('\n').length;
          violations.push({ file: p, line: lineNumber, text: body.replace(/\s+/g, ' ').slice(0, 200) });
        }
      }
    }
    expect(
      violations,
      `Code-less \`success: false\` responses are forbidden — use \`fail(code, message, context)\` from app/api/computer-use/error-codes.ts. Violations:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });

  it('imports `fail` (or ComputerUseError) wherever it returns error responses', async () => {
    // Smoke check: each guarded file should reference one of the typed error helpers.
    const files = await readGuardedFiles();
    for (const { path: p, lines } of files) {
      const text = lines.join('\n');
      const usesFail = /\bfail\s*\(/.test(text);
      const usesClass = /\bComputerUseError\b/.test(text);
      expect(usesFail || usesClass, `${p} should use fail() or ComputerUseError for error responses`).toBe(true);
    }
  });
});
