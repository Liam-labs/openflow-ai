/**
 * POST /api/models/detect
 *
 * Triggers a re-detection pass over the model registry and persists any
 * changed integration blocks back into `.AppData/models.json`.
 *
 * Sprint M P1 T5 (Reynolds, 2026-05-27). Idempotency contract from Sam's
 * plan AMENDMENT #3 holds: re-running with no infrastructure change
 * produces zero writes, and `wrote: false` in the response report.
 *
 * The same logic runs automatically on every server boot via
 * `instrumentation.ts` → `startupRunIntegrationDetection()`. This endpoint
 * is for on-demand refresh (e.g. after a developer drops a new
 * `collab-X.py` wrapper without restarting DevFlow).
 *
 * Auth: requireAuthOrLocal('write') — localhost calls pass without a token
 * so cron / dev-loop invocations work; remote callers need
 * `DEVFLOW_API_TOKEN`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { runIntegrationDetectionAndPersist } from '@/lib/model-integration-persist';

export const dynamic = 'force-dynamic';

export const POST = tracked('/api/models/detect', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  try {
    const report = await runIntegrationDetectionAndPersist();
    return NextResponse.json({
      success: true,
      ...report,
    });
  } catch (err) {
    console.error('[api/models/detect] error', err);
    return NextResponse.json(
      {
        success: false,
        error: 'Detection run failed',
        detail: err instanceof Error ? err.message : 'unknown error',
      },
      { status: 500 },
    );
  }
});
