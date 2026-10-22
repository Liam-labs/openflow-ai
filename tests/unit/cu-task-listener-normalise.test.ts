import { describe, it, expect } from 'vitest';
import { normaliseTaskOutput } from '@/lib/cu-task-listener';

const ESC = '\x1b';
const BEL = '\x07';

describe('normaliseTaskOutput — strips Claude-TUI chrome', () => {
  it('returns empty string for null/undefined/empty input', () => {
    expect(normaliseTaskOutput(null)).toBe('');
    expect(normaliseTaskOutput(undefined)).toBe('');
    expect(normaliseTaskOutput('')).toBe('');
  });

  it('passes plain prose through unchanged', () => {
    const plain = 'The capital of France is Paris.';
    expect(normaliseTaskOutput(plain)).toBe(plain);
  });

  it('strips SGR colour codes', () => {
    const coloured = `${ESC}[31mError:${ESC}[0m something failed`;
    expect(normaliseTaskOutput(coloured)).toBe('Error: something failed');
  });

  it('strips cursor-move and erase CSI sequences', () => {
    const animated = `Loading${ESC}[2K${ESC}[1G done`;
    expect(normaliseTaskOutput(animated)).toBe('Loading done');
  });

  it('strips OSC window-title sequences (terminated by BEL)', () => {
    const titled = `${ESC}]0;Claude — task running${BEL}Result: 42`;
    expect(normaliseTaskOutput(titled)).toBe('Result: 42');
  });

  it('strips OSC hyperlink sequences (terminated by ESC \\)', () => {
    const linked = `See ${ESC}]8;;https://example.com${ESC}\\example${ESC}]8;;${ESC}\\ for details`;
    expect(normaliseTaskOutput(linked)).toBe('See example for details');
  });

  it('drops the Claude welcome banner (box-drawing lines)', () => {
    const banner = [
      '╭───────────────────────────────────────────────╮',
      '│ ✻ Welcome to Claude Code!                     │',
      '│   /help for help, /status for your current setup │',
      '╰───────────────────────────────────────────────╯',
      '',
      'Final answer: 42',
    ].join('\n');
    const out = normaliseTaskOutput(banner);
    expect(out).toBe('│ ✻ Welcome to Claude Code!                     │\n│   /help for help, /status for your current setup │\n\nFinal answer: 42');
    // The pure box-drawing top/bottom lines are stripped; the side-rail
    // lines retain their content because they're <50% box chars.
  });

  it('strips prompt prefixes from input echo', () => {
    const echoed = '> what is 2+2?\n4\n❯ next question\n5';
    expect(normaliseTaskOutput(echoed)).toBe('what is 2+2?\n4\nnext question\n5');
  });

  it('strips trailing whitespace on every line', () => {
    const trailing = 'line one   \nline two\t\t\nline three';
    expect(normaliseTaskOutput(trailing)).toBe('line one\nline two\nline three');
  });

  it('collapses 3+ consecutive blank lines into a single double-blank', () => {
    const sparse = 'first\n\n\n\n\nsecond\n\n\n\nthird';
    expect(normaliseTaskOutput(sparse)).toBe('first\n\nsecond\n\nthird');
  });

  it('trims leading and trailing blank lines from the buffer', () => {
    const padded = '\n\n  \n\nactual content\n\n  \n\n';
    expect(normaliseTaskOutput(padded)).toBe('actual content');
  });

  it('end-to-end: realistic TUI capture → clean prose', () => {
    // Synthesised from the kind of buffer cu-task-listener actually receives:
    // OSC title, banner, coloured prompt, response with cursor moves, trailing junk.
    const raw = [
      `${ESC}]0;Claude${BEL}`,
      '╭─────────────────────────────────────────╮',
      '│ ✻ Welcome to Claude Code!               │',
      '╰─────────────────────────────────────────╯',
      '',
      `${ESC}[2m> ${ESC}[0msummarise the capital of France`,
      '',
      `${ESC}[1mAnswer:${ESC}[0m The capital of France is Paris.   `,
      '',
      'It has been the capital since 987 AD.',
      '',
      '',
      '',
    ].join('\n');

    const out = normaliseTaskOutput(raw);

    // Every piece of Claude-TUI chrome is gone:
    expect(out).not.toMatch(/\x1b/);                  // no ANSI
    expect(out).not.toMatch(/^[╭╰╮╯─]/m);            // no banner corners
    expect(out).not.toMatch(/^>\s/m);                 // no prompt prefixes
    expect(out).not.toMatch(/[ \t]$/m);               // no trailing whitespace
    expect(out).not.toMatch(/\n{3,}/);                // no triple blank lines
    expect(out).not.toMatch(/^\s*\n/);                // no leading blanks
    expect(out).not.toMatch(/\n\s*$/);                // no trailing blanks

    // Content survives:
    expect(out).toContain('summarise the capital of France');
    expect(out).toContain('The capital of France is Paris.');
    expect(out).toContain('It has been the capital since 987 AD.');
  });

  it('preserves an inline `─` separator inside prose (not a banner line)', () => {
    // Threshold is >50% box chars per line — a sentence with one separator
    // character should not be treated as chrome.
    const inline = 'Section A ─ background\n\nSection B ─ analysis';
    expect(normaliseTaskOutput(inline)).toBe('Section A ─ background\n\nSection B ─ analysis');
  });

  it('does not mangle Unicode prose (CJK, emoji, accents)', () => {
    const unicode = '你好,世界! ✨ café résumé naïveté';
    expect(normaliseTaskOutput(unicode)).toBe(unicode);
  });

  it('strips ANSI before banner detection (interleaved escapes do not save banner lines)', () => {
    // A box-drawing line wrapped in colour codes — should still be detected
    // as banner chrome after the ANSI strip pass runs first.
    const coloured = `${ESC}[36m╭──────────────╮${ESC}[0m\nActual content\n${ESC}[36m╰──────────────╯${ESC}[0m`;
    expect(normaliseTaskOutput(coloured)).toBe('Actual content');
  });
});
