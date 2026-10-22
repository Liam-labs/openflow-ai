/**
 * Tools Library — List + Create
 *
 * GET  /api/settings/tools   — list all tools
 * POST /api/settings/tools   — create new tool entry + scaffold guide file
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { withFileLock } from '@/lib/data-io';
import { tracked } from '@/lib/api-tracking';
import { appRoot } from '@/lib/app-paths';

export const dynamic = 'force-dynamic';

const DEVFLOW_DIR = appRoot();
const TOOLS_JSON = path.join(DEVFLOW_DIR, 'data', 'tools', 'tools.json');
const GUIDES_DIR = path.join(DEVFLOW_DIR, 'data', 'central-knowledge-base', 'tools');

const VALID_CATEGORIES = ['infrastructure', 'api', 'design', 'workflow', 'platform', 'media'];

interface Tool {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  tags: string[];
  guidePath: string;
  createdAt: string;
  updatedAt: string;
}

interface ToolsRegistry {
  tools: Tool[];
}

async function loadRegistry(): Promise<ToolsRegistry> {
  try {
    const content = await fs.readFile(TOOLS_JSON, 'utf-8');
    return JSON.parse(content) as ToolsRegistry;
  } catch {
    return { tools: [] };
  }
}

async function saveRegistry(registry: ToolsRegistry): Promise<void> {
  await fs.mkdir(path.dirname(TOOLS_JSON), { recursive: true });
  await withFileLock(TOOLS_JSON, async () => {
    await fs.writeFile(TOOLS_JSON, JSON.stringify(registry, null, 2));
  });
}

export const GET = tracked('/api/settings/tools', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const registry = await loadRegistry();
    return NextResponse.json({ success: true, tools: registry.tools, count: registry.tools.length });
  } catch (error) {
    console.error('[settings/tools] GET error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
});

export const POST = tracked('/api/settings/tools', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body = await request.json() as {
      name?: string;
      slug?: string;
      description?: string;
      category?: string;
      tags?: string[];
    };

    if (!body.name || typeof body.name !== 'string') {
      return NextResponse.json({ success: false, error: 'name is required' }, { status: 400 });
    }
    if (!body.category || !VALID_CATEGORIES.includes(body.category)) {
      return NextResponse.json(
        { success: false, error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` },
        { status: 400 }
      );
    }

    // Generate slug from name if not provided
    const slug = body.slug
      ? body.slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      : body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    if (!slug) {
      return NextResponse.json({ success: false, error: 'Could not generate valid slug from name' }, { status: 400 });
    }

    // Check for duplicate slug
    const registry = await loadRegistry();
    if (registry.tools.some(t => t.slug === slug)) {
      return NextResponse.json({ success: false, error: `Tool with slug "${slug}" already exists` }, { status: 409 });
    }

    const guidePath = `data/central-knowledge-base/tools/${slug}.md`;
    const guideAbsPath = path.join(GUIDES_DIR, `${slug}.md`);

    // Scaffold empty guide file
    await fs.mkdir(GUIDES_DIR, { recursive: true });
    try {
      await fs.access(guideAbsPath);
      // File exists — don't overwrite
    } catch {
      const stub = `# ${body.name}\n\n${body.description ?? ''}\n\n<!-- Add guide content here -->\n`;
      await fs.writeFile(guideAbsPath, stub);
    }

    const now = new Date().toISOString();
    const tool: Tool = {
      id: randomUUID(),
      name: body.name,
      slug,
      description: body.description ?? '',
      category: body.category,
      tags: Array.isArray(body.tags) ? body.tags.filter(t => typeof t === 'string') : [],
      guidePath,
      createdAt: now,
      updatedAt: now,
    };

    registry.tools.push(tool);
    await saveRegistry(registry);

    return NextResponse.json({ success: true, tool }, { status: 201 });
  } catch (error) {
    console.error('[settings/tools] POST error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
});
