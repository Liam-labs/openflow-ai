/**
 * Sprint 39 T4.1 — Full pipeline integration test for granular agent status.
 *
 * Tests the complete chain:
 *   JSONL tool_use → jsonl_state_reader → tool_to_label → heartbeat payload
 *   → handleHeartbeat → participant store → SSE collab:typing → resolveActivityLabel
 *
 * Verifies labels at each stage + backward compat (no activityDetail → "Working...").
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { handleHeartbeat } from '@/app/api/collab/_handlers/settings';
import { resolveActivityLabel } from '@/lib/activity-label';
import { eventBus } from '@/lib/event-bus';
import type { CollabChannelsData, CollabParticipant } from '@/lib/types';

// Mock writeData
vi.mock('@/app/api/collab/_collab-shared', () => ({
  writeData: vi.fn().mockResolvedValue(undefined),
  invalidateUnreadCache: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParticipant(overrides: Partial<CollabParticipant> = {}): CollabParticipant {
  return {
    id: 'p-pipeline',
    type: 'claude-terminal',
    name: 'PipelineAgent',
    source: 'WSL',
    joinedAt: '2026-04-12T10:00:00Z',
    lastSeen: '2026-04-12T10:00:00Z',
    ...overrides,
  };
}

function makeData(participants: CollabParticipant[] = [makeParticipant()]): CollabChannelsData {
  return {
    channels: [{
      id: 'ch-pipeline',
      name: 'Pipeline Test',
      participants,
      lastActivity: '2026-04-12T10:00:00Z',
      createdAt: '2026-04-12T10:00:00Z',
    }],
  } as CollabChannelsData;
}

/** Build a JSONL assistant entry with a tool_use content block. */
function buildToolUseJsonl(toolName: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Let me read that file.' },
        { type: 'tool_use', id: 'toolu_test', name: toolName, input: { file_path: '/tmp/test.ts' } },
      ],
    },
  });
}

/** Build a JSONL assistant entry with end_turn (idle). */
function buildEndTurnJsonl(): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_test2',
      type: 'message',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: 'Done.' },
      ],
    },
  });
}

/** Call Python jsonl_state_reader.check_jsonl_state + tool_to_label via subprocess. */
function callPythonReader(jsonlPath: string): { stopReason: string | null; lastToolName: string | null; label: string | null } {
  const script = `
import sys, json
sys.path.insert(0, '${path.join(process.cwd(), 'scripts')}')
from jsonl_state_reader import check_jsonl_state, tool_to_label
result = check_jsonl_state('${jsonlPath}')
if result is None:
    print(json.dumps({"stopReason": None, "lastToolName": None, "label": None}))
else:
    label = tool_to_label(result.last_tool_name)
    print(json.dumps({"stopReason": result.stop_reason, "lastToolName": result.last_tool_name, "label": label}))
`;
  const output = execFileSync('python3', ['-c', script], { encoding: 'utf-8' }).trim();
  return JSON.parse(output);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sprint 39: Full pipeline — JSONL → reader → heartbeat → SSE → label', () => {
  let tmpDir: string;
  let emittedEvents: Array<{ type: string; payload: Record<string, unknown> }>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sprint39-pipeline-'));
    emittedEvents = [];
    eventBus.emitEvent = vi.fn<typeof eventBus.emitEvent>((type, payload) => {
      emittedEvents.push({ type, payload: payload as Record<string, unknown> });
      return { id: 'test', type, data: payload, timestamp: new Date().toISOString() };
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Stage 1: Python JSONL reader → tool name → label
  // ---------------------------------------------------------------------------

  describe('Stage 1: JSONL reader → tool name → label', () => {
    const toolCases: Array<[string, string]> = [
      ['Read', 'Reading file...'],
      ['Edit', 'Editing file...'],
      ['Bash', 'Running command...'],
      ['Write', 'Writing file...'],
      ['Grep', 'Searching...'],
      ['Glob', 'Searching...'],
      ['Agent', 'Delegating...'],
    ];

    it.each(toolCases)('tool_use with %s → label "%s"', (toolName, expectedLabel) => {
      const jsonlPath = path.join(tmpDir, `${toolName.toLowerCase()}.jsonl`);
      writeFileSync(jsonlPath, buildToolUseJsonl(toolName) + '\n');

      const result = callPythonReader(jsonlPath);
      expect(result.stopReason).toBe('tool_use');
      expect(result.lastToolName).toBe(toolName);
      expect(result.label).toBe(expectedLabel);
    });

    it('end_turn → no tool name, no label', () => {
      const jsonlPath = path.join(tmpDir, 'endturn.jsonl');
      writeFileSync(jsonlPath, buildEndTurnJsonl() + '\n');

      const result = callPythonReader(jsonlPath);
      expect(result.stopReason).toBe('end_turn');
      expect(result.lastToolName).toBeNull();
      expect(result.label).toBeNull();
    });

    it('empty file → null result', () => {
      const jsonlPath = path.join(tmpDir, 'empty.jsonl');
      writeFileSync(jsonlPath, '');

      const result = callPythonReader(jsonlPath);
      expect(result.stopReason).toBeNull();
    });

    it('unknown tool name → null label (falls through to Thinking...)', () => {
      const jsonlPath = path.join(tmpDir, 'unknown.jsonl');
      writeFileSync(jsonlPath, buildToolUseJsonl('SomeUnknownTool') + '\n');

      const result = callPythonReader(jsonlPath);
      expect(result.stopReason).toBe('tool_use');
      expect(result.lastToolName).toBe('SomeUnknownTool');
      expect(result.label).toBeNull(); // Unknown → null → wrapper falls back to "Thinking..."
    });

    it('multiple entries → reads the LAST assistant entry', () => {
      const jsonlPath = path.join(tmpDir, 'multi.jsonl');
      writeFileSync(jsonlPath, [
        buildToolUseJsonl('Read'),
        buildToolUseJsonl('Edit'),
      ].join('\n') + '\n');

      const result = callPythonReader(jsonlPath);
      expect(result.lastToolName).toBe('Edit'); // Last entry wins
      expect(result.label).toBe('Editing file...');
    });
  });

  // ---------------------------------------------------------------------------
  // Stage 2: handleHeartbeat → participant store → SSE event
  // ---------------------------------------------------------------------------

  describe('Stage 2: handleHeartbeat → SSE collab:typing', () => {
    it('activityDetail stored on participant and emitted in SSE', async () => {
      const data = makeData();
      await handleHeartbeat(data, {
        action: 'heartbeat',
        channelId: 'ch-pipeline',
        participantId: 'p-pipeline',
        activityStatus: 'working',
        activityDetail: 'Reading file...',
      }, '2026-04-12T10:01:00Z');

      // Participant store
      expect(data.channels[0].participants[0].activityDetail).toBe('Reading file...');

      // SSE event
      expect(emittedEvents).toHaveLength(1);
      const payload = emittedEvents[0].payload;
      expect(payload.activityDetail).toBe('Reading file...');
      expect(payload.activityStatus).toBe('working');
    });

    it('null activityDetail when not provided (backward compat)', async () => {
      const data = makeData();
      await handleHeartbeat(data, {
        action: 'heartbeat',
        channelId: 'ch-pipeline',
        participantId: 'p-pipeline',
        activityStatus: 'working',
        // No activityDetail — old wrapper
      }, '2026-04-12T10:01:00Z');

      expect(data.channels[0].participants[0].activityDetail).toBeNull();
      expect(emittedEvents[0].payload.activityDetail).toBeNull();
    });

    it('activityDetail cleared on idle', async () => {
      const participant = makeParticipant({ activityDetail: 'Editing file...' });
      const data = makeData([participant]);

      await handleHeartbeat(data, {
        action: 'heartbeat',
        channelId: 'ch-pipeline',
        participantId: 'p-pipeline',
        activityStatus: 'idle',
      }, '2026-04-12T10:02:00Z');

      expect(data.channels[0].participants[0].activityDetail).toBeNull();
    });

    it('activityDetail updates across heartbeats', async () => {
      const data = makeData();

      // Read
      await handleHeartbeat(data, {
        action: 'heartbeat',
        channelId: 'ch-pipeline',
        participantId: 'p-pipeline',
        activityStatus: 'working',
        activityDetail: 'Reading file...',
      }, '2026-04-12T10:01:00Z');
      expect(data.channels[0].participants[0].activityDetail).toBe('Reading file...');

      // Edit
      await handleHeartbeat(data, {
        action: 'heartbeat',
        channelId: 'ch-pipeline',
        participantId: 'p-pipeline',
        activityStatus: 'working',
        activityDetail: 'Editing file...',
      }, '2026-04-12T10:01:05Z');
      expect(data.channels[0].participants[0].activityDetail).toBe('Editing file...');
      expect(emittedEvents[1].payload.activityDetail).toBe('Editing file...');
    });
  });

  // ---------------------------------------------------------------------------
  // Stage 3: resolveActivityLabel (frontend label resolution)
  // ---------------------------------------------------------------------------

  describe('Stage 3: resolveActivityLabel', () => {
    it('returns activityDetail when agent is working', () => {
      expect(resolveActivityLabel('Reading file...', true)).toBe('Reading file...');
      expect(resolveActivityLabel('Thinking...', true)).toBe('Thinking...');
      expect(resolveActivityLabel('Delegating...', true)).toBe('Delegating...');
    });

    it('returns "Working..." when activityDetail is null and working', () => {
      expect(resolveActivityLabel(null, true)).toBe('Working...');
      expect(resolveActivityLabel(undefined, true)).toBe('Working...');
    });

    it('returns null when not working', () => {
      expect(resolveActivityLabel('Reading file...', false)).toBeNull();
      expect(resolveActivityLabel(null, false)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Full pipeline: JSONL → reader → heartbeat → SSE → label
  // ---------------------------------------------------------------------------

  describe('Full pipeline round-trip', () => {
    it('Read tool: JSONL → "Reading file..." at every stage', async () => {
      // Stage 1: Python reader
      const jsonlPath = path.join(tmpDir, 'read-pipeline.jsonl');
      writeFileSync(jsonlPath, buildToolUseJsonl('Read') + '\n');
      const pyResult = callPythonReader(jsonlPath);
      expect(pyResult.label).toBe('Reading file...');

      // Stage 2: handleHeartbeat with the label
      const data = makeData();
      await handleHeartbeat(data, {
        action: 'heartbeat',
        channelId: 'ch-pipeline',
        participantId: 'p-pipeline',
        activityStatus: 'working',
        activityDetail: pyResult.label!,
      }, '2026-04-12T10:01:00Z');

      expect(data.channels[0].participants[0].activityDetail).toBe('Reading file...');
      expect(emittedEvents[0].payload.activityDetail).toBe('Reading file...');

      // Stage 3: Frontend label resolution
      const label = resolveActivityLabel(
        emittedEvents[0].payload.activityDetail as string,
        true
      );
      expect(label).toBe('Reading file...');
    });

    it('backward compat: old wrapper without activityDetail → "Working..."', async () => {
      // Stage 2: heartbeat without activityDetail
      const data = makeData();
      await handleHeartbeat(data, {
        action: 'heartbeat',
        channelId: 'ch-pipeline',
        participantId: 'p-pipeline',
        activityStatus: 'working',
      }, '2026-04-12T10:01:00Z');

      expect(emittedEvents[0].payload.activityDetail).toBeNull();

      // Stage 3: Frontend falls back to "Working..."
      const label = resolveActivityLabel(
        emittedEvents[0].payload.activityDetail as string | null,
        true
      );
      expect(label).toBe('Working...');
    });

    it('Bash tool: JSONL → "Running command..." end-to-end', async () => {
      const jsonlPath = path.join(tmpDir, 'bash-pipeline.jsonl');
      writeFileSync(jsonlPath, buildToolUseJsonl('Bash') + '\n');
      const pyResult = callPythonReader(jsonlPath);
      expect(pyResult.label).toBe('Running command...');

      const data = makeData();
      await handleHeartbeat(data, {
        action: 'heartbeat',
        channelId: 'ch-pipeline',
        participantId: 'p-pipeline',
        activityStatus: 'working',
        activityDetail: pyResult.label!,
      }, '2026-04-12T10:01:00Z');

      const label = resolveActivityLabel(
        emittedEvents[0].payload.activityDetail as string,
        true
      );
      expect(label).toBe('Running command...');
    });

    it('idle transition clears detail end-to-end', async () => {
      const participant = makeParticipant({ activityDetail: 'Editing file...' });
      const data = makeData([participant]);

      // JSONL shows end_turn
      const jsonlPath = path.join(tmpDir, 'idle-pipeline.jsonl');
      writeFileSync(jsonlPath, buildEndTurnJsonl() + '\n');
      const pyResult = callPythonReader(jsonlPath);
      expect(pyResult.label).toBeNull();

      // Heartbeat with idle status
      await handleHeartbeat(data, {
        action: 'heartbeat',
        channelId: 'ch-pipeline',
        participantId: 'p-pipeline',
        activityStatus: 'idle',
      }, '2026-04-12T10:02:00Z');

      expect(data.channels[0].participants[0].activityDetail).toBeNull();

      // Frontend shows nothing (not working)
      const label = resolveActivityLabel(null, false);
      expect(label).toBeNull();
    });
  });
});
