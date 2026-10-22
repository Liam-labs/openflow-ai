/**
 * Pure parsing helpers for rich chat-block components.
 * No React, no browser APIs — fully testable in a node environment.
 */

// ─── ProgressBlock ─────────────────────────────────────────────────────────────

export interface ProgressSpec {
  value: number;
  label: string;
  color?: string;
}

/**
 * Parse a progress-block JSON spec.
 * Returns null for invalid JSON, missing required fields, or wrong types.
 * Clamps value to [0, 100].
 */
export function parseProgressSpec(raw: string): ProgressSpec | null {
  try {
    const parsed = JSON.parse(raw.trim());
    if (typeof parsed.value !== 'number') return null;
    if (typeof parsed.label !== 'string') return null;
    return {
      value: Math.max(0, Math.min(100, parsed.value)),
      label: parsed.label,
      color: typeof parsed.color === 'string' ? parsed.color : undefined,
    };
  } catch {
    return null;
  }
}

// ─── ChartBlock ────────────────────────────────────────────────────────────────

export type ChartType = 'bar' | 'line' | 'pie' | 'area' | 'scatter' | 'sparkline';

const CHART_TYPES = new Set<string>(['bar', 'line', 'pie', 'area', 'scatter', 'sparkline']);
const SPEC_SIZE_CAP = 10_000;

export interface ChartSpec {
  type: ChartType;
  data: Record<string, unknown>[];
  xKey?: string;
  yKeys?: string[];
  title?: string;
  colors?: string[];
}

/**
 * Parse a chart-block JSON spec.
 * Returns null for invalid JSON, unknown type, non-array data, or specs > 10KB.
 */
export function parseChartSpec(raw: string): ChartSpec | null {
  if (raw.length > SPEC_SIZE_CAP) return null;
  try {
    const parsed = JSON.parse(raw.trim());
    if (typeof parsed.type !== 'string' || !CHART_TYPES.has(parsed.type)) return null;
    if (!Array.isArray(parsed.data)) return null;
    return {
      type: parsed.type as ChartType,
      data: parsed.data as Record<string, unknown>[],
      xKey:   typeof parsed.xKey === 'string'  ? parsed.xKey  : undefined,
      yKeys:  Array.isArray(parsed.yKeys)       ? (parsed.yKeys as string[]) : undefined,
      title:  typeof parsed.title === 'string'  ? parsed.title : undefined,
      colors: Array.isArray(parsed.colors)      ? (parsed.colors as string[]) : undefined,
    };
  } catch {
    return null;
  }
}
