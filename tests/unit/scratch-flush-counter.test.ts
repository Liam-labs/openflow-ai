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

const COUNTER_SH = join(REPO, 'scripts', 'hooks', 'scratch-flush-counter.sh');
const INIT_SH = join(REPO, 'scripts', 'hooks', 'session-scratch-init.sh');

type RunResult = { stdout: string; stderr: string; status: number };

function run(args: string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync('bash', [COUNTER_SH, ...args], {
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

function setup(): { agentDir: string; fakeHome: string; counterFile: string; journal: string } {
  const base = mkdtempSync(join(tmpdir(), 'scratch-flush-counter-'));
  const agentDir = join(base, 'Agent');
  mkdirSync(join(agentDir, '.claude'), { recursive: true });
  const fakeHome = join(base, 'home');
  mkdirSync(fakeHome, { recursive: true });
  execFileSync('bash', [INIT_SH, 'TestAgent', agentDir], { stdio: 'ignore' });
  return {
    agentDir,
    fakeHome,
    counterFile: join(agentDir, '.claude', '.scratch-flush-counter'),
    journal: join(agentDir, '.session-scratch', 'journal.md'),
  };
}

function cleanup(agentDir: string): void {
  // one level up — the tmpdir root
  const base = agentDir.replace(/\/Agent$/, '');
  rmSync(base, { recursive: true, force: true });
}

describe('scratch-flush-counter.sh', () => {
  it('first call → counter=1, no flush', () => {
    const { agentDir, fakeHome, counterFile, journal } = setup();
    writeFileSync(journal, 'pending content\n');
    const result = run(['TestAgent', agentDir], { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(readFileSync(counterFile, 'utf8').trim()).toBe('1');
    // Buffer untouched because we haven't hit interval yet
    expect(readFileSync(journal, 'utf8')).toBe('pending content\n');
    cleanup(agentDir);
  });

  it('counter persists across calls and increments correctly', () => {
    const { agentDir, fakeHome, counterFile } = setup();
    for (let i = 1; i <= 5; i++) {
      run(['TestAgent', agentDir], { HOME: fakeHome });
      expect(readFileSync(counterFile, 'utf8').trim()).toBe(String(i));
    }
    cleanup(agentDir);
  });

  it('at interval (default 25) → flushes all buffers + resets counter to 0', () => {
    const { agentDir, fakeHome, counterFile, journal } = setup();
    writeFileSync(journal, 'content to be flushed at 25\n');
    writeFileSync(join(agentDir, '.session-scratch', 'memory-pending.md'), 'memory fact\n');
    // Manually set the counter so we don't have to loop 24 times
    writeFileSync(counterFile, '24');
    run(['TestAgent', agentDir], { HOME: fakeHome });
    // Counter should have reset to 0
    expect(readFileSync(counterFile, 'utf8').trim()).toBe('0');
    // Buffers drained
    expect(statSync(journal).size).toBe(0);
    expect(statSync(join(agentDir, '.session-scratch', 'memory-pending.md')).size).toBe(0);
    // Content landed in target files
    expect(readFileSync(join(agentDir, 'logs', 'today.md'), 'utf8')).toBe('content to be flushed at 25\n');
    cleanup(agentDir);
  });

  it('custom interval via SCRATCH_FLUSH_INTERVAL env fires at that interval', () => {
    const { agentDir, fakeHome, counterFile, journal } = setup();
    writeFileSync(journal, 'triggered at 3\n');
    // 2 calls, no flush
    run(['TestAgent', agentDir], { HOME: fakeHome, SCRATCH_FLUSH_INTERVAL: '3' });
    run(['TestAgent', agentDir], { HOME: fakeHome, SCRATCH_FLUSH_INTERVAL: '3' });
    expect(readFileSync(counterFile, 'utf8').trim()).toBe('2');
    expect(statSync(journal).size).toBeGreaterThan(0);
    // 3rd call triggers flush
    run(['TestAgent', agentDir], { HOME: fakeHome, SCRATCH_FLUSH_INTERVAL: '3' });
    expect(readFileSync(counterFile, 'utf8').trim()).toBe('0');
    expect(statSync(journal).size).toBe(0);
    expect(readFileSync(join(agentDir, 'logs', 'today.md'), 'utf8')).toBe('triggered at 3\n');
    cleanup(agentDir);
  });

  it('subsequent interval hits continue to trigger (counter loops correctly)', () => {
    const { agentDir, fakeHome, counterFile, journal } = setup();
    writeFileSync(counterFile, '0');
    // First cycle: seed + 3 calls to hit interval=3
    writeFileSync(journal, 'cycle 1\n');
    for (let i = 0; i < 3; i++) {
      run(['TestAgent', agentDir], { HOME: fakeHome, SCRATCH_FLUSH_INTERVAL: '3' });
    }
    expect(readFileSync(counterFile, 'utf8').trim()).toBe('0');
    expect(statSync(journal).size).toBe(0);
    // Second cycle: seed new content, 3 more calls
    writeFileSync(journal, 'cycle 2\n');
    for (let i = 0; i < 3; i++) {
      run(['TestAgent', agentDir], { HOME: fakeHome, SCRATCH_FLUSH_INTERVAL: '3' });
    }
    expect(readFileSync(counterFile, 'utf8').trim()).toBe('0');
    expect(statSync(journal).size).toBe(0);
    // today.md should have BOTH cycles
    expect(readFileSync(join(agentDir, 'logs', 'today.md'), 'utf8')).toBe('cycle 1\ncycle 2\n');
    cleanup(agentDir);
  });

  it('empty buffer at interval → flush is no-op but counter still resets', () => {
    const { agentDir, fakeHome, counterFile, journal } = setup();
    writeFileSync(counterFile, '2');
    // No buffer content — journal is 0 bytes from init
    run(['TestAgent', agentDir], { HOME: fakeHome, SCRATCH_FLUSH_INTERVAL: '3' });
    expect(readFileSync(counterFile, 'utf8').trim()).toBe('0');
    expect(statSync(journal).size).toBe(0);
    // today.md NOT created because flush on empty buffer is no-op
    expect(existsSync(join(agentDir, 'logs', 'today.md'))).toBe(false);
    cleanup(agentDir);
  });

  it('missing counter file → starts from 1', () => {
    const { agentDir, fakeHome, counterFile } = setup();
    // Counter file doesn't exist yet
    expect(existsSync(counterFile)).toBe(false);
    run(['TestAgent', agentDir], { HOME: fakeHome });
    expect(readFileSync(counterFile, 'utf8').trim()).toBe('1');
    cleanup(agentDir);
  });

  it('corrupt counter file → recovers and starts from 1', () => {
    const { agentDir, fakeHome, counterFile } = setup();
    writeFileSync(counterFile, 'not-a-number\x00garbage');
    const result = run(['TestAgent', agentDir], { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(readFileSync(counterFile, 'utf8').trim()).toBe('1');
    cleanup(agentDir);
  });

  it('missing .claude dir → creates counter file parent', () => {
    const base = mkdtempSync(join(tmpdir(), 'scratch-flush-counter-bare-'));
    const agentDir = join(base, 'Agent');
    mkdirSync(agentDir, { recursive: true });
    const fakeHome = join(base, 'home');
    mkdirSync(fakeHome, { recursive: true });
    execFileSync('bash', [INIT_SH, 'Bare', agentDir], { stdio: 'ignore' });
    // .claude dir doesn't exist — script should create it
    const result = run(['Bare', agentDir], { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(readFileSync(join(agentDir, '.claude', '.scratch-flush-counter'), 'utf8').trim()).toBe('1');
    rmSync(base, { recursive: true, force: true });
  });

  it('usage error: missing args → exit 1 + /usage/ stderr', () => {
    const result = run([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage/i);
  });

  it('bad agent dir → exit 1', () => {
    const result = run(['TestAgent', '/nonexistent/agent/dir']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not found|does not exist/i);
  });
});
