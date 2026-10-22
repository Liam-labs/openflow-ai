/**
 * Post-execution skill synthesis trigger — Hermes Sprint T3.
 *
 * Inspects a session transcript (JSONL) at session end and decides whether
 * the agent should be prompted to synthesize a reusable skill from its
 * trajectory. Three trigger conditions (any one is sufficient):
 *
 *   1. ≥ 5 tool calls in the session
 *   2. Workaround pattern: tool error → retry (same tool) → success
 *   3. Complex pipeline: 3+ consecutive tool calls in a single turn
 *
 * Called by synthesis-check.ts (via flush.sh synthesis_gate) at session end.
 * The suggestion is injected at next session start via session-scratch-init.sh.
 */

import * as fs from 'fs';

// ─── Types ──────────────────────────────────────────────────────────

export interface SynthesisResult {
  /** Whether synthesis should be suggested to the agent. */
  triggered: boolean;
  /** Which trigger condition(s) fired. Empty if not triggered. */
  reasons: TriggerReason[];
  /** Total tool_use events counted in the session. */
  toolCount: number;
  /** Number of tool_result events with is_error=true. */
  errorCount: number;
  /** The suggestion text to inject, or null if not triggered. */
  suggestion: string | null;
}

export type TriggerReason =
  | 'tool_count'
  | 'workaround'
  | 'complex_pipeline';

export interface ParsedToolCall {
  name: string;
  id: string;
  index: number; // position in the tool-call sequence (0-based)
}

export interface ParsedToolResult {
  toolUseId: string;
  isError: boolean;
  content: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const TOOL_COUNT_THRESHOLD = 5;
const WORKAROUND_WINDOW = 10; // look this many tool calls ahead for retry+success
const PIPELINE_MIN_CONSECUTIVE = 3;
const TOOLS_THAT_COUNT = new Set([
  'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob',
  'WebSearch', 'WebFetch', 'Agent', 'TaskCreate',
]);

// ─── Main entry ─────────────────────────────────────────────────────

export function analyzeTranscript(transcriptPath: string): SynthesisResult {
  const lines = readTranscriptLines(transcriptPath);
  const toolCalls = extractToolCalls(lines);
  const results = extractResults(lines);

  const toolCount = toolCalls.length;
  const errorCount = results.filter(r => r.isError).length;
  const reasons: TriggerReason[] = [];

  // Trigger 1: tool count threshold
  if (toolCount >= TOOL_COUNT_THRESHOLD) {
    reasons.push('tool_count');
  }

  // Trigger 2: workaround pattern (error → retry → success)
  if (detectWorkaround(toolCalls, results)) {
    reasons.push('workaround');
  }

  // Trigger 3: complex pipeline (3+ consecutive tool calls in same turn)
  if (detectComplexPipeline(lines, toolCalls)) {
    reasons.push('complex_pipeline');
  }

  const triggered = reasons.length > 0;

  return {
    triggered,
    reasons,
    toolCount,
    errorCount,
    suggestion: triggered ? buildSuggestion(toolCount, reasons) : null,
  };
}

// ─── Parsing ────────────────────────────────────────────────────────

function readTranscriptLines(path: string): unknown[] {
  const raw = fs.readFileSync(path, 'utf-8');
  const lines: unknown[] = [];
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return lines;
}

interface TranscriptEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

interface ToolUseContent {
  type: 'tool_use';
  name: string;
  id: string;
  input?: unknown;
}

interface ToolResultContent {
  type: 'tool_result';
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
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
      const b = block as ToolUseContent;
      if (b.type === 'tool_use' && TOOLS_THAT_COUNT.has(b.name)) {
        calls.push({ name: b.name, id: b.id, index: calls.length });
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
      const b = block as ToolResultContent;
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

// ─── Pattern detectors ───────────────────────────────────────────────

function detectWorkaround(
  calls: ParsedToolCall[],
  results: ParsedToolResult[],
): boolean {
  if (results.length === 0 || calls.length === 0) return false;

  // Build a map: tool_use_id → ParsedToolResult for quick lookup
  const resultMap = new Map<string, ParsedToolResult>();
  for (const r of results) {
    resultMap.set(r.toolUseId, r);
  }

  // Find all error results
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const result = resultMap.get(call.id);
    if (!result || !result.isError) continue;

    // This call errored. Look ahead within WORKAROUND_WINDOW for a
    // re-attempt of the same tool that succeeded.
    const windowEnd = Math.min(i + WORKAROUND_WINDOW, calls.length);
    for (let j = i + 1; j < windowEnd; j++) {
      const laterCall = calls[j];
      if (laterCall.name !== call.name) continue;
      const laterResult = resultMap.get(laterCall.id);
      if (laterResult && !laterResult.isError) {
        return true; // error → retry same tool → success
      }
    }
  }

  return false;
}

function detectComplexPipeline(
  lines: unknown[],
  calls: ParsedToolCall[],
): boolean {
  // Group tool calls by turn (assistant message). Each assistant message
  // that contains tool_use blocks is one "turn". Count max consecutive
  // tool_use blocks across all assistant messages.

  let maxConsecutive = 0;
  let currentRun = 0;

  // Track tool presence per assistant message via a simple scan
  for (const raw of lines) {
    const entry = raw as TranscriptEntry;
    if (entry.type !== 'assistant') {
      // Non-assistant line breaks the run
      continue;
    }

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    const toolBlocks = content.filter(
      (b): b is ToolUseContent =>
        !!b && typeof b === 'object' && (b as ToolUseContent).type === 'tool_use' && TOOLS_THAT_COUNT.has((b as ToolUseContent).name),
    );

    if (toolBlocks.length > 0) {
      currentRun += toolBlocks.length;
      maxConsecutive = Math.max(maxConsecutive, currentRun);
    } else {
      // Check if this assistant message has thinking/text — still counts as
      // part of a run if it's between tool blocks. Only reset on user messages.
    }

    // Reset on non-tool turns — but we only want to count consecutive
    // tool_use blocks. Simply track the max in any one assistant message.
    if (toolBlocks.length >= PIPELINE_MIN_CONSECUTIVE) {
      return true;
    }
  }

  return false;
}

// ─── Suggestion builder ──────────────────────────────────────────────

function buildSuggestion(toolCount: number, reasons: TriggerReason[]): string {
  const reasonText = reasons.map(r => {
    switch (r) {
      case 'tool_count': return 'used 5+ tool calls';
      case 'workaround': return 'encountered and resolved errors through retries';
      case 'complex_pipeline': return 'executed a multi-step command pipeline';
    }
  }).join(', ');

  return [
    `This session ${reasonText} and represents a repeatable workflow.`,
    `Consider creating a skill: run /skills-skill to document the procedure.`,
    `Skip this suggestion if the work was exploratory or one-off.`,
  ].join(' ');
}
