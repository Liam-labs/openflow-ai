/**
 * Behavioral Anchor Rules — Read + Write
 *
 * GET /api/settings/anchor   — return current anchor rules
 * PUT /api/settings/anchor   — save updated rules
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { tracked } from '@/lib/api-tracking';
import { appRoot } from '@/lib/app-paths';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const DEVFLOW_DIR = appRoot();
const ANCHOR_JSON = path.join(DEVFLOW_DIR, 'data', 'scaffolding', 'behavioral-anchor.json');

interface AnchorRule {
  id: number;
  text: string;
  enabled: boolean;
}

interface AnchorData {
  version: string;
  rules: AnchorRule[];
}

async function loadAnchor(): Promise<AnchorData> {
  try {
    const content = await fs.readFile(ANCHOR_JSON, 'utf-8');
    return JSON.parse(content) as AnchorData;
  } catch {
    return { version: '1.0', rules: [] };
  }
}

export const GET = tracked('/api/settings/anchor', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  try {
    const data = await loadAnchor();

    // Also compute preview output (what check-rotate.sh will emit)
    const preview = data.rules
      .filter(r => r.enabled)
      .map(r => `${r.id}. ${r.text}`)
      .join('\n');

    return NextResponse.json({ success: true, ...data, preview });
  } catch (error) {
    console.error('[settings/anchor] GET error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
});

export const PUT = tracked('/api/settings/anchor', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  try {
    const body = await request.json() as { rules?: AnchorRule[]; version?: string };

    if (!Array.isArray(body.rules)) {
      return NextResponse.json({ success: false, error: 'rules array is required' }, { status: 400 });
    }

    // Validate each rule
    for (const rule of body.rules) {
      if (typeof rule.id !== 'number') {
        return NextResponse.json({ success: false, error: 'Each rule must have a numeric id' }, { status: 400 });
      }
      if (typeof rule.text !== 'string' || !rule.text.trim()) {
        return NextResponse.json({ success: false, error: 'Each rule must have non-empty text' }, { status: 400 });
      }
      if (typeof rule.enabled !== 'boolean') {
        return NextResponse.json({ success: false, error: 'Each rule must have a boolean enabled field' }, { status: 400 });
      }
    }

    const data: AnchorData = {
      version: body.version ?? '1.0',
      rules: body.rules,
    };

    await fs.mkdir(path.dirname(ANCHOR_JSON), { recursive: true });
    await fs.writeFile(ANCHOR_JSON, JSON.stringify(data, null, 2));

    const preview = data.rules
      .filter(r => r.enabled)
      .map(r => `${r.id}. ${r.text}`)
      .join('\n');

    return NextResponse.json({ success: true, ...data, preview });
  } catch (error) {
    console.error('[settings/anchor] PUT error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
});
