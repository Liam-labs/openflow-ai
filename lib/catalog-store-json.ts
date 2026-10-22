/**
 * JsonCatalogStore — JSON-file-backed implementation of CatalogStore.
 *
 * Source of truth: .AppData/systems-catalog.json
 * Uses flock/readJsonFile/writeJsonFile pattern (same as projects.json, cron-jobs.json).
 */

import path from 'path';
import { randomUUID } from 'crypto';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import type {
  CatalogStore,
  CatalogFeature,
  SystemsCatalogFile,
  FeatureFilters,
  AuditResult,
  KnownIssue,
  ImprovementEntry,
  StoredAudit,
  StoredIssue,
  StoredImprovement,
} from './catalog-types';

const CATALOG_VERSION = '1.0.0';

const CATALOG_PATH = path.join(DataPaths.appData, 'systems-catalog.json');

const DEFAULT_CATALOG: SystemsCatalogFile = {
  version: CATALOG_VERSION,
  lastModified: new Date().toISOString(),
  features: [],
  audits: [],
  issues: [],
  improvements: [],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readCatalog(): Promise<SystemsCatalogFile> {
  return readJsonFile<SystemsCatalogFile>(CATALOG_PATH, DEFAULT_CATALOG);
}

async function writeCatalog(data: SystemsCatalogFile): Promise<void> {
  data.lastModified = new Date().toISOString();
  await writeJsonFile(CATALOG_PATH, data);
}

/** Hydrate a feature with its related audits, issues, and improvements from flat arrays */
function hydrateFeature(
  feature: CatalogFeature,
  audits: StoredAudit[],
  issues: StoredIssue[],
  improvements: StoredImprovement[]
): CatalogFeature {
  const featureAudits = audits.filter(a => a.featureSlug === feature.slug);
  const featureIssues = issues.filter(i => i.featureSlug === feature.slug);
  const featureImprovements = improvements.filter(i => i.featureSlug === feature.slug);

  const lastAudit = featureAudits.length > 0
    ? featureAudits.sort((a, b) => b.date.localeCompare(a.date))[0]
    : null;

  return {
    ...feature,
    lastAuditedAt: lastAudit?.date ?? feature.lastAuditedAt,
    lastAuditResult: lastAudit ?? feature.lastAuditResult,
    knownIssues: featureIssues.filter(i => !i.resolvedAt),
    improvementHistory: featureImprovements,
  };
}

// Write hook — called after every catalog mutation.
// Allows external consumers (e.g., companion .md generator) to react.
type WriteHook = (catalog: SystemsCatalogFile) => Promise<void> | void;
const writeHooks: WriteHook[] = [];

export function onCatalogWrite(hook: WriteHook): void {
  writeHooks.push(hook);
}

async function runWriteHooks(catalog: SystemsCatalogFile): Promise<void> {
  for (const hook of writeHooks) {
    try {
      await hook(catalog);
    } catch (err) {
      console.error('[Catalog] Write hook error:', err);
    }
  }
}

// ─── Store Implementation ────────────────────────────────────────────────────

export const jsonCatalogStore: CatalogStore = {

  async listFeatures(filters?: FeatureFilters) {
    const catalog = await readCatalog();
    let features = catalog.features;

    // Apply filters
    if (filters?.category) {
      features = features.filter(f => f.category === filters.category);
    }
    if (filters?.status) {
      features = features.filter(f => f.status === filters.status);
    }
    if (filters?.complexity) {
      features = features.filter(f => f.complexity === filters.complexity);
    }
    if (filters?.q) {
      const q = filters.q.toLowerCase();
      features = features.filter(f =>
        f.name.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q) ||
        f.slug.toLowerCase().includes(q)
      );
    }

    const total = features.length;

    // Pagination
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? 100;
    features = features.slice(offset, offset + limit);

    // Hydrate with related data
    features = features.map(f => hydrateFeature(f, catalog.audits, catalog.issues, catalog.improvements));

    return { features, total };
  },

  async getFeature(slug: string) {
    const catalog = await readCatalog();
    const feature = catalog.features.find(f => f.slug === slug);
    if (!feature) return null;
    return hydrateFeature(feature, catalog.audits, catalog.issues, catalog.improvements);
  },

  async upsertFeature(data: Partial<CatalogFeature> & { slug: string }) {
    return withFileLock(CATALOG_PATH, async () => {
      const catalog = await readCatalog();
      const now = new Date().toISOString();
      const idx = catalog.features.findIndex(f => f.slug === data.slug);

      let feature: CatalogFeature;
      if (idx >= 0) {
        // Update existing
        feature = { ...catalog.features[idx], ...data, updatedAt: now };
        catalog.features[idx] = feature;
      } else {
        // Create new
        feature = {
          id: randomUUID(),
          name: data.slug,
          category: 'infrastructure' as const,
          description: '',
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
          ...data,
        };
        catalog.features.push(feature);
      }

      await writeCatalog(catalog);
      await runWriteHooks(catalog);
      return hydrateFeature(feature, catalog.audits, catalog.issues, catalog.improvements);
    });
  },

  async deleteFeature(slug: string) {
    await withFileLock(CATALOG_PATH, async () => {
      const catalog = await readCatalog();
      catalog.features = catalog.features.filter(f => f.slug !== slug);
      // Cascade: remove related records
      catalog.audits = catalog.audits.filter(a => a.featureSlug !== slug);
      catalog.issues = catalog.issues.filter(i => i.featureSlug !== slug);
      catalog.improvements = catalog.improvements.filter(i => i.featureSlug !== slug);
      await writeCatalog(catalog);
      await runWriteHooks(catalog);
    });
  },

  async insertAudit(slug: string, audit: Omit<AuditResult, 'id'>) {
    return withFileLock(CATALOG_PATH, async () => {
      const catalog = await readCatalog();
      const feature = catalog.features.find(f => f.slug === slug);
      if (!feature) throw new Error(`Feature not found: ${slug}`);

      const record: StoredAudit = {
        ...audit,
        id: randomUUID(),
        featureSlug: slug,
      };
      catalog.audits.push(record);

      // Update feature's denormalized audit summary
      feature.lastAuditedAt = record.date;
      feature.lastAuditResult = record; // keep in sync so md-generator reads correct outcome
      if (record.passed) {
        feature.status = 'audited';
      } else if (record.findings.length > 0) {
        feature.status = 'needs-work';
      }
      feature.updatedAt = new Date().toISOString();

      await writeCatalog(catalog);
      await runWriteHooks(catalog);
      return record;
    });
  },

  async getAudits(slug: string) {
    const catalog = await readCatalog();
    return catalog.audits
      .filter(a => a.featureSlug === slug)
      .sort((a, b) => b.date.localeCompare(a.date));
  },

  async insertIssue(slug: string, issue: Omit<KnownIssue, 'id'>) {
    return withFileLock(CATALOG_PATH, async () => {
      const catalog = await readCatalog();
      const feature = catalog.features.find(f => f.slug === slug);
      if (!feature) throw new Error(`Feature not found: ${slug}`);

      const record: StoredIssue = {
        ...issue,
        id: randomUUID(),
        featureSlug: slug,
      };
      catalog.issues.push(record);
      feature.updatedAt = new Date().toISOString();

      await writeCatalog(catalog);
      await runWriteHooks(catalog);
      return record;
    });
  },

  async resolveIssue(issueId: string) {
    await withFileLock(CATALOG_PATH, async () => {
      const catalog = await readCatalog();
      const issue = catalog.issues.find(i => i.id === issueId);
      if (!issue) throw new Error(`Issue not found: ${issueId}`);

      issue.resolvedAt = new Date().toISOString();

      // Check if all issues for this feature are now resolved
      const featureSlug = issue.featureSlug;
      const openIssues = catalog.issues.filter(i => i.featureSlug === featureSlug && !i.resolvedAt);
      if (openIssues.length === 0) {
        const feature = catalog.features.find(f => f.slug === featureSlug);
        if (feature && feature.status === 'needs-work') {
          feature.status = 'improved';
          feature.updatedAt = new Date().toISOString();
        }
      }

      await writeCatalog(catalog);
      await runWriteHooks(catalog);
    });
  },

  async getOpenIssues(slug?: string) {
    const catalog = await readCatalog();
    let issues = catalog.issues.filter(i => !i.resolvedAt);
    if (slug) {
      issues = issues.filter(i => i.featureSlug === slug);
    }
    return issues;
  },

  async insertImprovement(slug: string, entry: Omit<ImprovementEntry, 'id'>) {
    return withFileLock(CATALOG_PATH, async () => {
      const catalog = await readCatalog();
      const feature = catalog.features.find(f => f.slug === slug);
      if (!feature) throw new Error(`Feature not found: ${slug}`);

      const record: StoredImprovement = {
        ...entry,
        id: randomUUID(),
        featureSlug: slug,
      };
      catalog.improvements.push(record);
      feature.updatedAt = new Date().toISOString();

      await writeCatalog(catalog);
      await runWriteHooks(catalog);
      return record;
    });
  },

  async getImprovements(slug: string) {
    const catalog = await readCatalog();
    return catalog.improvements
      .filter(i => i.featureSlug === slug)
      .sort((a, b) => b.date.localeCompare(a.date));
  },
};
