/**
 * Tests for direct tmux session verification — T2.1-fix (Layer 1+2).
 *
 * The spawn hot path used to rely on `refreshTmuxSessionCache()` which
 * silently returned an empty set on any `tmux list-sessions` failure,
 * producing false-positive "session failed to start" errors under burst
 * concurrency. The fix introduces:
 *   - tmuxHasSessionDirect(name) → 'present' | 'absent' | 'server-error'
 *   - verifySpawnedSession(name) → retries once on server-error
 *
 * These tests pin the three-way classifier behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process so promisify(execFile) inside collab-pty resolves to our stub
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { execFile } from 'child_process';
import {
  extractSpawnFailureDiagnostic,
  tmuxHasSessionDirect,
  verifySpawnedSession,
} from '@/lib/collab-pty';

type ExecFileCallback = (err: unknown, stdout: string, stderr: string) => void;

function queueExecFileResults(
  results: Array<{ ok: boolean; code?: number; stderr?: string; stdout?: string }>,
) {
  let i = 0;
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation((
    _cmd: string,
    _args: string[],
    cbOrOpts: unknown,
    maybeCb?: ExecFileCallback,
  ) => {
    const cb = (typeof cbOrOpts === 'function' ? cbOrOpts : maybeCb) as ExecFileCallback;
    const r = results[i++] || { ok: false, code: 1, stderr: "can't find session: x" };
    if (r.ok) {
      cb(null, r.stdout || '', '');
    } else {
      const err = Object.assign(new Error(r.stderr || 'exec error'), {
        code: r.code ?? 1,
        stderr: r.stderr || '',
      });
      cb(err, '', r.stderr || '');
    }
    return {} as unknown;
  });
}

describe('tmuxHasSessionDirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'present' when `tmux has-session` exits 0", async () => {
    queueExecFileResults([{ ok: true }]);
    expect(await tmuxHasSessionDirect('collab-agent-abc12345')).toBe('present');
  });

  it("returns 'absent' when `tmux has-session` exits 1 with 'can't find session'", async () => {
    queueExecFileResults([
      { ok: false, code: 1, stderr: "can't find session: collab-agent-missing" },
    ]);
    expect(await tmuxHasSessionDirect('collab-agent-missing')).toBe('absent');
  });

  it("returns 'absent' when stderr contains 'session not found'", async () => {
    queueExecFileResults([
      { ok: false, code: 1, stderr: 'session not found' },
    ]);
    expect(await tmuxHasSessionDirect('collab-agent-missing')).toBe('absent');
  });

  it("returns 'server-error' when exit code is not 1 (e.g. tmux server flap)", async () => {
    queueExecFileResults([
      { ok: false, code: 2, stderr: '' },
    ]);
    expect(await tmuxHasSessionDirect('collab-agent-abc12345')).toBe('server-error');
  });

  it("returns 'server-error' when exit 1 but stderr doesn't match the 'absent' sentinel", async () => {
    queueExecFileResults([
      { ok: false, code: 1, stderr: 'no server running on /tmp/tmux-1000/default' },
    ]);
    expect(await tmuxHasSessionDirect('collab-agent-abc12345')).toBe('server-error');
  });

  it("returns 'absent' for invalid session names without hitting tmux", async () => {
    queueExecFileResults([]);
    expect(await tmuxHasSessionDirect('')).toBe('absent');
    expect(await tmuxHasSessionDirect('bad name with space')).toBe('absent');
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('verifySpawnedSession (T2.1 retry-on-server-error)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true on immediate present', async () => {
    queueExecFileResults([{ ok: true }]);
    expect(await verifySpawnedSession('collab-agent-abc12345')).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('returns false on immediate absent (no retry — genuine miss)', async () => {
    queueExecFileResults([
      { ok: false, code: 1, stderr: "can't find session: collab-agent-abc12345" },
    ]);
    expect(await verifySpawnedSession('collab-agent-abc12345')).toBe(false);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('retries on server-error and returns true when retry succeeds (transient tmux error)', async () => {
    queueExecFileResults([
      { ok: false, code: 2, stderr: '' },
      { ok: true },
    ]);
    expect(await verifySpawnedSession('collab-agent-abc12345')).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('retries on server-error and returns false when retry reports absent', async () => {
    queueExecFileResults([
      { ok: false, code: 2, stderr: '' },
      { ok: false, code: 1, stderr: "can't find session: collab-agent-abc12345" },
    ]);
    expect(await verifySpawnedSession('collab-agent-abc12345')).toBe(false);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('gives up after two consecutive server-errors (pessimistic fallback)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    queueExecFileResults([
      { ok: false, code: 2, stderr: '' },
      { ok: false, code: 2, stderr: '' },
    ]);
    expect(await verifySpawnedSession('collab-agent-abc12345')).toBe(false);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('extractSpawnFailureDiagnostic', () => {
  it('surfaces the actual wrapper failure and strips terminal controls', () => {
    const raw = [
      '\u001b[31m[Collab] Codex managed Design Reference gate preflight failed:',
      'Codex managed protected path is unavailable: /etc/codex\u001b[0m',
    ].join(' ');

    expect(extractSpawnFailureDiagnostic(raw)).toBe(
      '[Collab] Codex managed Design Reference gate preflight failed: Codex managed protected path is unavailable: /etc/codex',
    );
  });

  it('redacts credentials before a startup error is exposed to the UI', () => {
    const raw = 'Fatal: API_KEY=sk-live-super-secret TOKEN: bearer-secret';

    const diagnostic = extractSpawnFailureDiagnostic(raw);

    expect(diagnostic).toContain('API_KEY=[REDACTED]');
    expect(diagnostic).toContain('TOKEN=[REDACTED]');
    expect(diagnostic).not.toContain('super-secret');
    expect(diagnostic).not.toContain('bearer-secret');
  });

  it('returns null for non-diagnostic terminal redraw noise', () => {
    expect(extractSpawnFailureDiagnostic('OpenAI Codex\nready\n>')).toBeNull();
  });
});

describe('extractSpawnFailureDiagnostic: the last line of a Python traceback', () => {
  it('keeps the exception line, not only the word Traceback', () => {
    const raw = 'Traceback (most recent call last):\n  File "x.py", line 3, in run\n    from claude_mod_delivery import make_pump\nModuleNotFoundError: No module named \'claude_mod_delivery\'\n';
    expect(extractSpawnFailureDiagnostic(raw)).toContain("ModuleNotFoundError: No module named 'claude_mod_delivery'");
  });
});
