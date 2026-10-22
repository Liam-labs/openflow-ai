import { describe, expect, it } from 'vitest';
import { providerNames } from '@/lib/model-provider-names';

describe('providerNames', () => {
  const models = [{ provider: 'google' }, { provider: 'anthropic' }, { provider: 'google' }, {}];

  it('takes the names from the models when the API gives none', () => {
    expect(providerNames({ models })).toEqual(['anthropic', 'google']);
  });

  it('copes with the real API answer, where providers is an object of sign-in states', () => {
    const names = providerNames({ models, providers: { xai: { configured: false }, anthropic: { configured: true } } });
    expect(Array.isArray(names)).toBe(true);
    expect(names).toEqual(['anthropic', 'google', 'xai']);
    expect(providerNames({ models: [], providers: {} })).toEqual([]);
    expect(providerNames({ models: [], providers: { '': {}, a: {} } })).toEqual(['a']);
  });

  it('accepts a plain list, ignores blanks and non-text entries', () => {
    expect(providerNames({ models: [], providers: ['b', '', 'a', 3 as unknown as string, 'b'] })).toEqual(['a', 'b']);
  });

  it('never throws on an empty or odd response', () => {
    expect(providerNames({})).toEqual([]);
    expect(providerNames({ providers: null })).toEqual([]);
    expect(providerNames({ providers: 'google' })).toEqual([]);
  });
});
