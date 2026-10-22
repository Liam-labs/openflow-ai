import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAgentLastActivity,
  getAgentIdleSeconds,
  isAgentIdleForCompact,
  deriveAgentProjectKey,
} from '@/lib/agent-session-state';

/**
 * Build a minimal valid JSONL line with a timestamp.
 */
function jsonlLine(timestamp: string, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      type: 'user',
      timestamp,
      message: { role: 'user', content: 'test' },
      ...extra,
    }) + '\n'
  );
}

describe('deriveAgentProjectKey', () => {
  it('converts /home/user/SG-1/Team/Builder → -home-user-SG-1-Team-Builder', () => {
    expect(deriveAgentProjectKey('/home/user/SG-1/Team/Builder')).toBe(
      '-home-user-SG-1-Team-Builder',
    );
  });

  it('handles /tmp/foo/bar → -tmp-foo-bar', () => {
    expect(deriveAgentProjectKey('/tmp/foo/bar')).toBe('-tmp-foo-bar');
  });

  it('matches flush.sh convention for Builder', () => {
    // This is the same key used by flush.sh to derive MEMORY.md path
    expect(deriveAgentProjectKey('/home/user/SG-1/Team/Builder')).toBe(
      '-home-user-SG-1-Team-Builder',
    );
  });
});

describe('getAgentLastActivity', () => {
  let sandbox: string;
  let fakeHome: string;
  let agentDir: string;
  let projectsDir: string;
  let sessionDir: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'agent-session-state-'));
    fakeHome = join(sandbox, 'home');
    agentDir = join(sandbox, 'SG-1', 'Team', 'Test');
    mkdirSync(agentDir, { recursive: true });
    const projectKey = deriveAgentProjectKey(agentDir);
    projectsDir = join(fakeHome, '.claude', 'projects', projectKey);
    sessionDir = projectsDir;
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns null when ~/.claude/projects/<key>/ does not exist', async () => {
    rmSync(projectsDir, { recursive: true });
    const result = await getAgentLastActivity(agentDir, { home: fakeHome });
    expect(result).toBeNull();
  });

  it('returns null when there are no .jsonl files', async () => {
    const result = await getAgentLastActivity(agentDir, { home: fakeHome });
    expect(result).toBeNull();
  });

  it('returns null when the only .jsonl file is empty', async () => {
    writeFileSync(join(sessionDir, 'a.jsonl'), '');
    const result = await getAgentLastActivity(agentDir, { home: fakeHome });
    expect(result).toBeNull();
  });

  it('returns the timestamp from the last parseable entry', async () => {
    const content =
      jsonlLine('2026-04-10T19:00:00.000Z') + jsonlLine('2026-04-10T19:05:00.000Z');
    writeFileSync(join(sessionDir, 'a.jsonl'), content);
    const result = await getAgentLastActivity(agentDir, { home: fakeHome });
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe('2026-04-10T19:05:00.000Z');
    expect(result!.path).toBe(join(sessionDir, 'a.jsonl'));
  });

  it('picks the most recently modified .jsonl when multiple exist', async () => {
    const old = join(sessionDir, 'old.jsonl');
    const recent = join(sessionDir, 'recent.jsonl');
    writeFileSync(old, jsonlLine('2026-04-10T18:00:00.000Z'));
    writeFileSync(recent, jsonlLine('2026-04-10T19:00:00.000Z'));
    // Force mtime ordering: make "old" actually older
    const olderTime = new Date('2026-04-10T18:00:00.000Z').getTime() / 1000;
    const newerTime = new Date('2026-04-10T19:00:00.000Z').getTime() / 1000;
    utimesSync(old, olderTime, olderTime);
    utimesSync(recent, newerTime, newerTime);
    const result = await getAgentLastActivity(agentDir, { home: fakeHome });
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe('2026-04-10T19:00:00.000Z');
    expect(result!.path).toBe(recent);
  });

  it('walks backwards past a corrupt last line to find the most recent parseable timestamp', async () => {
    const content =
      jsonlLine('2026-04-10T19:00:00.000Z') +
      jsonlLine('2026-04-10T19:01:00.000Z') +
      'this-is-not-valid-json-and-should-be-skipped\n';
    writeFileSync(join(sessionDir, 'a.jsonl'), content);
    const result = await getAgentLastActivity(agentDir, { home: fakeHome });
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe('2026-04-10T19:01:00.000Z');
  });

  it('skips entries without a timestamp field and uses the prior one', async () => {
    const content =
      jsonlLine('2026-04-10T19:00:00.000Z') +
      JSON.stringify({ type: 'system', subtype: 'info' }) + '\n';
    writeFileSync(join(sessionDir, 'a.jsonl'), content);
    const result = await getAgentLastActivity(agentDir, { home: fakeHome });
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe('2026-04-10T19:00:00.000Z');
  });

  it('returns null when every line is corrupt or missing timestamp', async () => {
    const content = 'garbage\nmore garbage\n{"type":"nope"}\n';
    writeFileSync(join(sessionDir, 'a.jsonl'), content);
    const result = await getAgentLastActivity(agentDir, { home: fakeHome });
    expect(result).toBeNull();
  });

  it('handles trailing newlines gracefully', async () => {
    const content =
      jsonlLine('2026-04-10T19:00:00.000Z') + '\n\n\n';
    writeFileSync(join(sessionDir, 'a.jsonl'), content);
    const result = await getAgentLastActivity(agentDir, { home: fakeHome });
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe('2026-04-10T19:00:00.000Z');
  });
});

describe('getAgentIdleSeconds', () => {
  let sandbox: string;
  let fakeHome: string;
  let agentDir: string;
  let sessionDir: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'agent-idle-'));
    fakeHome = join(sandbox, 'home');
    agentDir = join(sandbox, 'SG-1', 'Team', 'Test');
    mkdirSync(agentDir, { recursive: true });
    const projectKey = deriveAgentProjectKey(agentDir);
    sessionDir = join(fakeHome, '.claude', 'projects', projectKey);
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns null when no activity is found', async () => {
    const result = await getAgentIdleSeconds(agentDir, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    expect(result).toBeNull();
  });

  it('computes seconds-since-last-activity from now (deterministic)', async () => {
    writeFileSync(join(sessionDir, 'a.jsonl'), jsonlLine('2026-04-10T19:59:30.000Z'));
    const result = await getAgentIdleSeconds(agentDir, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    expect(result).not.toBeNull();
    expect(result!.idleSeconds).toBe(30);
  });

  it('returns a large value for very old activity', async () => {
    writeFileSync(join(sessionDir, 'a.jsonl'), jsonlLine('2026-04-10T10:00:00.000Z'));
    const result = await getAgentIdleSeconds(agentDir, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    expect(result).not.toBeNull();
    expect(result!.idleSeconds).toBe(10 * 3600);
  });

  it('returns 0 when the last entry timestamp equals now', async () => {
    writeFileSync(join(sessionDir, 'a.jsonl'), jsonlLine('2026-04-10T20:00:00.000Z'));
    const result = await getAgentIdleSeconds(agentDir, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    expect(result).not.toBeNull();
    expect(result!.idleSeconds).toBe(0);
  });

  it('never returns a negative value if last entry is in the future (clock skew guard)', async () => {
    writeFileSync(join(sessionDir, 'a.jsonl'), jsonlLine('2026-04-10T20:00:10.000Z'));
    const result = await getAgentIdleSeconds(agentDir, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    expect(result).not.toBeNull();
    expect(result!.idleSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('isAgentIdleForCompact (guard wrapper)', () => {
  let sandbox: string;
  let fakeHome: string;
  let agentDir: string;
  let sessionDir: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'agent-busy-'));
    fakeHome = join(sandbox, 'home');
    agentDir = join(sandbox, 'SG-1', 'Team', 'Test');
    mkdirSync(agentDir, { recursive: true });
    const projectKey = deriveAgentProjectKey(agentDir);
    sessionDir = join(fakeHome, '.claude', 'projects', projectKey);
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('no JSONL → idle=false with reason "no activity" (skip compact to be safe)', async () => {
    const result = await isAgentIdleForCompact(agentDir, 30, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    expect(result.idle).toBe(false);
    expect(result.reason).toMatch(/no activity|no jsonl/i);
    expect(result.idleSeconds).toBeNull();
  });

  it('last entry 5s ago → idle=false (agent is busy)', async () => {
    writeFileSync(join(sessionDir, 'a.jsonl'), jsonlLine('2026-04-10T19:59:55.000Z'));
    const result = await isAgentIdleForCompact(agentDir, 30, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    expect(result.idle).toBe(false);
    expect(result.idleSeconds).toBe(5);
    expect(result.reason).toMatch(/busy|below threshold/i);
  });

  it('last entry 29s ago (just under 30s threshold) → idle=false', async () => {
    writeFileSync(join(sessionDir, 'a.jsonl'), jsonlLine('2026-04-10T19:59:31.000Z'));
    const result = await isAgentIdleForCompact(agentDir, 30, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    expect(result.idle).toBe(false);
    expect(result.idleSeconds).toBe(29);
  });

  it('last entry 30s ago (exactly at threshold) → idle=true', async () => {
    writeFileSync(join(sessionDir, 'a.jsonl'), jsonlLine('2026-04-10T19:59:30.000Z'));
    const result = await isAgentIdleForCompact(agentDir, 30, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    expect(result.idle).toBe(true);
    expect(result.idleSeconds).toBe(30);
  });

  it('last entry 120s ago → idle=true', async () => {
    writeFileSync(join(sessionDir, 'a.jsonl'), jsonlLine('2026-04-10T19:58:00.000Z'));
    const result = await isAgentIdleForCompact(agentDir, 30, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    expect(result.idle).toBe(true);
    expect(result.idleSeconds).toBe(120);
    expect(result.jsonlPath).toBe(join(sessionDir, 'a.jsonl'));
  });

  it('custom threshold 60s → 45s ago is below → not idle', async () => {
    writeFileSync(join(sessionDir, 'a.jsonl'), jsonlLine('2026-04-10T19:59:15.000Z'));
    const result = await isAgentIdleForCompact(agentDir, 60, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    expect(result.idle).toBe(false);
    expect(result.idleSeconds).toBe(45);
  });

  it('custom threshold 10s → 15s ago is above → idle', async () => {
    writeFileSync(join(sessionDir, 'a.jsonl'), jsonlLine('2026-04-10T19:59:45.000Z'));
    const result = await isAgentIdleForCompact(agentDir, 10, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    expect(result.idle).toBe(true);
    expect(result.idleSeconds).toBe(15);
  });

  it('clock skew (last entry in future) → idle=false with reason', async () => {
    writeFileSync(join(sessionDir, 'a.jsonl'), jsonlLine('2026-04-10T20:00:10.000Z'));
    const result = await isAgentIdleForCompact(agentDir, 30, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    // Conservative: don't compact if we don't trust the clock
    expect(result.idle).toBe(false);
    expect(result.reason).toMatch(/future|clock skew|negative/i);
  });

  it('includes the jsonlPath in the result when activity is found', async () => {
    const jsonlPath = join(sessionDir, 'session-42.jsonl');
    writeFileSync(jsonlPath, jsonlLine('2026-04-10T19:58:00.000Z'));
    const result = await isAgentIdleForCompact(agentDir, 30, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    expect(result.jsonlPath).toBe(jsonlPath);
  });

  it('uses default threshold of 30s when not specified', async () => {
    writeFileSync(join(sessionDir, 'a.jsonl'), jsonlLine('2026-04-10T19:59:45.000Z'));
    const result = await isAgentIdleForCompact(agentDir, undefined, {
      home: fakeHome,
      now: new Date('2026-04-10T20:00:00.000Z'),
    });
    // 15s < default 30s → busy
    expect(result.idle).toBe(false);
    expect(result.idleSeconds).toBe(15);
  });
});
