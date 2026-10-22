import { describe, it, expect } from 'vitest';
import { emblemFamily, emblemState } from '@/lib/model-emblem';

describe('emblemFamily', () => {
  it('maps model ids to families', () => {
    expect(emblemFamily('claude-sonnet-5-5')).toBe('claude');
    expect(emblemFamily('opus')).toBe('claude');
    expect(emblemFamily('gpt-6-astra')).toBe('openai');
    expect(emblemFamily('gemini-3-pro')).toBe('gemini');
    expect(emblemFamily('grok-5')).toBe('grok');
    expect(emblemFamily('deepseek-v4')).toBe('deepseek');
    expect(emblemFamily('v4')).toBe('deepseek');
  });
  it('has no emblem without a model', () => {
    expect(emblemFamily(null)).toBeNull();
    expect(emblemFamily(undefined)).toBeNull();
    expect(emblemFamily('')).toBeNull();
  });
});

describe('emblemState', () => {
  it('is idle when not working', () => {
    expect(emblemState(null, null)).toBe('idle');
    expect(emblemState(undefined, 'Thinking...')).toBe('idle');
  });
  it('is thinking with no detail or a thinking label', () => {
    expect(emblemState('working', null)).toBe('thinking');
    expect(emblemState('working', 'Thinking...')).toBe('thinking');
    expect(emblemState('working', 'Reasoning…')).toBe('thinking');
  });
  it('is tool for tool labels', () => {
    expect(emblemState('working', 'Running command…')).toBe('tool');
    expect(emblemState('working', 'Reading file...')).toBe('tool');
    expect(emblemState('working', 'Editing...')).toBe('tool');
  });
  it('is writing while typing a reply', () => {
    expect(emblemState('typing', null)).toBe('writing');
    expect(emblemState('working', 'Writing reply…')).toBe('writing');
  });
});
