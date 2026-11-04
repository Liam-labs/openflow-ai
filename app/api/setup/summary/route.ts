/**
 * GET /api/setup/summary
 *
 * What is set up on this install, for the Setup channel's status strip and for the Guide agent. Read-only. Yes, no or not-now per
 * item, with a plain label and where to turn it on. No hosts, accounts, keys or addresses.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { hasPassword } from '@/lib/dashboard-auth';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFileStrict } from '@/lib/data-io';
import { buildSetupSummary } from '@/lib/setup/setup-summary';
import { markerFile, readMarkerFile } from '@/lib/setup/setup-channel';
import path from 'path';

export const dynamic = 'force-dynamic';

const record = <T,>(file: string) => () => readJsonFileStrict<T>(file, {} as T);

export const GET = tracked('/api/setup/summary', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  const items = await buildSetupSummary({
    passwordSet: hasPassword,
    remoteAccess: record(DataPaths.remoteAccess),
    cloudflare: record(DataPaths.cloudflareAccess),
    browser: record(DataPaths.browserUse),
    memory: record(DataPaths.memoryWizard),
  });
  const marker = await readMarkerFile(markerFile(path.dirname(DataPaths.memoryWizard)));
  return NextResponse.json({ success: true, items, setupChannelId: marker?.channelId ?? null }, { headers: { 'Cache-Control': 'no-store' } });
});
