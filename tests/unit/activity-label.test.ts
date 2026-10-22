import { describe, it, expect } from 'vitest';
import { resolveActivityLabel } from '../../lib/activity-label';

describe('resolveActivityLabel', () => {
  it('returns null when agent is not working', () => {
    expect(resolveActivityLabel(null, false)).toBeNull();
    expect(resolveActivityLabel('Reading file...', false)).toBeNull();
  });

  it('returns activityDetail when present and working', () => {
    expect(resolveActivityLabel('Reading file...', true)).toBe('Reading file...');
    expect(resolveActivityLabel('Editing...', true)).toBe('Editing...');
    expect(resolveActivityLabel('Running command...', true)).toBe('Running command...');
    expect(resolveActivityLabel('Thinking...', true)).toBe('Thinking...');
    expect(resolveActivityLabel('Searching...', true)).toBe('Searching...');
    expect(resolveActivityLabel('Delegating...', true)).toBe('Delegating...');
  });

  it('falls back to "Working..." when activityDetail is null', () => {
    expect(resolveActivityLabel(null, true)).toBe('Working...');
  });

  it('falls back to "Working..." when activityDetail is undefined', () => {
    expect(resolveActivityLabel(undefined, true)).toBe('Working...');
  });

  it('falls back to "Working..." when activityDetail is empty string', () => {
    expect(resolveActivityLabel('', true)).toBe('Working...');
  });
});
