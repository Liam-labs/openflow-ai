import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fresh install has no PM2. /api/pm2 used to answer 500 (the cache was empty and nothing could fill it), so the Services and
// Overview panels showed nothing and the browser kept polling the failing route.
describe('pm2Status on a machine without PM2', () => {
  let oldPath: string | undefined;
  let emptyDir: string;

  beforeEach(() => {
    oldPath = process.env.PATH;
    emptyDir = mkdtempSync(join(tmpdir(), 'no-pm2-'));
    process.env.PATH = emptyDir;
    delete process.env.HOST_BRIDGE_URL;
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.PATH = oldPath;
    rmSync(emptyDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('answers with no services instead of throwing', async () => {
    const { pm2Status } = await import('@/lib/host-bridge/client');
    await expect(pm2Status()).resolves.toEqual({ processes: [], portsInUse: {} });
  });

  it('keeps answering after the cache time is up, and reports the same problem only once', async () => {
    const { pm2Status } = await import('@/lib/host-bridge/client');
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await pm2Status();
    for (let round = 0; round < 3; round++) {
      now += 5000;                                               // past the 4 s cache time: a background refresh starts
      await expect(pm2Status()).resolves.toEqual({ processes: [], portsInUse: {} });
      await new Promise((resolve) => setTimeout(resolve, 150));  // let the failing refresh finish
    }
    expect(console.error).toHaveBeenCalledTimes(1);
  });
  it('after a good answer, a later failure keeps serving it and does not retry before the cache time is up', async () => {
    const calls = join(emptyDir, 'calls.log');
    writeFileSync(join(emptyDir, 'pm2'), `#!/bin/sh\necho x >> "${calls}"\n[ "$(wc -l < "${calls}")" -le 1 ] && echo '[]' && exit 0\nexit 1\n`);
    chmodSync(join(emptyDir, 'pm2'), 0o755);
    process.env.PATH = `${emptyDir}:/usr/bin:/bin`;
    const { pm2Status } = await import('@/lib/host-bridge/client');
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await pm2Status();                                           // the one good answer
    now += 5000;
    await pm2Status();                                           // refresh starts and fails
    await new Promise((resolve) => setTimeout(resolve, 300));
    await pm2Status();                                           // same moment: served from the cache, no new pm2 run
    await pm2Status();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
