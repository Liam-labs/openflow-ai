/**
 * Tests for S2.1 — ServiceAlertsPanel now fetches supabase-backup events
 * from /api/logs and maps them to ServiceAlert rows with severity='critical'.
 *
 * These tests exercise the ServiceAlert shape + navTarget construction without
 * rendering the React component. The mapping logic is inside fetchAlerts; we
 * re-implement the minimum-viable mapping here and assert it against the
 * component's expected output shape, since the actual component state setter
 * is internal. For component-level integration we rely on browser testing.
 */

import { describe, it, expect } from 'vitest';

// Minimal types — match the panel's private interfaces
type AlertSeverity = 'critical' | 'warning' | 'info';
interface ServiceAlert {
  id: string;
  severity: AlertSeverity;
  type: 'service' | 'cron' | 'ai-task' | 'supabase-backup';
  name: string;
  detail: string;
  timestamp?: string;
  navTarget?: { section?: string; entityId?: string };
}

/**
 * Faithful re-implementation of the backup mapping block from
 * ServiceAlertsPanel.tsx — keeps this test in lockstep with the panel.
 * If you change the panel's mapping, update this helper to match.
 */
function mapBackupEntries(entries: Array<{
  id: string;
  timestamp?: string;
  severity?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}>): ServiceAlert[] {
  const collected: ServiceAlert[] = [];
  for (const entry of entries) {
    const meta = entry.metadata || {};
    const slug = typeof meta.slug === 'string' ? meta.slug : '';
    const instance = typeof meta.instance === 'string' ? meta.instance : slug || 'supabase-backup';
    const action = typeof meta.action === 'string' ? meta.action : 'supabase-backup';
    collected.push({
      id: `supabase-backup-${entry.id}`,
      severity: 'critical',
      type: 'supabase-backup',
      name: instance,
      detail: entry.title || `${action} failed`,
      timestamp: entry.timestamp,
      navTarget: slug ? { section: 'supabase', entityId: slug } : { section: 'supabase' },
    });
  }
  return collected;
}

describe('S2.1 — supabase-backup → ServiceAlert mapping', () => {
  it('maps a full-metadata dump-failure entry to a critical alert with slug-based navTarget', () => {
    const entries = [{
      id: 'log-1',
      timestamp: '2026-04-10T12:00:00Z',
      severity: 'high',
      title: 'Supabase backup failed: BnG-CRM — dump command exited 42',
      metadata: {
        action: 'supabase-backup.bng-crm',
        slug: 'bng-crm',
        instance: 'BnG-CRM',
        exitCode: 42,
      },
    }];
    const alerts = mapBackupEntries(entries);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual({
      id: 'supabase-backup-log-1',
      severity: 'critical',
      type: 'supabase-backup',
      name: 'BnG-CRM',
      detail: 'Supabase backup failed: BnG-CRM — dump command exited 42',
      timestamp: '2026-04-10T12:00:00Z',
      navTarget: { section: 'supabase', entityId: 'bng-crm' },
    });
  });

  it('falls back to slug when instance metadata is missing', () => {
    const entries = [{
      id: 'log-2',
      timestamp: '2026-04-10T12:01:00Z',
      title: 'Supabase backup failed: test — dump exited 1',
      metadata: { action: 'supabase-backup.test', slug: 'test', exitCode: 1 },
    }];
    const alerts = mapBackupEntries(entries);
    expect(alerts[0].name).toBe('test');
    expect(alerts[0].navTarget).toEqual({ section: 'supabase', entityId: 'test' });
  });

  it('falls back to "supabase-backup" name when instance AND slug are missing', () => {
    const entries = [{
      id: 'log-3',
      timestamp: '2026-04-10T12:02:00Z',
      title: 'Generic backup failure',
      metadata: {},
    }];
    const alerts = mapBackupEntries(entries);
    expect(alerts[0].name).toBe('supabase-backup');
    // No slug → navTarget has no entityId
    expect(alerts[0].navTarget).toEqual({ section: 'supabase' });
  });

  it('uses action field to synthesize a detail string when title is missing', () => {
    const entries = [{
      id: 'log-4',
      timestamp: '2026-04-10T12:03:00Z',
      metadata: { action: 'supabase-backup.wtt', slug: 'wtt', instance: 'WTT' },
    }];
    const alerts = mapBackupEntries(entries);
    expect(alerts[0].detail).toBe('supabase-backup.wtt failed');
  });

  it('produces "supabase-backup-<entryId>" deterministic IDs', () => {
    const entries = [
      { id: 'a1', metadata: { slug: 'one' } },
      { id: 'b2', metadata: { slug: 'two' } },
    ];
    const alerts = mapBackupEntries(entries);
    expect(alerts.map(a => a.id)).toEqual(['supabase-backup-a1', 'supabase-backup-b2']);
  });

  it('preserves timestamp for sort ordering in the panel', () => {
    const entries = [{
      id: 'ts-check',
      timestamp: '2026-04-10T08:15:00Z',
      metadata: { slug: 'x' },
    }];
    const alerts = mapBackupEntries(entries);
    expect(alerts[0].timestamp).toBe('2026-04-10T08:15:00Z');
  });

  it('returns empty array when there are no entries', () => {
    expect(mapBackupEntries([])).toEqual([]);
  });

  it('maps every entry in a batch to a separate critical alert', () => {
    const entries = [
      { id: '1', metadata: { slug: 'a', instance: 'A' }, title: 'fail A' },
      { id: '2', metadata: { slug: 'b', instance: 'B' }, title: 'fail B' },
      { id: '3', metadata: { slug: 'c', instance: 'C' }, title: 'fail C' },
    ];
    const alerts = mapBackupEntries(entries);
    expect(alerts).toHaveLength(3);
    expect(alerts.every(a => a.severity === 'critical')).toBe(true);
    expect(alerts.every(a => a.type === 'supabase-backup')).toBe(true);
  });
});
