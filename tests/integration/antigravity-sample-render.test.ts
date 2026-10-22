/**
 * Sprint A T3.1 — integration test against Builder's REAL decoded Antigravity
 * sample stream (data/antigravity-proto/sample-antigravity-stream.jsonl,
 * 341 RawMessageEntry lines from a real 234-step session).
 *
 * Validates the consumer path end-to-end: raw JSONL → flattenEntry → StreamItem
 * → interpretStream → InterpretedAction[], asserting STRUCTURE (block kinds,
 * pairing-merge, handler icons/tones/verbs/subjects). Per Builder's caveat the
 * reasoning-block TEXT is placeholder-noisy until the cortex pool decode lands,
 * so we deliberately do NOT assert on CoT prose — only the locked shape.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { flattenEntry } from '@/components/collab/agent-stream/helpers';
import { interpretStream } from '@/lib/agent-stream-interpret';
import type { RawMessageEntry, StreamItem } from '@/components/collab/agent-stream/types';
import type { IconName, ToneName } from '@/lib/agent-stream-interpret/types';

const FIXTURE = path.join(
  process.cwd(),
  'data/antigravity-proto/sample-antigravity-stream.jsonl',
);

const VALID_ICONS = new Set<IconName>([
  'file-text', 'edit-3', 'search', 'folder-search', 'terminal', 'globe',
  'database', 'git-pull-request', 'git-branch', 'package', 'cloud', 'brain',
  'sparkles', 'mail', 'calendar', 'image', 'file-cog', 'clipboard-list', 'bell',
  'clock', 'plug', 'eye', 'map', 'settings', 'shield', 'beaker',
  'message-square', 'help-circle', 'rocket', 'bar-chart', 'tag', 'pen-tool',
  'home', 'smartphone', 'keyboard', 'graduation-cap', 'wrench',
]);
const VALID_TONES = new Set<ToneName>(['neutral', 'mutate', 'external', 'danger']);

function loadItems(): StreamItem[] {
  const raw = readFileSync(FIXTURE, 'utf8');
  const items: StreamItem[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    items.push(...flattenEntry(JSON.parse(trimmed) as RawMessageEntry));
  }
  return items;
}

describe('Antigravity sample stream — consumer path', () => {
  const items = loadItems();

  it('flattens all four block kinds (thinking/tool_use/tool_result/text)', () => {
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds.has('thinking')).toBe(true);
    expect(kinds.has('tool_use')).toBe(true);
    expect(kinds.has('tool_result')).toBe(true);
    expect(kinds.has('text')).toBe(true);
    expect(items.filter((i) => i.kind === 'tool_use').length).toBeGreaterThan(50);
  });

  it('interprets every tool_use with a valid icon + tone + non-empty verb', () => {
    const actions = interpretStream(items);
    let count = 0;
    let nonEmptySubjects = 0;
    items.forEach((it, idx) => {
      if (it.kind !== 'tool_use') return;
      const a = actions[idx];
      expect(a).not.toBeNull();
      expect(VALID_ICONS.has(a!.icon)).toBe(true);
      expect(VALID_TONES.has(a!.tone)).toBe(true);
      expect(a!.verb.length).toBeGreaterThan(0); // toolAction or prettified name
      if (a!.subject.length > 0) nonEmptySubjects++;
      count++;
    });
    expect(count).toBeGreaterThan(50);
    // These steps all carry toolSummary, so subjects should be populated.
    expect(nonEmptySubjects).toBeGreaterThan(count * 0.9);
  });

  it('merges every paired tool_result into its tool_use (SummaryView single rows)', () => {
    const actions = interpretStream(items);
    const useIds = new Set(
      items.filter((i) => i.kind === 'tool_use' && i.toolUseId).map((i) => i.toolUseId),
    );
    let pairedResults = 0;
    let toolUseWithOutcome = 0;
    items.forEach((it, idx) => {
      if (it.kind === 'tool_result' && it.toolUseId && useIds.has(it.toolUseId)) {
        // Paired result must be suppressed (merged), not rendered as its own row.
        expect(actions[idx]).toBeNull();
        pairedResults++;
      }
      if (it.kind === 'tool_use' && actions[idx]?.outcome) toolUseWithOutcome++;
    });
    expect(pairedResults).toBeGreaterThan(50);
    // Each merged result fills its tool_use row's outcome.
    expect(toolUseWithOutcome).toBe(pairedResults);
  });

  it('maps the real tool names to the expected category icons', () => {
    const actions = interpretStream(items);
    const iconByName: Partial<Record<string, IconName>> = {};
    items.forEach((it, idx) => {
      if (it.kind === 'tool_use' && it.toolName && actions[idx]) {
        iconByName[it.toolName] = actions[idx]!.icon;
      }
    });
    // Only assert names actually present in the fixture.
    const expected: Record<string, IconName> = {
      view_file: 'file-text',
      run_command: 'terminal',
      grep_search: 'search',
      list_directory: 'folder-search',
      code_action: 'edit-3',
    };
    for (const [name, icon] of Object.entries(expected)) {
      if (iconByName[name]) expect(iconByName[name]).toBe(icon);
    }
  });
});
