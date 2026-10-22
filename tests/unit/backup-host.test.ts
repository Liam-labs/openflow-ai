import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { readHostBackupStatuses } from '@/lib/backup-host';

describe('readHostBackupStatuses', () => {
  it('reads host status files and skips malformed ones', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bk-'));
    writeFileSync(path.join(dir, 'devflow.json'), JSON.stringify({
      host: 'devflow', job: 'server-host-restic', started: 'a', finished: 'b', ok: true, errors: [], repoBytes: 5, snapshots: 3,
    }));
    writeFileSync(path.join(dir, 'bad.json'), '{nope');
    const res = await readHostBackupStatuses(dir);
    expect(res).toEqual([{ host: 'devflow', job: 'server-host-restic', started: 'a', finished: 'b', ok: true, errors: [], repoBytes: 5, snapshots: 3 }]);
  });

  it('returns an empty list when the directory is missing', async () => {
    expect(await readHostBackupStatuses('/nonexistent-backup-status')).toEqual([]);
  });
});
