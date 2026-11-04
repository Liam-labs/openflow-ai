/**
 * GET /api/broker/audit: the owner reads what the credential broker did (time, who, action, secret names, approval id, result).
 * Never a value. Signed-in owner only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { requestHasSession } from '@/lib/dashboard-auth';
import { tracked } from '@/lib/api-tracking';
import { DataPaths } from '@/lib/data-paths';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/broker/audit', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  if (!(await requestHasSession(request))) {
    return NextResponse.json({ success: false, error: 'Only the signed-in owner can read this.' }, { status: 403 });
  }
  let lines: string[] = [];
  try {
    lines = (await fs.readFile(path.join(DataPaths.appData, 'broker-audit.jsonl'), 'utf8')).split('\n').filter(Boolean);
  } catch {
    // no calls yet
  }
  const entries = lines.slice(-200).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  return NextResponse.json({ success: true, entries }, { headers: { 'Cache-Control': 'no-store' } });
});
