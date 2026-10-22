import { describe, expect, it } from 'vitest';
import { promises as fs, accessSync, constants } from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import {
  windowsDriveToMnt,
  stageCodexWindowsPackage,
  CODEX_WINDOWS_PACKAGE,
} from '@/lib/codex-windows-stage';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// DrvFs-backed staging tests only run where /mnt/c is writable (WSL host).
let mntWritable = false;
try {
  accessSync('/mnt/c', constants.W_OK);
  mntWritable = true;
} catch {
  /* not on a WSL host — skip the DrvFs cases */
}

describe('windowsDriveToMnt', () => {
  it('maps a Windows drive path to its /mnt mount', () => {
    expect(windowsDriveToMnt('C:\\DevFlow\\scripts')).toBe('/mnt/c/DevFlow/scripts');
  });
  it('lowercases the drive letter and accepts forward slashes', () => {
    expect(windowsDriveToMnt('D:/Foo/Bar')).toBe('/mnt/d/Foo/Bar');
  });
  it('rejects a UNC path (interop-launched pwsh cannot read \\\\wsl$)', () => {
    expect(() => windowsDriveToMnt('\\\\wsl$\\Ubuntu\\home')).toThrow(/Windows drive path/);
  });
  it('rejects a WSL/posix path', () => {
    expect(() => windowsDriveToMnt('/home/user/DevFlow/scripts')).toThrow(/Windows drive path/);
  });
});

describe('stageCodexWindowsPackage', () => {
  it.skipIf(!mntWritable)('stages, is idempotent, re-stages on change, and fails closed', async () => {
    const tag = `_test-stage-${process.pid}-${Date.now()}`;
    const winDir = `C:\\DevFlow\\${tag}`;
    const destDir = windowsDriveToMnt(winDir);
    const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpkg-'));
    const emptySrc = await fs.mkdtemp(path.join(os.tmpdir(), 'codexempty-'));
    try {
      for (const name of CODEX_WINDOWS_PACKAGE) {
        await fs.writeFile(path.join(srcDir, name), `content of ${name}\n`);
      }

      // 1) copies the whole package when absent
      await stageCodexWindowsPackage(winDir, srcDir);
      for (const name of CODEX_WINDOWS_PACKAGE) {
        const s = await fs.readFile(path.join(srcDir, name));
        const d = await fs.readFile(path.join(destDir, name));
        expect(sha(d)).toBe(sha(s));
      }

      // 2) idempotent — an unchanged file is left untouched (mtime preserved)
      const first = path.join(destDir, CODEX_WINDOWS_PACKAGE[0]);
      const before = (await fs.stat(first)).mtimeMs;
      await new Promise((r) => setTimeout(r, 25));
      await stageCodexWindowsPackage(winDir, srcDir);
      expect((await fs.stat(first)).mtimeMs).toBe(before);

      // 3) re-stages when the source changes
      await fs.writeFile(path.join(srcDir, CODEX_WINDOWS_PACKAGE[0]), 'CHANGED\n');
      await stageCodexWindowsPackage(winDir, srcDir);
      expect(await fs.readFile(first, 'utf8')).toBe('CHANGED\n');

      // 4) fails closed when a source file is missing
      await expect(
        stageCodexWindowsPackage(`C:\\DevFlow\\${tag}-b`, emptySrc),
      ).rejects.toThrow(/source script missing/);
    } finally {
      await fs.rm(srcDir, { recursive: true, force: true });
      await fs.rm(emptySrc, { recursive: true, force: true });
      await fs.rm(destDir, { recursive: true, force: true });
      try {
        await fs.rm(windowsDriveToMnt(`C:\\DevFlow\\${tag}-b`), { recursive: true, force: true });
      } catch {
        /* may never have been created */
      }
    }
  });

  it.skipIf(!mntWritable)('is a verified no-op against the real staged package', async () => {
    // Builder staged the real package to C:\DevFlow\scripts; a re-stage from the WSL
    // source must be a clean no-op with source==staged hashes (the canary precondition).
    await expect(stageCodexWindowsPackage('C:\\DevFlow\\scripts')).resolves.toBeUndefined();
    for (const name of CODEX_WINDOWS_PACKAGE) {
      const src = await fs.readFile(`/home/user/DevFlow/scripts/${name}`);
      const dst = await fs.readFile(`/mnt/c/DevFlow/scripts/${name}`);
      expect(sha(dst)).toBe(sha(src));
    }
  });
});
