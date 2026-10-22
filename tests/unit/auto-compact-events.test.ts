import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendAutoCompactEvents,
  readAutoCompactEvents,
  buildEventsFromSweep,
  type AutoCompactEvent,
} from '@/lib/auto-compact-events';
import type { AutoCompactSweepResult } from '@/lib/auto-compact-orchestrator';

/**
 * Sprint 38 T4.5 — JSONL event logger tests.
 */

function mkEvent(overrides: Partial<AutoCompactEvent> = {}): AutoCompactEvent {
  return {
    timestamp: '2026-04-10T21:00:00.000Z',
    channelId: 'ch-1',
    sprintId: 'sprint-1',
    agentId: 'agent-A',
    agentName: 'A',
    status: 'compacted',
    idleSeconds: 120,
    durationMs: 123,
    ...overrides,
  };
}

describe('appendAutoCompactEvents', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 't4_5_'));
    logPath = join(dir, 'nested', 'auto-compact-events.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates parent directories and the log file on first write', async () => {
    await appendAutoCompactEvents([mkEvent()], logPath);
    expect(existsSync(logPath)).toBe(true);
  });

  it('writes one JSONL line per event', async () => {
    const events = [
      mkEvent({ agentName: 'A' }),
      mkEvent({ agentName: 'B', status: 'skipped', reason: 'busy' }),
      mkEvent({ agentName: 'C', status: 'error', reason: 'tmux failed' }),
    ];
    await appendAutoCompactEvents(events, logPath);
    const raw = readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).agentName).toBe('A');
    expect(JSON.parse(lines[1]).agentName).toBe('B');
    expect(JSON.parse(lines[2]).agentName).toBe('C');
  });

  it('appends (not overwrites) existing content', async () => {
    await appendAutoCompactEvents([mkEvent({ agentName: 'first' })], logPath);
    await appendAutoCompactEvents([mkEvent({ agentName: 'second' })], logPath);

    const raw = readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).agentName).toBe('first');
    expect(JSON.parse(lines[1]).agentName).toBe('second');
  });

  it('is a no-op on empty array — file is not created', async () => {
    await appendAutoCompactEvents([], logPath);
    expect(existsSync(logPath)).toBe(false);
  });

  it('each line terminates with a newline for JSONL compatibility', async () => {
    await appendAutoCompactEvents([mkEvent()], logPath);
    const raw = readFileSync(logPath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
  });
});

describe('readAutoCompactEvents', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 't4_5_read_'));
    logPath = join(dir, 'auto-compact-events.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] when the log file does not exist', async () => {
    const events = await readAutoCompactEvents(logPath);
    expect(events).toEqual([]);
  });

  it('round-trips through appendAutoCompactEvents → readAutoCompactEvents', async () => {
    const written = [
      mkEvent({ agentName: 'X', status: 'compacted' }),
      mkEvent({ agentName: 'Y', status: 'skipped', reason: 'busy: 5s old' }),
    ];
    await appendAutoCompactEvents(written, logPath);
    const read = await readAutoCompactEvents(logPath);
    expect(read).toHaveLength(2);
    expect(read[0].agentName).toBe('X');
    expect(read[1].reason).toBe('busy: 5s old');
  });

  it('tolerates blank trailing lines', async () => {
    writeFileSync(
      logPath,
      JSON.stringify(mkEvent({ agentName: 'only' })) + '\n\n\n',
    );
    const read = await readAutoCompactEvents(logPath);
    expect(read).toHaveLength(1);
    expect(read[0].agentName).toBe('only');
  });

  it('skips corrupt lines and returns the parseable ones', async () => {
    const valid1 = JSON.stringify(mkEvent({ agentName: 'ok1' }));
    const valid2 = JSON.stringify(mkEvent({ agentName: 'ok2' }));
    writeFileSync(logPath, `${valid1}\n{not json}\n${valid2}\n`);

    const read = await readAutoCompactEvents(logPath);
    expect(read.map((e) => e.agentName)).toEqual(['ok1', 'ok2']);
  });
});

describe('buildEventsFromSweep', () => {
  it('maps sweep perAgent results → AutoCompactEvent with sweep metadata merged in', () => {
    const sweep: AutoCompactSweepResult = {
      attempted: 2,
      compacted: 1,
      skipped: 1,
      errored: 0,
      totalDurationMs: 1234,
      perAgent: [
        {
          name: 'A',
          agentId: 'a-id',
          workingDirectory: '/home/a',
          tmuxSessionName: 'ta',
          action: 'compacted',
          idleSeconds: 180,
          durationMs: 42,
        },
        {
          name: 'B',
          agentId: 'b-id',
          workingDirectory: '/home/b',
          tmuxSessionName: 'tb',
          action: 'skipped',
          reason: 'busy: 5s old',
          idleSeconds: 5,
          durationMs: 3,
        },
      ],
    };

    const events = buildEventsFromSweep(sweep, {
      channelId: 'ch-1',
      sprintId: 'sprint-xyz',
      timestamp: '2026-04-10T21:30:00.000Z',
    });

    expect(events).toHaveLength(2);

    expect(events[0]).toMatchObject({
      timestamp: '2026-04-10T21:30:00.000Z',
      channelId: 'ch-1',
      sprintId: 'sprint-xyz',
      agentId: 'a-id',
      agentName: 'A',
      workingDirectory: '/home/a',
      tmuxSessionName: 'ta',
      status: 'compacted',
      idleSeconds: 180,
      durationMs: 42,
    });
    expect(events[0].reason).toBeUndefined();

    expect(events[1]).toMatchObject({
      timestamp: '2026-04-10T21:30:00.000Z',
      channelId: 'ch-1',
      sprintId: 'sprint-xyz',
      agentId: 'b-id',
      agentName: 'B',
      status: 'skipped',
      reason: 'busy: 5s old',
      idleSeconds: 5,
      durationMs: 3,
    });
  });

  it('fills timestamp with new Date().toISOString() when omitted', () => {
    const sweep: AutoCompactSweepResult = {
      attempted: 1,
      compacted: 1,
      skipped: 0,
      errored: 0,
      totalDurationMs: 10,
      perAgent: [
        {
          name: 'A',
          agentId: 'a-id',
          workingDirectory: '/home/a',
          tmuxSessionName: 'ta',
          action: 'compacted',
          idleSeconds: 100,
          durationMs: 10,
        },
      ],
    };

    const before = Date.now();
    const events = buildEventsFromSweep(sweep, { channelId: 'ch' });
    const after = Date.now();

    const ts = Date.parse(events[0].timestamp);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
