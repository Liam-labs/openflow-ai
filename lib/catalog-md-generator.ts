/**
 * Catalog Companion .md Generator
 *
 * Registers a write hook on the JsonCatalogStore. After every catalog mutation,
 * writes per-feature markdown files to:
 *   data/central-knowledge-base/catalog/catalog-<slug>.md
 *
 * The Qdrant file watcher auto-ingests these within ~30 seconds, enabling
 * semantic search: "which system handles message delivery?" → finds collab feature.
 */

import path from 'path';
import { promises as fs } from 'fs';
import { APP_CWD } from '@/lib/app-paths';
import { onCatalogWrite } from '@/lib/catalog-store-json';
import type { SystemsCatalogFile, CatalogFeature, KnownIssue } from '@/lib/catalog-types';
import { PRODUCT_NAME } from '@/lib/brand';

const CATALOG_KB_DIR = path.join(/* turbopackIgnore: true */ APP_CWD, 'data', 'central-knowledge-base', 'catalog');

// ─── Markdown Formatter ───────────────────────────────────────────────────────

function formatFeatureMd(feature: CatalogFeature, openIssues: KnownIssue[]): string {
  const lines: string[] = [];

  lines.push(`# ${PRODUCT_NAME} Feature: ${feature.name}`);
  lines.push('');
  lines.push(`**Category:** ${feature.category}`);
  lines.push(`**Status:** ${feature.status}`);
  lines.push(`**Complexity:** ${feature.complexity}`);
  lines.push(`**Actions:** ${feature.actionCount}`);
  lines.push('');

  if (feature.description) {
    lines.push(feature.description);
    lines.push('');
  }

  if (feature.apiRoutes.length > 0) {
    lines.push('## API Routes');
    for (const route of feature.apiRoutes) {
      lines.push(`- ${route}`);
    }
    lines.push('');
  }

  if (feature.apiActions.length > 0) {
    lines.push('## API Actions');
    lines.push(feature.apiActions.join(', '));
    lines.push('');
  }

  const keyFiles = [
    ...feature.sourceFiles,
    ...feature.uiComponents,
    ...feature.dataFiles,
  ];
  if (keyFiles.length > 0) {
    lines.push('## Key Files');
    for (const f of keyFiles) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  if (feature.dependencies.length > 0) {
    lines.push('## Dependencies');
    lines.push(feature.dependencies.join(', '));
    lines.push('');
  }

  if (feature.healthCheck) {
    lines.push('## Health Check');
    const hc = feature.healthCheck;
    lines.push(`${hc.method} ${hc.endpoint} → ${hc.expectedStatus}`);
    if (hc.expectedShape) {
      lines.push(hc.expectedShape);
    }
    lines.push('');
  }

  lines.push('## Known Issues');
  if (openIssues.length === 0) {
    lines.push('None');
  } else {
    for (const issue of openIssues) {
      lines.push(`- [${issue.severity.toUpperCase()}] ${issue.title}`);
      if (issue.description) {
        lines.push(`  ${issue.description}`);
      }
    }
  }
  lines.push('');

  if (feature.lastAuditedAt) {
    lines.push('## Last Audit');
    const result = feature.lastAuditResult;
    const auditor = result?.auditor ?? 'Unknown';
    const outcome = result?.passed ? 'PASSED' : 'FAILED';
    lines.push(`${feature.lastAuditedAt.slice(0, 10)} — ${auditor} — ${outcome}`);
    lines.push('');
  }

  lines.push(`*Updated: ${feature.updatedAt.slice(0, 10)}*`);

  return lines.join('\n');
}

// ─── Hook Implementation ──────────────────────────────────────────────────────

async function generateCatalogMd(catalog: SystemsCatalogFile): Promise<void> {
  await fs.mkdir(CATALOG_KB_DIR, { recursive: true });

  const currentSlugs = new Set(catalog.features.map(f => f.slug));

  // Remove .md files for deleted features
  let existingFiles: string[] = [];
  try {
    existingFiles = await fs.readdir(CATALOG_KB_DIR);
  } catch {
    // Directory didn't exist until we just created it — nothing to clean up
  }

  await Promise.all(
    existingFiles
      .filter(f => f.startsWith('catalog-') && f.endsWith('.md'))
      .filter(f => !currentSlugs.has(f.slice('catalog-'.length, -'.md'.length)))
      .map(f => fs.unlink(path.join(CATALOG_KB_DIR, f)).catch(() => {}))
  );

  // Write/update .md for every current feature
  await Promise.all(
    catalog.features.map(feature => {
      const openIssues = catalog.issues.filter(
        i => i.featureSlug === feature.slug && !i.resolvedAt
      );
      const content = formatFeatureMd(feature, openIssues);
      const filePath = path.join(CATALOG_KB_DIR, `catalog-${feature.slug}.md`);
      return fs.writeFile(filePath, content, 'utf8');
    })
  );
}

// Register — fires after every catalog mutation (upsert, delete, audit, issue, improvement)
onCatalogWrite(generateCatalogMd);
