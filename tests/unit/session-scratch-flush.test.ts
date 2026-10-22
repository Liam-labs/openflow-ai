import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const FLUSH_SCRIPT = join(REPO, 'scripts', 'hooks', 'flush.sh');
const INIT_SCRIPT = join(REPO, 'scripts', 'hooks', 'session-scratch-init.sh');

type RunResult = { stdout: string; stderr: string; status: number };

function run(args: string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync('bash', [FLUSH_SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      status: err.status ?? 1,
    };
  }
}

function initScratch(agentDir: string): void {
  execFileSync('bash', [INIT_SCRIPT, 'TestAgent', agentDir], { stdio: 'ignore' });
}

describe('flush.sh', () => {
  let agentDir: string;
  let fakeHome: string;
  let memoryTargetDir: string;
  let memoryTarget: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'flush-'));
    agentDir = join(base, 'Agent');
    mkdirSync(agentDir, { recursive: true });
    fakeHome = join(base, 'home');
    mkdirSync(fakeHome, { recursive: true });
    // Derive project-key path matching the script's convention:
    //   /tmp/flush-xxxxx/Agent -> -tmp-flush-xxxxx-Agent
    const key = agentDir.replace(/\//g, '-');
    memoryTargetDir = join(fakeHome, '.claude', 'projects', key, 'memory');
    memoryTarget = join(memoryTargetDir, 'MEMORY.md');
    initScratch(agentDir);
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  // ------- Empty buffer -------
  it('empty buffer → no-op, target unchanged, buffer still empty', () => {
    const todayDir = join(agentDir, 'logs');
    mkdirSync(todayDir, { recursive: true });
    const today = join(todayDir, 'today.md');
    writeFileSync(today, '# existing\n');
    const result = run(['TestAgent', agentDir, 'journal'], { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(readFileSync(today, 'utf8')).toBe('# existing\n');
    expect(statSync(join(agentDir, '.session-scratch', 'journal.md')).size).toBe(0);
  });

  // ------- Non-empty journal → append + truncate -------
  it('non-empty journal buffer → appended to logs/today.md, buffer truncated', () => {
    const todayDir = join(agentDir, 'logs');
    mkdirSync(todayDir, { recursive: true });
    const today = join(todayDir, 'today.md');
    writeFileSync(today, '# Today\n\n');
    const bufContent = '## 12:34 — test\n- bullet one\n- bullet two\n';
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), bufContent);
    const result = run(['TestAgent', agentDir, 'journal'], { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(readFileSync(today, 'utf8')).toBe('# Today\n\n' + bufContent);
    expect(statSync(join(agentDir, '.session-scratch', 'journal.md')).size).toBe(0);
  });

  // ------- Target file does not exist → created -------
  it('target file does not exist → created with buffer content', () => {
    const bufContent = '## 13:00 — fresh day\n- first entry\n';
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), bufContent);
    const result = run(['TestAgent', agentDir, 'journal'], { HOME: fakeHome });
    expect(result.status).toBe(0);
    const today = join(agentDir, 'logs', 'today.md');
    expect(existsSync(today)).toBe(true);
    expect(readFileSync(today, 'utf8')).toBe(bufContent);
  });

  // ------- memory buffer → derived MEMORY.md path -------
  it('memory buffer → appended to derived ~/.claude/projects/<key>/memory/MEMORY.md', () => {
    mkdirSync(memoryTargetDir, { recursive: true });
    writeFileSync(memoryTarget, '# Existing memory\n');
    const bufContent = '## New fact\nSomething durable.\n';
    writeFileSync(join(agentDir, '.session-scratch', 'memory-pending.md'), bufContent);
    const result = run(['TestAgent', agentDir, 'memory'], { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(readFileSync(memoryTarget, 'utf8')).toBe('# Existing memory\n' + bufContent);
    expect(statSync(join(agentDir, '.session-scratch', 'memory-pending.md')).size).toBe(0);
  });

  it('memory buffer → creates target dir + file if missing', () => {
    const bufContent = '## First fact\nwritten\n';
    writeFileSync(join(agentDir, '.session-scratch', 'memory-pending.md'), bufContent);
    const result = run(['TestAgent', agentDir, 'memory'], { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(existsSync(memoryTarget)).toBe(true);
    expect(readFileSync(memoryTarget, 'utf8')).toBe(bufContent);
  });

  // ------- expertise buffer -------
  it('expertise buffer → appended to <AgentDir>/Expertise.md', () => {
    const expertise = join(agentDir, 'Expertise.md');
    writeFileSync(expertise, '# Expertise\n\n## Existing entry\n');
    const bufContent = '\n## New pattern\nsome details\n';
    writeFileSync(join(agentDir, '.session-scratch', 'expertise-pending.md'), bufContent);
    const result = run(['TestAgent', agentDir, 'expertise'], { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(readFileSync(expertise, 'utf8')).toBe('# Expertise\n\n## Existing entry\n' + bufContent);
    expect(statSync(join(agentDir, '.session-scratch', 'expertise-pending.md')).size).toBe(0);
  });

  // ------- content formatting preserved (exact byte equality) -------
  it('buffer content formatting preserved (newlines, headers, bullets — exact byte)', () => {
    const buf = '## 14:22 — **bold title**\n- item 1\n  - nested\n- item 2\n\n```ts\ncode block\n```\n';
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), buf);
    run(['TestAgent', agentDir, 'journal'], { HOME: fakeHome });
    const today = join(agentDir, 'logs', 'today.md');
    expect(readFileSync(today, 'utf8')).toBe(buf);
  });

  // ------- all mode flushes all 3 -------
  it('"all" mode flushes journal + memory + expertise in one call', () => {
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), 'j\n');
    writeFileSync(join(agentDir, '.session-scratch', 'memory-pending.md'), 'm\n');
    writeFileSync(join(agentDir, '.session-scratch', 'expertise-pending.md'), 'e\n');
    const result = run(['TestAgent', agentDir, 'all'], { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(readFileSync(join(agentDir, 'logs', 'today.md'), 'utf8')).toBe('j\n');
    expect(readFileSync(memoryTarget, 'utf8')).toBe('m\n');
    expect(readFileSync(join(agentDir, 'Expertise.md'), 'utf8')).toBe('e\n');
    expect(statSync(join(agentDir, '.session-scratch', 'journal.md')).size).toBe(0);
    expect(statSync(join(agentDir, '.session-scratch', 'memory-pending.md')).size).toBe(0);
    expect(statSync(join(agentDir, '.session-scratch', 'expertise-pending.md')).size).toBe(0);
  });

  it('default mode (no buffer arg) is "all"', () => {
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), 'jj\n');
    writeFileSync(join(agentDir, '.session-scratch', 'memory-pending.md'), 'mm\n');
    const result = run(['TestAgent', agentDir], { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(readFileSync(join(agentDir, 'logs', 'today.md'), 'utf8')).toBe('jj\n');
    expect(readFileSync(memoryTarget, 'utf8')).toBe('mm\n');
  });

  // ------- flock serialization -------
  it('concurrent flush attempts → second attempt skipped (flock non-blocking)', async () => {
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), 'first-content\n');
    const lockFile = join(agentDir, '.session-scratch', 'flush.lock');
    // Hold the lock from a sibling process for 2s.
    const holder = spawn('bash', ['-c', `flock -x "${lockFile}" -c 'sleep 2'`], {
      stdio: 'ignore',
    });
    // Give the holder 200ms to actually grab the lock.
    await new Promise((r) => setTimeout(r, 200));
    const result = run(['TestAgent', agentDir, 'journal'], { HOME: fakeHome });
    expect(result.status).toBe(0);
    // Buffer should still have content — we skipped the flush.
    expect(readFileSync(join(agentDir, '.session-scratch', 'journal.md'), 'utf8')).toBe('first-content\n');
    // flush.log should record the skip.
    const log = readFileSync(join(agentDir, '.session-scratch', 'flush.log'), 'utf8');
    expect(log).toMatch(/skip.*lock|lock.*skip/i);
    // Wait for holder to finish.
    await new Promise((r) => holder.on('exit', r));
  });

  // ------- atomic rename (byte equality) -------
  it('atomic rename pattern — target file byte-equals (old + buffer) after flush', () => {
    const todayDir = join(agentDir, 'logs');
    mkdirSync(todayDir, { recursive: true });
    const today = join(todayDir, 'today.md');
    const original = '# Today\n\n## 09:00 — morning\n- a\n- b\n';
    writeFileSync(today, original);
    const buf = '## 10:30 — later\n- c\n';
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), buf);
    run(['TestAgent', agentDir, 'journal'], { HOME: fakeHome });
    const actual = readFileSync(today, 'utf8');
    expect(actual).toBe(original + buf);
    // No leftover tmp files
    const leftovers = execFileSync('bash', ['-c', `ls "${todayDir}"/today.md.flush.*.tmp 2>/dev/null | wc -l`], { encoding: 'utf8' });
    expect(leftovers.trim()).toBe('0');
  });

  // ------- flush.log entries -------
  it('successful flush writes a log entry to .session-scratch/flush.log', () => {
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), 'hi\n');
    run(['TestAgent', agentDir, 'journal'], { HOME: fakeHome });
    const log = readFileSync(join(agentDir, '.session-scratch', 'flush.log'), 'utf8');
    expect(log).toMatch(/flushed.*journal/i);
  });

  it('empty buffer does not pollute flush.log', () => {
    run(['TestAgent', agentDir, 'journal'], { HOME: fakeHome });
    const logPath = join(agentDir, '.session-scratch', 'flush.log');
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    expect(log).not.toMatch(/flushed/i);
  });

  // ------- idempotency after flush -------
  it('running flush twice on already-empty buffer is a no-op', () => {
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), 'one\n');
    run(['TestAgent', agentDir, 'journal'], { HOME: fakeHome });
    const afterFirst = readFileSync(join(agentDir, 'logs', 'today.md'), 'utf8');
    const result = run(['TestAgent', agentDir, 'journal'], { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(readFileSync(join(agentDir, 'logs', 'today.md'), 'utf8')).toBe(afterFirst);
  });

  // ------- error paths -------
  it('exits non-zero with usage when args missing', () => {
    const result = run([], { HOME: fakeHome });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage/i);
  });

  it('exits non-zero when AgentDir does not exist', () => {
    const result = run(['TestAgent', join(agentDir, 'does-not-exist')], { HOME: fakeHome });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not found|does not exist/i);
  });

  it('exits non-zero when scratch dir is missing', () => {
    rmSync(join(agentDir, '.session-scratch'), { recursive: true });
    const result = run(['TestAgent', agentDir], { HOME: fakeHome });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/scratch/i);
  });

  it('exits non-zero with unknown buffer type', () => {
    const result = run(['TestAgent', agentDir, 'bogus'], { HOME: fakeHome });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown|invalid/i);
  });
});
