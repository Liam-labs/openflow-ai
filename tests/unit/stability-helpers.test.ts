import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  isServiceExpectedOnline,
  loadProjectsRegistry,
  getLastBuildTimestamp,
  filterBuildRestartCrashes,
  type ProjectEntry,
} from '@/lib/stability-helpers';

// ============================================
// isServiceExpectedOnline
// ============================================

describe('isServiceExpectedOnline', () => {
  const projects: ProjectEntry[] = [
    {
      id: 'seo-engine-server',
      name: 'SEO Engine Server',
      server: { autoStart: true, pm2Name: 'seo-engine' },
    },
    {
      id: 'footage-tracker',
      name: 'Footage Tracker',
      server: { autoStart: true, pm2Name: 'footage-tracker' },
    },
    {
      id: 'guru-store',
      name: 'Guru Store',
      server: { pm2Name: undefined },
      devServer: { enabled: true, pm2Name: 'dev-guru-store' },
    },
    {
      id: 'lorenzo-ferrandiz',
      name: 'Example Client One',
      server: { pm2Name: 'dev-lorenzo-ferrandiz' },
      devServer: { pm2Name: 'dev-lorenzo-ferrandiz' },
    },
    {
      id: 'n8n-server',
      name: 'n8n',
      server: { autoStart: false, pm2Name: 'n8n' },
    },
    {
      id: 'video-project-hub',
      name: 'Video Project Hub',
      server: { autoStart: false, pm2Name: 'video-project-hub' },
    },
    {
      id: 'amanda-ody-acupuncture',
      name: 'Example Client Two',
      server: { pm2Name: undefined },
      devServer: { enabled: true, pm2Name: 'dev-amanda-ody' },
    },
    {
      id: 'devflow',
      name: 'DevFlow',
      server: { autoStart: false, pm2Name: 'devflow' },
    },
  ];

  it('returns true for autoStart=true matched by pm2Name', () => {
    expect(isServiceExpectedOnline('seo-engine', projects)).toBe(true);
  });

  it('returns true for autoStart=true matched by project id', () => {
    expect(isServiceExpectedOnline('footage-tracker', projects)).toBe(true);
  });

  it('returns false for dev server matched by devServer.pm2Name', () => {
    expect(isServiceExpectedOnline('dev-guru-store', projects)).toBe(false);
  });

  it('returns false for dev server lorenzo-ferrandiz', () => {
    expect(isServiceExpectedOnline('dev-lorenzo-ferrandiz', projects)).toBe(false);
  });

  it('returns false for autoStart=false', () => {
    expect(isServiceExpectedOnline('n8n', projects)).toBe(false);
  });

  it('returns false for autoStart=false (video-project-hub)', () => {
    expect(isServiceExpectedOnline('video-project-hub', projects)).toBe(false);
  });

  it('returns false for dev server amanda-ody', () => {
    expect(isServiceExpectedOnline('dev-amanda-ody', projects)).toBe(false);
  });

  it('returns false for unmatched service name', () => {
    expect(isServiceExpectedOnline('unknown-service', projects)).toBe(false);
  });

  it('returns false for devflow (autoStart=false)', () => {
    expect(isServiceExpectedOnline('devflow', projects)).toBe(false);
  });

  it('returns false for autoStart=null (explicit null)', () => {
    const prjs: ProjectEntry[] = [
      { id: 'test', name: 'Test', server: { autoStart: null, pm2Name: 'test' } },
    ];
    expect(isServiceExpectedOnline('test', prjs)).toBe(false);
  });

  it('returns false for missing autoStart (undefined)', () => {
    const prjs: ProjectEntry[] = [
      { id: 'test', name: 'Test', server: { pm2Name: 'test' } },
    ];
    expect(isServiceExpectedOnline('test', prjs)).toBe(false);
  });

  it('returns false for empty projects array', () => {
    expect(isServiceExpectedOnline('anything', [])).toBe(false);
  });
});

// ============================================
// loadProjectsRegistry
// ============================================

describe('loadProjectsRegistry', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stability-helpers-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads projects from valid JSON', async () => {
    const data = {
      projects: [
        { id: 'foo', name: 'Foo', server: { autoStart: true } },
        { id: 'bar', name: 'Bar', server: { autoStart: false } },
      ],
    };
    await fs.writeFile(path.join(tmpDir, 'projects.json'), JSON.stringify(data));
    const result = await loadProjectsRegistry(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('foo');
  });

  it('returns empty array when file is missing', async () => {
    const result = await loadProjectsRegistry(path.join(tmpDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('returns empty array when JSON is malformed', async () => {
    await fs.writeFile(path.join(tmpDir, 'projects.json'), '{ broken json');
    const result = await loadProjectsRegistry(tmpDir);
    expect(result).toEqual([]);
  });

  it('returns empty array when projects key is missing', async () => {
    await fs.writeFile(path.join(tmpDir, 'projects.json'), '{"other": 1}');
    const result = await loadProjectsRegistry(tmpDir);
    expect(result).toEqual([]);
  });
});

// ============================================
// getLastBuildTimestamp
// ============================================

describe('getLastBuildTimestamp', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stability-build-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('parses the last Build complete timestamp', async () => {
    const logPath = path.join(tmpDir, 'nightly-build.log');
    await fs.writeFile(logPath, [
      '2026-04-10 03:02:47 [safe-build] Build complete (ID: abc123)',
      '2026-04-11 03:02:47 [safe-build] Build complete (ID: def456)',
      '2026-04-12 03:02:38 [safe-build] Build complete (ID: ghi789)',
    ].join('\n'));
    const ts = await getLastBuildTimestamp(logPath);
    expect(ts).not.toBeNull();
    // Should be the LAST entry
    const expected = new Date('2026-04-12T03:02:38').getTime();
    expect(ts).toBe(expected);
  });

  it('returns null when file does not exist', async () => {
    const ts = await getLastBuildTimestamp(path.join(tmpDir, 'missing.log'));
    expect(ts).toBeNull();
  });

  it('returns null when log has no Build complete lines', async () => {
    const logPath = path.join(tmpDir, 'nightly-build.log');
    await fs.writeFile(logPath, '2026-04-12 03:00:00 [safe-build] Starting build...\n');
    const ts = await getLastBuildTimestamp(logPath);
    expect(ts).toBeNull();
  });

  it('handles single Build complete line', async () => {
    const logPath = path.join(tmpDir, 'nightly-build.log');
    await fs.writeFile(logPath, '2026-04-12 03:02:38 [safe-build] Build complete (ID: xyz)\n');
    const ts = await getLastBuildTimestamp(logPath);
    expect(ts).toBe(new Date('2026-04-12T03:02:38').getTime());
  });

  it('ignores non-matching lines', async () => {
    const logPath = path.join(tmpDir, 'nightly-build.log');
    await fs.writeFile(logPath, [
      '2026-04-12 03:00:00 [safe-build] Build compilation succeeded',
      '2026-04-12 03:02:36 [safe-build] Build validated successfully',
      '2026-04-12 03:02:38 [safe-build] Build complete (ID: abc)',
      '2026-04-12 03:02:38 [safe-build] PM2 restarted',
    ].join('\n'));
    const ts = await getLastBuildTimestamp(logPath);
    expect(ts).toBe(new Date('2026-04-12T03:02:38').getTime());
  });
});

// ============================================
// filterBuildRestartCrashes
// ============================================

describe('filterBuildRestartCrashes', () => {
  const buildTs = new Date('2026-04-12T03:02:38').getTime();

  it('excludes crashes within 10 minutes of build', () => {
    const crashes = [
      buildTs + 30_000,   // 30s after build — excluded
      buildTs + 60_000,   // 1m after — excluded
      buildTs + 300_000,  // 5m after — excluded
    ];
    const result = filterBuildRestartCrashes(3, crashes, buildTs);
    expect(result.scoringCrashes).toBe(0);
    expect(result.excludedCount).toBe(3);
  });

  it('keeps crashes outside the 10-minute window', () => {
    const crashes = [
      buildTs - 60_000,             // 1m before build — kept
      buildTs + 700_000,            // 11m40s after — kept
    ];
    const result = filterBuildRestartCrashes(2, crashes, buildTs);
    expect(result.scoringCrashes).toBe(2);
    expect(result.excludedCount).toBe(0);
  });

  it('mixes excluded and kept crashes', () => {
    const crashes = [
      buildTs + 30_000,             // excluded (30s after)
      buildTs + 60_000,             // excluded (1m after)
      buildTs + 700_000,            // kept (11m40s after)
      buildTs - 3600_000,           // kept (1h before)
    ];
    const result = filterBuildRestartCrashes(4, crashes, buildTs);
    expect(result.scoringCrashes).toBe(2);
    expect(result.excludedCount).toBe(2);
  });

  it('returns raw count when lastBuildTs is null', () => {
    const result = filterBuildRestartCrashes(5, [buildTs + 30_000], null);
    expect(result.scoringCrashes).toBe(5);
    expect(result.excludedCount).toBe(0);
  });

  it('returns raw count when no crash timestamps provided', () => {
    const result = filterBuildRestartCrashes(0, [], buildTs);
    expect(result.scoringCrashes).toBe(0);
    expect(result.excludedCount).toBe(0);
  });

  it('never returns negative scoringCrashes', () => {
    // Edge case: more excluded than total (shouldn't happen, but defensive)
    const crashes = [buildTs + 1000, buildTs + 2000, buildTs + 3000];
    const result = filterBuildRestartCrashes(1, crashes, buildTs);
    expect(result.scoringCrashes).toBe(0);
    expect(result.excludedCount).toBe(3);
  });

  it('treats crash exactly at build timestamp as excluded', () => {
    const crashes = [buildTs]; // exactly at build time
    const result = filterBuildRestartCrashes(1, crashes, buildTs);
    expect(result.scoringCrashes).toBe(0);
    expect(result.excludedCount).toBe(1);
  });

  it('treats crash exactly at 10-minute boundary as excluded', () => {
    const crashes = [buildTs + 10 * 60 * 1000]; // exactly 10 minutes
    const result = filterBuildRestartCrashes(1, crashes, buildTs);
    expect(result.scoringCrashes).toBe(0);
    expect(result.excludedCount).toBe(1);
  });

  it('treats crash 1ms past 10-minute boundary as kept', () => {
    const crashes = [buildTs + 10 * 60 * 1000 + 1]; // 10 min + 1ms
    const result = filterBuildRestartCrashes(1, crashes, buildTs);
    expect(result.scoringCrashes).toBe(1);
    expect(result.excludedCount).toBe(0);
  });
});
