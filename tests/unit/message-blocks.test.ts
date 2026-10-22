import { describe, it, expect } from 'vitest';
import { hasBlockMarkdown, parseBlocks } from '@/lib/message-parser';

describe('hasBlockMarkdown', () => {
  it('false for plain prose', () => {
    expect(hasBlockMarkdown('just a normal sentence')).toBe(false);
  });
  it('false for inline-only markup (bold/code)', () => {
    expect(hasBlockMarkdown('some **bold** and `code` here')).toBe(false);
  });
  it('false when ## / - only appear INSIDE a fenced code block', () => {
    expect(hasBlockMarkdown('intro\n```md\n## not a heading\n- not a bullet\n```')).toBe(false);
  });
  it('true for a heading line', () => {
    expect(hasBlockMarkdown('## Section')).toBe(true);
  });
  it('true for a bullet line', () => {
    expect(hasBlockMarkdown('- item one')).toBe(true);
  });
  it('true for an ordered list line', () => {
    expect(hasBlockMarkdown('1. first')).toBe(true);
  });
  it('does not trip on bold-at-line-start (no space after *)', () => {
    expect(hasBlockMarkdown('*important* note')).toBe(false);
  });
});

describe('parseBlocks', () => {
  it('parses an H2 heading', () => {
    expect(parseBlocks('## Plan')).toEqual([{ type: 'heading', level: 2, text: 'Plan' }]);
  });
  it('groups consecutive bullets into one unordered list', () => {
    expect(parseBlocks('- a\n- b\n- c')).toEqual([
      { type: 'list', ordered: false, items: ['a', 'b', 'c'] },
    ]);
  });
  it('groups consecutive numbers into one ordered list', () => {
    expect(parseBlocks('1. a\n2. b')).toEqual([
      { type: 'list', ordered: true, items: ['a', 'b'] },
    ]);
  });
  it('separates heading + paragraph + list', () => {
    expect(parseBlocks('## Plan\n\nSteps:\n\n- one\n- two')).toEqual([
      { type: 'heading', level: 2, text: 'Plan' },
      { type: 'paragraph', text: 'Steps:' },
      { type: 'list', ordered: false, items: ['one', 'two'] },
    ]);
  });
  it('keeps fenced code opaque (no heading/bullet parsing inside)', () => {
    expect(parseBlocks('intro\n```js\n## x\n- y\n```\nouttro')).toEqual([
      { type: 'paragraph', text: 'intro' },
      { type: 'fence', value: '```js\n## x\n- y\n```' },
      { type: 'paragraph', text: 'outtro' },
    ]);
  });
  it('preserves internal newlines in a paragraph run', () => {
    expect(parseBlocks('## H\nline1\nline2')).toEqual([
      { type: 'heading', level: 2, text: 'H' },
      { type: 'paragraph', text: 'line1\nline2' },
    ]);
  });
});
