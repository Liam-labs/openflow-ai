/**
 * Heuristic code-snippet detection for the AgentChat composer (T2.2).
 *
 * Design priority: NON-DESTRUCTIVE. Plain prose must never be flagged as code,
 * because the caller surfaces a "wrap in code block?" suggestion — a false
 * positive on a chat sentence would be noise. We err toward false negatives.
 *
 * No external dependency (no highlight.js/prism in the repo); a focused set of
 * structural + keyword heuristics covers the languages the owner pastes in practice.
 */

export type DetectedLanguage =
  | 'json' | 'html' | 'css' | 'python'
  | 'typescript' | 'javascript' | 'bash' | 'sql';

export interface CodeDetection {
  isCode: boolean;
  language: DetectedLanguage | string | null;
  confidence: number; // 0..1
  alreadyFenced: boolean;
}

const NONE: CodeDetection = { isCode: false, language: null, confidence: 0, alreadyFenced: false };

const SHELL_CMD =
  /^(cd|ls|npm|npx|pnpm|yarn|pm2|git|curl|wget|echo|cat|sudo|chmod|chown|export|source|mkdir|rmdir|rm|cp|mv|ssh|scp|docker|kubectl|grep|sed|awk|tar|python3?|node|bash|sh)\b/;

const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));

export function detectCodeSnippet(raw: string): CodeDetection {
  const t = raw.trim();
  if (t.length < 10) return NONE;

  // Already fenced → caller should not re-wrap.
  if (t.startsWith('```') && t.lastIndexOf('```') > 2) {
    const fenceLang = t.slice(3, t.indexOf('\n') === -1 ? undefined : t.indexOf('\n')).trim();
    return { isCode: true, language: fenceLang || null, confidence: 0.99, alreadyFenced: true };
  }

  const lines = t.split('\n');

  // JSON — authoritative when it parses.
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(t);
      return { isCode: true, language: 'json', confidence: 0.95, alreadyFenced: false };
    } catch {
      /* not valid JSON — fall through */
    }
  }

  // HTML — opening + closing tag, or a doctype.
  if (
    (/<[a-z][\w-]*[\s/>]/i.test(t) && /<\/[a-z][\w-]*>/i.test(t)) ||
    /<!DOCTYPE/i.test(t)
  ) {
    return { isCode: true, language: 'html', confidence: 0.9, alreadyFenced: false };
  }

  // SQL — needs at least two clause keywords to avoid prose false positives.
  const sqlKw = t.match(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|CREATE TABLE|ALTER TABLE)\b/gi);
  if (sqlKw && sqlKw.length >= 2) {
    return { isCode: true, language: 'sql', confidence: 0.85, alreadyFenced: false };
  }

  const shellLines = lines.filter((l) => SHELL_CMD.test(l.trim()));

  // Generic code-likeness score.
  let score = 0;
  if (/[{}]/.test(t)) score += 1;
  if (/;\s*$/m.test(t)) score += 1;
  if (/=>|===|!==|&&|\|\||::/.test(t)) score += 1;
  if (/\b(const|let|var|function|class|def|import|export|interface|type|return|public|private|async|await|elif|lambda)\b/.test(t)) score += 2;
  if (/\w+\([^)]*\)/.test(t)) score += 1;
  if (/^\s{2,}\S/m.test(t)) score += 1;
  if (shellLines.length > 0) score += 2;

  // Prose penalty: a multi-word sentence ending in . ? ! with no code punctuation.
  const sentenceLike =
    /[a-z],?\s+[a-z]+\s+[a-z]+\s+[a-z]+/i.test(t) &&
    /[.?!]\s*$/.test(t) &&
    !/[{};]/.test(t);
  if (sentenceLike) score -= 3;

  const isCode = score >= 3;
  if (!isCode) return { ...NONE, confidence: clamp(score / 6) };

  return {
    isCode: true,
    language: guessLanguage(t, shellLines.length, lines.length),
    confidence: clamp(score / 6, 0.5, 0.95),
    alreadyFenced: false,
  };
}

function guessLanguage(t: string, shellLineCount: number, lineCount: number): DetectedLanguage | null {
  if (shellLineCount >= Math.max(1, Math.ceil(lineCount / 2))) return 'bash';

  const looksPython =
    /\bdef\s+\w+\s*\(.*\)\s*:/.test(t) ||
    /^\s*(import|from)\s+\w+/m.test(t) ||
    /\bprint\(/.test(t) ||
    (/:\s*$/m.test(t) && !/[{};]/.test(t));
  if (looksPython && !/;\s*$/m.test(t) && !/\b(const|let|var|function|interface)\b/.test(t)) {
    return 'python';
  }

  if (
    /\binterface\s+\w+/.test(t) ||
    /\btype\s+\w+\s*=/.test(t) ||
    /:\s*(string|number|boolean|void|any|unknown|[A-Z]\w+)\b/.test(t) ||
    /\benum\s+\w+/.test(t)
  ) {
    return 'typescript';
  }

  if (/\b(const|let|var|function)\b/.test(t) || /=>/.test(t)) return 'javascript';

  if (/[.#]?[\w-]+\s*\{[^}]*:[^}]*;[^}]*\}/.test(t)) return 'css';

  return null;
}

/** Wrap text in a fenced block with an optional language hint. */
export function fenceWithLanguage(text: string, language: string | null): string {
  return '```' + (language ?? '') + '\n' + text.replace(/\n+$/, '') + '\n```';
}
