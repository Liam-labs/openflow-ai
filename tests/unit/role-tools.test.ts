import { describe, it, expect } from 'vitest';
import { parseRoleFrontmatter, getAllowedToolsForRole, buildAllowedToolsFlag, INFRASTRUCTURE_TOOLS, getEffectiveToolsForRole } from '@/lib/role-tools';
import * as fs from 'fs';
import * as path from 'path';

describe('parseRoleFrontmatter', () => {
  it('parses valid YAML frontmatter and returns body without it', () => {
    const md = `---
allowedTools:
  - Read
  - Edit
  - Bash
---
# Backend Dev

You are a backend dev.`;

    const result = parseRoleFrontmatter(md);
    expect(result.frontmatter).toEqual({ allowedTools: ['Read', 'Edit', 'Bash'] });
    expect(result.body).toBe('# Backend Dev\n\nYou are a backend dev.');
  });

  it('returns empty frontmatter and full body when no frontmatter present', () => {
    const md = `# Researcher

Just a role description.`;

    const result = parseRoleFrontmatter(md);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(md);
  });

  it('handles frontmatter with extra fields', () => {
    const md = `---
allowedTools:
  - Read
  - Glob
disallowedTools:
  - Bash
tier: restricted
---
# Content`;

    const result = parseRoleFrontmatter(md);
    expect(result.frontmatter.allowedTools).toEqual(['Read', 'Glob']);
    expect(result.frontmatter.disallowedTools).toEqual(['Bash']);
    expect(result.frontmatter.tier).toBe('restricted');
    expect(result.body).toBe('# Content');
  });

  it('handles empty frontmatter block', () => {
    const md = `---
---
# Content`;

    const result = parseRoleFrontmatter(md);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('# Content');
  });
});

describe('getAllowedToolsForRole', () => {
  it('returns tool list when allowedTools is present in frontmatter', () => {
    const md = `---
allowedTools:
  - Read
  - Glob
  - Grep
  - WebSearch
  - WebFetch
---
# Researcher`;

    const tools = getAllowedToolsForRole(md);
    expect(tools).toEqual(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
  });

  it('returns null when no allowedTools specified (unrestricted)', () => {
    const md = `---
tier: full
---
# Team Lead`;

    const tools = getAllowedToolsForRole(md);
    expect(tools).toBeNull();
  });

  it('returns null when no frontmatter at all (unrestricted)', () => {
    const md = `# Some Role\n\nNo frontmatter here.`;
    const tools = getAllowedToolsForRole(md);
    expect(tools).toBeNull();
  });

  it('returns empty array if allowedTools is empty array', () => {
    const md = `---
allowedTools: []
---
# Locked Down`;

    const tools = getAllowedToolsForRole(md);
    expect(tools).toEqual([]);
  });
});

describe('buildAllowedToolsFlag', () => {
  it('builds comma-separated flag value', () => {
    const result = buildAllowedToolsFlag(['Read', 'Edit', 'Bash']);
    expect(result).toBe('Read,Edit,Bash');
  });

  it('returns single tool without comma', () => {
    const result = buildAllowedToolsFlag(['Read']);
    expect(result).toBe('Read');
  });

  it('handles empty array', () => {
    const result = buildAllowedToolsFlag([]);
    expect(result).toBe('');
  });
});

describe('INFRASTRUCTURE_TOOLS', () => {
  it('includes Agent and ToolSearch', () => {
    expect(INFRASTRUCTURE_TOOLS).toContain('Agent');
    expect(INFRASTRUCTURE_TOOLS).toContain('ToolSearch');
  });
});

describe('getEffectiveToolsForRole', () => {
  it('appends infrastructure tools to restricted role', () => {
    const md = `---
allowedTools:
  - Read
  - Glob
  - Grep
---
# Researcher`;

    const tools = getEffectiveToolsForRole(md);
    expect(tools).toEqual(['Read', 'Glob', 'Grep', 'Agent', 'ToolSearch']);
  });

  it('returns null for unrestricted role (no allowedTools)', () => {
    const md = `---
tier: full
---
# Team Lead`;

    const tools = getEffectiveToolsForRole(md);
    expect(tools).toBeNull();
  });

  it('does not duplicate infrastructure tools if already listed', () => {
    const md = `---
allowedTools:
  - Read
  - Agent
  - ToolSearch
---
# Role with infra`;

    const tools = getEffectiveToolsForRole(md);
    expect(tools).toEqual(['Read', 'Agent', 'ToolSearch']);
    // No duplicates
    expect(tools!.filter(t => t === 'Agent')).toHaveLength(1);
    expect(tools!.filter(t => t === 'ToolSearch')).toHaveLength(1);
  });

  it('returns null for no frontmatter at all', () => {
    const md = `# No Frontmatter`;
    expect(getEffectiveToolsForRole(md)).toBeNull();
  });
});

describe('B2 spec — per-role tool permission tiers (live role files)', () => {
  const rolesDir = path.join(process.cwd(), 'data', 'roles');

  function readRole(slug: string): string {
    return fs.readFileSync(path.join(rolesDir, `${slug}.md`), 'utf-8');
  }

  it('Researcher tier includes read/search tools plus Bash for research scripts', () => {
    const tools = getAllowedToolsForRole(readRole('researcher'));
    expect(tools).toEqual(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash']);
  });

  it('Researcher effective: adds Agent + ToolSearch', () => {
    const tools = getEffectiveToolsForRole(readRole('researcher'));
    expect(tools).toEqual(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash', 'Agent', 'ToolSearch']);
  });

  it('Team Lead tier: full (null = unrestricted)', () => {
    const tools = getAllowedToolsForRole(readRole('team-lead'));
    expect(tools).toBeNull();
  });

  it('Backend Dev tier: Read, Write, Edit, Bash, Glob, Grep only', () => {
    const tools = getAllowedToolsForRole(readRole('backend-dev'));
    expect(tools).toEqual(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']);
  });

  it('Backend Dev effective: adds Agent + ToolSearch', () => {
    const tools = getEffectiveToolsForRole(readRole('backend-dev'));
    expect(tools).toEqual(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent', 'ToolSearch']);
  });

  it('Frontend Dev tier: implementation, verification, and reference tools', () => {
    const tools = getAllowedToolsForRole(readRole('frontend-dev'));
    expect(tools).toEqual([
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash',
      'Skill',
      'WebFetch',
      'WebSearch',
    ]);
  });

  it('Frontend Dev effective: adds Agent + ToolSearch', () => {
    const tools = getEffectiveToolsForRole(readRole('frontend-dev'));
    expect(tools).toEqual([
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash',
      'Skill',
      'WebFetch',
      'WebSearch',
      'Agent',
      'ToolSearch',
    ]);
  });
});
