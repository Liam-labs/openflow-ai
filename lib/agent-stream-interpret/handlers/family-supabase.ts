/**
 * Sprint 5 — Supabase MCP family (catalogue §3f, 29 actions).
 * Prefix: mcp__claude_ai_Supabase__
 */

import type { FamilyHandler, Handler, InterpretedAction } from '../types';
import { truncate } from '../utils';

interface ActionMeta {
  verb: string;
  subject?: (input: Record<string, unknown>) => string;
}

function projectId(i: Record<string, unknown>): string {
  const p = i.project_id ?? i.id;
  return typeof p === 'string' ? p.slice(0, 12) : '';
}

const ACTIONS: Readonly<Record<string, ActionMeta>> = {
  // Project
  list_organizations: { verb: 'list orgs' },
  get_organization: { verb: 'get org', subject: (i) => String(i.id ?? '') },
  list_projects: { verb: 'list projects' },
  get_project: { verb: 'get project', subject: projectId },
  create_project: { verb: 'create project', subject: (i) => String(i.name ?? '') },
  pause_project: { verb: 'pause project', subject: projectId },
  restore_project: { verb: 'restore project', subject: projectId },
  get_project_url: { verb: 'get project URL', subject: projectId },
  get_publishable_keys: { verb: 'get API keys', subject: projectId },
  get_cost: { verb: 'get cost' },
  confirm_cost: { verb: 'confirm cost' },
  // Database
  execute_sql: {
    verb: 'SQL',
    subject: (i) => `\`${truncate(String(i.query ?? ''), 50)}\``,
  },
  list_tables: { verb: 'list tables', subject: (i) => String(i.schema ?? 'public') },
  list_extensions: { verb: 'list extensions' },
  list_migrations: { verb: 'list migrations' },
  apply_migration: { verb: 'apply migration', subject: (i) => String(i.name ?? '') },
  generate_typescript_types: { verb: 'generate TS types' },
  get_advisors: { verb: 'get advisors' },
  // Branches
  list_branches: { verb: 'list branches' },
  create_branch: { verb: 'create branch', subject: (i) => String(i.name ?? '') },
  delete_branch: { verb: 'delete branch' },
  merge_branch: { verb: 'merge branch' },
  reset_branch: { verb: 'reset branch' },
  rebase_branch: { verb: 'rebase branch' },
  // Edge Functions & Logs
  list_edge_functions: { verb: 'list edge functions' },
  get_edge_function: { verb: 'get function', subject: (i) => String(i.slug ?? '') },
  deploy_edge_function: { verb: 'deploy function', subject: (i) => String(i.slug ?? '') },
  get_logs: { verb: 'logs', subject: (i) => String(i.service ?? 'all') },
  search_docs: { verb: 'docs search', subject: (i) => truncate(String(i.query ?? ''), 60) },
};

export const supabaseFamily: FamilyHandler = (action, input, item): InterpretedAction => {
  const meta = ACTIONS[action];
  return {
    icon: 'database',
    verb: meta ? `Supabase ${meta.verb}` : `Supabase ${action}`,
    subject: meta?.subject ? meta.subject(input) : '',
    detail: '',
    outcome: null,
    tone: 'external',
    toolName: `mcp__claude_ai_Supabase__${action}`,
    toolUseId: item.toolUseId ?? '',
  };
};

export function registerHandlers(
  _exact: Record<string, Handler>,
  family: Record<string, FamilyHandler>,
): void {
  family.claude_ai_Supabase = supabaseFamily;
}
