import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  resolveJsonlForDir,
  resolveAgentJsonlPath,
  findAgentByName,
} from '@/lib/agent-jsonl-resolver';
import type { AgentRosterEntry } from '@/lib/types';

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

function makeRosterEntry(overrides: Partial<AgentRosterEntry>): AgentRosterEntry {
  return {
    id: 'roster-test',
    name: 'Test',
    workingDirectory: '/home/tester/SG-1/Team/Test',
    channelId: 'ch-1',
    participantId: 'pid-1',
    color: '#fff',
    status: 'running',
    autoResume: false,
    useCollabWrapper: true,
    dangerouslySkipPermissions: false,
    createdAt: '2026-04-01T00:00:00Z',
    crashCount: 0,
    ...overrides,
  };
}

describe('resolveJsonlForDir', () => {
  let sandbox: string;
  let fakeHome: string;
  let agentDir: string;
  let projectsDir: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'agent-jsonl-resolver-'));
    fakeHome = join(sandbox, 'home');
    agentDir = join(sandbox, 'SG-1', 'Team', 'Test');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, '.session-scratch'), { recursive: true });
    const projectKey = agentDir.replace(/\//g, '-');
    projectsDir = join(fakeHome, '.claude', 'projects', projectKey);
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns null when projects dir does not exist', async () => {
    rmSync(projectsDir, { recursive: true });
    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result).toBeNull();
  });

  it('returns null when no jsonl files exist at all', async () => {
    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result).toBeNull();
  });

  it('primary: reads session-id from scratch and returns matching jsonl', async () => {
    const sessionId = 'abc-123-session';
    writeFileSync(join(agentDir, '.session-scratch', 'session-id'), sessionId);
    const jsonlPath = join(projectsDir, `${sessionId}.jsonl`);
    writeFileSync(jsonlPath, '{}\n');

    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result).not.toBeNull();
    expect(result!.path).toBe(jsonlPath);
    expect(result!.resolvedVia).toBe('scratch');
  });

  it('primary: strips trailing newline and whitespace from session-id file', async () => {
    const sessionId = 'abc-123-session';
    writeFileSync(
      join(agentDir, '.session-scratch', 'session-id'),
      `  ${sessionId}\n\n`,
    );
    const jsonlPath = join(projectsDir, `${sessionId}.jsonl`);
    writeFileSync(jsonlPath, '{}\n');

    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result!.path).toBe(jsonlPath);
    expect(result!.resolvedVia).toBe('scratch');
  });

  it('primary: empty session-id file falls back to newest jsonl', async () => {
    writeFileSync(join(agentDir, '.session-scratch', 'session-id'), '');
    const fallbackPath = join(projectsDir, 'newest.jsonl');
    writeFileSync(fallbackPath, '{}\n');

    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result!.resolvedVia).toBe('fallback');
    expect(result!.path).toBe(fallbackPath);
  });

  it('primary: whitespace-only session-id file falls back', async () => {
    writeFileSync(join(agentDir, '.session-scratch', 'session-id'), '   \n\t  \n');
    const fallbackPath = join(projectsDir, 'newest.jsonl');
    writeFileSync(fallbackPath, '{}\n');

    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result!.resolvedVia).toBe('fallback');
  });

  it('primary: session-id pointing to non-existent jsonl falls back', async () => {
    writeFileSync(join(agentDir, '.session-scratch', 'session-id'), 'missing-id');
    const fallbackPath = join(projectsDir, 'actual.jsonl');
    writeFileSync(fallbackPath, '{}\n');

    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result!.resolvedVia).toBe('fallback');
    expect(result!.path).toBe(fallbackPath);
  });

  it('primary: no scratch file at all falls back', async () => {
    const fallbackPath = join(projectsDir, 'newest.jsonl');
    writeFileSync(fallbackPath, '{}\n');

    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result!.resolvedVia).toBe('fallback');
  });

  it('fallback: picks newest jsonl by mtime, not alphabetical', async () => {
    const older = join(projectsDir, 'zzz-old.jsonl');
    const newer = join(projectsDir, 'aaa-new.jsonl');
    writeFileSync(older, '{}\n');
    writeFileSync(newer, '{}\n');
    const oldTime = new Date('2026-01-01T00:00:00Z');
    const newTime = new Date('2026-04-01T00:00:00Z');
    utimesSync(older, oldTime, oldTime);
    utimesSync(newer, newTime, newTime);

    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result!.resolvedVia).toBe('fallback');
    expect(result!.path).toBe(newer);
  });

  it('ignores non-jsonl files in projects dir', async () => {
    writeFileSync(join(projectsDir, 'readme.txt'), 'not a session');
    writeFileSync(join(projectsDir, 'notes.md'), 'nope');
    const realPath = join(projectsDir, 'real.jsonl');
    writeFileSync(realPath, '{}\n');

    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result!.path).toBe(realPath);
  });

  it('primary A: transcript-path (absolute) takes precedence over session-id', async () => {
    // Write a transcript-path pointing at a jsonl OUTSIDE the derived projects dir
    // to prove that path is honoured as-is without re-derivation.
    const outOfBandDir = join(sandbox, 'alt-location');
    mkdirSync(outOfBandDir, { recursive: true });
    const outOfBandJsonl = join(outOfBandDir, 'live.jsonl');
    writeFileSync(outOfBandJsonl, '{}\n');
    writeFileSync(join(agentDir, '.session-scratch', 'transcript-path'), outOfBandJsonl);

    // Also write a session-id + matching jsonl in the derived dir to prove
    // transcript-path wins.
    writeFileSync(join(agentDir, '.session-scratch', 'session-id'), 'session-b');
    writeFileSync(join(projectsDir, 'session-b.jsonl'), '{}\n');

    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result!.path).toBe(outOfBandJsonl);
    expect(result!.resolvedVia).toBe('scratch');
  });

  it('primary A: transcript-path pointing to non-existent file falls through to session-id', async () => {
    writeFileSync(
      join(agentDir, '.session-scratch', 'transcript-path'),
      '/nonexistent/path/missing.jsonl',
    );
    const sessionId = 'live-session';
    writeFileSync(join(agentDir, '.session-scratch', 'session-id'), sessionId);
    const jsonlPath = join(projectsDir, `${sessionId}.jsonl`);
    writeFileSync(jsonlPath, '{}\n');

    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result!.path).toBe(jsonlPath);
    expect(result!.resolvedVia).toBe('scratch');
  });

  it('primary A: transcript-path empty falls through to session-id', async () => {
    writeFileSync(join(agentDir, '.session-scratch', 'transcript-path'), '\n  \n');
    const sessionId = 'fallback-session';
    writeFileSync(join(agentDir, '.session-scratch', 'session-id'), sessionId);
    const jsonlPath = join(projectsDir, `${sessionId}.jsonl`);
    writeFileSync(jsonlPath, '{}\n');

    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result!.path).toBe(jsonlPath);
  });

  it('primary A: transcript-path strips trailing newline', async () => {
    const outOfBandJsonl = join(sandbox, 'live-tail.jsonl');
    writeFileSync(outOfBandJsonl, '{}\n');
    writeFileSync(
      join(agentDir, '.session-scratch', 'transcript-path'),
      `${outOfBandJsonl}\n`,
    );

    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result!.path).toBe(outOfBandJsonl);
    expect(result!.resolvedVia).toBe('scratch');
  });

  it('primary wins over fallback when both are valid', async () => {
    const sessionId = 'primary-session';
    writeFileSync(join(agentDir, '.session-scratch', 'session-id'), sessionId);
    const primaryPath = join(projectsDir, `${sessionId}.jsonl`);
    writeFileSync(primaryPath, '{}\n');

    // Create a newer fallback candidate
    const fallbackPath = join(projectsDir, 'newer-but-wrong.jsonl');
    writeFileSync(fallbackPath, '{}\n');
    const futureTime = new Date('2099-01-01T00:00:00Z');
    utimesSync(fallbackPath, futureTime, futureTime);

    const result = await resolveJsonlForDir(agentDir, { home: fakeHome });
    expect(result!.resolvedVia).toBe('scratch');
    expect(result!.path).toBe(primaryPath);
  });
});

describe('findAgentByName', () => {
  it('finds agent by exact name via injected roster loader', async () => {
    const entry = makeRosterEntry({ name: 'McRae' });
    const result = await findAgentByName('McRae', {
      rosterLoader: async () => [entry],
    });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('McRae');
  });

  it('returns null when name is not in roster', async () => {
    const result = await findAgentByName('Nobody', {
      rosterLoader: async () => [makeRosterEntry({ name: 'McRae' })],
    });
    expect(result).toBeNull();
  });

  it('is case-insensitive on agent name', async () => {
    const result = await findAgentByName('MCRAE', {
      rosterLoader: async () => [makeRosterEntry({ name: 'McRae' })],
    });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('McRae');
  });

  it('prefers running agent when multiple entries share a name', async () => {
    const stopped = makeRosterEntry({
      id: 'r-stopped',
      name: 'Dup',
      status: 'stopped',
    });
    const running = makeRosterEntry({
      id: 'r-running',
      name: 'Dup',
      status: 'running',
    });
    const result = await findAgentByName('Dup', {
      rosterLoader: async () => [stopped, running],
    });
    expect(result!.id).toBe('r-running');
  });

  it('filters by channelId when provided — same name in different channels', async () => {
    const daveSG1 = makeRosterEntry({
      id: 'dave-sg1',
      name: 'Dave',
      channelId: 'ch-sg1',
      workingDirectory: '/home/tester/SG-1/Team/Dave',
      status: 'running',
    });
    const daveBnG = makeRosterEntry({
      id: 'dave-bng',
      name: 'Dave',
      channelId: 'ch-bng',
      workingDirectory: '/home/tester/BnG/Team/Dave',
      status: 'running',
    });
    const roster = async () => [daveSG1, daveBnG];

    const sg1Result = await findAgentByName('Dave', {
      rosterLoader: roster,
      channelId: 'ch-sg1',
    });
    expect(sg1Result!.id).toBe('dave-sg1');

    const bngResult = await findAgentByName('Dave', {
      rosterLoader: roster,
      channelId: 'ch-bng',
    });
    expect(bngResult!.id).toBe('dave-bng');
  });

  it('returns null when channelId provided but agent not in that channel', async () => {
    const dave = makeRosterEntry({
      id: 'dave-sg1',
      name: 'Dave',
      channelId: 'ch-sg1',
      status: 'running',
    });
    const result = await findAgentByName('Dave', {
      rosterLoader: async () => [dave],
      channelId: 'ch-other',
    });
    expect(result).toBeNull();
  });

  it('falls back to all-channel search when channelId is omitted', async () => {
    const daveSG1 = makeRosterEntry({
      id: 'dave-sg1',
      name: 'Dave',
      channelId: 'ch-sg1',
      status: 'running',
    });
    const daveBnG = makeRosterEntry({
      id: 'dave-bng',
      name: 'Dave',
      channelId: 'ch-bng',
      status: 'stopped',
    });
    const result = await findAgentByName('Dave', {
      rosterLoader: async () => [daveSG1, daveBnG],
    });
    // No channelId filter → returns running match (existing behavior)
    expect(result!.id).toBe('dave-sg1');
  });
});

describe('resolveAgentJsonlPath', () => {
  let sandbox: string;
  let fakeHome: string;
  let agentDir: string;
  let projectsDir: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'resolve-agent-jsonl-'));
    fakeHome = join(sandbox, 'home');
    agentDir = join(sandbox, 'SG-1', 'Team', 'TestAgent');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, '.session-scratch'), { recursive: true });
    const projectKey = agentDir.replace(/\//g, '-');
    projectsDir = join(fakeHome, '.claude', 'projects', projectKey);
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns null when agent name not in roster', async () => {
    const result = await resolveAgentJsonlPath('Unknown', {
      home: fakeHome,
      rosterLoader: async () => [],
    });
    expect(result).toBeNull();
  });

  it('resolves via scratch when primary is valid', async () => {
    const sessionId = 'live-session-42';
    writeFileSync(join(agentDir, '.session-scratch', 'session-id'), sessionId);
    const jsonlPath = join(projectsDir, `${sessionId}.jsonl`);
    writeFileSync(jsonlPath, '{}\n');

    const entry = makeRosterEntry({ name: 'TestAgent', workingDirectory: agentDir });
    const result = await resolveAgentJsonlPath('TestAgent', {
      home: fakeHome,
      rosterLoader: async () => [entry],
    });
    expect(result!.resolvedVia).toBe('scratch');
    expect(result!.path).toBe(jsonlPath);
  });

  it('prefers effectiveWorkingDirectory over workingDirectory', async () => {
    const sessionId = 'effective-session';
    writeFileSync(join(agentDir, '.session-scratch', 'session-id'), sessionId);
    const jsonlPath = join(projectsDir, `${sessionId}.jsonl`);
    writeFileSync(jsonlPath, '{}\n');

    const entry = makeRosterEntry({
      name: 'TestAgent',
      workingDirectory: '/bogus/path',
      effectiveWorkingDirectory: agentDir,
    });
    const result = await resolveAgentJsonlPath('TestAgent', {
      home: fakeHome,
      rosterLoader: async () => [entry],
    });
    expect(result!.path).toBe(jsonlPath);
  });

  it('returns null when roster entry has no working dir and no jsonl', async () => {
    const entry = makeRosterEntry({
      name: 'Empty',
      workingDirectory: join(sandbox, 'nonexistent'),
    });
    const result = await resolveAgentJsonlPath('Empty', {
      home: fakeHome,
      rosterLoader: async () => [entry],
    });
    expect(result).toBeNull();
  });

  it('falls back to newest jsonl when no scratch file', async () => {
    const fallbackPath = join(projectsDir, 'newest.jsonl');
    writeFileSync(fallbackPath, '{}\n');

    const entry = makeRosterEntry({ name: 'TestAgent', workingDirectory: agentDir });
    const result = await resolveAgentJsonlPath('TestAgent', {
      home: fakeHome,
      rosterLoader: async () => [entry],
    });
    expect(result!.resolvedVia).toBe('fallback');
    expect(result!.path).toBe(fallbackPath);
  });
});
