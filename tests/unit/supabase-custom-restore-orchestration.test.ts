import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';

import {
  getCustomRestoreStatus,
  initiateCustomRestore,
  runCustomRestoreJob,
  type CustomRestoreRuntime,
  type CustomRestoreStatus,
} from '@/lib/supabase-custom-restore';

const ROOT = path.join(tmpdir(), `devflow-restore-orchestration-${process.pid}`);
const SOURCE = path.join(ROOT, 'alpha', 'hourly', 'alpha-hourly-2026-07-28T11.dump');
const JOB: CustomRestoreStatus = {
  id: 'restore-test',
  projectSlug: 'alpha',
  filename: path.basename(SOURCE),
  containerName: 'supabase_db_alpha',
  status: 'pending',
  phase: 'queued',
  startedAt: '2026-07-28T12:00:00.000Z',
  updatedAt: '2026-07-28T12:00:00.000Z',
};

async function seedJob(job: CustomRestoreStatus = JOB): Promise<void> {
  await mkdir(path.dirname(SOURCE), { recursive: true });
  await writeFile(SOURCE, Buffer.alloc(2048, 1));
  await writeFile(path.join(ROOT, 'restore-jobs.json'), JSON.stringify({ version: 1, jobs: [job] }));
}

function runtime(events: string[], overrides: Partial<CustomRestoreRuntime> = {}): CustomRestoreRuntime {
  return {
    verifyArchive: vi.fn(async (_container, file) => { events.push(`verify:${path.basename(file)}`); }),
    listComposeContainers: vi.fn(async () => ['supabase_db_alpha', 'supabase_kong_alpha']),
    runDocker: vi.fn(async args => { events.push(`docker:${args[0]}:${args.at(-1)}`); return args.includes('SELECT 1') ? '1\n' : ''; }),
    createSafetyDump: vi.fn(async (_container, file) => {
      events.push('safety-dump');
      await writeFile(file, Buffer.alloc(2048, 2));
    }),
    restoreArchive: vi.fn(async () => { events.push('restore'); }),
    verifyContainerRecovered: vi.fn(async container => { events.push(`recovered:${container}`); }),
    ...overrides,
  };
}

describe('custom Supabase restore orchestration', () => {
  beforeEach(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await seedJob();
  });

  afterEach(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  it('validates before quiescing, creates/verifies safety backup before restore, and persists phases', async () => {
    const events: string[] = [];
    await runCustomRestoreJob({ backupsRoot: ROOT, projectSlug: 'alpha', filename: JOB.filename }, JOB, SOURCE, runtime(events));

    expect(events.indexOf(`verify:${JOB.filename}`)).toBeLessThan(events.indexOf('docker:stop:supabase_kong_alpha'));
    expect(events.indexOf('safety-dump')).toBeLessThan(events.indexOf('restore'));
    expect(events.filter(event => event.startsWith('verify:'))).toHaveLength(2);
    expect(await getCustomRestoreStatus(ROOT, JOB.id)).toMatchObject({
      status: 'success',
      phase: 'complete',
      safetyBackupFilename: expect.stringMatching(/^alpha-daily-pre-restore-/),
    });
  });

  it('aborts restore when the safety dump fails and restarts stopped siblings', async () => {
    const events: string[] = [];
    const failing = runtime(events, {
      createSafetyDump: vi.fn(async () => { events.push('safety-failed'); throw new Error('pg_dump failed'); }),
    });
    await runCustomRestoreJob({ backupsRoot: ROOT, projectSlug: 'alpha', filename: JOB.filename }, JOB, SOURCE, failing);

    expect(events).not.toContain('restore');
    expect(events).toContain('docker:start:supabase_kong_alpha');
    expect(events).toContain('recovered:supabase_kong_alpha');
    expect(await getCustomRestoreStatus(ROOT, JOB.id)).toMatchObject({
      status: 'error',
      phase: 'failed',
      error: expect.stringContaining('pg_dump failed'),
    });
  });

  it('restarts siblings and records failure when restore itself fails', async () => {
    const events: string[] = [];
    await runCustomRestoreJob(
      { backupsRoot: ROOT, projectSlug: 'alpha', filename: JOB.filename },
      JOB,
      SOURCE,
      runtime(events, { restoreArchive: vi.fn(async () => { events.push('restore'); throw new Error('restore failed'); }) }),
    );
    expect(events).toContain('docker:start:supabase_kong_alpha');
    expect(await getCustomRestoreStatus(ROOT, JOB.id)).toMatchObject({ status: 'error' });
  });

  it('does not report success when a restarted sibling fails recovery checks', async () => {
    const events: string[] = [];
    await runCustomRestoreJob(
      { backupsRoot: ROOT, projectSlug: 'alpha', filename: JOB.filename },
      JOB,
      SOURCE,
      runtime(events, {
        verifyContainerRecovered: vi.fn(async () => { throw new Error('container unhealthy'); }),
      }),
    );
    expect(await getCustomRestoreStatus(ROOT, JOB.id)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('container unhealthy'),
    });
  });

  it('fails closed when persisted job state is corrupt', async () => {
    await writeFile(path.join(ROOT, 'restore-jobs.json'), '{not json');
    await expect(getCustomRestoreStatus(ROOT, JOB.id)).rejects.toThrow(/restore job state/i);
  });

  it('fails closed on non-ENOENT restore-state read errors', async () => {
    await rm(path.join(ROOT, 'restore-jobs.json'));
    await mkdir(path.join(ROOT, 'restore-jobs.json'));
    await expect(getCustomRestoreStatus(ROOT, JOB.id)).rejects.toThrow(/restore job state/i);
  });

  it('reconciles an active persisted job with no in-memory worker to terminal error', async () => {
    const { getActiveCustomRestore } = await import('@/lib/supabase-custom-restore');
    expect(await getActiveCustomRestore(ROOT)).toBeNull();
    expect(await getCustomRestoreStatus(ROOT, JOB.id)).toMatchObject({
      status: 'error',
      phase: 'failed',
      error: expect.stringContaining('abandoned'),
    });
  });

  it('rejects a concurrent restore for the same slug with 409', async () => {
    await rm(path.join(ROOT, 'restore-jobs.json'));
    const deps = { isContainerRunning: vi.fn(async () => true), schedule: vi.fn() };
    await initiateCustomRestore({ backupsRoot: ROOT, projectSlug: 'alpha', filename: JOB.filename }, deps);
    await expect(
      initiateCustomRestore({ backupsRoot: ROOT, projectSlug: 'alpha', filename: JOB.filename }, deps),
    ).rejects.toMatchObject({ statusCode: 409 });

    const persisted = JSON.parse(await readFile(path.join(ROOT, 'restore-jobs.json'), 'utf8'));
    expect(persisted.jobs).toHaveLength(1);
  });
});
