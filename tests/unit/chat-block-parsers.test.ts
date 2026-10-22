/**
 * Unit tests for chat-block parser helpers.
 * Written TDD — RED first, then lib/chat-block-parsers.ts implemented.
 */

import { describe, it, expect } from 'vitest';
import { parseProgressSpec, parseChartSpec } from '@/lib/chat-block-parsers';

// ─── parseProgressSpec ────────────────────────────────────────────────────────

describe('parseProgressSpec', () => {
  it('parses a valid spec', () => {
    const result = parseProgressSpec('{"value": 75, "label": "Build progress"}');
    expect(result).not.toBeNull();
    expect(result!.value).toBe(75);
    expect(result!.label).toBe('Build progress');
  });

  it('includes color when provided', () => {
    const result = parseProgressSpec('{"value": 50, "label": "CPU", "color": "#3b82f6"}');
    expect(result!.color).toBe('#3b82f6');
  });

  it('clamps value below 0 to 0', () => {
    const result = parseProgressSpec('{"value": -10, "label": "x"}');
    expect(result!.value).toBe(0);
  });

  it('clamps value above 100 to 100', () => {
    const result = parseProgressSpec('{"value": 120, "label": "x"}');
    expect(result!.value).toBe(100);
  });

  it('returns null for invalid JSON', () => {
    expect(parseProgressSpec('not json')).toBeNull();
  });

  it('returns null when value is missing', () => {
    expect(parseProgressSpec('{"label": "x"}')).toBeNull();
  });

  it('returns null when value is not a number', () => {
    expect(parseProgressSpec('{"value": "75", "label": "x"}')).toBeNull();
  });

  it('returns null when label is missing', () => {
    expect(parseProgressSpec('{"value": 50}')).toBeNull();
  });

  it('returns null when label is not a string', () => {
    expect(parseProgressSpec('{"value": 50, "label": 42}')).toBeNull();
  });

  it('ignores non-string color (returns spec without color)', () => {
    const result = parseProgressSpec('{"value": 50, "label": "x", "color": 123}');
    expect(result).not.toBeNull();
    expect(result!.color).toBeUndefined();
  });
});

// ─── parseChartSpec ───────────────────────────────────────────────────────────

describe('parseChartSpec', () => {
  const validBar = '{"type":"bar","data":[{"x":"A","y":1}],"xKey":"x","yKeys":["y"]}';
  const validLine = '{"type":"line","data":[{"t":1,"v":10}],"xKey":"t","yKeys":["v"]}';
  const validPie = '{"type":"pie","data":[{"name":"A","value":50}],"xKey":"name","yKeys":["value"]}';
  const validArea = '{"type":"area","data":[{"x":1,"y":2}],"xKey":"x","yKeys":["y"]}';

  it('parses a valid bar spec', () => {
    const result = parseChartSpec(validBar);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('bar');
    expect(result!.data).toHaveLength(1);
    expect(result!.xKey).toBe('x');
    expect(result!.yKeys).toEqual(['y']);
  });

  it('parses a valid line spec', () => {
    expect(parseChartSpec(validLine)!.type).toBe('line');
  });

  it('parses a valid pie spec', () => {
    expect(parseChartSpec(validPie)!.type).toBe('pie');
  });

  it('parses a valid area spec', () => {
    expect(parseChartSpec(validArea)!.type).toBe('area');
  });

  it('includes optional title and colors', () => {
    const spec = '{"type":"bar","data":[],"title":"My Chart","colors":["#ff0000"]}';
    const result = parseChartSpec(spec);
    expect(result!.title).toBe('My Chart');
    expect(result!.colors).toEqual(['#ff0000']);
  });

  it('returns null for invalid JSON', () => {
    expect(parseChartSpec('not json')).toBeNull();
  });

  it('returns null for unknown chart type', () => {
    expect(parseChartSpec('{"type":"unknown","data":[]}')).toBeNull();
  });

  it('returns null when data is not an array', () => {
    expect(parseChartSpec('{"type":"bar","data":"oops"}')).toBeNull();
  });

  it('returns null when type is missing', () => {
    expect(parseChartSpec('{"data":[]}')).toBeNull();
  });

  it('returns null when spec exceeds 10KB', () => {
    const huge = '{"type":"bar","data":[' + '{"x":1}'.repeat(1500) + ']}';
    expect(parseChartSpec(huge)).toBeNull();
  });
});
