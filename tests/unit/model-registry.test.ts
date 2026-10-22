/**
 * Tests for lib/model-registry.ts — resolveModelFromRegistry
 *
 * P1-T2: Capability-aware filtering backward compat. Ensures the resolver
 * still returns correct IDs regardless of whether ModelEntry has the new
 * `capabilities` / `apiId` fields, and exercises all three resolution layers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

type FileMap = Record<string, string>;
let fileMap: FileMap = {};

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    readFileSync: (filePath: string, ...rest: unknown[]) => {
      if (typeof filePath === 'string' && filePath in fileMap) {
        return fileMap[filePath];
      }
      if (
        typeof filePath === 'string' &&
        (filePath.endsWith('models.json') || filePath.endsWith('configuredModels.json'))
      ) {
        const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      return (real.readFileSync as (...a: unknown[]) => unknown)(filePath, ...rest);
    },
  };
});

import {
  resolveModelFromRegistry,
  resolveApiIdForModel,
  resolveContextWindowForModel,
  resolveProviderForModel,
  inferAgentTypeForModel,
  isAgentTypeCompatibleWith,
} from '@/lib/model-registry';

const dataDir = path.join(process.cwd(), '.AppData');
const modelsPath = path.join(dataDir, 'models.json');
const configuredPath = path.join(dataDir, 'configuredModels.json');

function setFiles(models: unknown, configured: unknown) {
  fileMap = {
    [modelsPath]: JSON.stringify(models),
    [configuredPath]: JSON.stringify(configured),
  };
}

describe('resolveModelFromRegistry', () => {
  beforeEach(() => {
    fileMap = {};
  });

  describe('Layer 1: configuredModels.json per-agent override', () => {
    it('returns override model when agent has one', () => {
      setFiles(
        { models: [{ id: 'sonnet', agentTypes: ['claude'], isDefault: true }] },
        { overrides: { Builder: { model: 'opus' } } }
      );
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'claude')).toBe('opus');
    });

    it('override takes precedence over roleDefaults and isDefault', () => {
      setFiles(
        {
          roleDefaults: { 'backend-dev': { claude: 'haiku' } },
          models: [{ id: 'sonnet', agentTypes: ['claude'], isDefault: true }],
        },
        { overrides: { Builder: { model: 'opus' } } }
      );
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'claude')).toBe('opus');
    });

    it('ignores empty override model string and falls through', () => {
      setFiles(
        { models: [{ id: 'sonnet', agentTypes: ['claude'], isDefault: true }] },
        { overrides: { Builder: { model: '' } } }
      );
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'claude')).toBe('sonnet');
    });
  });

  describe('Layer 2: roleDefaults', () => {
    it('returns roleDefaults model for exact role + agentType match', () => {
      setFiles(
        {
          roleDefaults: { 'backend-dev': { claude: 'sonnet', gemini: 'gemini-3-flash-preview' } },
          models: [{ id: 'haiku', agentTypes: ['claude'], isDefault: true }],
        },
        {}
      );
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'claude')).toBe('sonnet');
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'gemini')).toBe('gemini-3-flash-preview');
    });

    it('falls back to _default role if specific role not defined', () => {
      setFiles(
        {
          roleDefaults: { '_default': { claude: 'sonnet' } },
          models: [],
        },
        {}
      );
      expect(resolveModelFromRegistry('Builder', 'unknown-role', 'claude')).toBe('sonnet');
    });

    it('falls through to isDefault when agentType missing from roleDefaults entry', () => {
      setFiles(
        {
          roleDefaults: { 'backend-dev': { claude: 'sonnet' } },
          models: [{ id: 'grok-4.20', agentTypes: ['grok'], isDefault: true }],
        },
        {}
      );
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'grok')).toBe('grok-4.20');
    });
  });

  describe('Layer 3: isDefault model for agentType', () => {
    it('returns the isDefault model for the agentType', () => {
      setFiles(
        {
          models: [
            { id: 'sonnet', agentTypes: ['claude'], isDefault: true },
            { id: 'haiku', agentTypes: ['claude'], isDefault: false },
          ],
        },
        {}
      );
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'claude')).toBe('sonnet');
    });

    it('returns undefined when no isDefault model matches agentType', () => {
      setFiles(
        { models: [{ id: 'sonnet', agentTypes: ['claude'], isDefault: true }] },
        {}
      );
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'grok')).toBeUndefined();
    });

    it('returns undefined when models.json and configured both empty', () => {
      setFiles({ models: [] }, {});
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'claude')).toBeUndefined();
    });
  });

  describe('Capability-aware backward compatibility', () => {
    it('resolves correctly when models have NO capabilities field', () => {
      setFiles(
        { models: [{ id: 'sonnet', agentTypes: ['claude'], isDefault: true }] },
        {}
      );
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'claude')).toBe('sonnet');
    });

    it('resolves correctly when models DO have capabilities + apiId fields', () => {
      setFiles(
        {
          models: [
            {
              id: 'sonnet',
              agentTypes: ['claude'],
              isDefault: true,
              apiId: 'claude-sonnet-4-6',
              capabilities: { contextWindow: 1_000_000, toolUse: true, reasoning: true },
            },
            {
              id: 'grok-4',
              agentTypes: ['grok'],
              isDefault: false,
              capabilities: { reasoningOnly: true, supportsStreaming: false, supportsTemperature: false },
            },
          ],
        },
        {}
      );
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'claude')).toBe('sonnet');
    });

    it('resolution ignores capabilities.reasoningOnly flag — filtering happens downstream', () => {
      setFiles(
        {
          models: [
            {
              id: 'grok-4',
              agentTypes: ['grok'],
              isDefault: true,
              capabilities: { reasoningOnly: true },
            },
          ],
        },
        {}
      );
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'grok')).toBe('grok-4');
    });
  });

  describe('resolveApiIdForModel', () => {
    it('returns the apiId when the registry entry has one', () => {
      setFiles(
        {
          models: [
            { id: 'sonnet', apiId: 'claude-sonnet-4-6[1m]', agentTypes: ['claude'] },
            { id: 'opus', apiId: 'claude-opus-4-6[1m]', agentTypes: ['claude'] },
          ],
        },
        {}
      );
      expect(resolveApiIdForModel('sonnet')).toBe('claude-sonnet-4-6[1m]');
      expect(resolveApiIdForModel('opus')).toBe('claude-opus-4-6[1m]');
    });

    it('falls back to the input id when no apiId is set', () => {
      setFiles(
        { models: [{ id: 'haiku', agentTypes: ['claude'] }] },
        {}
      );
      expect(resolveApiIdForModel('haiku')).toBe('haiku');
    });

    it('passes unknown model ids through unchanged', () => {
      setFiles(
        { models: [{ id: 'sonnet', apiId: 'claude-sonnet-4-6[1m]', agentTypes: ['claude'] }] },
        {}
      );
      expect(resolveApiIdForModel('some-random-model')).toBe('some-random-model');
    });

    it('resolves a retired provider ID through the canonical model aliases', () => {
      setFiles(
        {
          models: [{
            id: 'deepseek-flash',
            apiId: 'deepseek-flash[1m]',
            aliases: ['deepseek-v4-flash'],
            provider: 'deepseek',
            agentTypes: ['claude', 'hermes'],
          }],
        },
        {},
      );
      expect(resolveApiIdForModel('deepseek-v4-flash')).toBe('deepseek-flash[1m]');
      expect(resolveProviderForModel('deepseek-v4-flash')).toBe('deepseek');
      expect(inferAgentTypeForModel('deepseek-v4-flash')).toBe('claude');
      expect(isAgentTypeCompatibleWith('deepseek-v4-flash', 'hermes')).toBe(true);
    });

    it('returns empty string when input is empty', () => {
      setFiles({ models: [] }, {});
      expect(resolveApiIdForModel('')).toBe('');
    });
  });

  describe('resolveContextWindowForModel', () => {
    it('returns a positive registry context window', () => {
      setFiles(
        { models: [{ id: 'fable-5-1', agentTypes: ['claude'], capabilities: { contextWindow: 1_000_000 } }] },
        {}
      );
      expect(resolveContextWindowForModel('fable-5-1')).toBe(1_000_000);
    });

    it('returns null for missing or invalid context metadata', () => {
      setFiles(
        { models: [{ id: 'unknown-window', agentTypes: ['claude'], capabilities: { contextWindow: 0 } }] },
        {}
      );
      expect(resolveContextWindowForModel('unknown-window')).toBeNull();
      expect(resolveContextWindowForModel('missing')).toBeNull();
    });
  });

  // Hermes spawn (plan §1.5) pairs apiId (-m) with provider (--provider).
  describe('resolveProviderForModel', () => {
    it('returns the registry provider for the model', () => {
      setFiles(
        {
          models: [
            { id: 'sonnet', apiId: 'claude-sonnet-4-6', provider: 'anthropic', agentTypes: ['claude', 'hermes'] },
            { id: 'deepseek-v4-pro', apiId: 'deepseek-v4-pro', provider: 'deepseek', agentTypes: ['claude', 'hermes'] },
          ],
        },
        {}
      );
      expect(resolveProviderForModel('sonnet')).toBe('anthropic');
      expect(resolveProviderForModel('deepseek-v4-pro')).toBe('deepseek');
    });

    it('returns null for an unknown model', () => {
      setFiles({ models: [{ id: 'sonnet', provider: 'anthropic', agentTypes: ['claude'] }] }, {});
      expect(resolveProviderForModel('nope')).toBeNull();
    });

    it('returns null for an empty input', () => {
      setFiles({ models: [] }, {});
      expect(resolveProviderForModel('')).toBeNull();
    });

    it('returns null when the entry has no provider field', () => {
      setFiles({ models: [{ id: 'mystery', agentTypes: ['hermes'] }] }, {});
      expect(resolveProviderForModel('mystery')).toBeNull();
    });
  });

  describe('Robustness', () => {
    it('returns undefined when models.json is missing/unreadable', () => {
      fileMap = {};
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'claude')).toBeUndefined();
    });

    it('returns undefined when configuredModels.json is malformed but models.json ok', () => {
      fileMap = {
        [modelsPath]: JSON.stringify({
          models: [{ id: 'sonnet', agentTypes: ['claude'], isDefault: true }],
        }),
        [configuredPath]: 'not valid json',
      };
      expect(resolveModelFromRegistry('Builder', 'backend-dev', 'claude')).toBe('sonnet');
    });
  });
});

// ============================================
// A1 — inferAgentTypeForModel
// ============================================
// Sprint c62ebbd2 Phase A. Returns the first compatible agentType from the
// model's `agentTypes` registry list, or null when the model is unknown or
// has no compatible runtimes. This is the canonical "what wrapper do I spawn
// for this model?" lookup — used by roster.add default selection (B1) and
// setOverride auto-routing (B2).

describe('inferAgentTypeForModel', () => {
  beforeEach(() => {
    fileMap = {};
  });

  it('returns the first compatible agentType for a known model', () => {
    setFiles(
      { models: [{ id: 'opus', agentTypes: ['claude', 'claude-terminal'] }] },
      {}
    );
    expect(inferAgentTypeForModel('opus')).toBe('claude');
  });

  it('returns the first agentType when the list has multiple', () => {
    setFiles(
      {
        models: [
          {
            id: 'gemini-3.5-flash',
            agentTypes: ['gemini', 'gemini-terminal', 'gemini-powershell', 'antigravity'],
          },
        ],
      },
      {}
    );
    expect(inferAgentTypeForModel('gemini-3.5-flash')).toBe('gemini');
  });

  it('prefers Codex when an OpenAI model supports both Codex and Hermes', () => {
    setFiles(
      {
        models: [
          {
            id: 'gpt-5.6-sol',
            agentTypes: ['codex', 'hermes'],
          },
        ],
      },
      {},
    );
    expect(inferAgentTypeForModel('gpt-5.6-sol')).toBe('codex');
  });

  it('returns null for an unknown model', () => {
    setFiles({ models: [{ id: 'sonnet', agentTypes: ['claude'] }] }, {});
    expect(inferAgentTypeForModel('some-unregistered-model')).toBeNull();
  });

  it('returns null when models.json is missing', () => {
    fileMap = {};
    expect(inferAgentTypeForModel('opus')).toBeNull();
  });

  it('returns null when modelId is empty', () => {
    setFiles({ models: [{ id: 'opus', agentTypes: ['claude'] }] }, {});
    expect(inferAgentTypeForModel('')).toBeNull();
  });

  it('returns null when the model has no agentTypes', () => {
    setFiles({ models: [{ id: 'broken', agentTypes: [] }] }, {});
    expect(inferAgentTypeForModel('broken')).toBeNull();
  });

  it('returns null when the model entry lacks an agentTypes field', () => {
    setFiles(
      { models: [{ id: 'broken' } as unknown as { id: string; agentTypes: string[] }] },
      {}
    );
    expect(inferAgentTypeForModel('broken')).toBeNull();
  });
});

// ============================================
// A2 — isAgentTypeCompatibleWith
// ============================================
// Sprint c62ebbd2 Phase A. Companion validator for callers that want to
// check before mutating (e.g. UI showing a warning, or the roster.update
// path deciding whether the implied agentType change is actually necessary).

describe('isAgentTypeCompatibleWith', () => {
  beforeEach(() => {
    fileMap = {};
  });

  it('returns true when the agentType is in the model agentTypes list', () => {
    setFiles(
      { models: [{ id: 'opus', agentTypes: ['claude', 'claude-terminal'] }] },
      {}
    );
    expect(isAgentTypeCompatibleWith('opus', 'claude')).toBe(true);
    expect(isAgentTypeCompatibleWith('opus', 'claude-terminal')).toBe(true);
  });

  it('returns false when the agentType is not in the list', () => {
    setFiles({ models: [{ id: 'opus', agentTypes: ['claude'] }] }, {});
    expect(isAgentTypeCompatibleWith('opus', 'gemini')).toBe(false);
  });

  it('returns false for an unknown model', () => {
    setFiles({ models: [{ id: 'sonnet', agentTypes: ['claude'] }] }, {});
    expect(isAgentTypeCompatibleWith('unknown-model', 'claude')).toBe(false);
  });

  it('returns false when models.json is missing', () => {
    fileMap = {};
    expect(isAgentTypeCompatibleWith('opus', 'claude')).toBe(false);
  });

  it('returns false when modelId is empty', () => {
    setFiles({ models: [{ id: 'opus', agentTypes: ['claude'] }] }, {});
    expect(isAgentTypeCompatibleWith('', 'claude')).toBe(false);
  });

  it('returns false when agentType is empty', () => {
    setFiles({ models: [{ id: 'opus', agentTypes: ['claude'] }] }, {});
    expect(isAgentTypeCompatibleWith('opus', '')).toBe(false);
  });
});
