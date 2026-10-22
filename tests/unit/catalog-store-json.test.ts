import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@/lib/data-io', () => ({
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn().mockResolvedValue(undefined),
  withFileLock: vi.fn().mockImplementation((_: string, fn: () => Promise<unknown>) => fn()),
}));

import { readJsonFile, writeJsonFile } from '@/lib/data-io';
import { jsonCatalogStore } from '@/lib/catalog-store-json';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFeature(slug: string, overrides: object = {}) {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    category: 'infrastructure' as const,
    description: `${slug} description`,
    apiRoutes: [],
    apiActions: [],
    uiComponents: [],
    sourceFiles: [],
    dataFiles: [],
    dependencies: [],
    actionCount: 0,
    healthCheck: null,
    status: 'discovered' as const,
    complexity: 'medium' as const,
    lastAuditedAt: null,
    lastAuditResult: null,
    knownIssues: [],
    improvementHistory: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function emptyCatalog() {
  return {
    version: '1.0.0',
    lastModified: '2026-01-01T00:00:00.000Z',
    features: [],
    audits: [],
    issues: [],
    improvements: [],
  };
}

function catalogWith(features: object[], extras: object = {}) {
  return { ...emptyCatalog(), features, ...extras };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(readJsonFile).mockResolvedValue(emptyCatalog());
  vi.mocked(writeJsonFile).mockResolvedValue(undefined);
});

// ─── listFeatures ─────────────────────────────────────────────────────────────

describe('listFeatures', () => {
  it('returns all features when no filters applied', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([makeFeature('alpha'), makeFeature('beta')])
    );
    const { features, total } = await jsonCatalogStore.listFeatures();
    expect(total).toBe(2);
    expect(features).toHaveLength(2);
  });

  it('filters by category', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([
        makeFeature('a', { category: 'infrastructure' }),
        makeFeature('b', { category: 'automation' }),
      ])
    );
    const { features } = await jsonCatalogStore.listFeatures({ category: 'infrastructure' });
    expect(features).toHaveLength(1);
    expect(features[0].slug).toBe('a');
  });

  it('filters by status', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([
        makeFeature('a', { status: 'audited' }),
        makeFeature('b', { status: 'needs-work' }),
        makeFeature('c', { status: 'discovered' }),
      ])
    );
    const { features } = await jsonCatalogStore.listFeatures({ status: 'audited' });
    expect(features).toHaveLength(1);
    expect(features[0].slug).toBe('a');
  });

  it('filters by complexity', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([
        makeFeature('a', { complexity: 'low' }),
        makeFeature('b', { complexity: 'high' }),
      ])
    );
    const { features } = await jsonCatalogStore.listFeatures({ complexity: 'low' });
    expect(features).toHaveLength(1);
  });

  it('filters by query string (name/description/slug match)', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([
        makeFeature('auth-module', { name: 'Auth Module', description: 'Handles authentication' }),
        makeFeature('notifications', { name: 'Notifications', description: 'Push alerts' }),
      ])
    );
    const { features } = await jsonCatalogStore.listFeatures({ q: 'auth' });
    expect(features).toHaveLength(1);
    expect(features[0].slug).toBe('auth-module');
  });

  it('respects offset and limit for pagination', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([makeFeature('a'), makeFeature('b'), makeFeature('c')])
    );
    const { features } = await jsonCatalogStore.listFeatures({ limit: 2, offset: 1 });
    expect(features).toHaveLength(2);
    expect(features[0].slug).toBe('b');
  });
});

// ─── getFeature ───────────────────────────────────────────────────────────────

describe('getFeature', () => {
  it('returns a hydrated feature when slug exists', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([makeFeature('existing-feature')])
    );
    const feature = await jsonCatalogStore.getFeature('existing-feature');
    expect(feature).not.toBeNull();
    expect(feature!.slug).toBe('existing-feature');
  });

  it('returns null when slug does not exist', async () => {
    const result = await jsonCatalogStore.getFeature('ghost-feature');
    expect(result).toBeNull();
  });
});

// ─── upsertFeature ────────────────────────────────────────────────────────────

describe('upsertFeature', () => {
  it('creates a new feature when slug is not present', async () => {
    const written: object[] = [];
    vi.mocked(writeJsonFile).mockImplementation(async (_, data: unknown) => {
      written.push(data as object);
    });

    const feature = await jsonCatalogStore.upsertFeature({
      slug: 'new-service',
      name: 'New Service',
      description: 'A brand new service',
    });

    expect(feature.slug).toBe('new-service');
    expect(feature.name).toBe('New Service');
    expect(feature.id).toBeTruthy();
    expect(written.length).toBeGreaterThan(0);
  });

  it('updates an existing feature when slug already exists', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([makeFeature('existing', { description: 'Old description' })])
    );

    const feature = await jsonCatalogStore.upsertFeature({
      slug: 'existing',
      description: 'Updated description',
    });

    expect(feature.description).toBe('Updated description');
    expect(feature.id).toBe('id-existing'); // original id preserved
  });

  it('preserves the original id on update', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([makeFeature('keep-id', { id: 'original-uuid-here' })])
    );
    const feature = await jsonCatalogStore.upsertFeature({ slug: 'keep-id', name: 'Renamed' });
    expect(feature.id).toBe('original-uuid-here');
  });
});

// ─── deleteFeature ────────────────────────────────────────────────────────────

describe('deleteFeature', () => {
  it('removes the feature and cascades to audits, issues, improvements', async () => {
    const catalogData = {
      ...emptyCatalog(),
      features: [makeFeature('doomed'), makeFeature('survivor')],
      audits: [
        { id: 'aud-1', featureSlug: 'doomed', date: '2026-01-01', passed: true, findings: [], auditor: 'x', notes: '' },
      ],
      issues: [
        { id: 'iss-1', featureSlug: 'doomed', title: 'Bug', severity: 'low' as const, description: '', createdAt: '2026-01-01' },
      ],
      improvements: [
        { id: 'imp-1', featureSlug: 'doomed', description: 'Better', date: '2026-01-01', author: 'x' },
      ],
    };
    vi.mocked(readJsonFile).mockResolvedValue(catalogData);

    const written: { features: object[]; audits: object[]; issues: object[]; improvements: object[] }[] = [];
    vi.mocked(writeJsonFile).mockImplementation(async (_, data: unknown) => {
      written.push(data as typeof written[0]);
    });

    await jsonCatalogStore.deleteFeature('doomed');

    const saved = written[0];
    expect(saved.features.find((f: { slug?: string }) => f.slug === 'doomed')).toBeUndefined();
    expect(saved.features.find((f: { slug?: string }) => f.slug === 'survivor')).toBeTruthy();
    expect(saved.audits.every((a: { featureSlug?: string }) => a.featureSlug !== 'doomed')).toBe(true);
    expect(saved.issues.every((i: { featureSlug?: string }) => i.featureSlug !== 'doomed')).toBe(true);
    expect(saved.improvements.every((i: { featureSlug?: string }) => i.featureSlug !== 'doomed')).toBe(true);
  });
});

// ─── insertAudit ─────────────────────────────────────────────────────────────

describe('insertAudit', () => {
  it('throws when feature does not exist', async () => {
    await expect(
      jsonCatalogStore.insertAudit('nonexistent', {
        date: '2026-01-01',
        passed: true,
        findings: [],
        auditor: 'test',
        notes: '',
      })
    ).rejects.toThrow('Feature not found: nonexistent');
  });

  it('transitions status to "audited" on a passing audit', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([makeFeature('tested', { status: 'discovered' })])
    );

    const written: { features: { slug: string; status: string }[] }[] = [];
    vi.mocked(writeJsonFile).mockImplementation(async (_, data: unknown) => {
      written.push(data as typeof written[0]);
    });

    await jsonCatalogStore.insertAudit('tested', {
      date: '2026-01-01',
      passed: true,
      findings: [],
      auditor: 'tester',
      notes: 'All good',
    });

    const saved = written[0];
    const feature = saved.features.find(f => f.slug === 'tested');
    expect(feature?.status).toBe('audited');
  });

  it('transitions status to "needs-work" on a failing audit with findings', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([makeFeature('broken', { status: 'discovered' })])
    );

    const written: { features: { slug: string; status: string }[] }[] = [];
    vi.mocked(writeJsonFile).mockImplementation(async (_, data: unknown) => {
      written.push(data as typeof written[0]);
    });

    await jsonCatalogStore.insertAudit('broken', {
      date: '2026-01-01',
      passed: false,
      findings: [{ severity: 'high' as const, title: 'Bug', description: 'It breaks' }],
      auditor: 'tester',
      notes: '',
    });

    const saved = written[0];
    const feature = saved.features.find(f => f.slug === 'broken');
    expect(feature?.status).toBe('needs-work');
  });

  it('records the audit and returns it with an id', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([makeFeature('my-feature')])
    );

    const record = await jsonCatalogStore.insertAudit('my-feature', {
      date: '2026-01-15',
      passed: true,
      findings: [],
      auditor: 'alice',
      notes: '',
    });

    expect(record.id).toBeTruthy();
    expect(record.featureSlug).toBe('my-feature');
  });
});

// ─── insertIssue ─────────────────────────────────────────────────────────────

describe('insertIssue', () => {
  it('throws when feature does not exist', async () => {
    await expect(
      jsonCatalogStore.insertIssue('ghost', {
        title: 'Issue',
        severity: 'low' as const,
        description: '',
        discoveredAt: '2026-01-01',
        resolvedAt: null,
      })
    ).rejects.toThrow('Feature not found: ghost');
  });

  it('inserts an issue and returns it with an id', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([makeFeature('target')])
    );

    const issue = await jsonCatalogStore.insertIssue('target', {
      title: 'Missing auth',
      severity: 'high' as const,
      description: 'No token check',
      discoveredAt: '2026-01-01',
      resolvedAt: null,
    });

    expect(issue.id).toBeTruthy();
    expect(issue.featureSlug).toBe('target');
    expect(issue.title).toBe('Missing auth');
  });
});

// ─── resolveIssue ─────────────────────────────────────────────────────────────

describe('resolveIssue', () => {
  it('throws when issue id does not exist', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      catalogWith([makeFeature('f')], { issues: [] })
    );
    await expect(jsonCatalogStore.resolveIssue('nonexistent-id')).rejects.toThrow('Issue not found');
  });

  it('marks the issue resolvedAt', async () => {
    const catalogData = {
      ...emptyCatalog(),
      features: [makeFeature('f')],
      issues: [
        { id: 'iss-open', featureSlug: 'f', title: 'Bug', severity: 'low' as const, description: '', createdAt: '2026-01-01' },
      ],
    };
    vi.mocked(readJsonFile).mockResolvedValue(catalogData);

    const written: { issues: { id: string; resolvedAt?: string }[] }[] = [];
    vi.mocked(writeJsonFile).mockImplementation(async (_, data: unknown) => {
      written.push(data as typeof written[0]);
    });

    await jsonCatalogStore.resolveIssue('iss-open');

    const saved = written[0];
    const issue = saved.issues.find(i => i.id === 'iss-open');
    expect(issue?.resolvedAt).toBeTruthy();
  });

  it('transitions feature status to "improved" when all issues are resolved', async () => {
    const catalogData = {
      ...emptyCatalog(),
      features: [makeFeature('f', { status: 'needs-work' })],
      issues: [
        { id: 'iss-last', featureSlug: 'f', title: 'Last bug', severity: 'low' as const, description: '', createdAt: '2026-01-01' },
      ],
    };
    vi.mocked(readJsonFile).mockResolvedValue(catalogData);

    const written: { features: { slug: string; status: string }[] }[] = [];
    vi.mocked(writeJsonFile).mockImplementation(async (_, data: unknown) => {
      written.push(data as typeof written[0]);
    });

    await jsonCatalogStore.resolveIssue('iss-last');

    const saved = written[0];
    const feature = saved.features.find(f => f.slug === 'f');
    expect(feature?.status).toBe('improved');
  });

  it('does NOT change status to "improved" if other open issues remain', async () => {
    const catalogData = {
      ...emptyCatalog(),
      features: [makeFeature('f', { status: 'needs-work' })],
      issues: [
        { id: 'iss-1', featureSlug: 'f', title: 'Bug 1', severity: 'low' as const, description: '', createdAt: '2026-01-01' },
        { id: 'iss-2', featureSlug: 'f', title: 'Bug 2', severity: 'low' as const, description: '', createdAt: '2026-01-01' },
      ],
    };
    vi.mocked(readJsonFile).mockResolvedValue(catalogData);

    const written: { features: { slug: string; status: string }[] }[] = [];
    vi.mocked(writeJsonFile).mockImplementation(async (_, data: unknown) => {
      written.push(data as typeof written[0]);
    });

    await jsonCatalogStore.resolveIssue('iss-1'); // iss-2 still open

    const saved = written[0];
    const feature = saved.features.find(f => f.slug === 'f');
    expect(feature?.status).toBe('needs-work'); // not yet improved
  });
});

// ─── getOpenIssues ────────────────────────────────────────────────────────────

describe('getOpenIssues', () => {
  const catalogWithIssues = () => ({
    ...emptyCatalog(),
    features: [makeFeature('f1'), makeFeature('f2')],
    issues: [
      { id: 'i1', featureSlug: 'f1', title: 'Open A', severity: 'high' as const, description: '', createdAt: '2026-01-01' },
      { id: 'i2', featureSlug: 'f1', title: 'Closed', severity: 'low' as const, description: '', createdAt: '2026-01-01', resolvedAt: '2026-01-02' },
      { id: 'i3', featureSlug: 'f2', title: 'Open B', severity: 'medium' as const, description: '', createdAt: '2026-01-01' },
    ],
  });

  it('returns all open issues when no slug filter', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(catalogWithIssues());
    const issues = await jsonCatalogStore.getOpenIssues();
    expect(issues).toHaveLength(2);
    expect(issues.every(i => !i.resolvedAt)).toBe(true);
  });

  it('filters open issues by slug', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(catalogWithIssues());
    const issues = await jsonCatalogStore.getOpenIssues('f1');
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('i1');
  });

  it('returns empty array when all issues for a slug are resolved', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(catalogWithIssues());
    const issues = await jsonCatalogStore.getOpenIssues('f-noissues');
    expect(issues).toHaveLength(0);
  });
});
