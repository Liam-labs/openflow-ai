import { describe, it, expect } from 'vitest';
import { findSilentAgents, plainSession, SILENT_AFTER_MS } from '@/lib/silent-agents';

const T0 = Date.parse('2026-11-04T10:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const roster = [{ name: 'Lead', participantId: 'a1', tmuxSessionName: 'collab-lead-1', status: 'running' }];
const ask = (over = {}) => ({ id: 'm1', from: { id: 'u', type: 'user' }, content: '@Lead hello', timestamp: at(0), ...over });
const run = (messages: ReturnType<typeof ask>[], nowMs: number, extra: Partial<Parameters<typeof findSilentAgents>[0]> = {}) =>
  findSilentAgents({ messages, roster, participants: [], now: T0 + nowMs, ...extra });

describe('findSilentAgents', () => {
  it('waits the full 45 seconds before calling an agent silent, then names the command', () => {
    expect(run([ask()], SILENT_AFTER_MS - 1)).toMatchObject({ silent: [], pending: [{ name: 'Lead', dueAt: T0 + SILENT_AFTER_MS }] });
    const r = run([ask()], SILENT_AFTER_MS);
    expect(r.pending).toEqual([]);
    expect(r.silent[0]).toMatchObject({ name: 'Lead', tmuxSession: 'collab-lead-1' });
  });

  it('is not silent once the agent has said anything after the question', () => {
    const reply = { id: 'm2', from: { id: 'a1', type: 'claude-terminal' }, content: 'hi', timestamp: at(10_000) };
    expect(run([ask(), reply], 120_000).silent).toEqual([]);
  });

  it('an old reply from before the latest question does not count', () => {
    const old = { id: 'm0', from: { id: 'a1', type: 'claude-terminal' }, content: 'earlier', timestamp: at(-60_000) };
    expect(run([old, ask()], 60_000).silent).toHaveLength(1);
  });

  it('finds the agent by recipient id as well as by @name', () => {
    const msg = ask({ content: 'are you there?', recipients: ['a1'] });
    expect(run([msg], 60_000).silent).toHaveLength(1);
    expect(run([ask({ content: 'not for you, @Leader' })], 60_000).silent).toEqual([]);
  });

  it('ignores stopped agents, busy agents, broadcasts to nobody, and questions older than 15 minutes', () => {
    expect(findSilentAgents({ messages: [ask()], roster: [{ ...roster[0], status: 'stopped' }], participants: [], now: T0 + 60_000 }).silent).toEqual([]);
    expect(run([ask()], 60_000, { participants: [{ id: 'a1', activityStatus: 'working' }] }).silent).toEqual([]);
    expect(run([ask({ content: 'general chat' })], 60_000).silent).toEqual([]);
    expect(run([ask()], 16 * 60_000).silent).toEqual([]);
  });

  it('does not count an agent talking to the agent as the person asking', () => {
    expect(run([ask({ from: { id: 'a2', type: 'claude-terminal' } })], 60_000).silent).toEqual([]);
  });
});

describe('plainSession', () => {
  it('only passes a plain tmux session name on', () => {
    expect(plainSession('collab-lead-1')).toBe('collab-lead-1');
    expect(plainSession(undefined)).toBeUndefined();
    expect(plainSession('x; rm -rf ~')).toBeUndefined();
    expect(plainSession('a b')).toBeUndefined();
  });
});
