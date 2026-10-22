import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const SCRIPT = join(REPO, 'scripts', 'hooks', 'session-scratch-init.sh');

function run(agentName: string, agentDir: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('bash', [SCRIPT, agentName, agentDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
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

function runWithStdin(agentName: string, agentDir: string, stdin: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('bash', [SCRIPT, agentName, agentDir], {
      encoding: 'utf8',
      input: stdin,
      stdio: ['pipe', 'pipe', 'pipe'],
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

describe('session-scratch-init.sh', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-scratch-init-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .session-scratch/ directory on first run', () => {
    const result = run('TestAgent', tempDir);
    expect(result.status).toBe(0);
    expect(existsSync(join(tempDir, '.session-scratch'))).toBe(true);
    expect(statSync(join(tempDir, '.session-scratch')).isDirectory()).toBe(true);
  });

  it('creates journal.md, memory-pending.md, expertise-pending.md, flush.lock', () => {
    const result = run('TestAgent', tempDir);
    expect(result.status).toBe(0);
    const scratch = join(tempDir, '.session-scratch');
    expect(existsSync(join(scratch, 'journal.md'))).toBe(true);
    expect(existsSync(join(scratch, 'memory-pending.md'))).toBe(true);
    expect(existsSync(join(scratch, 'expertise-pending.md'))).toBe(true);
    expect(existsSync(join(scratch, 'flush.lock'))).toBe(true);
  });

  it('is idempotent — re-running does not overwrite existing content', () => {
    run('TestAgent', tempDir);
    const journal = join(tempDir, '.session-scratch', 'journal.md');
    writeFileSync(journal, '## 12:34 — test entry\n- some content\n');
    const memPending = join(tempDir, '.session-scratch', 'memory-pending.md');
    writeFileSync(memPending, '## Topic\npending note\n');
    const result = run('TestAgent', tempDir);
    expect(result.status).toBe(0);
    expect(readFileSync(journal, 'utf8')).toBe('## 12:34 — test entry\n- some content\n');
    expect(readFileSync(memPending, 'utf8')).toBe('## Topic\npending note\n');
  });

  it('creates only missing files when directory partially exists', () => {
    const scratch = join(tempDir, '.session-scratch');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'journal.md'), 'pre-existing journal\n');
    const result = run('TestAgent', tempDir);
    expect(result.status).toBe(0);
    expect(readFileSync(join(scratch, 'journal.md'), 'utf8')).toBe('pre-existing journal\n');
    expect(existsSync(join(scratch, 'memory-pending.md'))).toBe(true);
    expect(existsSync(join(scratch, 'expertise-pending.md'))).toBe(true);
    expect(existsSync(join(scratch, 'flush.lock'))).toBe(true);
  });

  it('creates new files as empty (zero-byte) so flush.sh can empty-check cleanly', () => {
    run('TestAgent', tempDir);
    const scratch = join(tempDir, '.session-scratch');
    for (const f of ['journal.md', 'memory-pending.md', 'expertise-pending.md', 'flush.lock']) {
      const size = statSync(join(scratch, f)).size;
      expect(size, `${f} should be empty on init`).toBe(0);
    }
  });

  it('exits non-zero with usage when AgentName is missing', () => {
    const result = run('', tempDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage/i);
  });

  it('exits non-zero with usage when AgentDir is missing', () => {
    const result = run('TestAgent', '');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage/i);
  });

  it('exits non-zero when AgentDir does not exist', () => {
    const nonexistent = join(tempDir, 'does-not-exist');
    const result = run('TestAgent', nonexistent);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not found|does not exist/i);
  });

  // Sprint 36 T3 — SessionStart hook JSON stdin handling

  it('Sprint 36 T3: writes session-id and transcript-path when Claude Code JSON is piped on stdin', () => {
    const sessionId = 'da50c8de-6969-411c-8d5c-c93bfdd42a0d';
    const transcriptPath = `${homedir()}/.claude/projects/-tmp-test/${sessionId}.jsonl`;
    const hookInput = JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd: tempDir,
    });
    const result = runWithStdin('TestAgent', tempDir, hookInput);
    expect(result.status).toBe(0);
    const scratch = join(tempDir, '.session-scratch');
    expect(readFileSync(join(scratch, 'session-id'), 'utf8').trim()).toBe(sessionId);
    expect(readFileSync(join(scratch, 'transcript-path'), 'utf8').trim()).toBe(transcriptPath);
  });

  it('Sprint 36 T3: overwrites session-id on subsequent SessionStart (new session_id)', () => {
    const firstInput = JSON.stringify({
      session_id: 'first-session-id',
      transcript_path: '/tmp/first.jsonl',
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    const secondInput = JSON.stringify({
      session_id: 'second-session-id',
      transcript_path: '/tmp/second.jsonl',
      hook_event_name: 'SessionStart',
      source: 'clear',
    });
    runWithStdin('TestAgent', tempDir, firstInput);
    runWithStdin('TestAgent', tempDir, secondInput);
    const scratch = join(tempDir, '.session-scratch');
    expect(readFileSync(join(scratch, 'session-id'), 'utf8').trim()).toBe('second-session-id');
    expect(readFileSync(join(scratch, 'transcript-path'), 'utf8').trim()).toBe('/tmp/second.jsonl');
  });

  it('Sprint 36 T3: does not create session-id file when stdin is empty (backward compat)', () => {
    const result = runWithStdin('TestAgent', tempDir, '');
    expect(result.status).toBe(0);
    const scratch = join(tempDir, '.session-scratch');
    expect(existsSync(join(scratch, 'session-id'))).toBe(false);
    expect(existsSync(join(scratch, 'transcript-path'))).toBe(false);
    // buffer files still created
    expect(existsSync(join(scratch, 'journal.md'))).toBe(true);
  });

  it('Sprint 36 T3: silent fallback on malformed JSON — exit 0, no files written, buffers still created', () => {
    const result = runWithStdin('TestAgent', tempDir, 'not valid json {{{');
    expect(result.status).toBe(0);
    const scratch = join(tempDir, '.session-scratch');
    expect(existsSync(join(scratch, 'session-id'))).toBe(false);
    expect(existsSync(join(scratch, 'transcript-path'))).toBe(false);
    expect(existsSync(join(scratch, 'journal.md'))).toBe(true);
    expect(existsSync(join(scratch, 'flush.lock'))).toBe(true);
  });

  it('Sprint 36 T3: JSON missing session_id writes nothing but exits cleanly', () => {
    const hookInput = JSON.stringify({
      hook_event_name: 'SessionStart',
      source: 'startup',
      // no session_id or transcript_path
    });
    const result = runWithStdin('TestAgent', tempDir, hookInput);
    expect(result.status).toBe(0);
    const scratch = join(tempDir, '.session-scratch');
    expect(existsSync(join(scratch, 'session-id'))).toBe(false);
    expect(existsSync(join(scratch, 'transcript-path'))).toBe(false);
  });

  it('Sprint 36 T3: JSON with only session_id writes session-id but not transcript-path', () => {
    const hookInput = JSON.stringify({
      session_id: 'abc-only',
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    const result = runWithStdin('TestAgent', tempDir, hookInput);
    expect(result.status).toBe(0);
    const scratch = join(tempDir, '.session-scratch');
    expect(readFileSync(join(scratch, 'session-id'), 'utf8').trim()).toBe('abc-only');
    expect(existsSync(join(scratch, 'transcript-path'))).toBe(false);
  });

  it('Sprint 36 T3: idempotent — existing session-id file preserves if new payload arrives with same session_id', () => {
    const sessionId = 'stable-session-id-123';
    const hookInput = JSON.stringify({
      session_id: sessionId,
      transcript_path: '/tmp/stable.jsonl',
      hook_event_name: 'SessionStart',
      source: 'resume',
    });
    runWithStdin('TestAgent', tempDir, hookInput);
    const firstSessionId = readFileSync(join(tempDir, '.session-scratch', 'session-id'), 'utf8').trim();
    runWithStdin('TestAgent', tempDir, hookInput);
    const secondSessionId = readFileSync(join(tempDir, '.session-scratch', 'session-id'), 'utf8').trim();
    expect(firstSessionId).toBe(sessionId);
    expect(secondSessionId).toBe(sessionId);
  });
});
