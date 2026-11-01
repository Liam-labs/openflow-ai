import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { DataPaths } from '@/lib/data-paths';

/** Installer-owned status. Reading the wizard never claims a name or changes DNS. */
export async function GET(request: NextRequest) {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  const serverMode = process.env.DEVFLOW_SERVER_MODE === '1';
  try {
    const saved = JSON.parse(await fs.readFile(path.join(DataPaths.appData, 'install-address.json'), 'utf8'));
    if (!saved || typeof saved.url !== 'string' ||
        !['claiming', 'certificate', 'ready', 'failed'].includes(saved.state) ||
        !['managed', 'fallback'].includes(saved.source) ||
        (saved.url !== '' && !/^https:\/\/[a-z0-9.-]+\/?$/i.test(saved.url))) {
      return NextResponse.json({ serverMode, address: null }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({ serverMode, address: {
      url: saved.url, state: saved.state, source: saved.source,
      ...(typeof saved.reason === 'string' ? { reason: saved.reason.slice(0, 400) } : {}),
    } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ serverMode, address: null }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
