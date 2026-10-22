import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { requireAuthOrLocal } from '@/lib/api-auth';

export async function POST(req: NextRequest) {
  const denied = await requireAuthOrLocal(req, 'write');
  if (denied) return denied;

  const body = await req.json().catch(() => ({})) as { path?: string };
  const wslPath = body.path ?? '';

  // Must be absolute
  if (!wslPath.startsWith('/')) {
    return NextResponse.json({ error: 'Path must be absolute' }, { status: 400 });
  }

  // No traversal
  if (wslPath.includes('..')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  // Only WSL filesystem — reject /mnt (Windows drives)
  if (/^\/mnt(\/|$)/.test(wslPath)) {
    return NextResponse.json({ error: 'Cannot open Windows-mounted paths via WSL bridge' }, { status: 400 });
  }

  // Map WSL path → UNC path for explorer.exe
  const uncPath = `\\\\wsl.localhost\\Ubuntu${wslPath}`;

  await new Promise<void>((resolve, reject) => {
    // explorer.exe is a Windows process; spawn it detached so it doesn't block
    const child = spawn('explorer.exe', [uncPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('spawn', () => { child.unref(); resolve(); });
    // explorer.exe often returns non-zero even on success — just resolve
    child.on('close', () => resolve());
  });

  return NextResponse.json({ success: true, uncPath });
}
