/**
 * prompt-parser.ts
 * Cross-model prompt structuring: raw author input -> canonical structured template.
 *
 * Non-destructive + opt-in. Trivial messages pass through UNTOUCHED ("hi" stays "hi").
 * Pure logic — no React, no browser APIs. Shared by the ColabInput preview (T2.3) and
 * the dispatch wiring (T3.1) so both render identical output from one source of truth.
 *
 * Internal representation is POML-style components (task/context/constraints/input/
 * output-format/code). Inference (raw -> components) is decoupled from rendering
 * (components -> string) so a future `targetModel` can drive per-model output without
 * touching the inference pass.
 *
 * Sprint: Prompt Composer — T1.1.
 */

import { parseTokens } from '@/lib/message-parser';

// ─── Public types (STABLE API — Daniel's T2.3 preview + T3.1 dispatch depend on these) ──

/** POML-style component kinds. `code`/`raw` are positional (rendered in the Input area). */
export type PromptComponentType =
  | 'task'
  | 'context'
  | 'constraints'
  | 'input'
  | 'output-format'
  | 'code'
  | 'raw';

export interface PromptComponent {
  type: PromptComponentType;
  content: string;
  /** Code components only — language hint applied to the fence. */
  language?: string;
  /** Input/code components relocated above Task by the large-input rule. */
  hoisted?: boolean;
}

export interface PromptParserOptions {
  /** Reserved for future per-model rendering (POML-stylesheet style). Unused in v1. */
  targetModel?: string;
  /** Override the large-input hoist threshold, in estimated tokens. Default ~20000. */
  hoistTokenThreshold?: number;
}

export interface PromptParseResult {
  /** Canonical structured text, or the original input verbatim when passthrough. */
  structured: string;
  /** True if the parser restructured the input; false if it passed through untouched. */
  wasStructured: boolean;
  /** POML component breakdown (drives the preview pane). Empty array on passthrough. */
  components: PromptComponent[];
}

// ─── Tuning constants ────────────────────────────────────────────────────────

/** Large-input hoist threshold (estimated tokens) — input above this moves above Task. */
const DEFAULT_HOIST_TOKEN_THRESHOLD = 20_000;
/** Rough token estimate: ~4 chars per token (vendor-agnostic heuristic). */
const CHARS_PER_TOKEN = 4;
/** Below this word count, with no other signal, structuring adds no value -> passthrough. */
const STRUCTURE_MIN_WORDS = 40;
/** An unlabelled prose block longer than this is treated as pasted input/data, not context. */
const INPUT_BULK_CHARS = 600;

// ─── Detection regexes ───────────────────────────────────────────────────────

/** A bullet or numbered list line. */
const BULLET_RE = /^\s*([-*+]|\d+\.)\s+/;

/** Leading section label: optional ##/**, a known keyword, optional :/-/* and whitespace. */
const LABEL_RE =
  /^\s*(?:#{1,6}\s*)?(?:\*\*\s*)?(task|objective|goal|context|background|constraints?|requirements?|rules?|input|data|given|output\s*format|output|format|response)\b\s*[:\-*]*\s*/i;

/** Output-format intent: an output verb followed (in the same clause) by a format noun. */
const OUTPUT_CUE_RE =
  /\b(respond|reply|return|answer|output|format(?:ted)?|present)\b[^.?!]*\b(json|markdown|md|table|bullets?|lists?|prose|paragraphs?|csv|xml|yaml|diff|code|plain\s?text)\b/i;

/** Background/context signal for an unlabelled prose block. */
const CONTEXT_CUE_RE =
  /(https?:\/\/|\b(currently|previously|background|context|we (?:use|have|run|are)|the existing|at the moment|right now|for reference)\b)/i;

/** Prose output-style cues lacking a format noun: negations, concision, "verb … just/only". */
const OUTPUT_STYLE_RE =
  /\b(?:no|without)\s+(?:explanation|explanations|preamble|commentary|comments?|prose|intro|introduction|notes?|caveats?|disclaimers?|yapping|fluff|filler)\b|\b(?:return|give|output|respond|reply|provide|answer)\b[^.?!]*\b(?:just|only)\b|\b(?:just|only)\s+(?:the\s+)?(?:code|answer|result|output|number|value|json|list|name|url|sql|function|diff|snippet)\b|\b(?:be\s+)?(?:concise|brief|terse)\b|\b(?:one|single)[\s-](?:word|line|sentence|paragraph)\b/i;

/** Inline constraint connectors embedded in a task sentence (conservative — never bare "and"). */
const INLINE_CONSTRAINT_RE =
  /\b(?:but|however|though)\s+(?:do not|don'?t|must not|never|without|avoid|make sure|ensure|keep|only|no)\b|\bwithout\s+\w+ing\b|\bas long as\b|\bprovided that\b/i;

/** A clause that opens with a constraint modal/imperative — clause-level constraint detection. */
const CONSTRAINT_CLAUSE_RE =
  /^(?:must(?:\s+not)?|should(?:\s+not)?|shall(?:\s+not)?|do not|don'?t|never|always|ensure|make sure|avoid|reject|disallow|keep\s+it\b|without\s+\w+ing)\b/i;

// ─── Small pure helpers ──────────────────────────────────────────────────────

function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/** Heuristic: does an unfenced block look like source code? Conservative to avoid prose false-positives. */
function looksLikeCode(s: string): boolean {
  const lines = s.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return false;
  const KEYWORD =
    /\b(function|const|let|var|def|class|import|from|return|public|private|void|async|await|=>|SELECT|INSERT|UPDATE|DELETE)\b/;
  const codey = lines.filter(
    (l) =>
      /[;{}]\s*$/.test(l) ||
      (/^\s+\S/.test(l) && /[=(){}[\]]/.test(l)) ||
      KEYWORD.test(l) ||
      /^\s*(#include|using|package|@)\b/.test(l),
  ).length;
  if (lines.length === 1) {
    return /[;{}]/.test(s) && /[=(){}]/.test(s) && KEYWORD.test(s);
  }
  return codey >= Math.max(2, Math.ceil(lines.length * 0.5));
}

/** Best-effort language hint for an unfenced code block. Returns '' when unknown. */
function detectLanguage(s: string): string {
  if (/\b(def |elif |self\.|print\()/.test(s) || /:\s*$/m.test(s)) return 'python';
  if (/\b(function|const|let|=>|console\.log|document\.|export )\b/.test(s)) {
    return /\b(interface |type |: string|: number)\b/.test(s) ? 'typescript' : 'javascript';
  }
  const t = s.trim();
  if ((t.startsWith('{') || t.startsWith('[')) && /[:}\]]/.test(t)) {
    try {
      JSON.parse(t);
      return 'json';
    } catch {
      /* not valid JSON — fall through */
    }
  }
  if (/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\b/i.test(s)) return 'sql';
  if (/^#!.*\b(bash|sh)\b/.test(s) || /\b(echo |cd |ls |grep |curl |sudo |npm |git )\b/.test(s)) return 'bash';
  return '';
}

/** Per-line code signal — anchored on code punctuation, not bare English keywords. */
function lineLooksLikeCode(l: string): boolean {
  const t = l.trim();
  if (!t) return false;
  if (/[;{]\s*$/.test(t)) return true; // ends with ; or {
  if (/^[}\])];?$/.test(t)) return true; // lone closing bracket
  if (/=>/.test(t)) return true;
  if (/^\s{2,}\S/.test(l) && /[=(){}[\];]/.test(l)) return true; // indented + code punct
  if (/\b(?:function|def|class)\s+\w+/.test(t)) return true; // named declaration
  if (/\b(?:const|let|var)\s+\w+\s*=/.test(t)) return true;
  if (/\bimport\b.*\bfrom\b/.test(t)) return true;
  if (/\b(?:SELECT|INSERT|UPDATE|DELETE)\b.+\b(?:FROM|INTO|SET|WHERE)\b/i.test(t)) return true;
  return false;
}

/** Find the longest contiguous run of unfenced code lines (>=2, with real punctuation). */
function splitOutCodeRun(text: string): { before: string; code: string; after: string } | null {
  const lines = text.split('\n');
  if (lines.length < 2) return null;
  const flags = lines.map(lineLooksLikeCode);
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (flags[i]) {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) return null;
  const code = lines.slice(bestStart, bestStart + bestLen).join('\n');
  if (!/[{};]/.test(code)) return null; // require real code punctuation, not just keywords
  return {
    before: lines.slice(0, bestStart).join('\n').trim(),
    code,
    after: lines.slice(bestStart + bestLen).join('\n').trim(),
  };
}

/** Detect an unfenced inline code expression on a single line, stripping a leading "broken version:" cue. */
function extractInlineCode(text: string): { before: string; code: string; after: string } | null {
  const exprRe =
    /(?:function\s+\w*\s*\([^)]*\)\s*\{[^}]*\}|\b[\w.]+\s*=\s*\([^)]*\)\s*=>[^;\n]*|\b[\w.]+\([^)]*\)\s*\{[^}]*\}|\{[^{}]*\breturn\b[^{}]*\})/;
  const m = text.match(exprRe);
  if (!m || m.index === undefined) return null;
  const code = m[0].trim();
  if (code.length < 6) return null;
  const before = text
    .slice(0, m.index)
    .replace(
      /[,.;:]?\s*\b(?:current(?:ly)?\s+broken\s+version|broken\s+version|current\s+code|existing\s+code|here'?s?\s+the(?:\s+\w+)?|here is the(?:\s+\w+)?)\s*:?\s*$/i,
      '',
    )
    .trim();
  const after = text.slice(m.index + m[0].length).trim();
  return { before, code, after };
}

/** Split a task sentence's trailing output instruction off into its own piece. */
function splitTrailingOutput(text: string): { task: string; output: string | null } {
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length >= 2) {
    const last = sentences[sentences.length - 1];
    if (OUTPUT_CUE_RE.test(last) || OUTPUT_STYLE_RE.test(last)) {
      return { task: sentences.slice(0, -1).join(' ').trim(), output: last.trim() };
    }
  }
  return { task: text, output: null };
}

/** Peel conservative inline constraint clauses ("… but do not X and keep Y") off a task sentence. */
function extractInlineConstraints(text: string): { task: string; constraints: string[] } {
  const leadRe =
    /\b(?:but|however|though)\s+(?=do not\b|don'?t\b|must not\b|never\b|without\b|avoid\b|make sure\b|ensure\b|keep\b|only\b|no\b)|\bwithout\s+(?=\w+ing\b)|\bas long as\b|\bprovided that\b/i;
  const m = text.match(leadRe);
  if (!m || m.index === undefined || m.index === 0) return { task: text, constraints: [] };
  const task = text
    .slice(0, m.index)
    .trim()
    .replace(/\s+(?:and|but|,)\s*$/i, '')
    .replace(/[,;:]\s*$/, '')
    .trim();
  if (!task) return { task: text, constraints: [] };
  const region = text
    .slice(m.index)
    .replace(/^\b(?:but|however|though)\b\s*/i, '')
    .replace(/[.!?]\s*$/, '')
    .trim();
  const constraints = region
    .split(/\s+and\s+|\s*;\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (constraints.length === 0) return { task: text, constraints: [] };
  return { task, constraints };
}

/** Group a text run into prose/bullet blocks; blank lines and prose<->bullet transitions split blocks. */
function splitTextIntoBlocks(text: string): Array<{ kind: 'prose' | 'bullets'; value: string }> {
  const blocks: Array<{ kind: 'prose' | 'bullets'; value: string }> = [];
  let cur: { kind: 'prose' | 'bullets'; lines: string[] } | null = null;
  const flush = () => {
    if (cur && cur.lines.length) {
      const value = cur.lines.join('\n').trim();
      if (value) blocks.push({ kind: cur.kind, value });
    }
    cur = null;
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const kind: 'prose' | 'bullets' = BULLET_RE.test(line) ? 'bullets' : 'prose';
    if (!cur || cur.kind !== kind) {
      flush();
      cur = { kind, lines: [] };
    }
    cur.lines.push(line);
  }
  flush();
  return blocks;
}

function labelToType(label: string): PromptComponentType {
  const l = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^(task|objective|goal)$/.test(l)) return 'task';
  if (/^(context|background)$/.test(l)) return 'context';
  if (/^(constraints?|requirements?|rules?)$/.test(l)) return 'constraints';
  if (/^(input|data|given)$/.test(l)) return 'input';
  return 'output-format';
}

/** Mutable accumulator threaded through classification. */
interface ParseState {
  components: PromptComponent[];
  hasTask: boolean;
  taskRef: PromptComponent | null;
}

function pushTyped(state: ParseState, type: PromptComponentType, body: string): void {
  const content = body.trim();
  if (!content) return;
  if (type === 'constraints' || type === 'context') {
    const existing = state.components.find((c) => c.type === type);
    if (existing) {
      existing.content += (type === 'constraints' ? '\n' : '\n\n') + content;
      return;
    }
  }
  const comp: PromptComponent = { type, content };
  if (type === 'task' && !state.hasTask) {
    state.hasTask = true;
    state.taskRef = comp;
  }
  state.components.push(comp);
}

/** Split prose into ordered clauses on sentence terminators and commas. */
function splitClauses(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|,\s+/)
    .map((s) => s.replace(/[.!?,]+\s*$/, '').trim())
    .filter(Boolean);
}

function isOutputClause(clause: string): boolean {
  return OUTPUT_CUE_RE.test(clause) || OUTPUT_STYLE_RE.test(clause);
}

/**
 * Classify an unstructured task paragraph clause-by-clause into task / constraints /
 * output-format. Generalises peeling to comma-separated and mid-position cues, not just
 * the trailing sentence. Plain prose with nothing to peel is preserved verbatim.
 */
function classifyTaskClauses(state: ParseState, text: string): void {
  const clauses = splitClauses(text);
  const taskParts: string[] = [];
  const outputs: string[] = [];
  const constraints: string[] = [];
  for (const cl of clauses) {
    if (isOutputClause(cl)) outputs.push(cl);
    else if (CONSTRAINT_CLAUSE_RE.test(cl)) constraints.push(cl);
    else taskParts.push(cl);
  }

  if (outputs.length === 0 && constraints.length === 0) {
    // Nothing peeled at clause level — preserve prose; fall back to connector + trailing split.
    const { task: afterOutput, output } = splitTrailingOutput(text);
    const { task, constraints: inline } = extractInlineConstraints(afterOutput);
    pushTyped(state, 'task', task);
    for (const c of inline) pushTyped(state, 'constraints', `- ${c}`);
    if (output) pushTyped(state, 'output-format', output);
    return;
  }

  // Clauses peeled — also run the connector-split on the assembled task ("but do not X and keep Y").
  const { task, constraints: inline } = extractInlineConstraints(taskParts.join(', ').trim());
  if (task) pushTyped(state, 'task', task);
  for (const c of inline) pushTyped(state, 'constraints', `- ${c}`);
  for (const c of constraints) pushTyped(state, 'constraints', `- ${c}`);
  for (const o of outputs) pushTyped(state, 'output-format', o);
}

function classifyProse(state: ParseState, text: string): void {
  // Split an unfenced multi-line code run out of the prose before any other classification.
  const codeSplit = splitOutCodeRun(text);
  if (codeSplit) {
    if (codeSplit.before) classifyProse(state, codeSplit.before);
    state.components.push({
      type: 'code',
      content: codeSplit.code,
      language: detectLanguage(codeSplit.code) || undefined,
    });
    if (codeSplit.after) classifyProse(state, codeSplit.after);
    return;
  }
  // Single-line inline code expression (e.g. after "current broken version:").
  const inlineCode = extractInlineCode(text);
  if (inlineCode) {
    if (inlineCode.before) classifyProse(state, inlineCode.before);
    state.components.push({
      type: 'code',
      content: inlineCode.code,
      language: detectLanguage(inlineCode.code) || undefined,
    });
    if (inlineCode.after) classifyProse(state, inlineCode.after);
    return;
  }
  if (text.length > INPUT_BULK_CHARS) {
    pushTyped(state, 'input', text);
    return;
  }
  if (!state.hasTask) {
    classifyTaskClauses(state, text);
    return;
  }
  if ((OUTPUT_CUE_RE.test(text) || OUTPUT_STYLE_RE.test(text)) && text.length < 200) {
    pushTyped(state, 'output-format', text);
    return;
  }
  if (CONTEXT_CUE_RE.test(text)) {
    pushTyped(state, 'context', text);
    return;
  }
  pushTyped(state, 'context', text);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Passthrough predicate: would structuring this input add value?
 * False for trivial conversational input (protects "hi" from becoming a template).
 */
export function shouldStructure(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const hasCode = /```/.test(raw) || looksLikeCode(raw);
  const listItems = (raw.match(/^\s*([-*+]|\d+\.)\s+/gm) || []).length;
  const hasList = listItems >= 2;
  const hasLabel = LABEL_RE.test(raw);
  const hasOutputCue = OUTPUT_CUE_RE.test(raw) || OUTPUT_STYLE_RE.test(raw);
  const hasInlineConstraint = INLINE_CONSTRAINT_RE.test(raw);
  const words = trimmed.split(/\s+/).length;
  return hasCode || hasList || hasLabel || hasOutputCue || hasInlineConstraint || words >= STRUCTURE_MIN_WORDS;
}

/**
 * Inference only: raw input -> POML components (ordered). Exposed for the preview pane
 * and tests. Performs section inference, code extraction, and large-input hoisting.
 */
export function parseComponents(raw: string, options?: PromptParserOptions): PromptComponent[] {
  const hoistThreshold = options?.hoistTokenThreshold ?? DEFAULT_HOIST_TOKEN_THRESHOLD;
  const state: ParseState = { components: [], hasTask: false, taskRef: null };

  // 1. Split into ordered segments: prose-text runs and fenced-code blocks.
  const codeTokens = parseTokens(raw)
    .filter((t) => t.type === 'code-block')
    .sort((a, b) => a.start - b.start);

  const segments: Array<{ kind: 'text' | 'code'; value: string; language?: string }> = [];
  let cursor = 0;
  for (const tok of codeTokens) {
    if (tok.start > cursor) segments.push({ kind: 'text', value: raw.slice(cursor, tok.start) });
    segments.push({ kind: 'code', value: (tok.inner ?? '').replace(/\n+$/, ''), language: tok.language || '' });
    cursor = tok.end;
  }
  if (cursor < raw.length) segments.push({ kind: 'text', value: raw.slice(cursor) });

  // 2. Walk segments in order; a bare label line types the block that follows it.
  let pendingType: PromptComponentType | null = null;
  for (const seg of segments) {
    if (seg.kind === 'code') {
      let language = seg.language;
      if (!language && looksLikeCode(seg.value)) language = detectLanguage(seg.value);
      state.components.push({ type: 'code', content: seg.value, language: language || undefined });
      pendingType = null;
      continue;
    }
    for (const block of splitTextIntoBlocks(seg.value)) {
      if (block.kind === 'prose') {
        const lm = block.value.match(LABEL_RE);
        if (lm) {
          const type = labelToType(lm[1]);
          const inline = block.value.slice(lm[0].length).trim();
          if (inline) {
            pushTyped(state, type, inline);
            pendingType = null;
          } else {
            pendingType = type; // bare label — types the next block
          }
          continue;
        }
        if (pendingType) {
          pushTyped(state, pendingType, block.value);
          pendingType = null;
          continue;
        }
        classifyProse(state, block.value);
      } else {
        // bullet block: typed by a pending label, else constraints by default
        pushTyped(state, pendingType ?? 'constraints', block.value);
        pendingType = null;
      }
    }
  }

  // 3. Large-input hoisting: move bulky input/code above Task and rewrite the task line.
  const hoistTargets = state.components.filter(
    (c) => (c.type === 'input' || c.type === 'code') && estimateTokens(c.content) > hoistThreshold,
  );
  if (hoistTargets.length > 0) {
    for (const t of hoistTargets) t.hoisted = true;
    if (state.taskRef) {
      const base = state.taskRef.content.trim();
      const terminated = /[.!?:]$/.test(base) ? base : `${base}.`;
      state.taskRef.content = `Based on the input above, ${terminated}`;
    }
  }

  return state.components;
}

/** Render a single input/code component (code -> fenced block, text -> trimmed content). */
function renderInputLike(c: PromptComponent): string {
  if (c.type === 'code') {
    return '```' + (c.language || '') + '\n' + c.content.replace(/\n+$/, '') + '\n```';
  }
  return c.content.trim();
}

/** Normalise a constraints body so every non-empty line is a bullet. */
function asBullets(content: string): string {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (BULLET_RE.test(l) ? l : `- ${l}`))
    .join('\n');
}

/**
 * Rendering only: components -> canonical template string. Pure; honours the `hoisted`
 * flag. Exposed for future per-model tuning (the `targetModel` stylesheet hook).
 */
export function renderComponents(components: PromptComponent[], _options?: PromptParserOptions): string {
  const isInputLike = (c: PromptComponent) => c.type === 'input' || c.type === 'code';
  const hoisted = components.filter((c) => isInputLike(c) && c.hoisted);
  const task = components.find((c) => c.type === 'task');
  const contexts = components.filter((c) => c.type === 'context');
  const constraints = components.filter((c) => c.type === 'constraints');
  const inputsLower = components.filter((c) => isInputLike(c) && !c.hoisted);
  const outputs = components.filter((c) => c.type === 'output-format');

  const sections: string[] = [];
  if (hoisted.length) sections.push('## Input\n' + hoisted.map(renderInputLike).join('\n\n'));
  if (task) sections.push('## Task\n' + task.content.trim());
  if (contexts.length) sections.push('## Context\n' + contexts.map((c) => c.content.trim()).join('\n\n'));
  if (constraints.length) sections.push('## Constraints\n' + constraints.map((c) => asBullets(c.content)).join('\n'));
  if (inputsLower.length) sections.push('## Input\n' + inputsLower.map(renderInputLike).join('\n\n'));
  if (outputs.length) sections.push('## Output format\n' + outputs.map((c) => c.content.trim()).join('\n\n'));

  return sections.join('\n\n');
}

/**
 * Main entry. Raw author input -> canonical structured template.
 * Non-destructive: returns the input verbatim (wasStructured=false) for trivial messages
 * or when structuring would not change the content.
 */
export function parsePrompt(raw: string, options?: PromptParserOptions): PromptParseResult {
  if (!shouldStructure(raw)) {
    return { structured: raw, wasStructured: false, components: [] };
  }
  const components = parseComponents(raw, options);
  if (components.length === 0) {
    return { structured: raw, wasStructured: false, components: [] };
  }
  const structured = renderComponents(components, options);
  if (!structured.trim() || structured.trim() === raw.trim()) {
    return { structured: raw, wasStructured: false, components };
  }
  return { structured, wasStructured: true, components };
}
