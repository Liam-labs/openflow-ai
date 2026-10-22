import { describe, it, expect } from 'vitest';
import { resolveSendContent } from '@/lib/resolve-send-content';
import { parsePrompt } from '@/lib/prompt-parser';

describe('resolveSendContent — Structure-prompt dispatch contract (T3.1)', () => {
  it('toggle OFF passes content through verbatim, even when structurable', () => {
    const raw = 'Task: build a REST endpoint\nConstraints:\n- validate email\nRespond as JSON';
    expect(resolveSendContent(raw, false)).toBe(raw);
  });

  it('toggle ON sends a trivial message untouched (parser passthrough)', () => {
    expect(resolveSendContent('hi', true)).toBe('hi');
  });

  it('toggle ON forwards the parser\'s structured output for a structurable prompt', () => {
    const raw = 'Task: build a REST endpoint\nConstraints:\n- validate email\nRespond as JSON';
    const parsed = parsePrompt(raw);
    // Guard: this fixture really does restructure — protects against a false pass
    // if the parser ever decided to passthrough it.
    expect(parsed.wasStructured).toBe(true);
    expect(resolveSendContent(raw, true)).toBe(parsed.structured);
    expect(resolveSendContent(raw, true)).not.toBe(raw);
  });

  it('toggle ON is a no-op for empty content', () => {
    expect(resolveSendContent('', true)).toBe('');
  });
});
