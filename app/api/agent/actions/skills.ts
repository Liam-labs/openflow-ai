/**
 * Skills & Commands Scanner (Agent API)
 *
 * Scans for available Claude Code slash commands and skills.
 * Commands: ~/.claude/commands/{name}.md (global) + .claude/commands/{name}.md (project)
 * Skills: ~/.claude/skills/{name}/SKILL.md (global) + .claude/skills/{name}/SKILL.md (project)
 */

import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { appRoot } from '@/lib/app-paths';

interface SlashItem {
  name: string;
  description: string;
  type: 'command' | 'skill';
  argumentHint?: string;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns key-value pairs from the --- delimited block.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key && value) result[key] = value;
    }
  }
  return result;
}

/**
 * Scan a directory for command .md files.
 */
async function scanCommands(dir: string): Promise<SlashItem[]> {
  const items: SlashItem[] = [];
  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      try {
        const content = await fs.readFile(path.join(dir, file), 'utf-8');
        const fm = parseFrontmatter(content);
        items.push({
          name: file.replace('.md', ''),
          description: fm.description || '',
          type: 'command',
          argumentHint: fm['argument-hint'] || undefined,
        });
      } catch { /* skip unreadable files */ }
    }
  } catch { /* directory may not exist */ }
  return items;
}

/**
 * Scan a directory for skill subdirectories containing SKILL.md.
 */
async function scanSkills(dir: string): Promise<SlashItem[]> {
  const items: SlashItem[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(dir, entry.name, 'SKILL.md');
      try {
        const content = await fs.readFile(skillFile, 'utf-8');
        const fm = parseFrontmatter(content);
        items.push({
          name: fm.name || entry.name,
          description: fm.description || '',
          type: 'skill',
        });
      } catch { /* no SKILL.md in this dir */ }
    }
  } catch { /* directory may not exist */ }
  return items;
}

/**
 * skills.list - List all available slash commands and skills.
 * Scans both global (~/.claude/) and project-level (.claude/) locations.
 */
export async function list(body: AgentApiRequest, _auth: AgentAuthContext) {
  const homeDir = os.homedir();
  const projectDir = body.projectPath as string || appRoot();

  // Scan all locations in parallel
  const [globalCommands, projectCommands, globalSkills, projectSkills] = await Promise.all([
    scanCommands(path.join(homeDir, '.claude', 'commands')),
    scanCommands(path.join(projectDir, '.claude', 'commands')),
    scanSkills(path.join(homeDir, '.claude', 'skills')),
    scanSkills(path.join(projectDir, '.claude', 'skills')),
  ]);

  // Merge, deduplicating by name+type (project overrides global)
  const seen = new Map<string, SlashItem>();
  for (const item of [...globalCommands, ...globalSkills]) {
    seen.set(`${item.type}:${item.name}`, item);
  }
  // Project-level overrides global
  for (const item of [...projectCommands, ...projectSkills]) {
    seen.set(`${item.type}:${item.name}`, item);
  }

  const items = Array.from(seen.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'command' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { items, count: items.length };
}
