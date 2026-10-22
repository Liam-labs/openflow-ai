/**
 * Scaffolding File List + Open Folder
 *
 * GET  /api/settings/scaffolding   — returns merged list from manifest + global-rules
 * POST /api/settings/scaffolding   — opens a folder in Windows Explorer
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appRoot } from '@/lib/app-paths';
import { getHomeDir } from '@/lib/home-dir';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

const DEVFLOW_DIR = appRoot();
const MASTERS_DIR = path.join(DEVFLOW_DIR, 'data', 'scaffolding', 'masters');
const MANIFEST_PATH = path.join(DEVFLOW_DIR, 'data', 'scaffolding', 'manifest.json');
const HOME = getHomeDir();

export type ScaffoldingCategory =
  | 'global-rules'
  | 'agent-behavior'
  | 'agent-methodology'
  | 'agent-context'
  | 'per-model'
  | 'per-agent';

export interface ScaffoldingFile {
  id: string;
  label: string;
  category: ScaffoldingCategory;
  absolutePath: string;
  displayPath: string;
  sizeBytes: number;
  updatedAt: string;
  isTemplate: boolean;
  exists: boolean;
  summary: string;
  appliesTo: string;
}

/**
 * Per-id metadata: re-categorizes manifest entries into functional groups
 * (behaviour / methodology / context) and adds human-readable summary + appliesTo.
 * Keys are manifest `id` fields or GLOBAL_RULES `id` fields.
 */
const ID_META: Record<string, { category: ScaffoldingCategory; summary: string; appliesTo: string }> = {
  // --- Agent Behaviour (universal behavioral guardrails) ---
  'task-discipline':                { category: 'agent-behavior',    appliesTo: 'All agents',             summary: 'Outcome continuity, proportionate board coordination, blocker pinning and closure.' },
  'channel-communication':          { category: 'agent-behavior',    appliesTo: 'All agents',             summary: 'Plain-English message quality plus runtime-owned transport.' },
  'approval-protocol':              { category: 'agent-behavior',    appliesTo: 'All agents',             summary: 'Separate approval only for destructive, external-live or out-of-scope authority gaps.' },

  // --- Agent Methodology (engineering practices) ---
  'tdd-methodology':                { category: 'agent-methodology', appliesTo: 'When methodology is relevant', summary: 'Compact router to proportionate test-first methodology.' },
  'verification-before-completion': { category: 'agent-methodology', appliesTo: 'All dev agents',         summary: 'Compact router to evidence proportionate to the claim and risk.' },
  'systematic-debugging':           { category: 'agent-methodology', appliesTo: 'Debugging work',         summary: 'Compact router to systematic diagnosis.' },
  'code-review-process':            { category: 'agent-methodology', appliesTo: 'Reviewers, Team Leads',  summary: 'Compact router to consolidated, risk-proportionate review.' },

  // --- Agent Context (platform, profile, MCP, aesthetics) ---
  'base-role-boilerplate':          { category: 'agent-context',     appliesTo: 'All agents',             summary: 'Shared operating agreement — autonomy, continuity, safety, evidence and plain English.' },
  'devflow-md':                     { category: 'agent-context',     appliesTo: 'All agents',             summary: 'Compact DevFlow, AgentChat, documentation, KB and live-state context map.' },
  'rag-memory-rules':               { category: 'agent-context',     appliesTo: 'Every agent presence',   summary: 'Harness-neutral RAG search, KB fallback and memory destinations.' },
  'mcp-outlook':                    { category: 'agent-context',     appliesTo: 'All agents',             summary: 'Shared HTTP Outlook MCP entry; preserves unrelated MCP servers.' },
  'user-profile':                   { category: 'agent-context',     appliesTo: 'All agents',             summary: `User profile (${HUMAN_ROUTING_NAME}) — personalises agent responses to user context.` },
  'frontend-aesthetics-block':      { category: 'agent-context',     appliesTo: 'Material visual work',   summary: 'Compact visual-skill router; selection blocks only the gated visual mutation.' },

  // --- Per-Model ---
  'alignment-claude':               { category: 'per-model',         appliesTo: 'Claude harness',         summary: 'Claude-specific autonomy, output, memory and safety adjustments.' },
  'alignment-gemini':               { category: 'per-model',         appliesTo: 'Gemini harness',         summary: 'Gemini wrapper/output and attachment adjustments.' },
  'alignment-grok':                 { category: 'per-model',         appliesTo: 'Grok harness',           summary: 'Grok verification and output adjustments.' },
  'gemini-md':                      { category: 'per-model',         appliesTo: 'Gemini harness',         summary: 'Gemini entrypoint importing the canonical local rules.' },
  'grok-md':                        { category: 'per-model',         appliesTo: 'Grok harness',           summary: 'Grok entrypoint importing the canonical local rules.' },

  // --- Per-Agent Templates ---
  'workspace-md':                   { category: 'per-agent',         appliesTo: 'Every agent (templated)', summary: 'Workspace paths — absolute paths to agent_dir / team_dir / project_dir.' },
  'startup-md':                     { category: 'per-agent',         appliesTo: 'Every agent (templated)', summary: 'Small startup context set plus continuity and precedence.' },
  'expertise-md':                   { category: 'per-agent',         appliesTo: 'Every agent (write-once)', summary: 'Expertise log — accumulated codebase patterns. Deployed once, never overwritten.' },
  'handoff-md':                     { category: 'per-agent',         appliesTo: 'Every agent (stub)',     summary: 'Session handoff stub — overwritten each session by Stop hook.' },

  // --- Global Rules (hardcoded) ---
  'user-claude-md':        { category: 'global-rules', appliesTo: 'Every Claude session (system-wide)', summary: 'User-level Claude Code instructions — loaded at every session start.' },
  'devflow-claude-md':     { category: 'global-rules', appliesTo: 'Sessions inside DevFlow project',    summary: 'Project-level DevFlow instructions — loaded when cwd is inside DevFlow.' },
};

const DEFAULT_META = { summary: '', appliesTo: '' };

/** Hardcoded global-rules entries — not in manifest */
const GLOBAL_RULES: Array<{ id: string; label: string; absolutePath: string }> = [
  { id: 'user-claude-md',         label: 'User CLAUDE.md',          absolutePath: `${HOME}/.claude/CLAUDE.md` },
  { id: 'devflow-claude-md',      label: 'DevFlow CLAUDE.md',        absolutePath: `${DEVFLOW_DIR}/CLAUDE.md` },
];

async function getFileStats(absolutePath: string): Promise<{ sizeBytes: number; updatedAt: string; exists: boolean }> {
  try {
    const stat = await fs.stat(absolutePath);
    return { sizeBytes: stat.size, updatedAt: stat.mtime.toISOString(), exists: true };
  } catch {
    return { sizeBytes: 0, updatedAt: new Date().toISOString(), exists: false };
  }
}

function collapseHome(p: string): string {
  if (p.startsWith(HOME)) return '~' + p.slice(HOME.length);
  if (p.startsWith(DEVFLOW_DIR)) return p.slice(DEVFLOW_DIR.length + 1);
  return p;
}

export const GET = tracked('/api/settings/scaffolding', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const files: ScaffoldingFile[] = [];

    // Source 1: manifest.json
    let manifest: { files: Array<{ id: string; category: string; master: string; description?: string; condition?: string }> } = { files: [] };
    try {
      manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf-8'));
    } catch { /* manifest missing — proceed with empty */ }

    for (const entry of manifest.files) {
      const absolutePath = path.join(MASTERS_DIR, entry.master);
      const stats = await getFileStats(absolutePath);
      const label = path.basename(entry.master);
      const meta = ID_META[entry.id];
      files.push({
        id: entry.id,
        label,
        category: (meta?.category ?? entry.category) as ScaffoldingCategory,
        absolutePath,
        displayPath: collapseHome(absolutePath),
        isTemplate: label.endsWith('.tmpl'),
        summary: meta?.summary ?? entry.description ?? DEFAULT_META.summary,
        appliesTo: meta?.appliesTo ?? entry.condition ?? DEFAULT_META.appliesTo,
        ...stats,
      });
    }

    // Source 2: hardcoded global-rules
    for (const entry of GLOBAL_RULES) {
      const stats = await getFileStats(entry.absolutePath);
      const meta = ID_META[entry.id];
      files.push({
        id: entry.id,
        label: entry.label,
        category: 'global-rules',
        absolutePath: entry.absolutePath,
        displayPath: collapseHome(entry.absolutePath),
        isTemplate: false,
        summary: meta?.summary ?? DEFAULT_META.summary,
        appliesTo: meta?.appliesTo ?? DEFAULT_META.appliesTo,
        ...stats,
      });
    }

    return NextResponse.json({ success: true, files });
  } catch (error) {
    console.error('[settings/scaffolding] GET error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
});

export const POST = tracked('/api/settings/scaffolding', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const body = await request.json() as { path?: string };
    const folderPath = body.path;
    if (!folderPath) {
      return NextResponse.json({ success: false, error: 'path is required' }, { status: 400 });
    }

    const resolved = path.resolve(folderPath);
    if (!resolved.startsWith('/home/') && !resolved.startsWith(DEVFLOW_DIR)) {
      return NextResponse.json({ success: false, error: 'Access restricted' }, { status: 403 });
    }

    // Open the directory (or the parent dir of a file)
    let dirToOpen = resolved;
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) dirToOpen = path.dirname(resolved);
    } catch {
      dirToOpen = path.dirname(resolved);
    }

    execFileAsync('wslpath', ['-w', dirToOpen])
      .then(({ stdout: winPath }) => {
        execFile('explorer.exe', [winPath.trim()], (error) => {
          if (error) console.error('[settings/scaffolding] open-folder error:', error);
        });
      })
      .catch((err: Error) => {
        console.error('[settings/scaffolding] wslpath error:', err);
      });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[settings/scaffolding] POST error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
});
