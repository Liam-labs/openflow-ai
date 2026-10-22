import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { collectProcessHealth } from '@/lib/process-health';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

// GET /api/process-health
// Returns full process health snapshot: summary, top consumers, history
export const GET = tracked('/api/process-health', async (request: NextRequest) => {
  try {
    const authDenied = await requireAuthOrLocal(request, 'read');
    if (authDenied) return authDenied;

    const data = await collectProcessHealth();
    return NextResponse.json(data);
  } catch (error) {
    console.error('[process-health] GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to collect process health data' },
      { status: 500 }
    );
  }
});

// POST /api/process-health
// Body: { "action": "kill", "pid": 12345, "signal": "SIGTERM" | "SIGKILL" }
export const POST = tracked('/api/process-health', async (request: NextRequest) => {
  try {
    const authDenied = await requireAuthOrLocal(request, 'write');
    if (authDenied) return authDenied;

    const body = await request.json() as { action?: string; pid?: number; signal?: string };
    const { action, pid, signal } = body;

    if (action !== 'kill') {
      return NextResponse.json({ success: false, error: 'Unknown action. Supported: kill' }, { status: 400 });
    }

    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return NextResponse.json({ success: false, error: 'Missing or invalid pid' }, { status: 400 });
    }

    const sig = signal || 'SIGTERM';
    if (sig !== 'SIGTERM' && sig !== 'SIGKILL') {
      return NextResponse.json(
        { success: false, error: 'Invalid signal. Use SIGTERM or SIGKILL' },
        { status: 400 }
      );
    }

    // Safety guards
    if (pid === 1) {
      return NextResponse.json({ success: false, error: 'Cannot kill init (PID 1)' }, { status: 403 });
    }
    if (pid === process.pid) {
      return NextResponse.json({ success: false, error: 'Cannot kill own process' }, { status: 403 });
    }

    // Use process.kill() — avoids shell signal name parsing issues
    process.kill(pid, sig as NodeJS.Signals);
    return NextResponse.json({ success: true, pid, signal: sig });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('ESRCH') || msg.includes('No such process')) {
      return NextResponse.json({ success: false, error: 'Process not found or already dead' }, { status: 404 });
    }
    if (msg.includes('EPERM') || msg.includes('Operation not permitted')) {
      return NextResponse.json({ success: false, error: 'Permission denied' }, { status: 403 });
    }
    console.error('[process-health] POST error:', error);
    return NextResponse.json({ success: false, error: `Kill failed: ${msg}` }, { status: 500 });
  }
});
