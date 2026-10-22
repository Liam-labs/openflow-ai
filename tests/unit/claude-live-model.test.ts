import { describe, expect, it } from 'vitest';
import { modelSwitchState } from '@/lib/claude-live-model';

describe('modelSwitchState', () => {
  it('sees the success line for the requested model', () => {
    expect(modelSwitchState('❯ /model claude-sonnet-5-5\n  ⎿  Set model to claude-sonnet-5-5 and saved as your default', 'claude-sonnet-5-5')).toBe('applied');
    expect(modelSwitchState('❯ /model claude-opus-5-5\n  ⎿  Set model to Opus 5.5 and saved as your default', 'claude-opus-5-5')).toBe('applied');
  });
  it('confirms only when Yes is the highlighted option', () => {
    expect(modelSwitchState('   Switch model?\n   ❯ 1. Yes, switch to Sonnet 5.5\n     2. No, go back', 'claude-sonnet-5-5')).toBe('confirm');
    expect(modelSwitchState('   Switch model?\n     1. Yes, switch\n   ❯ 2. No, go back', 'claude-sonnet-5-5')).toBe('waiting');
  });
  it('does not mistake a different model for success', () => {
    expect(modelSwitchState('❯ /model claude-opus-5-5\n  ⎿  Set model to Opus 5.5\n❯ /model claude-sonnet-5-5', 'claude-sonnet-5-5')).toBe('waiting');
  });
});
