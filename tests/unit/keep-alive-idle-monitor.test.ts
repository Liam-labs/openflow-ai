import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cron-scheduler', () => ({ cronScheduler: { reloadJobs: vi.fn() } }));

import { nextIdleTimerAction } from '@/app/api/agent/actions/keep-alive';

describe('keep-alive idle monitor timer rule', () => {
  it('starts a nudge timer when an agent first goes idle', () => {
    expect(nextIdleTimerAction('idle', false)).toBe('start');
  });
  it('keeps the running timer on repeated idle heartbeats (they arrive every 30s)', () => {
    expect(nextIdleTimerAction('idle', true)).toBe('keep');
  });
  it('cancels the nudge as soon as the agent is working or typing again', () => {
    expect(nextIdleTimerAction('working', true)).toBe('cancel');
    expect(nextIdleTimerAction('typing', true)).toBe('cancel');
  });
  it('does nothing for a busy agent with no timer', () => {
    expect(nextIdleTimerAction('working', false)).toBe('keep');
  });
});
