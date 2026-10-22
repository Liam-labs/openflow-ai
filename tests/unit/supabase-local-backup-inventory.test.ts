import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';

import {
  resolveCustomBackupFile,
  resolveKnownLocalSupabaseProjects,
  scanLocalSupabaseBackups,
} from '@/lib/supabase-local-backups';

const ROOT = path.join(tmpdir(), `devflow-supabase-inventory-${process.pid}`);
const NOW = new Date('2026-07-28T12:00:00.000Z');

async function seed(relativePath: string, bytes: number, mtime: Date): Promise<void> {
  const filePath = path.join(ROOT, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.alloc(bytes, 1));
  const { utimes } = await import('fs/promises');
  await utimes(filePath, mtime, mtime);
}

describe('local Supabase custom backup inventory', () => {
  beforeEach(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await seed(
      'alpha/hourly/alpha-hourly-2026-07-28T11.dump',
      2048,
      new Date('2026-07-28T11:00:00.000Z'),
    );
    await seed(
      'alpha/daily/alpha-daily-2026-07-28.dump',
      4096,
      new Date('2026-07-28T03:00:00.000Z'),
    );
    await seed(
      'retired/hourly/retired-hourly-2026-07-28T08.dump',
      1024,
      new Date('2026-07-28T08:00:00.000Z'),
    );
    await seed(
      'alpha/hourly/alpha-hourly-2026-07-28T12.dump',
      999,
      new Date('2026-07-28T12:00:00.000Z'),
    );
    await seed('alpha/hourly/ignore.sql', 50, NOW);
    await seed('alpha/other/alpha-hourly-2026-07-28T12.dump', 50, NOW);
  });

  afterEach(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  it('returns every retained project, counts, sizes, freshness, and running state', async () => {
    const inventory = await scanLocalSupabaseBackups({
      backupsRoot: ROOT,
      runningContainers: new Set(['supabase_db_alpha']),
      now: NOW,
    });

    expect(inventory.summary).toEqual({
      totalBackups: 3,
      totalProjects: 2,
      healthyProjects: 1,
      staleProjects: 0,
      offlineProjects: 1,
      unknownProjects: 0,
      lastBackupAt: '2026-07-28T11:00:00.000Z',
      totalSizeBytes: 7168,
    });

    const alpha = inventory.projects.find(project => project.slug === 'alpha');
    expect(alpha).toMatchObject({
      id: 'alpha',
      name: 'alpha',
      status: 'healthy',
      containerRunning: true,
      latestBackupAt: '2026-07-28T11:00:00.000Z',
      counts: { total: 2, daily: 1, hourly: 1 },
      totalSizeBytes: 6144,
    });
    expect(alpha?.backups.map(backup => backup.filename)).toEqual([
      'alpha-hourly-2026-07-28T11.dump',
      'alpha-daily-2026-07-28.dump',
    ]);

    const retired = inventory.projects.find(project => project.slug === 'retired');
    expect(retired).toMatchObject({
      status: 'offline',
      containerRunning: false,
      counts: { total: 1, daily: 0, hourly: 1 },
    });
  });

  it('marks a running project stale once the latest hourly dump is older than 90 minutes', async () => {
    const inventory = await scanLocalSupabaseBackups({
      backupsRoot: ROOT,
      runningContainers: new Set(['supabase_db_alpha', 'supabase_db_retired']),
      now: new Date('2026-07-28T12:31:00.000Z'),
    });

    expect(inventory.projects.find(project => project.slug === 'alpha')?.status).toBe('stale');
  });

  it('includes a running Supabase project before it has produced its first backup', async () => {
    const inventory = await scanLocalSupabaseBackups({
      backupsRoot: ROOT,
      runningContainers: new Set(['supabase_db_alpha', 'supabase_db_new-project']),
      now: NOW,
    });

    expect(inventory.projects.find(project => project.slug === 'new-project')).toMatchObject({
      id: 'new-project',
      name: 'new-project',
      status: 'stale',
      containerRunning: true,
      latestBackupAt: null,
      counts: { total: 0, daily: 0, hourly: 0 },
      totalSizeBytes: 0,
      backups: [],
    });
    expect(inventory.summary.totalProjects).toBe(3);
  });

  it('includes registered offline projects and applies their human-readable names', async () => {
    const inventory = await scanLocalSupabaseBackups({
      backupsRoot: ROOT,
      runningContainers: new Set(['supabase_db_alpha']),
      knownProjects: new Map([
        ['alpha', 'Alpha CRM'],
        ['signal-ref', 'Emails-and-Marketing'],
      ]),
      now: NOW,
    });

    const alpha = inventory.projects.find(project => project.slug === 'alpha');
    expect(alpha?.name).toBe('Alpha CRM');
    expect(alpha?.backups.every(backup => backup.projectName === 'Alpha CRM')).toBe(true);
    expect(inventory.projects.find(project => project.slug === 'signal-ref')).toMatchObject({
      name: 'Emails-and-Marketing',
      status: 'offline',
      containerRunning: false,
      counts: { total: 0, daily: 0, hourly: 0 },
    });
  });

  it('resolves placeholder project ids through the live API port identity', () => {
    const projects = resolveKnownLocalSupabaseProjects([
      {
        type: 'local',
        name: 'Emails-and-Marketing',
        connection: { url: 'http://127.0.0.1:54361', projectId: 'SUPABASE_PROJECT_COMMS_ENGINE' },
      },
      {
        type: 'local',
        name: 'ADHD Project',
        connection: { url: 'http://127.0.0.1:54351', projectId: 'neurostride-local' },
      },
    ], new Map([[54361, 'qqtnarwcseqrykricaug']]));

    expect(projects).toEqual(new Map([
      ['qqtnarwcseqrykricaug', 'Emails-and-Marketing'],
      ['neurostride-local', 'ADHD Project'],
    ]));
  });

  it('reports unknown health when Docker discovery is unavailable', async () => {
    const inventory = await scanLocalSupabaseBackups({
      backupsRoot: ROOT,
      runningContainers: new Set(),
      dockerAvailable: false,
      now: NOW,
    });

    expect(inventory.projects.find(project => project.slug === 'alpha')).toMatchObject({
      status: 'unknown',
      containerRunning: null,
    });
    expect(inventory.summary.unknownProjects).toBe(2);
    expect(inventory.summary.offlineProjects).toBe(0);
  });

  it('resolves only an exact contained dump belonging to the selected project and tier', async () => {
    const resolved = await resolveCustomBackupFile(
      ROOT,
      'alpha',
      'alpha-hourly-2026-07-28T11.dump',
    );
    expect(resolved.tier).toBe('hourly');
    expect(resolved.filePath).toBe(
      path.join(ROOT, 'alpha', 'hourly', 'alpha-hourly-2026-07-28T11.dump'),
    );

    await expect(resolveCustomBackupFile(ROOT, 'alpha', '../secret.dump')).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      resolveCustomBackupFile(ROOT, 'alpha', 'retired-hourly-2026-07-28T08.dump'),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      resolveCustomBackupFile(ROOT, '../alpha', 'alpha-hourly-2026-07-28T11.dump'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a symlink even when its name looks like an owned custom dump', async () => {
    const linkedName = 'alpha-hourly-2026-07-28T10.dump';
    await symlink(
      path.join(ROOT, 'retired', 'hourly', 'retired-hourly-2026-07-28T08.dump'),
      path.join(ROOT, 'alpha', 'hourly', linkedName),
    );
    await expect(resolveCustomBackupFile(ROOT, 'alpha', linkedName)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('does not traverse a symlinked tier directory outside the backup root', async () => {
    const outside = `${ROOT}-outside`;
    await rm(outside, { recursive: true, force: true });
    await mkdir(path.join(ROOT, 'evil'), { recursive: true });
    await seed('../devflow-supabase-inventory-' + process.pid + '-outside/evil-hourly-2026-07-28T11.dump', 2048, NOW);
    await symlink(outside, path.join(ROOT, 'evil', 'hourly'));

    const inventory = await scanLocalSupabaseBackups({
      backupsRoot: ROOT,
      runningContainers: new Set(),
      now: NOW,
    });
    expect(inventory.projects.some(project => project.slug === 'evil')).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });
});
