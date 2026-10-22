/**
 * Sprint 38 T1b.6 — Integration test for the full session-scratch flush flow.
 *
 * Exercises the P1b pipeline end-to-end against real shell scripts on a
 * throwaway fixture directory. Unlike the per-script unit tests, this file
 * chains multiple scripts together through all five flush trigger paths:
 *   1. Fresh session init (SessionStart hook)
 *   2. Direct flush.sh all-mode (every-25-turns / pre-compact callers)
 *   3. /flush-journal skill command (manual, journal-only)
 *   4. /flush-journal --all (manual, all buffers)
 *   5. PreCompact hook ordering (flush → pre-compact-write → handoff.md)
 *   6. Turn-counter safety net (scratch-flush-counter.sh at interval)
 *   7. Edge cases (empty buffer, lock contention, atomic rename cleanup)
 *
 * Each test uses a fresh mkdtempSync dir and does NOT touch any real agent
 * state. HOME is overridden via spawn env so MEMORY.md lands inside the
 * fixture, not the real ~/.claude/projects/ tree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  appendFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const HOOKS_DIR = join(REPO, 'scripts', 'hooks');
const INIT_SCRIPT = `${HOOKS_DIR}/session-scratch-init.sh`;
const FLUSH_SCRIPT = `${HOOKS_DIR}/flush.sh`;
const FLUSH_JOURNAL_SCRIPT = `${HOOKS_DIR}/flush-journal.sh`;
const PRE_COMPACT_SCRIPT = `${HOOKS_DIR}/pre-compact-write.sh`;
const COUNTER_SCRIPT = `${HOOKS_DIR}/scratch-flush-counter.sh`;

type RunResult = { stdout: string; stderr: string; status: number };

function run(
  script: string,
  args: string[],
  env: Record<string, string> = {}
): RunResult {
  try {
    const stdout = execFileSync('bash', [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    const err = e as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      status: err.status ?? 1,
    };
  }
}

interface Fixture {
  baseDir: string;
  fakeHome: string;
  agentDir: string;
  scratchDir: string;
  journalBuf: string;
  memoryBuf: string;
  expertiseBuf: string;
  logsDir: string;
  todayMd: string;
  memoryMd: string;
  expertiseMd: string;
  flushLog: string;
}

function makeFixture(): Fixture {
  const baseDir = mkdtempSync(join(tmpdir(), 'p1b-int-'));
  const fakeHome = join(baseDir, 'home');
  const agentDir = join(baseDir, 'agent', 'TestAgent');
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(agentDir, 'logs'), { recursive: true });

  // Initialise scratch layout via the real init script
  execFileSync('bash', [INIT_SCRIPT, 'TestAgent', agentDir], { stdio: 'ignore' });

  const scratchDir = join(agentDir, '.session-scratch');
  const logsDir = join(agentDir, 'logs');

  // Project-key derivation matches flush.sh:  "/a/b/c" → "-a-b-c"
  const projectKey = agentDir.split('/').join('-');
  const memoryDir = join(fakeHome, '.claude', 'projects', projectKey, 'memory');

  return {
    baseDir,
    fakeHome,
    agentDir,
    scratchDir,
    journalBuf: join(scratchDir, 'journal.md'),
    memoryBuf: join(scratchDir, 'memory-pending.md'),
    expertiseBuf: join(scratchDir, 'expertise-pending.md'),
    logsDir,
    todayMd: join(logsDir, 'today.md'),
    memoryMd: join(memoryDir, 'MEMORY.md'),
    expertiseMd: join(agentDir, 'Expertise.md'),
    flushLog: join(scratchDir, 'flush.log'),
  };
}

describe('Sprint 38 P1b integration — full flush pipeline', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.baseDir, { recursive: true, force: true });
  });

  // ── Scenario 1: SessionStart init creates the scratch layout ────────────
  it('session-scratch-init creates all 4 scratch files idempotently', () => {
    // Layout already created in beforeEach. Verify files.
    expect(existsSync(fx.scratchDir)).toBe(true);
    expect(existsSync(fx.journalBuf)).toBe(true);
    expect(existsSync(fx.memoryBuf)).toBe(true);
    expect(existsSync(fx.expertiseBuf)).toBe(true);
    expect(existsSync(join(fx.scratchDir, 'flush.lock'))).toBe(true);

    // Write content, re-run init, confirm content survives (idempotency)
    writeFileSync(fx.journalBuf, 'existing journal content\n');
    const r = run(INIT_SCRIPT, ['TestAgent', fx.agentDir]);
    expect(r.status).toBe(0);
    expect(readFileSync(fx.journalBuf, 'utf8')).toBe('existing journal content\n');
  });

  // ── Scenario 2: Direct flush.sh all-mode drains all 3 buffers ──────────
  it('flush.sh all-mode drains all 3 buffers into targets and clears buffers', () => {
    writeFileSync(fx.journalBuf, '## 10:00 — test journal entry\n- did a thing\n');
    writeFileSync(fx.memoryBuf, '- learned X is now Y\n');
    writeFileSync(fx.expertiseBuf, '- pattern: always Z\n');

    const r = run(FLUSH_SCRIPT, ['TestAgent', fx.agentDir, 'all'], { HOME: fx.fakeHome });
    expect(r.status).toBe(0);

    // Targets created + content landed
    expect(readFileSync(fx.todayMd, 'utf8')).toContain('did a thing');
    expect(readFileSync(fx.memoryMd, 'utf8')).toContain('learned X is now Y');
    expect(readFileSync(fx.expertiseMd, 'utf8')).toContain('pattern: always Z');

    // Buffers truncated (exist but empty)
    expect(statSync(fx.journalBuf).size).toBe(0);
    expect(statSync(fx.memoryBuf).size).toBe(0);
    expect(statSync(fx.expertiseBuf).size).toBe(0);

    // flush.log records all 3 flush events
    const log = readFileSync(fx.flushLog, 'utf8');
    expect(log).toMatch(/flushed journal/);
    expect(log).toMatch(/flushed memory/);
    expect(log).toMatch(/flushed expertise/);
  });

  // ── Scenario 3: /flush-journal skill-command path (manual, journal-only) ─
  it('flush-journal.sh resolves session file and flushes journal only', () => {
    writeFileSync(fx.journalBuf, 'journal only entry\n');
    writeFileSync(fx.memoryBuf, 'memory should NOT flush\n');
    writeFileSync(fx.expertiseBuf, 'expertise should NOT flush\n');

    // Build a fake collab-session file matching flush-journal.sh's schema
    const sessionFile = join(fx.baseDir, 'session.json');
    writeFileSync(
      sessionFile,
      JSON.stringify({
        displayName: 'TestAgent',
        projectPath: fx.agentDir,
        channelId: 'test-channel',
        participantId: 'test-pid',
      })
    );

    const r = run(FLUSH_JOURNAL_SCRIPT, [], {
      HOME: fx.fakeHome,
      FLUSH_SESSION_FILE: sessionFile,
    });
    expect(r.status).toBe(0);

    // Journal flushed
    expect(readFileSync(fx.todayMd, 'utf8')).toContain('journal only entry');
    expect(statSync(fx.journalBuf).size).toBe(0);

    // Memory and expertise NOT flushed (no target files created, buffers intact)
    expect(existsSync(fx.memoryMd)).toBe(false);
    expect(existsSync(fx.expertiseMd)).toBe(false);
    expect(readFileSync(fx.memoryBuf, 'utf8')).toContain('memory should NOT flush');
    expect(readFileSync(fx.expertiseBuf, 'utf8')).toContain('expertise should NOT flush');
  });

  // ── Scenario 4: /flush-journal --all flushes all 3 ──────────────────────
  it('flush-journal.sh --all flushes all 3 buffers', () => {
    writeFileSync(fx.journalBuf, 'j\n');
    writeFileSync(fx.memoryBuf, 'm\n');
    writeFileSync(fx.expertiseBuf, 'e\n');

    const sessionFile = join(fx.baseDir, 'session.json');
    writeFileSync(
      sessionFile,
      JSON.stringify({ displayName: 'TestAgent', projectPath: fx.agentDir })
    );

    const r = run(FLUSH_JOURNAL_SCRIPT, ['--all'], {
      HOME: fx.fakeHome,
      FLUSH_SESSION_FILE: sessionFile,
    });
    expect(r.status).toBe(0);

    expect(readFileSync(fx.todayMd, 'utf8')).toBe('j\n');
    expect(readFileSync(fx.memoryMd, 'utf8')).toBe('m\n');
    expect(readFileSync(fx.expertiseMd, 'utf8')).toBe('e\n');
    expect(statSync(fx.journalBuf).size).toBe(0);
    expect(statSync(fx.memoryBuf).size).toBe(0);
    expect(statSync(fx.expertiseBuf).size).toBe(0);
  });

  // ── Scenario 5: PreCompact owns flush-before-resume-boundary ordering ─
  it('PreCompact flushes all while creating only a minimal handoff when absent', () => {
    writeFileSync(fx.journalBuf, 'buffered entry that must land before handoff\n');

    const preResult = run(PRE_COMPACT_SCRIPT, ['TestAgent', fx.agentDir], {
      HOME: fx.fakeHome,
    });
    expect(preResult.status).toBe(0);

    expect(readFileSync(fx.todayMd, 'utf8')).toContain('buffered entry that must land');
    expect(readFileSync(join(fx.logsDir, 'handoff.md'), 'utf8').trimEnd().split('\n')).toHaveLength(4);
    expect(statSync(fx.journalBuf).size).toBe(0);
  });

  // ── Scenario 6: Turn-counter safety net fires at the configured interval ─
  it('scratch-flush-counter fires flush exactly at SCRATCH_FLUSH_INTERVAL', () => {
    writeFileSync(fx.journalBuf, 'pending from turns 1 and 2\n');

    // Interval=3 → counter hits the threshold on the 3rd call
    // (turn 1: counter 0→1, turn 2: 1→2, turn 3: 2→3 >= interval → flush)
    for (let i = 1; i <= 2; i++) {
      const r = run(COUNTER_SCRIPT, ['TestAgent', fx.agentDir], {
        HOME: fx.fakeHome,
        SCRATCH_FLUSH_INTERVAL: '3',
      });
      expect(r.status).toBe(0);
    }
    // Buffer still holds content (haven't hit interval yet)
    expect(readFileSync(fx.journalBuf, 'utf8')).toContain('pending');
    expect(existsSync(fx.todayMd)).toBe(false);

    // 3rd call crosses the threshold → flush fires, buffer empties
    const r3 = run(COUNTER_SCRIPT, ['TestAgent', fx.agentDir], {
      HOME: fx.fakeHome,
      SCRATCH_FLUSH_INTERVAL: '3',
    });
    expect(r3.status).toBe(0);
    expect(statSync(fx.journalBuf).size).toBe(0);
    expect(readFileSync(fx.todayMd, 'utf8')).toContain('pending from turns 1 and 2');

    // Counter reset → 4th call does not fire again on its own
    appendFileSync(fx.journalBuf, 'new post-reset entry\n');
    const r4 = run(COUNTER_SCRIPT, ['TestAgent', fx.agentDir], {
      HOME: fx.fakeHome,
      SCRATCH_FLUSH_INTERVAL: '3',
    });
    expect(r4.status).toBe(0);
    expect(readFileSync(fx.journalBuf, 'utf8')).toContain('new post-reset entry');
  });

  // ── Scenario 7: Empty buffers are a no-op, targets untouched ────────────
  it('flush.sh on empty buffers does not create target files or log entries', () => {
    // Buffers exist but are empty (init state)
    expect(statSync(fx.journalBuf).size).toBe(0);

    const r = run(FLUSH_SCRIPT, ['TestAgent', fx.agentDir, 'all'], { HOME: fx.fakeHome });
    expect(r.status).toBe(0);

    // No target files created
    expect(existsSync(fx.todayMd)).toBe(false);
    expect(existsSync(fx.memoryMd)).toBe(false);
    expect(existsSync(fx.expertiseMd)).toBe(false);

    // flush.log should have no flushed-* entries (empty file is fine)
    if (existsSync(fx.flushLog)) {
      const log = readFileSync(fx.flushLog, 'utf8');
      expect(log).not.toMatch(/flushed journal/);
      expect(log).not.toMatch(/flushed memory/);
      expect(log).not.toMatch(/flushed expertise/);
    }
  });

  // ── Scenario 8: Concurrent flush with lock contention yields skip ───────
  it('flush.sh skips gracefully when flush.lock is held externally', async () => {
    writeFileSync(fx.journalBuf, 'content that should NOT be flushed under contention\n');

    // Hold the flock externally via a background bash that acquires and sleeps
    const lockHolder = spawn(
      'bash',
      ['-c', `exec 9>${fx.scratchDir}/flush.lock && flock 9 && sleep 2`],
      { stdio: 'ignore' }
    );

    // Give the holder a moment to acquire
    await new Promise((r) => setTimeout(r, 200));

    const r = run(FLUSH_SCRIPT, ['TestAgent', fx.agentDir, 'all'], { HOME: fx.fakeHome });

    // Release the holder
    lockHolder.kill();
    await new Promise((r) => setTimeout(r, 100));

    // flush.sh should exit 0 (clean skip), buffer preserved, log shows skip
    expect(r.status).toBe(0);
    expect(readFileSync(fx.journalBuf, 'utf8')).toContain('should NOT be flushed');
    expect(existsSync(fx.todayMd)).toBe(false);
    const log = readFileSync(fx.flushLog, 'utf8');
    expect(log).toMatch(/skip: another flush holds the lock/);
  });

  it('memory cap exit 1 preserves the pending buffer and target', () => {
    const oversized = 'x'.repeat(2201);
    writeFileSync(fx.memoryBuf, oversized);

    const r = run(FLUSH_SCRIPT, ['TestAgent', fx.agentDir, 'memory'], { HOME: fx.fakeHome });

    expect(r.status).toBe(0);
    expect(readFileSync(fx.memoryBuf, 'utf8')).toBe(oversized);
    expect(existsSync(fx.memoryMd)).toBe(false);
    expect(readFileSync(fx.flushLog, 'utf8')).toMatch(/cap-gate: BLOCKED memory flush/);
  });

  // ── Scenario 9: No .tmp leftover files after successful flush ───────────
  it('atomic-rename leaves no .tmp files in the target directories', () => {
    writeFileSync(fx.journalBuf, 'some journal\n');
    writeFileSync(fx.memoryBuf, 'some memory\n');
    writeFileSync(fx.expertiseBuf, 'some expertise\n');

    const r = run(FLUSH_SCRIPT, ['TestAgent', fx.agentDir, 'all'], { HOME: fx.fakeHome });
    expect(r.status).toBe(0);

    // No *.flush.*.tmp files anywhere in the fixture
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) {
          out.push(...walk(full));
        } else {
          out.push(full);
        }
      }
      return out;
    }
    const allFiles = walk(fx.baseDir);
    const leaks = allFiles.filter((f) => /\.flush\.\d+\.tmp$/.test(f));
    expect(leaks).toEqual([]);
  });

  // ── Scenario 10: Full end-to-end (write → flush all → second flush is no-op) ─
  it('full round-trip: write → flush → empty → re-flush is a no-op', () => {
    writeFileSync(fx.journalBuf, 'turn 1 entry\n');
    writeFileSync(fx.memoryBuf, 'memory delta\n');
    writeFileSync(fx.expertiseBuf, 'expertise delta\n');

    // First flush: content lands
    const r1 = run(FLUSH_SCRIPT, ['TestAgent', fx.agentDir, 'all'], { HOME: fx.fakeHome });
    expect(r1.status).toBe(0);
    expect(readFileSync(fx.todayMd, 'utf8')).toBe('turn 1 entry\n');

    // Second flush on empty buffers: targets unchanged, no new log entries
    const beforeLog = existsSync(fx.flushLog) ? readFileSync(fx.flushLog, 'utf8') : '';
    const r2 = run(FLUSH_SCRIPT, ['TestAgent', fx.agentDir, 'all'], { HOME: fx.fakeHome });
    expect(r2.status).toBe(0);
    expect(readFileSync(fx.todayMd, 'utf8')).toBe('turn 1 entry\n');
    const afterLog = existsSync(fx.flushLog) ? readFileSync(fx.flushLog, 'utf8') : '';
    // Log file unchanged (no new 'flushed *' entries)
    const newFlushLines =
      afterLog.split('\n').filter((l) => /flushed (journal|memory|expertise)/.test(l)).length -
      beforeLog.split('\n').filter((l) => /flushed (journal|memory|expertise)/.test(l)).length;
    expect(newFlushLines).toBe(0);

    // Write new content, third flush: appends to existing target without
    // clobbering the turn 1 entry
    writeFileSync(fx.journalBuf, 'turn 2 entry\n');
    const r3 = run(FLUSH_SCRIPT, ['TestAgent', fx.agentDir, 'all'], { HOME: fx.fakeHome });
    expect(r3.status).toBe(0);
    const finalContent = readFileSync(fx.todayMd, 'utf8');
    expect(finalContent).toContain('turn 1 entry');
    expect(finalContent).toContain('turn 2 entry');
    // Order matters: turn 1 came first
    expect(finalContent.indexOf('turn 1 entry')).toBeLessThan(finalContent.indexOf('turn 2 entry'));
  });
});
