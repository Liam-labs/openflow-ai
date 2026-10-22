/**
 * Tools Library — Get + Update + Delete
 *
 * GET    /api/settings/tools/[id]   — get tool metadata + guide content
 * PUT    /api/settings/tools/[id]   — update metadata or guide content
 * DELETE /api/settings/tools/[id]   — remove tool entry (optionally delete guide)
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { withFileLock } from '@/lib/data-io';
import { tracked } from '@/lib/api-tracking';
import { appRoot } from '@/lib/app-paths';

export const dynamic = 'force-dynamic';

const DEVFLOW_DIR = appRoot();
const TOOLS_JSON = path.join(DEVFLOW_DIR, 'data', 'tools', 'tools.json');

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
  await withFileLock(TOOLS_JSON, async () => {
    await fs.writeFile(TOOLS_JSON, JSON.stringify(registry, null, 2));
  });
}

export const GET = tracked('/api/settings/tools/:id', async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const { id } = await params;
    const registry = await loadRegistry();
    const tool = registry.tools.find(t => t.id === id) ?? null;

    if (!tool) {
      return NextResponse.json({ success: false, error: 'Tool not found' }, { status: 404 });
    }

    let guideContent: string | null = null;
    try {
      const guidePath = path.join(DEVFLOW_DIR, tool.guidePath);
      guideContent = await fs.readFile(guidePath, 'utf-8');
    } catch {
      // Guide file missing — return null content
    }

    return NextResponse.json({ success: true, tool, guideContent });
  } catch (error) {
    console.error('[settings/tools/[id]] GET error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
});

export const PUT = tracked('/api/settings/tools/:id', async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const { id } = await params;
    const registry = await loadRegistry();
    const toolIndex = registry.tools.findIndex(t => t.id === id);

    if (toolIndex === -1) {
      return NextResponse.json({ success: false, error: 'Tool not found' }, { status: 404 });
    }

    const body = await request.json() as {
      name?: string;
      description?: string;
      category?: string;
      tags?: string[];
      guideContent?: string;
    };

    const tool = registry.tools[toolIndex];

    // Update metadata fields
    if (body.name && typeof body.name === 'string') tool.name = body.name;
    if (body.description !== undefined && typeof body.description === 'string') tool.description = body.description;
    if (body.category && VALID_CATEGORIES.includes(body.category)) tool.category = body.category;
    if (Array.isArray(body.tags)) tool.tags = body.tags.filter(t => typeof t === 'string');
    tool.updatedAt = new Date().toISOString();

    registry.tools[toolIndex] = tool;
    await saveRegistry(registry);

    // Update guide content if provided
    if (typeof body.guideContent === 'string') {
      const guidePath = path.join(DEVFLOW_DIR, tool.guidePath);
      await fs.mkdir(path.dirname(guidePath), { recursive: true });
      await fs.writeFile(guidePath, body.guideContent, 'utf-8');
    }

    return NextResponse.json({ success: true, tool });
  } catch (error) {
    console.error('[settings/tools/[id]] PUT error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
});

export const DELETE = tracked('/api/settings/tools/:id', async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const { id } = await params;
    const registry = await loadRegistry();
    const toolIndex = registry.tools.findIndex(t => t.id === id);

    if (toolIndex === -1) {
      return NextResponse.json({ success: false, error: 'Tool not found' }, { status: 404 });
    }

    const tool = registry.tools[toolIndex];

    // Check if caller wants to delete the guide file too
    const url = new URL(request.url);
    const deleteGuide = url.searchParams.get('deleteGuide') === 'true';

    if (deleteGuide) {
      try {
        const guidePath = path.join(DEVFLOW_DIR, tool.guidePath);
        await fs.unlink(guidePath);
      } catch {
        // Guide file may not exist
      }
    }

    registry.tools.splice(toolIndex, 1);
    await saveRegistry(registry);

    return NextResponse.json({ success: true, deletedId: id });
  } catch (error) {
    console.error('[settings/tools/[id]] DELETE error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
});
