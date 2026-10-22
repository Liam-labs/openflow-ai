/**
 * Catalog Actions (Agent API)
 *
 * Exposes the Systems Catalog via the agent API.
 * All actions use the CatalogStore interface (currently backed by JSON).
 */

import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';
import { jsonCatalogStore } from '@/lib/catalog-store-json';
import type { FeatureCategory, FeatureStatus, Complexity } from '@/lib/catalog-types';

/** catalog.list — List features with optional filters */
export async function list(body: AgentApiRequest, _auth: AgentAuthContext) {
  const filters = {
    category: body.category as FeatureCategory | undefined,
    status: body.status as FeatureStatus | undefined,
    complexity: body.complexity as Complexity | undefined,
    q: body.q as string | undefined,
    limit: typeof body.limit === 'number' ? body.limit : undefined,
    offset: typeof body.offset === 'number' ? body.offset : undefined,
  };
  return jsonCatalogStore.listFeatures(filters);
}

/** catalog.get — Get a single feature by slug */
export async function get(body: AgentApiRequest, _auth: AgentAuthContext) {
  const slug = body.slug as string;
  if (!slug) throw Object.assign(new Error('slug is required'), { statusCode: 400 });
  const feature = await jsonCatalogStore.getFeature(slug);
  if (!feature) throw Object.assign(new Error(`Feature not found: ${slug}`), { statusCode: 404 });
  return { feature };
}

/** catalog.upsert — Create or update a feature */
export async function upsert(body: AgentApiRequest, _auth: AgentAuthContext) {
  const slug = body.slug as string;
  if (!slug) throw Object.assign(new Error('slug is required'), { statusCode: 400 });
  const feature = await jsonCatalogStore.upsertFeature({ ...body, slug } as unknown as Parameters<typeof jsonCatalogStore.upsertFeature>[0]);
  return { feature };
}

/** catalog.delete — Delete a feature by slug */
export async function deleteFeature(body: AgentApiRequest, _auth: AgentAuthContext) {
  const slug = body.slug as string;
  if (!slug) throw Object.assign(new Error('slug is required'), { statusCode: 400 });
  await jsonCatalogStore.deleteFeature(slug);
  return { deleted: true };
}

/** catalog.audit — Record an audit result for a feature */
export async function audit(body: AgentApiRequest, _auth: AgentAuthContext) {
  const slug = body.slug as string;
  if (!slug) throw Object.assign(new Error('slug is required'), { statusCode: 400 });
  const result = await jsonCatalogStore.insertAudit(slug, {
    date: (body.date as string) || new Date().toISOString(),
    auditor: (body.auditor as string) || 'unknown',
    passed: !!body.passed,
    findings: (body.findings as []) || [],
    notes: (body.notes as string) || '',
  });
  return { audit: result };
}

/** catalog.audits — Get audit history for a feature */
export async function audits(body: AgentApiRequest, _auth: AgentAuthContext) {
  const slug = body.slug as string;
  if (!slug) throw Object.assign(new Error('slug is required'), { statusCode: 400 });
  const results = await jsonCatalogStore.getAudits(slug);
  return { audits: results };
}

/** catalog.issue — File a known issue against a feature */
export async function issue(body: AgentApiRequest, _auth: AgentAuthContext) {
  const slug = body.slug as string;
  const title = body.title as string;
  if (!slug || !title) throw Object.assign(new Error('slug and title are required'), { statusCode: 400 });
  const result = await jsonCatalogStore.insertIssue(slug, {
    title,
    severity: (body.severity as 'critical' | 'high' | 'medium' | 'low') || 'medium',
    description: (body.description as string) || '',
    discoveredAt: (body.discoveredAt as string) || new Date().toISOString(),
    resolvedAt: null,
    taskId: body.taskId as string | undefined,
  });
  return { issue: result };
}

/** catalog.issues — List open issues, optionally filtered by feature slug */
export async function issues(body: AgentApiRequest, _auth: AgentAuthContext) {
  const slug = body.slug as string | undefined;
  const results = await jsonCatalogStore.getOpenIssues(slug);
  return { issues: results };
}

/** catalog.resolveIssue — Mark an issue as resolved */
export async function resolveIssue(body: AgentApiRequest, _auth: AgentAuthContext) {
  const issueId = body.issueId as string;
  if (!issueId) throw Object.assign(new Error('issueId is required'), { statusCode: 400 });
  await jsonCatalogStore.resolveIssue(issueId);
  return { resolved: true };
}

/** catalog.improvement — Record an improvement for a feature */
export async function improvement(body: AgentApiRequest, _auth: AgentAuthContext) {
  const slug = body.slug as string;
  const description = body.description as string;
  if (!slug || !description) throw Object.assign(new Error('slug and description are required'), { statusCode: 400 });
  const result = await jsonCatalogStore.insertImprovement(slug, {
    date: (body.date as string) || new Date().toISOString(),
    description,
    agent: (body.agent as string) || 'unknown',
    taskId: body.taskId as string | undefined,
  });
  return { improvement: result };
}

/** catalog.improvements — Get improvement history for a feature */
export async function improvements(body: AgentApiRequest, _auth: AgentAuthContext) {
  const slug = body.slug as string;
  if (!slug) throw Object.assign(new Error('slug is required'), { statusCode: 400 });
  const results = await jsonCatalogStore.getImprovements(slug);
  return { improvements: results };
}
