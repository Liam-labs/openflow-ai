import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  activeRestoreToViewState,
  groupSupabaseBackupsByProject,
  inferSupabaseBackupTier,
  normalizeSupabaseInventory,
  restorePollBackoffMs,
} from '@/app/backups/supabase-backup-inventory';

describe('inferSupabaseBackupTier', () => {
  it('recognises explicit daily and hourly filename tiers', () => {
    expect(inferSupabaseBackupTier('seo-engine-daily-2026-07-28.sql')).toBe('daily');
    expect(inferSupabaseBackupTier('devflow-hourly-2026-07-28-11.sql')).toBe('hourly');
    expect(inferSupabaseBackupTier('manual-export.sql')).toBe('manual');
  });
});

describe('normalizeSupabaseInventory', () => {
  it('normalises wrapped inventory and uses project slug as the project id', () => {
    const result = normalizeSupabaseInventory({
      success: true,
      data: {
        projects: [{
          slug: 'devflow',
          name: 'DevFlow',
          status: 'healthy',
          containerRunning: true,
          backups: [
            { filename: 'devflow-hourly-2026-07-28-11.sql', createdAt: '2026-07-28T11:00:00.000Z', sizeMb: 8 },
            { filename: 'devflow-daily-2026-07-28.sql', createdAt: '2026-07-28T04:00:00.000Z', sizeMb: 12 },
          ],
        }],
      },
    });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({
      id: 'devflow',
      slug: 'devflow',
      name: 'DevFlow',
      health: 'healthy',
      containerRunning: true,
      counts: { total: 2, daily: 1, hourly: 1, manual: 0 },
    });
    expect(result.backups[0]).toMatchObject({
      projectId: 'devflow',
      tier: 'hourly',
      sizeBytes: 8 * 1024 * 1024,
    });
    expect(result.summary).toMatchObject({ totalBackups: 2, totalProjects: 1, healthyProjects: 1 });
  });

  it('deduplicates top-level and project-nested backup entries', () => {
    const duplicate = {
      filename: 'crm-daily-2026-07-28.sql',
      projectSlug: 'crm',
      createdAt: '2026-07-28T07:00:00.000Z',
    };
    const result = normalizeSupabaseInventory({
      projects: [{ slug: 'crm', name: 'CRM', backups: [duplicate] }],
      backups: [duplicate],
    });

    expect(result.backups).toHaveLength(1);
    expect(result.projects[0].counts.total).toBe(1);
  });

  it('uses the backend project status as authoritative even with a very recent backup', () => {
    const result = normalizeSupabaseInventory({
      projects: [{
        slug: 'search',
        name: 'Search',
        status: 'stale',
        containerRunning: true,
        backups: [{
          filename: 'search-hourly-2026-07-28-11.dump',
          createdAt: '2026-07-28T11:59:00.000Z',
          tier: 'hourly',
        }],
      }],
    });

    expect(result.projects[0].health).toBe('stale');
    expect(result.summary).toMatchObject({ healthyProjects: 0, staleProjects: 1 });
  });

  it('preserves backend unknown status instead of presenting it as an error', () => {
    const result = normalizeSupabaseInventory({
      projects: [{
        slug: 'unclassified',
        name: 'Unclassified',
        status: 'unknown',
        containerRunning: true,
        backups: [{
          filename: 'unclassified-daily-2026-07-28.dump',
          createdAt: '2026-07-28T04:00:00.000Z',
          tier: 'daily',
        }],
      }],
    });

    expect(result.projects[0].health).toBe('unknown');
    expect(result.summary).toMatchObject({ healthyProjects: 0, staleProjects: 0, offlineProjects: 0 });
  });

  it('normalises restore.active and recovers a pollable restore view after reload', () => {
    const result = normalizeSupabaseInventory({
      success: true,
      projects: [{
        slug: 'devflow',
        name: 'DevFlow',
        status: 'healthy',
        containerRunning: true,
        backups: [{
          id: 'devflow:daily:devflow-daily-2026-07-28.dump',
          filename: 'devflow-daily-2026-07-28.dump',
          projectId: 'devflow',
          projectName: 'DevFlow',
          tier: 'daily',
          createdAt: '2026-07-28T04:00:00.000Z',
          sizeBytes: 12_000,
          status: 'available',
        }],
      }],
      restore: {
        active: {
          id: 'restore-123',
          projectSlug: 'devflow',
          filename: 'devflow-daily-2026-07-28.dump',
          status: 'running',
          phase: 'safety-backup',
          startedAt: '2026-07-28T11:58:00.000Z',
          updatedAt: '2026-07-28T11:59:00.000Z',
        },
      },
    });

    expect(result.restore.active).toMatchObject({
      id: 'restore-123',
      projectSlug: 'devflow',
      phase: 'safety-backup',
    });
    expect(activeRestoreToViewState(result)).toMatchObject({
      id: 'restore-123',
      phase: 'running',
      progress: 45,
      statusUnavailable: false,
      backup: { projectId: 'devflow', filename: 'devflow-daily-2026-07-28.dump' },
    });
  });
});

describe('restorePollBackoffMs', () => {
  it('backs off transient status failures but remains bounded', () => {
    expect(restorePollBackoffMs(0)).toBe(2_500);
    expect(restorePollBackoffMs(1)).toBe(5_000);
    expect(restorePollBackoffMs(3)).toBe(20_000);
    expect(restorePollBackoffMs(99)).toBe(30_000);
  });
});

describe('groupSupabaseBackupsByProject', () => {
  it('groups projects alphabetically and keeps each project newest-first', () => {
    const backups = [
      { id: 'z-old', filename: 'z-hourly-old.dump', projectId: 'zeta', projectName: 'Zeta', tier: 'hourly' as const, createdAt: '2026-07-29T10:00:00Z', sizeBytes: 1, status: 'available' as const },
      { id: 'a', filename: 'a-daily.dump', projectId: 'alpha', projectName: 'Alpha', tier: 'daily' as const, createdAt: '2026-07-29T09:00:00Z', sizeBytes: 1, status: 'available' as const },
      { id: 'z-new', filename: 'z-hourly-new.dump', projectId: 'zeta', projectName: 'Zeta', tier: 'hourly' as const, createdAt: '2026-07-29T12:00:00Z', sizeBytes: 1, status: 'available' as const },
    ];

    const groups = groupSupabaseBackupsByProject(backups);

    expect(groups.map(group => group.projectName)).toEqual(['Alpha', 'Zeta']);
    expect(groups[1].backups.map(backup => backup.id)).toEqual(['z-new', 'z-old']);
    expect(groups[1].counts).toEqual({ total: 2, daily: 0, hourly: 2, manual: 0 });
  });
});

describe('Supabase backup project groups', () => {
  it('renders project groups as collapsed, accessible disclosure rows', async () => {
    const source = await readFile('app/backups/SupabaseBackupsSection.tsx', 'utf8');

    expect(source).toContain('expandedProjects');
    expect(source).toContain('aria-expanded={isExpanded}');
    expect(source).toContain('isExpanded && group.backups.map');
  });
});
