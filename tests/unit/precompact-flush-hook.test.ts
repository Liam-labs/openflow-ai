import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const PRE_COMPACT_WRITE = join(REPO, 'scripts', 'hooks', 'pre-compact-write.sh');
const INIT = join(REPO, 'scripts', 'hooks', 'session-scratch-init.sh');

describe('PreCompact hook chain end-to-end (sandbox)', () => {
  let sandbox: string;
  let agentDir: string;
  let fakeHome: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'precompact-'));
    agentDir = join(sandbox, 'Agent');
    mkdirSync(agentDir, { recursive: true });
    fakeHome = join(sandbox, 'home');
    mkdirSync(fakeHome, { recursive: true });
    execFileSync('bash', [INIT, 'SandboxAgent', agentDir], { stdio: 'ignore' });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('pre-compact-write flushes all first, while preserving existing handoff state', () => {
    // Seed buffer content that simulates mid-session writes
    const journal = join(agentDir, '.session-scratch', 'journal.md');
    writeFileSync(journal, '## 12:00 — pre-compaction entry\n- one\n- two\n');

    const existingHandoff = 'STATUS: implementation in progress\nPENDING: exact resume state\nDO_NOT_REPEAT: stale approach\n';
    mkdirSync(join(agentDir, 'logs'), { recursive: true });
    writeFileSync(join(agentDir, 'logs', 'handoff.md'), existingHandoff);

    execFileSync('bash', [PRE_COMPACT_WRITE, 'SandboxAgent', agentDir], {
      env: { ...process.env, HOME: fakeHome },
      stdio: 'pipe',
    });

    expect(statSync(journal).size).toBe(0);
    const today = join(agentDir, 'logs', 'today.md');
    expect(readFileSync(today, 'utf8')).toBe('## 12:00 — pre-compaction entry\n- one\n- two\n');

    const handoff = join(agentDir, 'logs', 'handoff.md');
    expect(existsSync(handoff)).toBe(true);
    expect(readFileSync(handoff, 'utf8')).toBe(existingHandoff);
  });

  it('flush.sh all drains all 3 buffers on pre-compact', () => {
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), 'j\n');
    writeFileSync(join(agentDir, '.session-scratch', 'memory-pending.md'), 'm\n');
    writeFileSync(join(agentDir, '.session-scratch', 'expertise-pending.md'), 'e\n');

    execFileSync('bash', [PRE_COMPACT_WRITE, 'SandboxAgent', agentDir], {
      env: { ...process.env, HOME: fakeHome },
      stdio: 'pipe',
    });

    expect(statSync(join(agentDir, '.session-scratch', 'journal.md')).size).toBe(0);
    expect(statSync(join(agentDir, '.session-scratch', 'memory-pending.md')).size).toBe(0);
    expect(statSync(join(agentDir, '.session-scratch', 'expertise-pending.md')).size).toBe(0);
    expect(readFileSync(join(agentDir, 'logs', 'today.md'), 'utf8')).toBe('j\n');
    expect(readFileSync(join(agentDir, 'Expertise.md'), 'utf8')).toBe('e\n');
  });

  it('empty buffers before pre-compact → hook chain is still safe (no-op flush)', () => {
    // No content seeded — all 4 scratch files are empty
    execFileSync('bash', [PRE_COMPACT_WRITE, 'SandboxAgent', agentDir], {
      env: { ...process.env, HOME: fakeHome },
      stdio: 'pipe',
    });
    // With no agent-owned handoff, the hook creates only its minimal base.
    const handoff = join(agentDir, 'logs', 'handoff.md');
    expect(existsSync(handoff)).toBe(true);
    expect(readFileSync(handoff, 'utf8').trimEnd().split('\n')).toHaveLength(4);
  });
});
