import { describe, it, expect } from 'vitest';
import { applyFormat } from '@/lib/input-formatting';

describe('applyFormat — inline-code', () => {
  it('inserts a backtick pair with the caret between them when there is no selection', () => {
    const r = applyFormat('inline-code', 'hi', 2, 2);
    expect(r.value).toBe('hi``');
    expect(r.selStart).toBe(3);
    expect(r.selEnd).toBe(3);
  });

  it('wraps the current selection and keeps the inner text selected', () => {
    const r = applyFormat('inline-code', 'hello world', 6, 11);
    expect(r.value).toBe('hello `world`');
    expect(r.selStart).toBe(7);
    expect(r.selEnd).toBe(12);
  });

  it('toggles off when the selection is already wrapped', () => {
    const r = applyFormat('inline-code', 'hello `world`', 6, 13);
    expect(r.value).toBe('hello world');
    expect(r.selStart).toBe(6);
    expect(r.selEnd).toBe(11);
  });
});

describe('applyFormat — bullet', () => {
  it('prefixes a single line and selects the resulting block', () => {
    const r = applyFormat('bullet', 'item', 2, 2);
    expect(r.value).toBe('- item');
    expect(r.selStart).toBe(0);
    expect(r.selEnd).toBe(6);
  });

  it('prefixes every line in a multi-line selection', () => {
    const r = applyFormat('bullet', 'a\nb', 0, 3);
    expect(r.value).toBe('- a\n- b');
    expect(r.selStart).toBe(0);
    expect(r.selEnd).toBe(7);
  });

  it('toggles bullets off when every line already has them', () => {
    const r = applyFormat('bullet', '- a\n- b', 0, 7);
    expect(r.value).toBe('a\nb');
    expect(r.selStart).toBe(0);
    expect(r.selEnd).toBe(3);
  });
});

describe('applyFormat — heading', () => {
  it('prefixes the line with "## "', () => {
    const r = applyFormat('heading', 'Title', 0, 0);
    expect(r.value).toBe('## Title');
    expect(r.selStart).toBe(0);
    expect(r.selEnd).toBe(8);
  });

  it('toggles the heading off', () => {
    const r = applyFormat('heading', '## Title', 0, 8);
    expect(r.value).toBe('Title');
    expect(r.selStart).toBe(0);
    expect(r.selEnd).toBe(5);
  });
});

describe('applyFormat — code-block', () => {
  it('inserts an empty fence with the caret on the middle line', () => {
    const r = applyFormat('code-block', '', 0, 0);
    expect(r.value).toBe('```\n\n```');
    expect(r.selStart).toBe(4);
    expect(r.selEnd).toBe(4);
  });

  it('separates the fence from preceding text with a newline', () => {
    const r = applyFormat('code-block', 'abc', 3, 3);
    expect(r.value).toBe('abc\n```\n\n```');
    expect(r.selStart).toBe(8);
    expect(r.selEnd).toBe(8);
  });

  it('wraps a selection in a fenced block and selects the inner code', () => {
    const r = applyFormat('code-block', 'see code', 4, 8);
    expect(r.value).toBe('see \n```\ncode\n```');
    expect(r.selStart).toBe(9);
    expect(r.selEnd).toBe(13);
  });
});
