import { describe, expect, it } from 'vitest';
import { buildRestartResumeText, formatShutdownTime } from '@/lib/agent-restart-notice';

describe('buildRestartResumeText', () => {
  it('addresses the agent, states the shutdown time and points at the handoff', () => {
    const text = buildRestartResumeText('Builder', '2026-09-28T01:40:17.000Z');
    expect(text.startsWith('@Builder ')).toBe(true);
    expect(text).toContain('restarted after an unexpected shutdown at');
    expect(text).toContain(formatShutdownTime('2026-09-28T01:40:17.000Z'));
    expect(text).toContain('logs/handoff.md');
    expect(text).toContain('Do not re-answer');
  });

  it('keeps an unparseable timestamp verbatim instead of printing Invalid Date', () => {
    expect(formatShutdownTime('not-a-date')).toBe('not-a-date');
    expect(buildRestartResumeText('Vala', 'not-a-date')).not.toContain('Invalid Date');
  });
});
