/**
 * POST /api/setup/test-bridge
 *
 * Tests connectivity to the host-bridge daemon.
 * Used by the wizard's Step 5 "Test Connection" button.
 *
 * Body: { url?: string }  (defaults to http://localhost:3001)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

interface TestBridgeRequest {
  url?: string;
}

interface TestBridgeResponse {
  success: boolean;
  reachable: boolean;
  error?: string;
  details?: {
    status: string;
    version?: string;
    uptime?: number;
    processCount?: number;
  };
}

/** Only allow localhost targets to prevent SSRF */
function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

export const POST = tracked('/api/setup/test-bridge', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body: TestBridgeRequest = await request.json();
    const bridgeUrl = (body.url || 'http://localhost:3001').replace(/\/$/, '');

    if (!isLocalhostUrl(bridgeUrl)) {
      return NextResponse.json<TestBridgeResponse>({
        success: false,
        reachable: false,
        error: 'Bridge URL must be localhost (127.0.0.1 or ::1)',
      }, { status: 400 });
    }

    // Test 1: Health check (no auth required)
    let healthOk = false;
    let healthData: Record<string, unknown> = {};

    try {
      const healthRes = await fetch(`${bridgeUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });

      if (healthRes.ok) {
        healthData = await healthRes.json();
        healthOk = (healthData as Record<string, unknown>).status === 'ok';
      }
    } catch {
      return NextResponse.json<TestBridgeResponse>({
        success: false,
        reachable: false,
        error: `Cannot reach host bridge at ${bridgeUrl}. Is the daemon running?`,
      });
    }

    if (!healthOk) {
      return NextResponse.json<TestBridgeResponse>({
        success: false,
        reachable: true,
        error: 'Host bridge responded but health check failed',
      });
    }

    // Test 2: Try PM2 status (requires auth — but we can test without to verify it's the bridge)
    let processCount: number | undefined;
    try {
      const statusRes = await fetch(`${bridgeUrl}/pm2/status`, {
        signal: AbortSignal.timeout(5000),
      });
      // 401 = bridge is running and auth is enforced (good)
      // 200 = bridge is running without auth (also fine for now)
      if (statusRes.status === 401) {
        // Auth is working — we can't get process count without a token
        processCount = undefined;
      } else if (statusRes.ok) {
        const statusData = await statusRes.json();
        processCount = (statusData as Record<string, unknown>)?.data
          ? ((statusData as Record<string, unknown>).data as Record<string, unknown>)?.processes
            ? (((statusData as Record<string, unknown>).data as Record<string, unknown>).processes as unknown[]).length
            : undefined
          : undefined;
      }
    } catch {
      // Non-fatal — health passed so bridge is reachable
    }

    const response: TestBridgeResponse = {
      success: true,
      reachable: true,
      details: {
        status: 'ok',
        version: healthData.version as string | undefined,
        uptime: healthData.uptime as number | undefined,
        processCount,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[Setup test-bridge] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, reachable: false, error: message },
      { status: 500 }
    );
  }
});
