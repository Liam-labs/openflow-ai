import { describe, it, expect } from 'vitest';
import { getModelLabel, isReasoningOnlyModel } from '../../lib/model-label';

const registry = [
  { id: 'opus', label: 'Opus', apiId: 'claude-opus-4-6[1m]' },
  { id: 'sonnet', label: 'Sonnet', apiId: 'claude-sonnet-4-6[1m]' },
  { id: 'haiku', label: 'Haiku', apiId: 'claude-haiku-4-5-20251001' },
  { id: 'grok-4.20', label: 'Grok 4.20', apiId: 'grok-4-20' },
];

describe('getModelLabel', () => {
  it('returns empty string for falsy modelId', () => {
    expect(getModelLabel(undefined, registry)).toBe('');
    expect(getModelLabel('', registry)).toBe('');
    expect(getModelLabel(null as unknown as string, registry)).toBe('');
  });

  it('returns the registry label verbatim, never bolting on a [1m] suffix', () => {
    // The 1M-context distinction lives in the registry label itself
    // (e.g. "Opus 4.8 · 1M"), not in an auto-appended suffix.
    expect(getModelLabel('sonnet', registry)).toBe('Sonnet');
    expect(getModelLabel('opus', registry)).toBe('Opus');
    expect(getModelLabel('haiku', registry)).toBe('Haiku');
    expect(getModelLabel('grok-4.20', registry)).toBe('Grok 4.20');
  });

  it('uses the canonical label for a persisted provider alias', () => {
    const withAlias = [
      { id: 'deepseek-flash', aliases: ['deepseek-v4-flash'], label: 'DeepSeek V4.1 Flash' },
    ];
    expect(getModelLabel('deepseek-v4-flash', withAlias)).toBe('DeepSeek V4.1 Flash');
  });

  it('falls back to capitalized id when model not in registry', () => {
    expect(getModelLabel('mystery', registry)).toBe('Mystery');
    expect(getModelLabel('gemini-3-flash-preview', registry)).toBe('Gemini-3-flash-preview');
  });

  it('falls back to capitalized id when registry is empty', () => {
    expect(getModelLabel('sonnet', [])).toBe('Sonnet');
  });

  it('uses capitalized id when registry entry has no label (ignores apiId 1m marker)', () => {
    const noLabel = [{ id: 'sonnet', apiId: 'claude-sonnet-4-6[1m]' }];
    expect(getModelLabel('sonnet', noLabel)).toBe('Sonnet');
  });

  it('uses capitalized id when registry entry has no apiId', () => {
    const noApiId = [{ id: 'sonnet', label: 'Sonnet' }];
    expect(getModelLabel('sonnet', noApiId)).toBe('Sonnet');
  });

  it('returns the label as-is regardless of any [1m] in the apiId', () => {
    const oneM = [{ id: 'weird', label: 'Weird', apiId: 'foo[1m]' }];
    expect(getModelLabel('weird', oneM)).toBe('Weird');
  });

  it('trims registry lookup to exact id match', () => {
    expect(getModelLabel('son', registry)).toBe('Son');
  });
});

const grokRegistry = [
  { id: 'grok-4', label: 'Grok 4', capabilities: { reasoningOnly: true } },
  { id: 'grok-4.20', label: 'Grok 4.20', capabilities: { reasoningOnly: false } },
  { id: 'grok-4-1-fast', label: 'Grok 4.1 Fast', capabilities: {} },
  { id: 'grok-no-caps', label: 'Grok NoCaps' },
];

describe('isReasoningOnlyModel', () => {
  it('returns true when capabilities.reasoningOnly is true', () => {
    expect(isReasoningOnlyModel('grok-4', grokRegistry)).toBe(true);
  });

  it('returns false when capabilities.reasoningOnly is false', () => {
    expect(isReasoningOnlyModel('grok-4.20', grokRegistry)).toBe(false);
  });

  it('returns false when capabilities.reasoningOnly is unset', () => {
    expect(isReasoningOnlyModel('grok-4-1-fast', grokRegistry)).toBe(false);
  });

  it('returns false when model entry has no capabilities', () => {
    expect(isReasoningOnlyModel('grok-no-caps', grokRegistry)).toBe(false);
  });

  it('returns false when model is not in registry', () => {
    expect(isReasoningOnlyModel('unknown', grokRegistry)).toBe(false);
  });

  it('returns false for falsy modelId', () => {
    expect(isReasoningOnlyModel(undefined, grokRegistry)).toBe(false);
    expect(isReasoningOnlyModel('', grokRegistry)).toBe(false);
    expect(isReasoningOnlyModel(null as unknown as string, grokRegistry)).toBe(false);
  });

  it('returns false when registry is empty', () => {
    expect(isReasoningOnlyModel('grok-4', [])).toBe(false);
  });
});
