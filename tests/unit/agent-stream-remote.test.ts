/**
 * Live Feed for agents that run on the agent host (21 Oct 2026: DevFlow moved to the server, transcripts stayed on the PC, every
 * stream answered "no active session"). The TypeScript readers are driven through the REAL stream-fs op of scripts/agent-hostd.py
 * (a helper process serves it), with the same fixtures the local resolvers use.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { deriveAgentProjectKey } from '@/lib/agent-session-state';
import { remoteStreamFs, localStreamFs, StreamHostOfflineError, type StreamFs } from '@/lib/agent-stream-fs';
import { resolveAgentStreamSource } from '@/lib/agent-stream-runtime';
import { chooseAgentStreamSource } from '@/lib/agent-stream-source';
import { readBackfill, readDelta } from '@/lib/agent-stream-tail';
import type { AgentRosterEntry } from '@/lib/types';

let root: string;
let home: string;
let work: string;
let server: ChildProcessWithoutNullStreams;
let pending: Array<(line: string) => void> = [];
let fsx: StreamFs;
let calls = 0;

const call = (_host: string, _op: string, args: Record<string, unknown>) => new Promise<unknown>((resolveCall, reject) => {
  calls++;
  pending.push((line) => {
    const reply = JSON.parse(line) as { ok: boolean; result?: unknown; error?: string };
    if (reply.ok) resolveCall(reply.result); else reject(Object.assign(new Error(reply.error), { code: 'EHOSTOP' }));
  });
  server.stdin.write(JSON.stringify(args) + '\n');
});

const agent = (over: Partial<AgentRosterEntry>): AgentRosterEntry => ({
  id: 'a1', name: 'Tester', channelId: 'c1', workingDirectory: work, agentType: 'claude', status: 'running', ...over,
} as AgentRosterEntry);
const line = (obj: unknown) => JSON.stringify(obj) + '\n';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'stream-remote-'));
  home = join(root, 'home');
  work = join(home, 'SG-1', 'Team', 'Tester');
  mkdirSync(join(work, '.session-scratch'), { recursive: true });
  server = spawn('python3', ['-B', resolve('tests/helpers/hostd_stream_fs_server.py'), home, join(home, 'SG-1')], { stdio: ['pipe', 'pipe', 'inherit'] }) as ChildProcessWithoutNullStreams;
  createInterface({ input: server.stdout }).on('line', (text) => pending.shift()?.(text));
  fsx = remoteStreamFs('desk', call);
});
afterAll(() => { server.kill(); rmSync(root, { recursive: true, force: true }); });

describe('Claude transcripts on the agent host', () => {
  it('resolves through the scratch pointer, the session id and the newest file, like the local resolver', async () => {
    const dir = join(home, '.claude', 'projects', deriveAgentProjectKey(work));
    mkdirSync(dir, { recursive: true });
    const older = join(dir, 'older.jsonl'); const newer = join(dir, 'newer.jsonl'); const pinned = join(dir, 'pinned.jsonl');
    writeFileSync(older, line({ n: 1 })); writeFileSync(pinned, line({ n: 2 }));
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(newer, line({ n: 3 }));
    const viaRemote = (opts = {}) => resolveAgentStreamSource(agent({}), { fsx, ...opts });
    const viaLocal = () => resolveAgentStreamSource(agent({}), { fsx: localStreamFs(home), home });
    // newest-by-mtime fallback
    expect((await viaRemote())).toEqual(await viaLocal());
    expect((await viaRemote())?.path).toBe(newer);
    // session-id pointer
    writeFileSync(join(work, '.session-scratch', 'session-id'), 'pinned');
    expect((await viaRemote())?.path).toBe(pinned);
    expect(await viaRemote()).toEqual(await viaLocal());
    // transcript-path pointer wins
    writeFileSync(join(work, '.session-scratch', 'transcript-path'), older);
    expect((await viaRemote())?.path).toBe(older);
    expect(await viaRemote()).toEqual(await viaLocal());
  });

  it('backfills the last lines of a large file and then follows appended lines, including non-ASCII text', async () => {
    const dir = join(home, '.claude', 'projects', deriveAgentProjectKey(work));
    const file = join(dir, 'big.jsonl');
    const rows = Array.from({ length: 30_000 }, (_, i) => line({ i, text: 'Café ✓ ' + 'x'.repeat(60) }));   // ~2.5 MB: more than one range
    writeFileSync(file, rows.join(''));
    const back = await readBackfill(file, 50, fsx);
    expect(back.lines).toHaveLength(50);
    expect(JSON.parse(back.lines[49]).i).toBe(29_999);
    expect(JSON.parse(back.lines[0]).i).toBe(29_950);                       // the partial first line of the tail was dropped, not parsed
    expect(back.offset).toBe(Buffer.byteLength(rows.join('')));

    appendFileSync(file, line({ i: 30_000, text: 'Café ✓' }) + '{"i":30001,"te');   // one full line and the start of another
    let delta = await readDelta(file, back.offset, '', fsx);
    expect(delta.lines.map((l) => JSON.parse(l).i)).toEqual([30_000]);
    expect(delta.leftover).toBe('{"i":30001,"te');
    appendFileSync(file, 'xt":"done"}\n');
    delta = await readDelta(file, delta.offset, delta.leftover, fsx);
    expect(delta.lines.map((l) => JSON.parse(l).i)).toEqual([30_001]);
    expect(delta.leftover).toBe('');
    expect((await readDelta(file, delta.offset, '', fsx)).lines).toEqual([]);
  });

  it('catches up over several reads without cutting a multi-byte character or losing a line', async () => {
    const dir = join(home, '.claude', 'projects', deriveAgentProjectKey(work));
    const file = join(dir, 'catchup.jsonl');
    writeFileSync(file, '');
    const rows = Array.from({ length: 12_000 }, (_, i) => line({ i, text: '✓✓✓ ' + 'é'.repeat(40) }));   // ~1.5 MB, every character 2-3 bytes
    writeFileSync(file, rows.join(''));
    let offset = 0; let leftover = ''; const seen: number[] = [];
    for (let round = 0; round < 10 && seen.length < rows.length; round++) {
      const d = await readDelta(file, offset, leftover, fsx);
      offset = d.offset; leftover = d.leftover;
      for (const l of d.lines) seen.push(JSON.parse(l).i);
    }
    expect(seen).toEqual(rows.map((_, i) => i));
  });

  it.each([0, 1, 2, 3, 4])('never cuts a multi-byte character when one line is longer than a read (cut position %i)', async (pad) => {
    const dir = join(home, '.claude', 'projects', deriveAgentProjectKey(work));
    const file = join(dir, `longline-${pad}.jsonl`);
    const text = 'x'.repeat(pad) + 'é✓'.repeat(300_000);                 // one ~1.5 MB line; across the five pads the 1 MiB cut lands on every byte of the 5-byte pattern
    writeFileSync(file, line({ text }) + line({ after: true }));
    let offset = 0; let leftover = ''; const got: Array<Record<string, unknown>> = [];
    for (let round = 0; round < 6; round++) {
      const d = await readDelta(file, offset, leftover, fsx);
      offset = d.offset; leftover = d.leftover;
      got.push(...d.lines.map((l) => JSON.parse(l)));
    }
    expect(got).toHaveLength(2);
    expect(got[0].text).toBe(text);
    expect(got[1]).toEqual({ after: true });
  });

  it.each([0, 1, 2, 3])('never cuts a four-byte character (emoji) either (cut position %i)', async (pad) => {
    const dir = join(home, '.claude', 'projects', deriveAgentProjectKey(work));
    const file = join(dir, `emoji-${pad}.jsonl`);
    const text = 'x'.repeat(pad) + '😀'.repeat(400_000);
    writeFileSync(file, line({ text }) + line({ after: true }));
    let offset = 0; let leftover = ''; const got: Array<Record<string, unknown>> = [];
    for (let round = 0; round < 6; round++) {
      const d = await readDelta(file, offset, leftover, fsx);
      offset = d.offset; leftover = d.leftover;
      got.push(...d.lines.map((l) => JSON.parse(l)));
    }
    expect(got.map((g) => (typeof g.text === 'string' ? g.text.length : g))).toEqual([text.length, { after: true }]);
    expect(got[0].text).toBe(text);
  });

  it('does not show the half line a tail read starts in', async () => {
    const dir = join(home, '.claude', 'projects', deriveAgentProjectKey(work));
    const file = join(dir, 'halfline.jsonl');
    writeFileSync(file, line({ big: 'y'.repeat(1_200_000) }) + line({ k: 1 }) + line({ k: 2 }));
    const back = await readBackfill(file, 50, fsx);
    expect(back.lines.map((l) => JSON.parse(l))).toEqual([{ k: 1 }, { k: 2 }]);
  });

  it('starts over when the file was replaced by a smaller one, and reports a missing file as empty', async () => {
    const dir = join(home, '.claude', 'projects', deriveAgentProjectKey(work));
    const file = join(dir, 'rotate.jsonl');
    writeFileSync(file, line({ a: 1 }) + line({ a: 2 }));
    const first = await readBackfill(file, 10, fsx);
    writeFileSync(file, line({ b: 1 }));
    const after = await readDelta(file, first.offset, '', fsx);
    expect(after.lines.map((l) => JSON.parse(l))).toEqual([{ b: 1 }]);
    expect(await readDelta(join(dir, 'gone.jsonl'), 5, 'x', fsx)).toEqual({ lines: [], offset: 0, leftover: '' });
    expect(await readBackfill(join(dir, 'gone.jsonl'), 5, fsx)).toEqual({ lines: [], offset: 0 });
  });
});

describe('other runtimes on the agent host', () => {
  it('finds a Codex rollout by its working folder and ignores the others', async () => {
    const day = join(home, '.codex', 'sessions', '2026', '10', '21');
    mkdirSync(day, { recursive: true });
    const mine = join(day, 'rollout-mine.jsonl');
    writeFileSync(join(day, 'rollout-other.jsonl'), line({ type: 'session_meta', payload: { cwd: '/somewhere/else' } }));
    writeFileSync(mine, line({ type: 'session_meta', payload: { cwd: work } }));
    const got = await resolveAgentStreamSource(agent({ agentType: 'codex' }), { fsx });
    expect(got).toEqual({ path: mine, runtime: 'codex', resolvedVia: 'codex-session-cwd' });
    expect(await resolveAgentStreamSource(agent({ agentType: 'codex', workingDirectory: '/no/such/folder' }), { fsx })).toBeNull();
  });

  it('looks at the newest 40 Codex rollouts on the host, and at all of them on this machine', async () => {
    const day = join(home, '.codex', 'sessions', '2027', '01', '01');
    mkdirSync(day, { recursive: true });
    const folder = join(home, 'SG-1', 'Team', 'Deep');
    const oldest = join(day, 'rollout-0000.jsonl');
    writeFileSync(oldest, line({ type: 'session_meta', payload: { cwd: folder } }));
    for (let i = 1; i <= 45; i++) {
      await new Promise((r) => setTimeout(r, 3));
      writeFileSync(join(day, `rollout-${String(i).padStart(4, '0')}.jsonl`), line({ type: 'session_meta', payload: { cwd: `/other/${i}` } }));
    }
    const deep = agent({ agentType: 'codex', workingDirectory: folder });
    expect(await resolveAgentStreamSource(deep, { fsx })).toBeNull();                                   // 46th newest: past the host cap
    expect((await resolveAgentStreamSource(deep, { fsx: localStreamFs(home), home }))?.path).toBe(oldest);
  });

  it('finds the newest Gemini chat of the matching project', async () => {
    const proj = join(home, '.gemini', 'tmp', 'p1');
    mkdirSync(join(proj, 'chats'), { recursive: true });
    writeFileSync(join(proj, '.project_root'), work + '\n');
    writeFileSync(join(proj, 'chats', 'session-1.jsonl'), '{}\n');
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(join(proj, 'chats', 'session-2.jsonl'), '{}\n');
    await new Promise((r) => setTimeout(r, 15));
    mkdirSync(join(home, '.gemini', 'tmp', 'p2', 'chats'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'tmp', 'p2', '.project_root'), '/another');
    writeFileSync(join(home, '.gemini', 'tmp', 'p2', 'chats', 'session-9.jsonl'), '{}\n');
    const got = await resolveAgentStreamSource(agent({ agentType: 'gemini' }), { fsx });
    expect(got).toEqual({ path: join(proj, 'chats', 'session-2.jsonl'), runtime: 'gemini', resolvedVia: 'gemini-project-root' });
  });

  it('prefers the Grok wrapper stream, then a native chat history, then the deterministic wrapper path', async () => {
    const g = agent({ agentType: 'grok' });
    expect((await resolveAgentStreamSource(g, { fsx }))?.resolvedVia).toBe('grok-wrapper-stream');   // nothing exists yet: deterministic path
    const native = join(home, '.grok', 'sessions', encodeURIComponent(work), 'abc');
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, 'chat_history.jsonl'), '{}\n');
    expect(await resolveAgentStreamSource(g, { fsx })).toEqual({ path: join(native, 'chat_history.jsonl'), runtime: 'grok', resolvedVia: 'grok-native-chat' });
    writeFileSync(join(work, '.grok-stream.jsonl'), '{}\n');
    expect((await resolveAgentStreamSource(g, { fsx }))?.resolvedVia).toBe('grok-wrapper-stream');
  });
});

describe('the host path', () => {
  it('asks the host for its home folder once, not on every resolution', async () => {
    const seen: string[] = [];
    const counting = remoteStreamFs('desk', async (host, op, args) => { seen.push(String(args.action)); return call(host, op, args); });
    await resolveAgentStreamSource(agent({}), { fsx: counting });
    await resolveAgentStreamSource(agent({}), { fsx: counting });
    expect(seen.filter((a) => a === 'home')).toHaveLength(1);
  });
});

describe('the host refuses what is not a transcript', () => {
  it('never returns a login file, even when asked by name through a link', async () => {
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'TOKEN');
    writeFileSync(join(home, '.secrets'), 'KEY=1');
    expect(await fsx.readText(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))).toBeNull();
    expect(await fsx.readText(join(home, '.secrets'))).toBeNull();
    const dir = join(home, '.claude', 'projects', 'trap');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(home, '.secrets'), join(dir, 'stolen.jsonl'));
    expect(await fsx.readText(join(dir, 'stolen.jsonl'))).toBeNull();
    expect(await readBackfill(join(dir, 'stolen.jsonl'), 5, fsx)).toEqual({ lines: [], offset: 0 });
  });
});

describe('choosing by where the agent\'s files are', () => {
  it('an agent that RUNS on the server but works on the desktop\'s folders is read on the desktop', async () => {
    const prev = process.env.DEVFLOW_AGENT_HOST;
    process.env.DEVFLOW_AGENT_HOST = 'desk';
    try {
      const seen: string[] = [];
      const chosen = await chooseAgentStreamSource(agent({ runLocation: 'server' } as Partial<AgentRosterEntry>), { remoteFsFor: (h) => { seen.push(h); return fsx; } });
      expect(seen).toEqual(['desk']);
      expect(chosen?.fsx.remote).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.DEVFLOW_AGENT_HOST; else process.env.DEVFLOW_AGENT_HOST = prev;
    }
  });

  it('with no agent host configured (one machine) everything is read locally', async () => {
    const prev = process.env.DEVFLOW_AGENT_HOST;
    delete process.env.DEVFLOW_AGENT_HOST;
    try {
      const seen: string[] = [];
      await chooseAgentStreamSource(agent({}), { remoteFsFor: (h) => { seen.push(h); return fsx; }, home: join(root, 'nothing-here') });
      expect(seen).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.DEVFLOW_AGENT_HOST = prev;
    }
  });
});

describe('choosing where to read', () => {
  const localAgent = () => agent({ workingDirectory: join(root, 'localhome', 'SG-1', 'Team', 'Tester') });
  const fake = (over: Partial<StreamFs>): StreamFs => ({
    remote: true, home: async () => '/h', readText: async () => null, stat: async () => null, readdir: async () => null,
    findFiles: async () => [], readRange: async () => null, readTail: async () => null, ...over,
  });

  const lworkDir = () => join(root, 'localhome', 'SG-1', 'Team', 'Tester');
  it('reads the agent host for an agent that runs there', async () => {
    const proj = join(home, '.claude', 'projects', deriveAgentProjectKey(work));
    const before = calls;
    const chosen = await chooseAgentStreamSource(agent({}), { host: 'desk', remoteFsFor: () => fsx });
    expect(chosen?.fsx.remote).toBe(true);
    expect(chosen?.resolved.path.startsWith(proj)).toBe(true);
    expect(calls).toBeGreaterThan(before);
  });

  it('reads this machine for an agent that runs here (no host)', async () => {
    const dir = join(root, 'localhome', '.claude', 'projects', deriveAgentProjectKey(lworkDir()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's.jsonl'), '{}\n');
    const before = calls;
    const chosen = await chooseAgentStreamSource(localAgent(), { host: null, home: join(root, 'localhome') });
    expect(chosen?.fsx.remote).toBe(false);
    expect(chosen?.resolved.path).toBe(join(dir, 's.jsonl'));
    expect(calls).toBe(before);
  });

  it('falls back to this machine when the host has no session for the agent', async () => {
    const dir = join(root, 'localhome', '.claude', 'projects', deriveAgentProjectKey(lworkDir()));
    const chosen = await chooseAgentStreamSource(localAgent(), { host: 'desk', remoteFsFor: () => fake({}), home: join(root, 'localhome') });
    expect(chosen?.fsx.remote).toBe(false);
    expect(chosen?.resolved.path).toBe(join(dir, 's.jsonl'));
  });

  it('says the host is offline instead of "no session" when it does not answer and nothing is local', async () => {
    const dead = remoteStreamFs('desk', async () => { throw Object.assign(new Error('late'), { code: 'EHOSTTIMEOUT' }); });
    await expect(chooseAgentStreamSource(localAgent(), { host: 'desk', remoteFsFor: () => dead, home: join(root, 'nothing-here') })).rejects.toBeInstanceOf(StreamHostOfflineError);
  });

  it('still serves a local session while the host is offline', async () => {
    const dead = remoteStreamFs('desk', async () => { throw Object.assign(new Error('late'), { code: 'EHOSTTIMEOUT' }); });
    const chosen = await chooseAgentStreamSource(localAgent(), { host: 'desk', remoteFsFor: () => dead, home: join(root, 'localhome') });
    expect(chosen?.fsx.remote).toBe(false);
  });

  it('returns null when neither machine has a session', async () => {
    expect(await chooseAgentStreamSource(localAgent(), { host: 'desk', remoteFsFor: () => fake({}), home: join(root, 'nothing-here') })).toBeNull();
  });
});
