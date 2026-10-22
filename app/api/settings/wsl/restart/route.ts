/**
 * POST /api/settings/wsl/restart — Restart WSL
 *
 * Triggers `wsl --shutdown` via a detached Windows-side process with a 2-second
 * delay so the HTTP response reaches the client before WSL dies. DevFlow and all
 * WSL processes will terminate — WSL must be reopened manually.
 */

import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { requireTokenOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { defaultHost, hostCall } from '@/lib/host-executor';
import { PRODUCT_NAME } from '@/lib/brand';

export const dynamic = 'force-dynamic';

export const POST = tracked('/api/settings/wsl/restart', async (request: NextRequest) => {
  const authDenied = await requireTokenOrLocal(request, 'admin');
  if (authDenied) return authDenied;

  // DevFlow on the server: the PC's agent-hostd schedules the shutdown there.
  const host = defaultHost();
  if (host) {
    try {
      await hostCall(host, 'wsl-restart', {}, 30_000);
      return NextResponse.json({
        success: true,
        message: `WSL shutdown initiated on the PC (${host}). Agents running there stop in ~2 seconds. Reopen a terminal on the PC to start WSL again.`,
      });
    } catch (error) {
      const timedOut = (error as { code?: string })?.code === 'EHOSTTIMEOUT';
      console.error('[settings/wsl/restart] host error:', error);
      return NextResponse.json(
        { success: false, error: timedOut ? `The PC (${host}) is not connected to ${PRODUCT_NAME} right now` : `Failed to restart WSL on the PC: ${(error as Error).message}` },
        { status: timedOut ? 503 : 502 }
      );
    }
  }

  try {
    // Fire a Windows-side cmd.exe that waits 2s then shuts down WSL.
    // The delay gives the HTTP response time to reach the browser.
    // cmd.exe runs on Windows — survives WSL shutdown.
    exec('cmd.exe /c "timeout /t 2 /nobreak >nul && wsl --shutdown"', (err) => {
      if (err) console.error('[settings/wsl/restart] exec error:', err);
    });

    return NextResponse.json({
      success: true,
      message: 'WSL shutdown initiated. All WSL processes will terminate in ~2 seconds. Reopen your terminal to restart WSL.',
    });
  } catch (error) {
    console.error('[settings/wsl/restart] error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to initiate WSL restart' },
      { status: 500 }
    );
  }
});
