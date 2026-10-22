/**
 * Trajectory Capture — Hermes Sprint T4.
 *
 * Reads a session transcript (JSONL) and produces a pre-filled SKILL.md
 * template from the agent's tool-call trajectory. Supports the
 * /skills-skill --from-trajectory flag.
 *
 * Called by the skills-skill invocation path when --from-trajectory is
 * passed. The agent reviews and edits the pre-filled template before saving.
 */

import * as fs from 'fs';

// ─── Types ──────────────────────────────────────────────────────────

export interface TrajectoryCaptureOptions {
  /** Path to the session transcript JSONL file. */
  transcriptPath: string;
  /** Max tool calls to capture from the end of the session (default 10). */
  maxToolCalls?: number;
  /** Override the auto-derived skill name. */
  skillName?: string;
}

export interface TrajectoryCaptureResult {
  /** Derived (or overridden) kebab-case skill name. */
  skillName: string;
  /** Pre-filled SKILL.md markdown string ready for agent review. */
  template: string;
  /** Number of tool calls captured. */
  toolCount: number;
  /** Most-used tool in the trajectory. */
  dominantTool: string;
  /** Ordered list of tool names in the captured sequence. */
  toolSequence: string[];
}

interface ParsedToolCall {
  name: string;
  id: string;
  input: Record<string, unknown>;
}

interface ParsedToolResult {
  toolUseId: string;
  isError: boolean;
  content: string;
}

interface Prerequisite {
  label: string;
  value: string;
}

const DEFAULT_MAX_TOOL_CALLS = 10;

// ─── Main entry ─────────────────────────────────────────────────────

export function captureTrajectory(
  options: TrajectoryCaptureOptions,
): TrajectoryCaptureResult {
  const { transcriptPath, maxToolCalls = DEFAULT_MAX_TOOL_CALLS, skillName: overrideName } = options;

  const lines = readTranscriptLines(transcriptPath);
  const toolCalls = extractToolCalls(lines);
  const results = extractResults(lines);

  // Take the last N tool calls
  const recentCalls = toolCalls.slice(-maxToolCalls);

  // Determine dominant tool (most frequent in the captured window)
  const toolCounts = new Map<string, number>();
  for (const call of recentCalls) {
    toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1);
  }
  let dominantTool = 'Bash';
  let dominantCount = 0;
  for (const [name, count] of toolCounts) {
    if (count > dominantCount) {
      dominantTool = name;
      dominantCount = count;
    }
  }

  const skillName = overrideName ?? deriveSkillName(dominantTool, recentCalls);
  const prereqs = extractPrerequisites(recentCalls, lines);
  const template = buildTemplate(skillName, dominantTool, recentCalls, prereqs);

  return {
    skillName,
    template,
    toolCount: recentCalls.length,
    dominantTool,
    toolSequence: recentCalls.map(c => c.name),
  };
}

// ─── Parsing ────────────────────────────────────────────────────────

interface TranscriptEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

interface ToolUseBlock {
  type: string;
  name: string;
  id: string;
  input: Record<string, unknown>;
}

function readTranscriptLines(path: string): unknown[] {
  if (!fs.existsSync(path)) return [];
  const raw = fs.readFileSync(path, 'utf-8');
  const lines: unknown[] = [];
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return lines;
}

function extractToolCalls(lines: unknown[]): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const raw of lines) {
    const entry = raw as TranscriptEntry;
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as ToolUseBlock;
      if (b.type === 'tool_use') {
        calls.push({ name: b.name, id: b.id, input: b.input ?? {} });
      }
    }
  }
  return calls;
}

function extractResults(lines: unknown[]): ParsedToolResult[] {
  const results: ParsedToolResult[] = [];
  for (const raw of lines) {
    const entry = raw as TranscriptEntry;
    if (entry.type !== 'user') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
      if (b.type === 'tool_result') {
        results.push({
          toolUseId: b.tool_use_id ?? '',
          isError: b.is_error === true,
          content: typeof b.content === 'string' ? b.content : '',
        });
      }
    }
  }
  return results;
}

// ─── Skill name derivation ──────────────────────────────────────────

const TOOL_TO_DOMAIN: Record<string, string> = {
  Bash: 'cli',
  Read: 'file-inspection',
  Edit: 'code-modification',
  Write: 'file-creation',
  Grep: 'code-search',
  Glob: 'file-discovery',
  WebSearch: 'web-research',
  WebFetch: 'content-extraction',
  Agent: 'sub-agent-delegation',
  TaskCreate: 'task-tracking',
};

function deriveSkillName(dominantTool: string, calls: ParsedToolCall[]): string {
  const domain = TOOL_TO_DOMAIN[dominantTool] ?? 'workflow';

  // If dominant tool is Bash, try to extract a more specific name from commands
  if (dominantTool === 'Bash') {
    const cmd = extractPrimaryCommand(calls);
    if (cmd) return `${cmd}-workflow`;
  }

  // If dominant tool is Edit/Write, derive from file extension
  if (dominantTool === 'Edit' || dominantTool === 'Write') {
    const ext = extractDominantExtension(calls);
    if (ext) return `${ext}-editing`;
  }

  return domain;
}

function extractPrimaryCommand(calls: ParsedToolCall[]): string | null {
  for (const call of calls) {
    if (call.name !== 'Bash') continue;
    const cmd = String(call.input.command ?? call.input.cmd ?? '');
    // Extract the first word (the binary name)
    const match = cmd.match(/^(\w+)/);
    if (match) {
      const bin = match[1].toLowerCase();
      // Skip common shells and generic wrappers
      if (['cd', 'ls', 'cat', 'echo', 'source', 'export', 'bash', 'sh', 'exec'].includes(bin)) continue;
      return bin;
    }
  }
  return null;
}

function extractDominantExtension(calls: ParsedToolCall[]): string | null {
  const exts = new Map<string, number>();
  for (const call of calls) {
    if (call.name !== 'Edit' && call.name !== 'Write' && call.name !== 'Read') continue;
    const path = String(call.input.file_path ?? call.input.path ?? '');
    const match = path.match(/\.(\w+)$/);
    if (match) {
      const ext = match[1].toLowerCase();
      exts.set(ext, (exts.get(ext) ?? 0) + 1);
    }
  }
  if (exts.size === 0) return null;
  return [...exts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ─── Prerequisite extraction ────────────────────────────────────────

function extractPrerequisites(calls: ParsedToolCall[], lines: unknown[]): Prerequisite[] {
  const prereqs: Prerequisite[] = [];

  // Collect unique file paths from Read/Edit/Write/Grep/Glob calls
  const paths = new Set<string>();
  for (const call of calls) {
    const path = String(call.input.file_path ?? call.input.path ?? call.input.pattern ?? '');
    if (path && !path.startsWith('/tmp/')) {
      paths.add(path);
    }
  }
  if (paths.size > 0) {
    prereqs.push({ label: 'Files', value: [...paths].slice(0, 5).join(', ') });
  }

  // Detect working directory from first Bash call with cd
  for (const call of calls) {
    if (call.name !== 'Bash') continue;
    const cmd = String(call.input.command ?? '');
    const cdMatch = cmd.match(/cd\s+(\S+)/);
    if (cdMatch) {
      prereqs.push({ label: 'Working directory', value: cdMatch[1] });
      break;
    }
  }

  // Detect NPM/node tooling
  for (const call of calls) {
    if (call.name !== 'Bash') continue;
    const cmd = String(call.input.command ?? '');
    if (cmd.includes('tsx ') || cmd.includes('tsc ')) {
      prereqs.push({ label: 'Runtime', value: 'Node.js + TypeScript (tsx)' });
      break;
    }
    if (cmd.includes('npx ') || cmd.includes('npm ')) {
      prereqs.push({ label: 'Runtime', value: 'Node.js + npm' });
      break;
    }
    if (cmd.includes('python3 ') || cmd.includes('python ')) {
      prereqs.push({ label: 'Runtime', value: 'Python 3' });
      break;
    }
  }

  // Detect env vars referenced
  const envVars = new Set<string>();
  for (const call of calls) {
    if (call.name !== 'Bash') continue;
    const cmd = String(call.input.command ?? '');
    const matches = cmd.matchAll(/\$([A-Z_][A-Z0-9_]*)/g);
    for (const m of matches) {
      if (!['PATH', 'HOME', 'USER', 'PWD', 'SHELL', 'PPID'].includes(m[1])) {
        envVars.add(m[1]);
      }
    }
  }
  if (envVars.size > 0) {
    prereqs.push({ label: 'Environment variables', value: [...envVars].join(', ') });
  }

  return prereqs;
}

// ─── Template builder ───────────────────────────────────────────────

function buildTemplate(
  skillName: string,
  dominantTool: string,
  calls: ParsedToolCall[],
  prereqs: Prerequisite[],
): string {
  const title = skillNameToTitle(skillName);
  const description = buildDescription(dominantTool, calls);
  const steps = buildSteps(calls);
  const prereqSection = buildPrereqSection(prereqs);

  return [
    '---',
    `name: ${skillName}`,
    `description: >`,
    `  ${description}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## Instructions',
    '',
    ...steps,
    '',
    prereqSection,
    '',
    '## Examples',
    '',
    '<!-- Fill in 2-3 concrete examples of when to use this skill -->',
    '',
    '### Example 1: [Scenario]',
    '',
    '**Trigger:** [what the user says]',
    '',
    '**Result:** [what the skill produces]',
    '',
    '### Example 2: [Scenario]',
    '',
    '**Trigger:** [what the user says]',
    '',
    '**Result:** [what the skill produces]',
    '',
    '## Troubleshooting',
    '',
    '<!-- Fill in common failure modes and fixes -->',
    '',
    '### [Error Symptom]',
    '',
    '**Cause:** [why it happens]',
    '',
    '**Fix:** [how to resolve]',
    '',
  ].join('\n');
}

function skillNameToTitle(name: string): string {
  return name
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function buildDescription(dominantTool: string, calls: ParsedToolCall[]): string {
  const toolNames = [...new Set(calls.map(c => c.name))];
  const toolList = toolNames.slice(0, 5).join(', ');
  return [
    `Auto-generated from session trajectory. ${dominantTool}-based workflow using: ${toolList}.`,
    `Use when performing similar multi-step operations. Review and customize before deploying.`,
  ].join(' ');
}

function buildSteps(calls: ParsedToolCall[]): string[] {
  if (calls.length === 0) {
    return ['### Step 1: [Describe first action]', '', '<!-- No tool calls captured — fill in manually -->'];
  }

  const steps: string[] = [];
  let stepNum = 1;

  // Group consecutive calls of the same tool
  let i = 0;
  while (i < calls.length) {
    const call = calls[i];
    const action = toolCallToAction(call);

    // Peek ahead: if next call is same tool, merge into one step
    let mergedCount = 1;
    while (i + mergedCount < calls.length && calls[i + mergedCount].name === call.name) {
      mergedCount++;
    }

    if (mergedCount > 1) {
      steps.push(`### Step ${stepNum}: ${action} (×${mergedCount})`);
    } else {
      steps.push(`### Step ${stepNum}: ${action}`);
    }
    steps.push('');

    // Add concrete detail from the first call in the group
    const detail = toolCallToDetail(call);
    if (detail) {
      steps.push(detail);
      steps.push('');
    }

    i += mergedCount;
    stepNum++;
  }

  return steps;
}

function toolCallToAction(call: ParsedToolCall): string {
  switch (call.name) {
    case 'Bash': return 'Run command';
    case 'Read': return 'Read file';
    case 'Edit': return 'Edit file';
    case 'Write': return 'Write file';
    case 'Grep': return 'Search codebase';
    case 'Glob': return 'Find files';
    case 'WebSearch': return 'Search the web';
    case 'WebFetch': return 'Fetch web content';
    case 'Agent': return 'Delegate to sub-agent';
    case 'TaskCreate': return 'Create task';
    default: return `Run ${call.name}`;
  }
}

function toolCallToDetail(call: ParsedToolCall): string | null {
  switch (call.name) {
    case 'Bash': {
      const cmd = String(call.input.command ?? '');
      if (cmd.length > 100) return `\`${cmd.slice(0, 100)}...\``;
      return `\`${cmd}\``;
    }
    case 'Read':
    case 'Edit':
    case 'Write': {
      const path = String(call.input.file_path ?? '');
      if (path) return `Target: \`${path}\``;
      return null;
    }
    case 'Grep':
    case 'Glob': {
      const pattern = String(call.input.pattern ?? call.input.path ?? '');
      if (pattern) return `Pattern: \`${pattern}\``;
      return null;
    }
    case 'WebSearch': {
      const query = String(call.input.query ?? '');
      if (query && query.length <= 200) return `Query: "${query}"`;
      return null;
    }
    case 'WebFetch': {
      const url = String(call.input.url ?? '');
      if (url) return `URL: \`${url}\``;
      return null;
    }
    case 'Agent': {
      const desc = String(call.input.description ?? '');
      if (desc) return `Task: "${desc}"`;
      return null;
    }
    default: return null;
  }
}

function buildPrereqSection(prereqs: Prerequisite[]): string {
  if (prereqs.length === 0) {
    return [
      '## Environmental Prerequisites',
      '',
      '<!-- Fill in: required tools, files, env vars, or services -->',
    ].join('\n');
  }

  const lines = ['## Environmental Prerequisites', ''];
  for (const p of prereqs) {
    lines.push(`- **${p.label}:** ${p.value}`);
  }
  return lines.join('\n');
}
