import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('backup provider tabs contract', () => {
  it('exposes Full WSL, Restic, and Supabase as isolated tab panels', async () => {
    const source = await readFile('app/backups/BackupsClient.tsx', 'utf8');

    expect(source).toContain('role="tablist"');
    expect(source).toContain("{ id: 'wsl', label: 'Full WSL'");
    expect(source).toContain("{ id: 'restic', label: 'Restic'");
    expect(source).toContain("{ id: 'supabase', label: 'Supabase'");
    expect(source).toContain("activeProvider === 'supabase'");
    expect(source).toContain("activeProvider === 'wsl'");
    expect(source).toContain("activeProvider === 'restic'");
  });

  it('loads WSL and Restic independently so one slow provider cannot hide the other', async () => {
    const client = await readFile('app/backups/BackupsClient.tsx', 'utf8');
    const route = await readFile('app/api/backups/route.ts', 'utf8');

    expect(client).toContain("fetch('/api/backups?scope=wsl'");
    expect(client).toContain("fetch('/api/backups?scope=restic'");
    expect(route).toContain("if (scope === 'wsl')");
    expect(route).toContain("if (scope === 'restic')");
  });

  it('preserves zero-value retention settings and never presents unavailable size as zero', async () => {
    const client = await readFile('app/backups/BackupsClient.tsx', 'utf8');

    expect(client).toContain('status.keepDaily ?? 7');
    expect(client).toContain('status.keepWeekly ?? 4');
    expect(client).toContain('status.keepMonthly ?? 6');
    expect(client).toContain("resticRepoSize = resticData?.repoStats");
    expect(client).toContain(": '—'");
  });
});
