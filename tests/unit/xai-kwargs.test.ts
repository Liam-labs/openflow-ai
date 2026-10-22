/**
 * Tests for lib/xai-kwargs.ts — capability-aware xAI request-body builder.
 * Sprint 42 / P4-T4: wires reasoningOnly / supportsTemperature / supportsStreaming / toolUse
 * capability flags into the body construction so callers can pass a single kwargs bag
 * and have forbidden fields stripped automatically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock fs to provide an in-memory models.json
type FsStats = { mtimeMs: number };
let currentStats: FsStats = { mtimeMs: Date.now() };
let currentJson = '';

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    readFileSync: (filePath: string, ...rest: unknown[]) => {
      if (typeof filePath === 'string' && filePath.endsWith('models.json')) {
        return currentJson;
      }
      return (real.readFileSync as (...a: unknown[]) => unknown)(filePath, ...rest);
    },
    statSync: (filePath: string, ...rest: unknown[]) => {
      if (typeof filePath === 'string' && filePath.endsWith('models.json')) {
        return currentStats as unknown as ReturnType<typeof real.statSync>;
      }
      return (real.statSync as (...a: unknown[]) => unknown)(filePath, ...rest);
    },
  };
});

import { buildXaiBody, __resetXaiCapabilitiesCacheForTest } from '@/lib/xai-kwargs';

function setModels(models: unknown) {
  currentStats = { mtimeMs: Date.now() + Math.random() };
  currentJson = JSON.stringify({ models });
  __resetXaiCapabilitiesCacheForTest();
}

describe('buildXaiBody', () => {
  beforeEach(() => {
    currentJson = '';
    currentStats = { mtimeMs: 0 };
    __resetXaiCapabilitiesCacheForTest();
  });

  it('passes unknown models through unchanged', () => {
    setModels([]);
    const out = buildXaiBody('grok-unknown', { temperature: 0.5, top_p: 1, stream: true });
    expect(out).toEqual({ model: 'grok-unknown', temperature: 0.5, top_p: 1, stream: true });
  });

  it('strips temperature/top_p/stream/tools for reasoningOnly models', () => {
    setModels([
      {
        id: 'grok-4',
        provider: 'xai',
        capabilities: { reasoningOnly: true },
      },
    ]);
    const out = buildXaiBody('grok-4', {
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      top_p: 0.9,
      stream: true,
      tools: [{ type: 'function' }],
      tool_choice: 'auto',
      max_tokens: 1000,
    });
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
    expect(out.stream).toBeUndefined();
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(out.max_tokens).toBe(1000);
    expect(out.messages).toBeDefined();
    expect(out.model).toBe('grok-4');
  });

  it('strips temperature + top_p when supportsTemperature=false', () => {
    setModels([
      {
        id: 'grok-partial',
        provider: 'xai',
        capabilities: { supportsTemperature: false, supportsStreaming: true, toolUse: true },
      },
    ]);
    const out = buildXaiBody('grok-partial', {
      temperature: 0.5,
      top_p: 0.8,
      stream: true,
      tools: [{ type: 'function' }],
    });
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
    expect(out.stream).toBe(true);
    expect(out.tools).toBeDefined();
  });

  it('strips stream only when supportsStreaming=false', () => {
    setModels([
      {
        id: 'grok-4.20',
        provider: 'xai',
        capabilities: { supportsStreaming: false, supportsTemperature: true, toolUse: true },
      },
    ]);
    const out = buildXaiBody('grok-4.20', { temperature: 0.7, stream: true, tools: [] });
    expect(out.stream).toBeUndefined();
    expect(out.temperature).toBe(0.7);
    expect(out.tools).toEqual([]);
  });

  it('strips tools/tool_choice when toolUse=false', () => {
    setModels([
      {
        id: 'grok-no-tools',
        provider: 'xai',
        capabilities: { toolUse: false, supportsTemperature: true, supportsStreaming: true },
      },
    ]);
    const out = buildXaiBody('grok-no-tools', {
      temperature: 0.7,
      tools: [{ type: 'function' }],
      tool_choice: 'auto',
    });
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(out.temperature).toBe(0.7);
  });

  it('ignores non-xai entries (e.g. Claude)', () => {
    setModels([
      {
        id: 'sonnet',
        provider: 'anthropic',
        capabilities: { reasoningOnly: true },
      },
    ]);
    // Claude models are NOT registered as xai, so the helper passes through
    const out = buildXaiBody('sonnet', { temperature: 0.7, stream: true });
    expect(out.temperature).toBe(0.7);
    expect(out.stream).toBe(true);
  });

  it('returns a new object — does not mutate the input bag', () => {
    setModels([
      { id: 'grok-4', provider: 'xai', capabilities: { reasoningOnly: true } },
    ]);
    const base = { temperature: 0.7, messages: [] };
    buildXaiBody('grok-4', base);
    expect(base).toEqual({ temperature: 0.7, messages: [] });
  });

  it('falls back to passthrough when models.json is unreadable', () => {
    // empty currentJson causes JSON.parse to throw → catch returns {}
    currentJson = '';
    currentStats = { mtimeMs: Date.now() };
    __resetXaiCapabilitiesCacheForTest();
    const out = buildXaiBody('grok-4', { temperature: 0.7 });
    expect(out).toEqual({ model: 'grok-4', temperature: 0.7 });
  });
});
