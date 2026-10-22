/**
 * Tools Library Actions
 *
 * Agent-facing actions for discovering and reading tool guides.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';
import { emitApiError } from '@/lib/event-bus';
import { appPath } from '@/lib/app-paths';

const TOOLS_JSON = appPath('data', 'tools', 'tools.json');

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

async function loadTools(): Promise<ToolsRegistry> {
  try {
    const content = await fs.readFile(TOOLS_JSON, 'utf-8');
    return JSON.parse(content) as ToolsRegistry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[tools] Failed to load tools registry:', error);
      emitApiError(error, 'api/agent/actions/tools', { severity: 'medium', context: { path: TOOLS_JSON } });
    }
    return { tools: [] };
  }
}

/**
 * tools.list — List all tools (or filter by category/tag)
 */
export async function list(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ tools: Tool[]; count: number }> {
  const registry = await loadTools();
  let tools = registry.tools;

  if (body.category && typeof body.category === 'string') {
    tools = tools.filter(t => t.category === body.category);
  }

  if (body.tag && typeof body.tag === 'string') {
    const tag = (body.tag as string).toLowerCase();
    tools = tools.filter(t => t.tags.some(tg => tg.toLowerCase() === tag));
  }

  return { tools, count: tools.length };
}

/**
 * tools.get — Get a tool by slug, including guide content
 */
export async function get(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ tool: Tool | null; guideContent: string | null; found: boolean }> {
  const slug = body.slug;
  if (!slug || typeof slug !== 'string') {
    throw new Error('slug is required');
  }

  const registry = await loadTools();
  const tool = registry.tools.find(t => t.slug === slug) ?? null;

  if (!tool) {
    return { tool: null, guideContent: null, found: false };
  }

  let guideContent: string | null = null;
  try {
    const guidePath = appPath(tool.guidePath);
    guideContent = await fs.readFile(guidePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    }
  }

  return { tool, guideContent, found: true };
}

/**
 * tools.search — Search tools by name, description, tags, or category
 */
export async function search(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ results: Array<Tool & { score: number }>; count: number }> {
  const query = body.query;
  if (!query || typeof query !== 'string') {
    throw new Error('query is required');
  }

  const registry = await loadTools();
  const q = query.toLowerCase();
  const results: Array<Tool & { score: number }> = [];

  for (const tool of registry.tools) {
    let score = 0;

    if (tool.name.toLowerCase().includes(q)) score += 10;
    if (tool.slug.toLowerCase().includes(q)) score += 8;
    if (tool.description.toLowerCase().includes(q)) score += 5;
    if (tool.category.toLowerCase().includes(q)) score += 4;
    if (tool.tags.some(t => t.toLowerCase().includes(q))) score += 6;

    if (score > 0) {
      results.push({ ...tool, score });
    }
  }

  results.sort((a, b) => b.score - a.score);

  return { results, count: results.length };
}
