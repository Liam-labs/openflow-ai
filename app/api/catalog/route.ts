/**
 * /api/catalog — Systems Catalog CRUD
 *
 * GET  /api/catalog                         — List all features (with optional filters)
 * GET  /api/catalog?slug=sprint-board       — Get a single feature by slug
 * GET  /api/catalog?slug=sprint-board&sub=audits       — Get audits for a feature
 * GET  /api/catalog?slug=sprint-board&sub=issues       — Get open issues for a feature
 * GET  /api/catalog?slug=sprint-board&sub=improvements — Get improvements for a feature
 * GET  /api/catalog?sub=issues                         — Get all open issues (no slug = global)
 *
 * POST /api/catalog  { action: "upsert", ... }         — Create or update a feature
 * POST /api/catalog  { action: "delete", slug }        — Delete a feature
 * POST /api/catalog  { action: "audit", slug, ... }    — Record an audit result
 * POST /api/catalog  { action: "issue", slug, ... }    — File a known issue
 * POST /api/catalog  { action: "resolve_issue", issueId } — Resolve an issue
 * POST /api/catalog  { action: "improvement", slug, ... } — Record an improvement
 */

import { NextRequest, NextResponse } from 'next/server';
import { jsonCatalogStore } from '@/lib/catalog-store-json';
import '@/lib/catalog-md-generator'; // registers onCatalogWrite hook (side-effect import)
import type { FeatureCategory, FeatureStatus, Complexity } from '@/lib/catalog-types';
import { tracked } from '@/lib/api-tracking';
import { requireTokenOrLocal } from '@/lib/api-auth';
import { requireAuthOrLocal } from '@/lib/api-auth';

// ─── GET ─────────────────────────────────────────────────────────────────────

export const GET = tracked('/api/catalog', async (request: Request) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  try {
    const { searchParams } = new URL(request.url);
    const slug = searchParams.get('slug');
    const sub = searchParams.get('sub');

    // Single feature by slug
    if (slug && !sub) {
      const feature = await jsonCatalogStore.getFeature(slug);
      if (!feature) {
        return NextResponse.json({ error: `Feature not found: ${slug}` }, { status: 404 });
      }
      return NextResponse.json({ feature });
    }

    // Sub-resource for a specific feature
    if (slug && sub) {
      // Verify feature exists
      const feature = await jsonCatalogStore.getFeature(slug);
      if (!feature) {
        return NextResponse.json({ error: `Feature not found: ${slug}` }, { status: 404 });
      }

      switch (sub) {
        case 'audits': {
          const audits = await jsonCatalogStore.getAudits(slug);
          return NextResponse.json({ audits });
        }
        case 'issues': {
          const issues = await jsonCatalogStore.getOpenIssues(slug);
          return NextResponse.json({ issues });
        }
        case 'improvements': {
          const improvements = await jsonCatalogStore.getImprovements(slug);
          return NextResponse.json({ improvements });
        }
        default:
          return NextResponse.json({ error: `Unknown sub-resource: ${sub}` }, { status: 400 });
      }
    }

    // Global sub-resources (no slug)
    if (!slug && sub === 'issues') {
      const issues = await jsonCatalogStore.getOpenIssues();
      return NextResponse.json({ issues });
    }

    // List features with filters
    const filters = {
      category: searchParams.get('category') as FeatureCategory | undefined || undefined,
      status: searchParams.get('status') as FeatureStatus | undefined || undefined,
      complexity: searchParams.get('complexity') as Complexity | undefined || undefined,
      q: searchParams.get('q') || undefined,
      limit: searchParams.get('limit') ? parseInt(searchParams.get('limit')!, 10) : undefined,
      offset: searchParams.get('offset') ? parseInt(searchParams.get('offset')!, 10) : undefined,
    };

    const result = await jsonCatalogStore.listFeatures(filters);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[Catalog GET]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
});

// ─── POST ────────────────────────────────────────────────────────────────────

export const POST = tracked('/api/catalog', async (request: NextRequest) => {
  const authDenied = await requireTokenOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body = await request.json();
    const action = body.action as string;

    if (!action) {
      return NextResponse.json({ error: 'action is required' }, { status: 400 });
    }

    switch (action) {
      case 'upsert': {
        if (!body.slug) {
          return NextResponse.json({ error: 'slug is required' }, { status: 400 });
        }
        const feature = await jsonCatalogStore.upsertFeature(body);
        return NextResponse.json({ feature });
      }

      case 'delete': {
        if (!body.slug) {
          return NextResponse.json({ error: 'slug is required' }, { status: 400 });
        }
        await jsonCatalogStore.deleteFeature(body.slug);
        return NextResponse.json({ deleted: true });
      }

      case 'audit': {
        if (!body.slug) {
          return NextResponse.json({ error: 'slug is required' }, { status: 400 });
        }
        const audit = await jsonCatalogStore.insertAudit(body.slug, {
          date: body.date || new Date().toISOString(),
          auditor: body.auditor || 'unknown',
          passed: !!body.passed,
          findings: body.findings || [],
          notes: body.notes || '',
        });
        return NextResponse.json({ audit });
      }

      case 'issue': {
        if (!body.slug || !body.title) {
          return NextResponse.json({ error: 'slug and title are required' }, { status: 400 });
        }
        const issue = await jsonCatalogStore.insertIssue(body.slug, {
          title: body.title,
          severity: body.severity || 'medium',
          description: body.description || '',
          discoveredAt: body.discoveredAt || new Date().toISOString(),
          resolvedAt: null,
          taskId: body.taskId,
        });
        return NextResponse.json({ issue });
      }

      case 'resolve_issue': {
        if (!body.issueId) {
          return NextResponse.json({ error: 'issueId is required' }, { status: 400 });
        }
        await jsonCatalogStore.resolveIssue(body.issueId);
        return NextResponse.json({ resolved: true });
      }

      case 'improvement': {
        if (!body.slug || !body.description) {
          return NextResponse.json({ error: 'slug and description are required' }, { status: 400 });
        }
        const improvement = await jsonCatalogStore.insertImprovement(body.slug, {
          date: body.date || new Date().toISOString(),
          description: body.description,
          agent: body.agent || 'unknown',
          taskId: body.taskId,
        });
        return NextResponse.json({ improvement });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    console.error('[Catalog POST]', err);
    const status = err instanceof Error && err.message.includes('not found') ? 404 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status }
    );
  }
});
