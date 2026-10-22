/**
 * Prompt Composer — T1.2 parser unit tests.
 * Written TDD — RED first, then lib/prompt-parser.ts implemented to GREEN.
 *
 * Coverage: passthrough (make-or-break), shouldStructure signals, fenced-code
 * detection + language hint, bullets -> constraints, large-input hoisting + closer,
 * explicit-label section inference, output-format cue, mixed content ordering,
 * idempotency, and parse/render decoupling.
 */

import { describe, it, expect } from 'vitest';
import {
  parsePrompt,
  parseComponents,
  renderComponents,
  shouldStructure,
  type PromptComponent,
} from '@/lib/prompt-parser';

// ─── Passthrough — the make-or-break guard ───────────────────────────────────

describe('parsePrompt — passthrough (trivial input must stay untouched)', () => {
  it('"hi" stays "hi" — never a 5-heading template', () => {
    const r = parsePrompt('hi');
    expect(r.structured).toBe('hi');
    expect(r.wasStructured).toBe(false);
    expect(r.components).toEqual([]);
  });

  it('short thanks passes through', () => {
    expect(parsePrompt('thanks, that worked!').structured).toBe('thanks, that worked!');
    expect(parsePrompt('thanks, that worked!').wasStructured).toBe(false);
  });

  it('a short single-line instruction passes through', () => {
    const msg = '@Edge open https://example.com and screenshot the page';
    const r = parsePrompt(msg);
    expect(r.structured).toBe(msg);
    expect(r.wasStructured).toBe(false);
  });

  it('a short question passes through', () => {
    const r = parsePrompt('what is the capital of France?');
    expect(r.structured).toBe('what is the capital of France?');
    expect(r.wasStructured).toBe(false);
  });

  it('empty / whitespace passes through', () => {
    expect(parsePrompt('').structured).toBe('');
    expect(parsePrompt('   \n  ').wasStructured).toBe(false);
  });
});

// ─── shouldStructure predicate ───────────────────────────────────────────────

describe('shouldStructure — structure-signal detection', () => {
  it('false for short plain text', () => {
    expect(shouldStructure('hi')).toBe(false);
    expect(shouldStructure('fix the typo on the homepage')).toBe(false);
  });

  it('true when a fenced code block is present (even if short)', () => {
    expect(shouldStructure('fix this\n```js\nconst x=1\n```')).toBe(true);
  });

  it('true when 2+ bullet items are present', () => {
    expect(shouldStructure('do the thing\n- one\n- two')).toBe(true);
  });

  it('false for a single stray bullet', () => {
    expect(shouldStructure('- just one item')).toBe(false);
  });

  it('true when an explicit section label is present', () => {
    expect(shouldStructure('Task: refactor the parser')).toBe(true);
  });

  it('true when the message is long enough to benefit (>= 40 words)', () => {
    const long = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ');
    expect(shouldStructure(long)).toBe(true);
  });
});

// ─── Fenced code block detection + language hint ─────────────────────────────

describe('parsePrompt — fenced code blocks', () => {
  const input = 'Fix the bug in this function.\n```js\nfunction add(a,b){return a-b}\n```';

  it('detects a code component with its language', () => {
    const comps = parseComponents(input);
    const code = comps.find((c) => c.type === 'code');
    expect(code).toBeDefined();
    expect(code!.language).toBe('js');
    expect(code!.content).toContain('function add');
  });

  it('preserves the fenced block with language hint in the structured output', () => {
    const r = parsePrompt(input);
    expect(r.wasStructured).toBe(true);
    expect(r.structured).toContain('## Task');
    expect(r.structured).toContain('Fix the bug');
    expect(r.structured).toContain('```js');
    expect(r.structured).toContain('function add(a,b){return a-b}');
  });
});

// ─── Bullets -> constraints ──────────────────────────────────────────────────

describe('parsePrompt — bullet lists become constraints', () => {
  const input =
    'Refactor the auth module.\n- must not break existing sessions\n- keep changes under 50 lines';

  it('classifies the bullet group as constraints', () => {
    const comps = parseComponents(input);
    expect(comps.find((c) => c.type === 'task')!.content).toContain('Refactor the auth module');
    const cons = comps.find((c) => c.type === 'constraints');
    expect(cons).toBeDefined();
    expect(cons!.content).toContain('must not break existing sessions');
    expect(cons!.content).toContain('keep changes under 50 lines');
  });

  it('renders a Constraints section with the bullets', () => {
    const r = parsePrompt(input);
    expect(r.structured).toContain('## Constraints');
    expect(r.structured).toContain('- must not break existing sessions');
    expect(r.structured).toContain('- keep changes under 50 lines');
  });
});

// ─── Large-input hoisting + closer line ──────────────────────────────────────

describe('parsePrompt — large-input hoisting', () => {
  it('hoists an explicit Input block above Task with a closer line', () => {
    const data = 'log entry line\n'.repeat(8); // ~120 chars
    const input = `Input:\n${data}\nSummarize the errors.`;
    const r = parsePrompt(input, { hoistTokenThreshold: 5 }); // tiny threshold to force hoist

    expect(r.wasStructured).toBe(true);
    // Input section appears ABOVE the Task section
    expect(r.structured.indexOf('## Input')).toBeLessThan(r.structured.indexOf('## Task'));
    // Closer line rewrites the task
    expect(r.structured).toContain('Based on the input above, Summarize the errors.');
    // component flagged hoisted
    const inputComp = r.components.find((c) => c.type === 'input');
    expect(inputComp?.hoisted).toBe(true);
  });

  it('auto-classifies a large unlabelled block as input and hoists it', () => {
    const bulk = 'x '.repeat(400); // ~800 chars, well past bulk threshold
    const input = `Summarize the following.\n\n${bulk}`;
    const r = parsePrompt(input, { hoistTokenThreshold: 5 });
    expect(r.structured.indexOf('## Input')).toBeLessThan(r.structured.indexOf('## Task'));
    expect(r.structured).toContain('Based on the input above,');
  });

  it('does NOT hoist when input is below the threshold', () => {
    const input = 'Input:\nsmall data\n\nSummarize it.';
    const r = parsePrompt(input); // default 20k threshold — no hoist
    if (r.wasStructured) {
      // Task should come before Input when not hoisted
      expect(r.structured.indexOf('## Task')).toBeLessThan(r.structured.indexOf('## Input'));
      expect(r.structured).not.toContain('Based on the input above');
    }
  });
});

// ─── Explicit-label section inference ────────────────────────────────────────

describe('parseComponents — explicit labels map to sections', () => {
  it('maps Task/Context/Constraints labels (with or without ## or colon)', () => {
    const input = [
      '## Task',
      'Build the endpoint.',
      '',
      'Context: we use Fastify.',
      '',
      'Constraints:',
      '- validate all inputs',
    ].join('\n');
    const comps = parseComponents(input);
    expect(comps.find((c) => c.type === 'task')!.content).toContain('Build the endpoint');
    expect(comps.find((c) => c.type === 'context')!.content).toContain('Fastify');
    expect(comps.find((c) => c.type === 'constraints')!.content).toContain('validate all inputs');
  });
});

// ─── Output-format cue ───────────────────────────────────────────────────────

describe('parsePrompt — output-format detection', () => {
  it('splits a trailing format instruction into an output-format section', () => {
    const input = 'Extract all the dates from the text. Respond as a JSON array.';
    const r = parsePrompt(input);
    expect(r.structured).toContain('## Output format');
    expect(r.structured).toContain('JSON');
    const task = r.components.find((c) => c.type === 'task');
    expect(task!.content).toContain('Extract all the dates');
    expect(task!.content).not.toContain('JSON');
  });
});

// ─── Mixed content — canonical ordering ──────────────────────────────────────

describe('parsePrompt — mixed content renders in canonical order', () => {
  const input = [
    'Task: Migrate the users table to add a status column.',
    '',
    'Context: we run Postgres 14 in production.',
    '',
    'Constraints:',
    '- zero downtime',
    '- must be reversible',
    '',
    '```sql',
    'ALTER TABLE users ADD COLUMN status text;',
    '```',
    '',
    'Output: a migration file and a rollback file.',
  ].join('\n');

  it('orders Task < Context < Constraints < Input < Output format', () => {
    const r = parsePrompt(input);
    const s = r.structured;
    expect(s.indexOf('## Task')).toBeGreaterThanOrEqual(0);
    expect(s.indexOf('## Task')).toBeLessThan(s.indexOf('## Context'));
    expect(s.indexOf('## Context')).toBeLessThan(s.indexOf('## Constraints'));
    expect(s.indexOf('## Constraints')).toBeLessThan(s.indexOf('## Input'));
    expect(s.indexOf('## Input')).toBeLessThan(s.indexOf('## Output format'));
  });

  it('keeps the sql fence with its language', () => {
    expect(parsePrompt(input).structured).toContain('```sql');
    expect(parsePrompt(input).structured).toContain('ALTER TABLE users');
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('parsePrompt — idempotent on already-canonical input', () => {
  it('re-structuring canonical output is stable', () => {
    const input = [
      'Task: do the thing.',
      '',
      'Constraints:',
      '- be fast',
      '- be safe',
    ].join('\n');
    const once = parsePrompt(input).structured;
    const twice = parsePrompt(once).structured;
    expect(twice).toBe(once);
  });
});

// ─── parse/render decoupling ─────────────────────────────────────────────────

describe('renderComponents — pure rendering from components', () => {
  it('renders a task + constraints set into canonical markdown', () => {
    const comps: PromptComponent[] = [
      { type: 'task', content: 'Do X' },
      { type: 'constraints', content: '- rule one\n- rule two' },
    ];
    const out = renderComponents(comps);
    expect(out).toContain('## Task');
    expect(out).toContain('Do X');
    expect(out).toContain('## Constraints');
    expect(out).toContain('- rule one');
  });

  it('parsePrompt(structured-case) equals renderComponents(parseComponents)', () => {
    const input = 'Refactor the module.\n- keep it small\n- add a test';
    const viaParse = parsePrompt(input);
    expect(viaParse.structured).toBe(renderComponents(parseComponents(input)));
  });
});

// ─── T3.2 prose-depth gaps (plain prose is Owner's main input) ─────────────────

describe('T3.2 — prose output-cue depth', () => {
  it('"No explanation, just the code" -> output-format, stripped from task', () => {
    const r = parsePrompt('Write a function that reverses a string. No explanation, just the code.');
    expect(r.wasStructured).toBe(true);
    expect(r.structured).toContain('## Output format');
    const task = r.components.find((c) => c.type === 'task');
    expect(task!.content).toContain('reverses a string');
    expect(task!.content).not.toMatch(/no explanation/i);
  });

  it('"Return just the action items" -> output-format', () => {
    const r = parsePrompt('Summarize the meeting notes. Return just the action items.');
    expect(r.structured).toContain('## Output format');
  });

  it('"Be concise — one sentence" -> output-format', () => {
    const r = parsePrompt('Explain what a closure is. Be concise — one sentence.');
    expect(r.structured).toContain('## Output format');
  });

  it('still passes "hi" through (no over-trigger from new cues)', () => {
    expect(parsePrompt('hi').wasStructured).toBe(false);
    expect(parsePrompt('thanks, just letting you know').wasStructured).toBe(false);
  });
});

describe('T3.2 — inline constraint splitting', () => {
  it('splits "but do not X and keep Y" into constraints', () => {
    const r = parsePrompt(
      'Refactor the auth module but do not break existing sessions and keep it under 50 lines.',
    );
    expect(r.structured).toContain('## Constraints');
    const cons = r.components.find((c) => c.type === 'constraints');
    expect(cons!.content).toMatch(/break existing sessions/i);
    expect(cons!.content).toMatch(/under 50 lines/i);
    const task = r.components.find((c) => c.type === 'task');
    expect(task!.content).toContain('Refactor the auth module');
    expect(task!.content).not.toMatch(/50 lines/i);
  });

  it('does NOT split plain "do X and Y" prose into a false constraint', () => {
    const r = parsePrompt('Build the login page and add a signup link to it as well right now please.');
    const cons = r.components.find((c) => c.type === 'constraints');
    expect(cons).toBeUndefined();
  });
});

describe('T3.2 — unfenced code detection', () => {
  it('detects and fences an unfenced JS block in prose', () => {
    const input = 'Fix this function:\nfunction add(a, b) {\n  return a - b;\n}';
    const r = parsePrompt(input);
    const code = r.components.find((c) => c.type === 'code');
    expect(code).toBeDefined();
    expect(code!.content).toContain('return a - b');
    expect(r.structured).toContain('```');
    const task = r.components.find((c) => c.type === 'task');
    expect(task!.content).toContain('Fix this function');
    expect(task!.content).not.toContain('return a - b');
  });

  it('does NOT treat plain prose as code', () => {
    const input =
      'Please update the homepage hero text and the footer copyright year, then redeploy the site.';
    const r = parsePrompt(input);
    expect(r.components.find((c) => c.type === 'code')).toBeUndefined();
  });
});

describe('T3.2 — Jack re-verify samples (realistic end-to-end)', () => {
  it('sample 1: comma-separated "respond as JSON only" -> output-format', () => {
    const r = parsePrompt(
      'write a regex for email validation, handle plus addressing, respond as JSON only',
    );
    expect(r.wasStructured).toBe(true);
    expect(r.structured).toContain('## Output format');
    expect(r.structured).toMatch(/JSON/i);
    const task = r.components.find((c) => c.type === 'task');
    expect(task!.content).toMatch(/email validation/i);
    expect(task!.content).not.toMatch(/respond as json/i);
  });

  it('sample 2: mid-position output cue + inline constraints + fenced inline code', () => {
    const r = parsePrompt(
      'build a fn to validate UK postcodes. must handle standard formats and lowercase, reject empty. return just the function, no explanation. current broken version: function check(p){return p.length>5}',
    );
    expect(r.wasStructured).toBe(true);
    // output cue peeled despite trailing code
    expect(r.structured).toContain('## Output format');
    expect(r.structured).toMatch(/no explanation|just the function/i);
    // inline constraints lifted out
    expect(r.structured).toContain('## Constraints');
    expect(r.structured).toMatch(/reject empty/i);
    // unfenced inline code fenced
    const code = r.components.find((c) => c.type === 'code');
    expect(code).toBeDefined();
    expect(code!.content).toContain('function check');
    expect(r.structured).toContain('```');
    // task stays clean
    const task = r.components.find((c) => c.type === 'task');
    expect(task!.content).toMatch(/UK postcodes/i);
    expect(task!.content).not.toContain('function check');
  });
});
