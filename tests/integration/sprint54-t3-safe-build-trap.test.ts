/**
 * Sprint 54 T3 — scripts/safe-build.sh must remove .AppData/rebuild.lock on EXIT.
 *
 * Background: Sprint 54 T1 added POST /api/settings/rebuild which creates
 * .AppData/rebuild.lock via O_EXCL, fires safe-build.sh in a detached child,
 * and returns 200. The script never removed the lock, so every rebuild after
 * the first returned 409 forever.
 *
 * Fix: add `trap 'rm -f "$REBUILD_LOCK_FILE"' EXIT` near the top of
 * safe-build.sh so the lock is cleared on normal completion, errors, and
 * signal-driven exits. `rm -f` on a missing file is a no-op, so CLI runs that
 * never created the lock are untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const SAFE_BUILD = join(REPO, 'scripts', 'safe-build.sh');

let workDir: string;
let lockFile: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'safe-build-trap-'));
  mkdirSync(join(workDir, '.AppData'), { recursive: true });
  lockFile = join(workDir, '.AppData', 'rebuild.lock');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Run a minimal shell that replays ONLY the trap idiom used by safe-build.sh:
 *   REBUILD_LOCK_FILE="<path>"
 *   trap 'rm -f "$REBUILD_LOCK_FILE"' EXIT
 * Then exit with the requested code. Used to prove the pattern itself behaves
 * correctly independent of the rest of safe-build.sh's pipeline.
 */
function runTrapStub(exitCode: number, lockPath: string): number {
  try {
    execFileSync(
      'bash',
      [
        '-c',
        `REBUILD_LOCK_FILE="${lockPath}"; trap 'rm -f "$REBUILD_LOCK_FILE"' EXIT; exit ${exitCode}`,
      ],
      { stdio: 'ignore' },
    );
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? 1;
  }
}

describe('Sprint 54 T3 — EXIT trap removes rebuild.lock', () => {
  it('removes rebuild.lock on normal exit (0)', () => {
    writeFileSync(lockFile, JSON.stringify({ pid: 1234 }));
    expect(existsSync(lockFile)).toBe(true);

    const rc = runTrapStub(0, lockFile);
    expect(rc).toBe(0);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('removes rebuild.lock on error exit (1)', () => {
    writeFileSync(lockFile, JSON.stringify({ pid: 5678 }));
    expect(existsSync(lockFile)).toBe(true);

    const rc = runTrapStub(1, lockFile);
    expect(rc).toBe(1);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('is a no-op when rebuild.lock does not exist (manual CLI run)', () => {
    expect(existsSync(lockFile)).toBe(false);
    // Should exit cleanly — rm -f on missing path does nothing.
    const rc = runTrapStub(0, lockFile);
    expect(rc).toBe(0);
    expect(existsSync(lockFile)).toBe(false);
  });
});

describe('Sprint 54 T3 — safe-build.sh embeds the trap', () => {
  it('safe-build.sh defines REBUILD_LOCK_FILE', () => {
    const script = readFileSync(SAFE_BUILD, 'utf-8');
    expect(script).toMatch(/REBUILD_LOCK_FILE=.*rebuild\.lock/);
  });

  it('safe-build.sh installs an EXIT trap that removes the rebuild lock', () => {
    const script = readFileSync(SAFE_BUILD, 'utf-8');
    expect(script).toMatch(/trap .*REBUILD_LOCK_FILE.* EXIT/);
  });

  it('safe-build.sh passes bash -n syntax check after the trap edit', () => {
    // `bash -n` parses without executing — confirms the added trap line did
    // not break the script's syntax.
    execFileSync('bash', ['-n', SAFE_BUILD], { stdio: 'ignore' });
  });
});
