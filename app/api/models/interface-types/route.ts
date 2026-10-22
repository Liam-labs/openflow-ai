/**
 * GET /api/models/interface-types
 *
 * Returns the canonical interface-type catalogue — one entry per distinct
 * label `pickInterfaceType()` can emit, with human-readable label,
 * description, and the source agentTypes that map to each label.
 *
 * Consumed by Phase 3 <ModelPicker /> for the interface-type filter dropdown.
 *
 * Sprint M P3 T2 history:
 *   - 2026-05-27 (an agent): first version with hardcoded list inline
 *   - 2026-05-27 (Reynolds, routed by CJack after role-boundary recheck):
 *     refactored to call `getInterfaceTypeOptions()` from
 *     lib/model-integration-detect.ts so the list is derived from the same
 *     AGENT_TYPE_TO_INTERFACE map the detector uses. Single source of
 *     truth — adding a new wrapper updates one place, not two. Also
 *     added per-option `agentTypes` cross-ref + requireAuthOrLocal('read')
 *     per the Q1 hardening pattern.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { getInterfaceTypeOptions } from '@/lib/model-integration-detect';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/models/interface-types', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  const interfaceTypes = getInterfaceTypeOptions();
  return NextResponse.json(
    {
      interfaceTypes,
      total: interfaceTypes.length,
    },
    // Catalogue derived from a static map; cache 5 min. ModelPicker
    // hits this once per mount, refresh isn't time-sensitive.
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
});
