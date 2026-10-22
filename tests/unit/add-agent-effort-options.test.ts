import { describe, expect, it } from 'vitest';

import { effortOptions } from '@/components/modals/AddAgentModal';
import type { ModelEntry } from '@/components/colab-types';

describe('Add Agent effort options', () => {
  it('offers ultra for Codex agents', () => {
    expect(effortOptions('codex', undefined)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  it('does not offer Codex-only ultra to Claude or Antigravity', () => {
    expect(effortOptions('claude', undefined)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(effortOptions('antigravity', undefined)).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  it('offers no effort override for a non-reasoning model', () => {
    const model = {
      capabilities: { reasoning: false },
    } as ModelEntry;

    expect(effortOptions('codex', model)).toEqual([]);
  });
});
