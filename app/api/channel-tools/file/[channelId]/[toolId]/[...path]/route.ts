/**
 * GET /api/channel-tools/file/<channelId>/<toolId>/<path...> - serves one file of a declared `html` tool so the
 * launcher can open it in a browser tab. Read-only; only files inside that tool's own folder (never dot-files,
 * never outside it, 5 MB max). The page is sandboxed so a tool cannot reach DevFlow's own pages or cookies.
 */
import { NextRequest, NextResponse } from 'next/server';

import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { CHANNEL_TOOL_CSP } from '@/lib/channel-tool-csp';
import { contentTypeFor, readChannelToolFile } from '@/lib/channel-tools';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ channelId: string; toolId: string; path: string[] }> };

export const GET = tracked('/api/channel-tools/file', async (request: NextRequest, context?: Params) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  const { channelId, toolId, path } = await context!.params;
  const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return '\0'; } };
  const rel = path.map(decode).join('/');
  const file = await readChannelToolFile(decode(channelId), decode(toolId), rel);
  if (!file.ok) return NextResponse.json({ success: false, error: file.message }, { status: file.statusCode });
  const type = contentTypeFor(rel);
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Sandboxed (opaque origin). next.config.ts applies the same policy, because a config rule replaces this header.
    'Content-Security-Policy': CHANNEL_TOOL_CSP,
    // Lets a sandboxed tool page load its own sibling files (data.json etc.).
    'Access-Control-Allow-Origin': '*',
  };
  if (type === 'application/octet-stream') headers['Content-Disposition'] = 'attachment';
  return new NextResponse(new Uint8Array(file.data), { status: 200, headers });
});
