import { describe, it, expect } from 'vitest';
import {
  flattenEntry,
  filterForSummary,
  buildToolUseIndex,
  formatTimestamp,
  summarizeToolInput,
  normalizeToolResult,
  appendUniqueItems,
} from '@/components/collab/agent-stream/helpers';
import type { RawMessageEntry } from '@/components/collab/agent-stream/types';

describe('flattenEntry', () => {
  it('returns [] for null/undefined/non-object input', () => {
    expect(flattenEntry(null as unknown as RawMessageEntry)).toEqual([]);
    expect(flattenEntry(undefined as unknown as RawMessageEntry)).toEqual([]);
  });

  it('flattens user entry with string content into a single text item', () => {
    const entry: RawMessageEntry = {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-04-11T12:00:00.000Z',
      message: { content: 'hello there' },
    };
    const out = flattenEntry(entry);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'u1:0',
      kind: 'text',
      role: 'user',
      timestamp: '2026-04-11T12:00:00.000Z',
      text: 'hello there',
    });
  });

  it('skips empty string content', () => {
    const entry: RawMessageEntry = {
      type: 'user',
      uuid: 'u2',
      message: { content: '' },
    };
    expect(flattenEntry(entry)).toEqual([]);
  });

  it('flattens assistant entry with text + thinking + tool_use blocks in order', () => {
    const entry: RawMessageEntry = {
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-04-11T12:01:00.000Z',
      message: {
        content: [
          { type: 'thinking', thinking: 'let me plan' },
          { type: 'text', text: 'Here we go' },
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
          },
        ],
      },
    };
    const out = flattenEntry(entry);
    expect(out.map((i) => i.kind)).toEqual(['thinking', 'text', 'tool_use']);
    expect(out[0].text).toBe('let me plan');
    expect(out[1].text).toBe('Here we go');
    expect(out[2].toolName).toBe('Read');
    expect(out[2].toolInput).toEqual({ file_path: '/tmp/a.txt' });
    expect(out[2].toolUseId).toBe('toolu_01');
    expect(out[0].id).toBe('a1:0');
    expect(out[2].id).toBe('a1:2');
  });

  it('flattens user entry with tool_result block (string content)', () => {
    const entry: RawMessageEntry = {
      type: 'user',
      uuid: 'u3',
      timestamp: '2026-04-11T12:02:00.000Z',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: 'file contents here',
          },
        ],
      },
    };
    const out = flattenEntry(entry);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'tool_result',
      role: 'user',
      toolUseId: 'toolu_01',
      toolResultText: 'file contents here',
      toolResultIsError: false,
    });
  });

  it('flattens tool_result with array content (text + image)', () => {
    const entry: RawMessageEntry = {
      type: 'user',
      uuid: 'u4',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_02',
            content: [
              { type: 'text', text: 'line1' },
              { type: 'image' },
              { type: 'text', text: 'line2' },
            ],
          },
        ],
      },
    };
    const out = flattenEntry(entry);
    expect(out[0].toolResultText).toBe('line1\n[image]\nline2');
  });

  it('carries is_error flag on tool_result', () => {
    const entry: RawMessageEntry = {
      type: 'user',
      uuid: 'u5',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_03',
            content: 'boom',
            is_error: true,
          },
        ],
      },
    };
    const out = flattenEntry(entry);
    expect(out[0].toolResultIsError).toBe(true);
  });

  it('extracts summary entries', () => {
    const entry: RawMessageEntry = {
      type: 'summary',
      uuid: 's1',
      summary: 'Session summary text',
    };
    const out = flattenEntry(entry);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'summary',
      role: 'summary',
      text: 'Session summary text',
    });
  });

  it('returns [] for malformed block types', () => {
    const entry: RawMessageEntry = {
      type: 'assistant',
      uuid: 'a2',
      message: {
        content: [
          { type: 'unknown_block' } as never,
          null as never,
          { type: 'text', text: '' } as never,
        ],
      },
    };
    expect(flattenEntry(entry)).toEqual([]);
  });

  it('generates stable fallback ids when uuid is missing', () => {
    const entry: RawMessageEntry = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hi' }],
      },
    };
    const [item] = flattenEntry(entry);
    const [replayedItem] = flattenEntry(entry);
    expect(item.id).toMatch(/^h[a-z0-9]+:0$/);
    expect(replayedItem.id).toBe(item.id);
  });
});

describe('appendUniqueItems', () => {
  it('drops replayed stream items while retaining new items in order', () => {
    const seen = new Set<string>();
    const first = [
      { id: 'call-1:0', kind: 'tool_use', role: 'assistant', timestamp: '' },
      { id: 'call-1-result:0', kind: 'tool_result', role: 'user', timestamp: '' },
    ] as never;
    const current = appendUniqueItems([], first, seen, 500);
    const replayAndNew = appendUniqueItems(
      current,
      [first[0], { id: 'call-2:0', kind: 'tool_use', role: 'assistant', timestamp: '' }] as never,
      seen,
      500,
    );

    expect(replayAndNew.map((item) => item.id)).toEqual([
      'call-1:0',
      'call-1-result:0',
      'call-2:0',
    ]);
  });

  it('bounds both retained items and dedupe identities', () => {
    const seen = new Set<string>();
    const result = appendUniqueItems(
      [],
      ['one', 'two', 'three'].map((id) => ({
        id,
        kind: 'text',
        role: 'assistant',
        timestamp: '',
        text: id,
      })) as never,
      seen,
      2,
    );

    expect(result.map((item) => item.id)).toEqual(['two', 'three']);
    expect([...seen]).toEqual(['two', 'three']);
  });
});

describe('filterForSummary', () => {
  it('strips thinking items and keeps everything else', () => {
    const items = [
      { id: '1', kind: 'thinking', role: 'assistant', timestamp: '', text: 'x' },
      { id: '2', kind: 'text', role: 'assistant', timestamp: '', text: 'y' },
      {
        id: '3',
        kind: 'tool_use',
        role: 'assistant',
        timestamp: '',
        toolName: 'Read',
        toolInput: {},
      },
      {
        id: '4',
        kind: 'tool_result',
        role: 'user',
        timestamp: '',
        toolResultText: 'z',
      },
    ] as const;
    const out = filterForSummary(items as never);
    expect(out.map((i) => i.id)).toEqual(['2', '3', '4']);
  });
});

describe('buildToolUseIndex', () => {
  it('maps tool_use_id → item', () => {
    const items = [
      {
        id: '1',
        kind: 'tool_use' as const,
        role: 'assistant' as const,
        timestamp: '',
        toolName: 'Read',
        toolUseId: 'toolu_A',
      },
      {
        id: '2',
        kind: 'tool_result' as const,
        role: 'user' as const,
        timestamp: '',
        toolUseId: 'toolu_A',
        toolResultText: 'ok',
      },
    ];
    const idx = buildToolUseIndex(items);
    expect(idx.size).toBe(1);
    expect(idx.get('toolu_A')?.toolName).toBe('Read');
  });
});

describe('formatTimestamp', () => {
  it('returns empty string for missing/invalid input', () => {
    expect(formatTimestamp(undefined)).toBe('');
    expect(formatTimestamp('')).toBe('');
    expect(formatTimestamp('not-a-date')).toBe('');
  });

  it('formats an ISO timestamp as HH:MM:SS', () => {
    const out = formatTimestamp('2026-04-11T12:34:56.000Z');
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe('summarizeToolInput', () => {
  it('picks file_path when present', () => {
    expect(summarizeToolInput({ file_path: '/tmp/x.ts', extra: 1 })).toBe(
      '/tmp/x.ts',
    );
  });

  it('picks command when present', () => {
    expect(summarizeToolInput({ command: 'ls -la' })).toBe('ls -la');
  });

  it('falls back to JSON for object-only inputs', () => {
    expect(summarizeToolInput({ limit: 10 })).toBe('{"limit":10}');
  });

  it('truncates long JSON fallbacks', () => {
    const bigObj = { data: 'x'.repeat(500) };
    const out = summarizeToolInput(bigObj);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty string for missing input', () => {
    expect(summarizeToolInput(undefined)).toBe('');
  });
});

describe('normalizeToolResult', () => {
  it('passes strings through', () => {
    expect(normalizeToolResult('raw output')).toBe('raw output');
  });

  it('joins text array blocks with newlines', () => {
    expect(
      normalizeToolResult([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });

  it('collapses image blocks to [image] marker', () => {
    expect(
      normalizeToolResult([{ type: 'image' }, { type: 'text', text: 'ok' }]),
    ).toBe('[image]\nok');
  });

  it('returns empty string for unrecognized shapes', () => {
    expect(normalizeToolResult(null)).toBe('');
    expect(normalizeToolResult(42)).toBe('');
  });
});
