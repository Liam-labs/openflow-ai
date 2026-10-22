/**
 * Restart grace window for agents whose folders are on the agent host (21 Oct 2026): the server watched ITS OWN disk for the agent's
 * "saved my notes" files, so for a desktop agent nothing ever changed and every restart waited the full cap. The watch now asks the
 * host (real host op through a helper process); an agent whose folders are here is watched locally, as before.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

let server: ChildProcessWithoutNullStreams;
const pending: Array<(line: string) => void> = [];
let hostOffline = false;
let filesHost: string | null = 'desk';
const events: string[] = [];
let calls: string[] = [];

vi.mock('@/lib/tmux-send', () => ({ tmuxSendKeys: async () => {} }));
vi.mock('@/lib/log-writer', () => ({ logEvent: async (_a: string, _b: string, message: string) => { events.push(message); } }));
vi.mock('@/lib/host-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/host-executor')>();
  return {
    ...actual,
    filesHostFor: () => filesHost,
    tmuxRun: async () => ({ stdout: '', stderr: '' }),
    hostCall: (_host: string, op: string, args: Record<string, unknown>) => new Promise<unknown>((resolveCall, reject) => {
      calls.push(op);
      if (hostOffline) { reject(Object.assign(new Error('late'), { code: 'EHOSTTIMEOUT' })); return; }
      pending.push((line) => {
        const reply = JSON.parse(line) as { ok: boolean; result?: unknown; error?: string };
        if (reply.ok) resolveCall(reply.result); else reject(Object.assign(new Error(reply.error), { code: 'EHOSTOP' }));
      });
      server.stdin.write(JSON.stringify({ op, args }) + '\n');
    }),
  };
});

import { flushAgentMemory } from '@/app/api/collab/pty/_handlers/message-inject';
import type { AgentRosterEntry } from '@/lib/types';

let root: string;
let hostHome: string;
let dir: string;
const agent = () => ({ id: 'a1', participantId: 'p1', name: 'Builder', channelId: 'c1', workingDirectory: dir, tmuxSessionName: 'collab-agent-x', agentType: 'claude', status: 'running' }) as unknown as AgentRosterEntry;
const last = () => events[events.length - 1] ?? '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'restart-grace-'));
  hostHome = join(root, 'host');
  dir = join(hostHome, 'SG-1', 'Team', 'Builder');
  mkdirSync(join(dir, 'logs'), { recursive: true });
  server = spawn('python3', ['-B', resolve('tests/helpers/hostd_op_server.py'), hostHome, join(hostHome, 'SG-1')], { stdio: ['pipe', 'pipe', 'inherit'] }) as ChildProcessWithoutNullStreams;
  createInterface({ input: server.stdout }).on('line', (text) => pending.shift()?.(text));
});
afterAll(() => { server.kill(); rmSync(root, { recursive: true, force: true }); });

describe('flushAgentMemory for an agent whose folders are on the agent host', () => {
  it('ends early once the host shows the notes were saved and settled', async () => {
    filesHost = 'desk'; calls = [];
    const started = Date.now();
    const run = flushAgentMemory('c1', agent(), { graceMs: 15_000 });
    setTimeout(() => writeFileSync(join(dir, 'logs', 'today.md'), 'saved\n'), 1_200);
    await run;
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(last()).toContain('outcome=early-exit');
    expect(last()).toContain('saved=today.md');
    expect(calls.every((c) => c === 'save-mtimes')).toBe(true);
  }, 30_000);

  it('sees the agent\'s auto-memory file under the HOST\'s home, not this machine\'s', async () => {
    filesHost = 'desk'; calls = [];
    const mem = join(hostHome, '.claude', 'projects', dir.replace(/\//g, '-'), 'memory');
    mkdirSync(mem, { recursive: true });
    const run = flushAgentMemory('c1', agent(), { graceMs: 15_000 });
    setTimeout(() => writeFileSync(join(mem, 'MEMORY.md'), 'saved\n'), 1_200);
    await run;
    expect(last()).toContain('outcome=early-exit');
    expect(last()).toContain('saved=MEMORY.md');
  }, 30_000);

  it('waits the whole cap when nothing is saved', async () => {
    filesHost = 'desk';
    const started = Date.now();
    await flushAgentMemory('c1', agent(), { graceMs: 2_500 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_400);
    expect(last()).toContain('outcome=cap');
  }, 20_000);

  it('does not fail when the host does not answer: it just waits the cap', async () => {
    filesHost = 'desk'; hostOffline = true;
    try {
      await flushAgentMemory('c1', agent(), { graceMs: 1_600 });
      expect(last()).toContain('outcome=cap');
    } finally {
      hostOffline = false;
    }
  }, 20_000);
});

describe('flushAgentMemory for an agent whose folders are on this machine', () => {
  it('still watches the local disk and never asks a host', async () => {
    filesHost = null; calls = [];
    const local = join(root, 'local', 'Team', 'Mine');
    mkdirSync(join(local, 'logs'), { recursive: true });
    const a = { ...agent(), workingDirectory: local } as AgentRosterEntry;
    const run = flushAgentMemory('c1', a, { graceMs: 15_000 });
    setTimeout(() => writeFileSync(join(local, 'logs', 'handoff.md'), 'saved\n'), 1_200);
    await run;
    expect(last()).toContain('outcome=early-exit');
    expect(last()).toContain('saved=handoff.md');
    expect(calls).toEqual([]);
  }, 30_000);
});
