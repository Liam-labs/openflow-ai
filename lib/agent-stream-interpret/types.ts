/**
 * Sprint 5 — Live-Feed Interpreter: Public Types
 *
 * The interpreter emits pure data — no React, no DOM. The UI maps `icon`
 * strings to Lucide components, `tone` to CSS classes, and the outcome
 * shape to a result chip / pending spinner.
 */

import type { StreamItem } from '@/components/collab/agent-stream/types';

export type IconName =
  | 'file-text'        // Read, PDF read
  | 'edit-3'           // Edit, Write, PDF edit
  | 'search'           // Grep, search_*, ToolSearch
  | 'folder-search'    // Glob, list_folders
  | 'terminal'         // Bash generic, python, node, docker
  | 'globe'            // WebFetch, WebSearch, curl
  | 'database'         // qdrant, supabase, psql, sqlite
  | 'git-pull-request' // GitHub PR ops
  | 'git-branch'       // git, branches, gitcommit skill
  | 'package'          // npm, pnpm, yarn, bun, pm2, npx
  | 'cloud'            // gdrive, docker, canva
  | 'brain'            // Agent / sub-agent dispatch, qdrant RAG
  | 'sparkles'         // skills / slash commands
  | 'mail'             // outlook, gmail, brevo
  | 'calendar'         // calendar / meeting
  | 'image'            // snapshot, canva, figma
  | 'file-cog'         // pdf-editor
  | 'clipboard-list'   // TaskCreate / Task* mgmt
  | 'bell'             // PushNotification
  | 'clock'            // ScheduleWakeup, cron
  | 'plug'             // MCP resource tools, generic MCP fallback
  | 'eye'              // Monitor
  | 'map'              // Plan mode, init skill
  | 'settings'         // n8n, pm2 ops, mail rules, config skills
  | 'shield'           // security review, auth/secrets
  | 'beaker'           // tests (vitest/jest)
  | 'message-square'   // collab skills, comments
  | 'help-circle'      // AskUserQuestion, ask skill
  | 'rocket'           // remote trigger, deploy, devflow skill
  | 'bar-chart'        // SEO reporter
  | 'tag'              // labels, meta-tags skill
  | 'pen-tool'         // humanizer, content skills
  | 'home'             // Rightmove
  | 'smartphone'       // Android, OnePlus, adapt
  | 'keyboard'         // keybindings
  | 'graduation-cap'   // teach-impeccable
  | 'wrench';          // generic fallback

export type ToneName =
  | 'neutral'   // read-only, no side effects, safe to repeat
  | 'mutate'    // writes to local disk or local process state
  | 'external'  // calls outside the machine (APIs, web, OAuth, sub-agents)
  | 'danger';   // destructive or hard-to-reverse (delete, send, force, drop)

export interface InterpretedOutcome {
  /** !tool_result.is_error */
  ok: boolean;
  /** One-line summary: "✓ 80 lines" / "✗ ENOENT" / "✓ 3 matches". */
  summary: string;
  /** Optional numeric stat the UI can show as a chip. */
  count?: number;
  countLabel?: 'lines' | 'matches' | 'files' | 'bytes' | 'items';
}

export interface InterpretedAction {
  icon: IconName;
  /** Short verb: "Read", "GitHub PR create", "RAG search". */
  verb: string;
  /** Bold subject — filename, search term, URL. Path-stripped. May be ''. */
  subject: string;
  /** Muted detail after subject — line range, scope, flags. May be ''. */
  detail: string;
  /** Filled when paired tool_result is known. Null while pending. */
  outcome: InterpretedOutcome | null;
  tone: ToneName;
  /** Source tool name verbatim. '' for orphan results. */
  toolName: string;
  /** Carry-through of tool_use_id for re-opening raw JSON. */
  toolUseId: string;
}

/** Per-tool exact handler. Builds the action shell — outcome filled later. */
export type Handler = (
  input: Record<string, unknown>,
  item: StreamItem,
) => InterpretedAction;

/** MCP family handler — receives the action segment after the prefix split. */
export type FamilyHandler = (
  action: string,
  input: Record<string, unknown>,
  item: StreamItem,
) => InterpretedAction;

export type DispatchTier = 'exact' | 'family' | 'bash' | 'fallback';

export type { StreamItem };
