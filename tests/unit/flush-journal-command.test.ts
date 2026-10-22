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
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const HELPER = join(REPO, 'scripts', 'hooks', 'flush-journal.sh');
const INIT = join(REPO, 'scripts', 'hooks', 'session-scratch-init.sh');
const COMMAND_MD = join(homedir(), '.claude', 'commands', 'flush-journal.md');

type RunResult = { stdout: string; stderr: string; status: number };

function run(args: string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync('bash', [HELPER, ...args], {
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

function seedAgent(base: string, displayName = 'TestAgent'): {
  agentDir: string;
  sessionFile: string;
  fakeHome: string;
} {
  const agentDir = join(base, 'Agent');
  mkdirSync(agentDir, { recursive: true });
  const claudeDir = join(agentDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const sessionFile = join(claudeDir, 'collab-session-12345.json');
  writeFileSync(
    sessionFile,
    JSON.stringify({
      channelId: 'test-channel',
      participantId: 'test-participant',
      displayName,
      projectPath: agentDir,
      pid: 12345,
    }),
  );
  execFileSync('bash', [INIT, displayName, agentDir], { stdio: 'ignore' });
  const fakeHome = join(base, 'home');
  mkdirSync(fakeHome, { recursive: true });
  return { agentDir, sessionFile, fakeHome };
}

describe('flush-journal.sh helper', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'flush-journal-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('explicit session file via FLUSH_SESSION_FILE env → flushes journal buffer', () => {
    const { agentDir, sessionFile, fakeHome } = seedAgent(tempRoot);
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), '## 10:00 — hi\n');
    const result = run([], { FLUSH_SESSION_FILE: sessionFile, HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(readFileSync(join(agentDir, 'logs', 'today.md'), 'utf8')).toBe('## 10:00 — hi\n');
    expect(statSync(join(agentDir, '.session-scratch', 'journal.md')).size).toBe(0);
  });

  it('default mode flushes ONLY journal, not memory or expertise', () => {
    const { agentDir, sessionFile, fakeHome } = seedAgent(tempRoot);
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), 'j\n');
    writeFileSync(join(agentDir, '.session-scratch', 'memory-pending.md'), 'm\n');
    writeFileSync(join(agentDir, '.session-scratch', 'expertise-pending.md'), 'e\n');
    const result = run([], { FLUSH_SESSION_FILE: sessionFile, HOME: fakeHome });
    expect(result.status).toBe(0);
    // journal drained
    expect(statSync(join(agentDir, '.session-scratch', 'journal.md')).size).toBe(0);
    // memory + expertise untouched
    expect(readFileSync(join(agentDir, '.session-scratch', 'memory-pending.md'), 'utf8')).toBe('m\n');
    expect(readFileSync(join(agentDir, '.session-scratch', 'expertise-pending.md'), 'utf8')).toBe('e\n');
  });

  it('--all flag flushes all 3 buffers', () => {
    const { agentDir, sessionFile, fakeHome } = seedAgent(tempRoot);
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), 'j\n');
    writeFileSync(join(agentDir, '.session-scratch', 'memory-pending.md'), 'm\n');
    writeFileSync(join(agentDir, '.session-scratch', 'expertise-pending.md'), 'e\n');
    const result = run(['--all'], { FLUSH_SESSION_FILE: sessionFile, HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(statSync(join(agentDir, '.session-scratch', 'journal.md')).size).toBe(0);
    expect(statSync(join(agentDir, '.session-scratch', 'memory-pending.md')).size).toBe(0);
    expect(statSync(join(agentDir, '.session-scratch', 'expertise-pending.md')).size).toBe(0);
  });

  it('empty journal buffer → exit 0, no-op, user-facing message', () => {
    const { sessionFile, fakeHome } = seedAgent(tempRoot);
    const result = run([], { FLUSH_SESSION_FILE: sessionFile, HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/done/i);
  });

  it('prints flush.log tail on successful non-empty flush', () => {
    const { agentDir, sessionFile, fakeHome } = seedAgent(tempRoot);
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), 'content\n');
    const result = run([], { FLUSH_SESSION_FILE: sessionFile, HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/flushed.*journal/i);
  });

  it('missing session file → exit 1 with clear error', () => {
    const fakeHome = join(tempRoot, 'home');
    mkdirSync(fakeHome, { recursive: true });
    const result = run([], { FLUSH_SESSION_FILE: '/nonexistent/session.json', HOME: fakeHome });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no collab session|session file/i);
  });

  it('session file missing displayName → exit 1', () => {
    const agentDir = join(tempRoot, 'Agent');
    mkdirSync(agentDir, { recursive: true });
    const sessionFile = join(tempRoot, 'bad-session.json');
    writeFileSync(sessionFile, JSON.stringify({ projectPath: agentDir }));
    execFileSync('bash', [INIT, 'Placeholder', agentDir], { stdio: 'ignore' });
    const fakeHome = join(tempRoot, 'home');
    mkdirSync(fakeHome, { recursive: true });
    const result = run([], { FLUSH_SESSION_FILE: sessionFile, HOME: fakeHome });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/displayName|projectPath|missing/i);
  });

  it('session file missing projectPath → exit 1', () => {
    const sessionFile = join(tempRoot, 'bad-session.json');
    writeFileSync(sessionFile, JSON.stringify({ displayName: 'Foo' }));
    const fakeHome = join(tempRoot, 'home');
    mkdirSync(fakeHome, { recursive: true });
    const result = run([], { FLUSH_SESSION_FILE: sessionFile, HOME: fakeHome });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/projectPath|missing/i);
  });

  it('scratch dir missing in agent → propagates flush.sh error', () => {
    const agentDir = join(tempRoot, 'Agent');
    mkdirSync(agentDir, { recursive: true });
    const sessionFile = join(tempRoot, 'session.json');
    writeFileSync(
      sessionFile,
      JSON.stringify({ displayName: 'X', projectPath: agentDir, pid: 1 }),
    );
    const fakeHome = join(tempRoot, 'home');
    mkdirSync(fakeHome, { recursive: true });
    const result = run([], { FLUSH_SESSION_FILE: sessionFile, HOME: fakeHome });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/scratch/i);
  });

  it('PPID-based fallback discovers session file in cwd/.claude/ (most recent)', () => {
    const { agentDir, fakeHome } = seedAgent(tempRoot);
    writeFileSync(join(agentDir, '.session-scratch', 'journal.md'), 'discovered\n');
    // Launch with cwd=agentDir, no FLUSH_SESSION_FILE override
    const stdout = execFileSync('bash', [HELPER], {
      cwd: agentDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: fakeHome, FLUSH_SESSION_FILE: '' },
    });
    expect(stdout).toMatch(/done|flushed/i);
    expect(readFileSync(join(agentDir, 'logs', 'today.md'), 'utf8')).toBe('discovered\n');
  });
});

describe('/flush-journal slash command markdown', () => {
  it('exists at ~/.claude/commands/flush-journal.md', () => {
    expect(existsSync(COMMAND_MD)).toBe(true);
  });

  it('has frontmatter with description + allowed-tools', () => {
    const content = readFileSync(COMMAND_MD, 'utf8');
    expect(content).toMatch(/^---/m);
    expect(content).toMatch(/description:\s*\S/i);
    expect(content).toMatch(/allowed-tools:\s*Bash/i);
  });

  it('references the helper script path', () => {
    const content = readFileSync(COMMAND_MD, 'utf8');
    expect(content).toContain(join(REPO, 'scripts', 'hooks', 'flush-journal.sh'));
  });

  it('passes $ARGUMENTS through for --all support', () => {
    const content = readFileSync(COMMAND_MD, 'utf8');
    expect(content).toContain('$ARGUMENTS');
  });
});
