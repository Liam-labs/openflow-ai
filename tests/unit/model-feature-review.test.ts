import { describe, expect, it } from 'vitest';
import { returnToFor } from '@/lib/model-feature-client';
import { initialCardState, nextCardState, type ModelFeatureInfo } from '@/lib/model-feature-card';

describe('review: real return-trip boundaries', () => {
  it('preserves the settings section when returning from Connections', () => {
    const location = { pathname: '/operations', search: '?tab=automation', hash: '#systems/automation' };
    expect(returnToFor(location)).toBe('/operations?tab=automation#systems/automation');
  });
  it('resumes an already-confirmed provider change on a feature that was already on', () => {
    const feature: ModelFeatureInfo = {
      id: 'knowledge-update', name: 'Knowledge update', ready: true, enabled: true,
      active: { provider: 'anthropic', model: 'claude-existing' },
      recommended: { provider: 'deepseek', model: 'deepseek-chat', reason: 'Cost only' },
      dataSent: ['Notes'], keyConfigured: true,
    };
    const state = nextCardState(initialCardState(feature), {
      type: 'resume', choice: { provider: 'deepseek', model: 'deepseek-chat' }, level: null,
    });
    expect(state.request).toEqual({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' });
  });
});
