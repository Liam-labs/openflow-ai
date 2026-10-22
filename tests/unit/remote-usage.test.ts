/**
 * Usage panel and frozen-agent check for agents whose transcripts are on the agent host (21 Oct 2026: DevFlow moved to the server,
 * so every usage figure read 0 and the liveness signal was blank). The TypeScript is driven against the REAL host ops
 * (scripts/hostd_usage.py through agent-hostd) served by a helper process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

let server: ChildProcessWithoutNullStreams;
const pending: Array<(line: string) => void> = [];
let hostCalls: Array<{ op: string; action?: string }> = [];
let hostOffline = false;
let channels: unknown = { channels: [], lastUpdated: '' };

vi.mock('@/lib/host-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/host-executor')>();
  return {
    ...actual,
    hostCall: (_host: string, op: string, args: Record<string, unknown>) => new Promise<unknown>((resolveCall, reject) => {
      hostCalls.push({ op, action: args.action as string | undefined });
      if (hostOffline) { reject(Object.assign(new Error('late'), { code: 'EHOSTTIMEOUT' })); return; }
      pending.push((line) => {
        const reply = JSON.parse(line) as { ok: boolean; result?: unknown; error?: string };
        if (reply.ok) resolveCall(reply.result); else reject(Object.assign(new Error(reply.error), { code: 'EHOSTOP' }));
      });
      server.stdin.write(JSON.stringify({ op, args }) + '\n');
    }),
  };
});
vi.mock('@/lib/data-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/data-io')>();
  return { ...actual, readJsonFile: async (file: string, fallback: unknown) => (String(file).includes('collab-channels') ? channels : fallback) };
});

import { getChannelAgentUsage, getGlobalUsageSummary, getUsageLimits } from '@/lib/token-usage';
import { remoteFilesSince, remoteFile, remoteTranscriptMtime, resetRemoteMtimes, resetRemoteUsageCache, settleRemoteMtimes } from '@/lib/remote-usage';
import { resolveJsonlMtimeMs } from '@/lib/frozen-detection-jsonl';

let root: string;
let hostHome: string;
let localHome: string;
const rec = (inp: number, out: number, at: string, model = 'claude-sonnet-5-5') =>
  JSON.stringify({ type: 'assistant', timestamp: at, message: { model, usage: { input_tokens: inp, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } } }) + '\n';
const key = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, '-');
const agentDir = () => join(hostHome, 'SG-1', 'Team', 'Builder');
const projDir = () => join(hostHome, '.claude', 'projects', key(agentDir()));
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'remote-usage-'));
  hostHome = join(root, 'host');
  localHome = join(root, 'local');
  mkdirSync(join(agentDir(), '.session-scratch'), { recursive: true });
  mkdirSync(projDir(), { recursive: true });
  mkdirSync(join(localHome, '.claude', 'projects'), { recursive: true });
  server = spawn('python3', ['-B', resolve('tests/helpers/hostd_op_server.py'), hostHome, join(hostHome, 'SG-1')], { stdio: ['pipe', 'pipe', 'inherit'] }) as ChildProcessWithoutNullStreams;
  createInterface({ input: server.stdout }).on('line', (text) => pending.shift()?.(text));
  vi.stubEnv('HOME', localHome);
  vi.stubEnv('DEVFLOW_AGENT_HOST', 'desk');
});
afterAll(() => { server.kill(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
beforeEach(() => { hostCalls = []; hostOffline = false; resetRemoteUsageCache(); resetRemoteMtimes(); });

/** The host answers from its background index (stale-while-revalidate), and the summary has its own 5 s cache: poll until the answer arrives. */
async function eventually<T>(get: () => Promise<T>, ok: (value: T) => boolean, seconds = 20): Promise<T> {
  let value = await get();
  for (let i = 0; i < seconds && !ok(value); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    resetRemoteUsageCache();
    value = await get();
  }
  return value;
}

/** The host builds its index in the background: ask until its first pass is done. */
async function untilReady() {
  for (let i = 0; i < 100; i++) {
    const files = await remoteFilesSince(0);
    resetRemoteUsageCache();
    if (files.length) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('host index never became ready');
}

describe('usage on the agent host', () => {
  let session: string;
  beforeAll(async () => {
    session = join(projDir(), '38402b66-aaaa-bbbb-cccc-000000000001.jsonl');
    writeFileSync(session, rec(100, 50, iso(60_000)) + rec(200, 80, iso(30_000)) + '{"type":"user"}\n');
    await untilReady();
  });

  it('the global summary and its model breakdown include the host\'s sessions', async () => {
    const summary = await getGlobalUsageSummary();
    expect(summary.sessionCount).toBe(1);
    expect(summary.todayTokens.inputTokens).toBe(300);
    expect(summary.todayTokens.outputTokens).toBe(130);
    expect(summary.todayTokens.cacheReadTokens).toBe(2000);
    expect(summary.modelBreakdown.map((m) => m.modelId)).toEqual(['claude-sonnet-5-5']);
  });

  it('each agent in a channel shows the usage of its transcript on the host, found like the Live Feed finds it', async () => {
    channels = { channels: [{ id: 'c1', roster: { agents: [
      { id: 'a1', participantId: 'p-builder', name: 'Builder', channelId: 'c1', workingDirectory: agentDir(), status: 'running' },
      { id: 'a2', participantId: 'p-none', name: 'Nobody', channelId: 'c1', workingDirectory: join(hostHome, 'SG-1', 'Team', 'Nobody'), status: 'running' },
    ] } }], lastUpdated: '' };
    const usage = await getChannelAgentUsage('c1');
    const builder = usage.agents.find((a) => a.agentName === 'Builder')!;
    expect(builder.tokens).toEqual({ inputTokens: 300, outputTokens: 130, cacheReadTokens: 2000, cacheCreationTokens: 20 });
    expect(builder.totalTokens).toBe(430);
    expect(builder.messageCount).toBe(2);
    expect(builder.sessionId).toBe('38402b66-aaaa-bbbb-cccc-000000000001');
    expect(usage.agents.find((a) => a.agentName === 'Nobody')!.totalTokens).toBe(0);
    expect(usage.total.totalTokens).toBe(430);
  });

  it('a recorded session id points at that session rather than the newest one', async () => {
    const older = join(projDir(), 'older-session.jsonl');
    writeFileSync(older, rec(7, 3, iso(3_000_000)));
    utimesSync(older, new Date(Date.now() - 3_000_000), new Date(Date.now() - 3_000_000));   // older than the other session, so only the recorded id can find it
    channels = { channels: [{ id: 'c2', roster: { agents: [
      { id: 'a1', participantId: 'p-builder', name: 'Builder', channelId: 'c2', workingDirectory: agentDir(), lastClaudeSessionId: 'older-session', status: 'running' },
    ] } }], lastUpdated: '' };
    const usage = await eventually(() => getChannelAgentUsage('c2'), (u) => u.agents[0].tokens.inputTokens > 0);
    expect(usage.agents[0].sessionId).toBe('older-session');
    expect(usage.agents[0].tokens.inputTokens).toBe(7);
  }, 40_000);

  it('only Claude agents are read from the host (other runtimes keep their own accounting)', async () => {
    channels = { channels: [{ id: 'c3', roster: { agents: [
      { id: 'a9', participantId: 'p-codex', name: 'Codexer', channelId: 'c3', workingDirectory: agentDir(), agentType: 'codex', status: 'running' },
    ] } }], lastUpdated: '' };
    const usage = await getChannelAgentUsage('c3');
    expect(usage.agents[0].totalTokens).toBe(0);
    expect(hostCalls.filter((c) => c.op === 'usage-facts' && c.action === 'file')).toEqual([]);
  });

  it('with no agent host configured, a channel\'s usage asks the host for nothing', async () => {
    vi.stubEnv('DEVFLOW_AGENT_HOST', '');
    try {
      channels = { channels: [{ id: 'c4', roster: { agents: [
        { id: 'a1', participantId: 'p-builder', name: 'Builder', channelId: 'c4', workingDirectory: agentDir(), status: 'running' },
      ] } }], lastUpdated: '' };
      hostCalls = [];
      await getChannelAgentUsage('c4');
      expect(hostCalls).toEqual([]);
    } finally {
      vi.stubEnv('DEVFLOW_AGENT_HOST', 'desk');
    }
  });

  it('the daily reset follows the earliest message on EITHER machine', async () => {
    const localProj = join(localHome, '.claude', 'projects', '-loc');
    mkdirSync(localProj, { recursive: true });
    writeFileSync(join(localProj, 'l.jsonl'), rec(5, 5, iso(600_000)));                       // here: 10 minutes ago
    const limits = await eventually(() => getUsageLimits(), (l) => new Date(l.daily.resetTime).getTime() - Date.now() > 4 * 3_600_000 - 600_000 && new Date(l.daily.resetTime).getTime() - Date.now() < 4.5 * 3_600_000);
    const untilReset = new Date(limits.daily.resetTime).getTime() - Date.now();
    expect(untilReset).toBeGreaterThan(4 * 3_600_000 + 5 * 60_000);                        // host's earliest (about 50 min ago) + 5 h, not this machine's (10 min ago) + 5 h
    expect(untilReset).toBeLessThan(4 * 3_600_000 + 20 * 60_000);
    rmSync(localProj, { recursive: true, force: true });
  }, 40_000);

  it('the rolling-window limit counts the host\'s recent messages', async () => {
    const limits = await getUsageLimits();
    expect(limits.daily.usedTokens).toBeGreaterThan(0);
  });

  it('the weekly figure counts the host\'s sessions too', async () => {
    const limits = await getUsageLimits();
    expect(limits.weekly.usedTokens).toBeGreaterThanOrEqual(1000 + 1000);   // both messages of the session, cache included
  });

  it('a host that does not answer leaves the figures at what this machine has instead of failing', async () => {
    resetRemoteUsageCache();
    hostOffline = true;
    const summary = await getGlobalUsageSummary();
    expect(summary.todayTokens.totalTokens).toBe(0);
    expect(summary.sessionCount).toBe(0);
  });

  it('asks the host for nothing when there is none (one-machine install)', async () => {
    vi.stubEnv('DEVFLOW_AGENT_HOST', '');
    try {
      resetRemoteUsageCache();
      expect(await remoteFilesSince(0)).toEqual([]);
      expect(await remoteFile(session)).toBeNull();
      expect(hostCalls).toEqual([]);
    } finally {
      vi.stubEnv('DEVFLOW_AGENT_HOST', 'desk');
    }
  });

  it('the host refuses a file that is not a session transcript', async () => {
    writeFileSync(join(hostHome, '.secrets'), 'KEY=1');
    expect(await remoteFile(join(hostHome, '.secrets'))).toBeNull();
  });

  it('a growing session is counted incrementally', async () => {
    resetRemoteUsageCache();
    const before = (await eventually(() => getGlobalUsageSummary(), (x) => x.todayTokens.inputTokens > 0)).todayTokens.inputTokens;
    appendFileSync(session, rec(1000, 1, iso(1_000)));
    const after = (await eventually(() => getGlobalUsageSummary(), (x) => x.todayTokens.inputTokens > before)).todayTokens.inputTokens;
    expect(after - before).toBe(1000);
  }, 60_000);
});

describe('frozen-agent liveness for agents on the agent host', () => {
  it('knows nothing on the first ask, then the host\'s answer; folders asked in one tick share one call', async () => {
    const t = join(projDir(), 'live.jsonl');
    writeFileSync(t, '{}\n');
    const second = join(hostHome, 'SG-1', 'Team', 'Other');
    mkdirSync(join(second, '.session-scratch'), { recursive: true });
    mkdirSync(join(hostHome, '.claude', 'projects', key(second)), { recursive: true });
    writeFileSync(join(hostHome, '.claude', 'projects', key(second), 'x.jsonl'), '{}\n');
    utimesSync(join(hostHome, '.claude', 'projects', key(second), 'x.jsonl'), new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));

    expect(remoteTranscriptMtime(agentDir())).toBeUndefined();
    expect(remoteTranscriptMtime(second)).toBeUndefined();
    await settleRemoteMtimes();
    expect(hostCalls.filter((c) => c.op === 'transcript-mtimes')).toHaveLength(1);
    const fresh = remoteTranscriptMtime(agentDir()) as number;
    expect(Date.now() - fresh).toBeLessThan(120_000);
    expect(Date.now() - (remoteTranscriptMtime(second) as number)).toBeGreaterThan(500_000);
    await settleRemoteMtimes();
    expect(hostCalls.filter((c) => c.op === 'transcript-mtimes')).toHaveLength(1);          // fresh answers are not asked again
  });

  it('resolveJsonlMtimeMs uses the host\'s transcript and keeps this machine\'s when it is fresher', async () => {
    resetRemoteMtimes();
    expect(resolveJsonlMtimeMs(agentDir())).toBeNull();                      // nothing here, host not asked yet
    await settleRemoteMtimes();
    const viaHost = resolveJsonlMtimeMs(agentDir());
    expect(viaHost).not.toBeNull();
    expect(Date.now() - (viaHost as number)).toBeLessThan(120_000);
  });

  it('uses the freshest evidence of life when both machines have a transcript', async () => {
    const dir = join(hostHome, 'SG-1', 'Team', 'Both');                                   // its own folders, so no other test's files interfere
    const hostProj = join(hostHome, '.claude', 'projects', key(dir));
    const localProj = join(localHome, '.claude', 'projects', key(dir));
    mkdirSync(join(dir, '.session-scratch'), { recursive: true });
    mkdirSync(hostProj, { recursive: true });
    mkdirSync(localProj, { recursive: true });
    const hostFile = join(hostProj, 'h.jsonl');
    const localFile = join(localProj, 'l.jsonl');
    writeFileSync(hostFile, '{}\n');
    writeFileSync(localFile, '{}\n');
    const ago = (ms: number) => new Date(Date.now() - ms);
    try {
      for (const [hostAge, localAge, expectedAge] of [[600_000, 20_000, 20_000], [20_000, 600_000, 20_000]] as const) {
        utimesSync(hostFile, ago(hostAge), ago(hostAge));
        utimesSync(localFile, ago(localAge), ago(localAge));
        resetRemoteMtimes();
        resolveJsonlMtimeMs(dir);
        await settleRemoteMtimes();
        const got = resolveJsonlMtimeMs(dir) as number;
        expect(Math.abs(Date.now() - got - expectedAge)).toBeLessThan(5_000);
      }
    } finally {
      rmSync(localProj, { recursive: true, force: true });
    }
  });

  it('gives no answer (as before) when no host is configured', () => {
    vi.stubEnv('DEVFLOW_AGENT_HOST', '');
    try {
      resetRemoteMtimes();
      expect(remoteTranscriptMtime(agentDir())).toBeUndefined();
      expect(hostCalls.filter((c) => c.op === 'transcript-mtimes')).toHaveLength(0);
    } finally {
      vi.stubEnv('DEVFLOW_AGENT_HOST', 'desk');
    }
  });
});
