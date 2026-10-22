/**
 * Sprint 42 P6-T1 — Integration: spawn one agent per engine × role combination.
 *
 * Exercises the spawn-time model resolution path against the real models.json
 * (v1.4.0) to verify that every (engine × role) combination resolves to an
 * intended model ID and that resolveApiIdForModel plumbs the correct downstream
 * apiId (incl. the Sonnet/Opus [1m] variant contract from Sprint 42 P2).
 *
 * Coverage:
 *   - 4 engines: claude, gemini, grok, ollama (ollama has no roleDefaults →
 *     falls through to the isDefault model for the agentType).
 *   - 6 roles: team-lead, backend-dev, frontend-dev, researcher,
 *     integration-agent, axiom.
 *   - Plus the _default fallback for an unrecognised role.
 *   - Plus per-agent configuredModels.json override (layer 1) wins over
 *     roleDefaults (layer 2) and isDefault (layer 3).
 *
 * This is the logic-level integration test for Sprint 42. The live 4-engine
 * smoke is P6-T4 (post-nightly-bake).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { resolveModelFromRegistry, resolveApiIdForModel } from '@/lib/model-registry';

const APPDATA_DIR = path.join(process.cwd(), '.AppData');
const MODELS_JSON = path.join(APPDATA_DIR, 'models.json');
const CONFIGURED_MODELS_JSON = path.join(APPDATA_DIR, 'configuredModels.json');

interface ModelsJsonShape {
  version?: string;
  models: Array<{ id: string; agentTypes: string[]; isDefault?: boolean; apiId?: string }>;
  roleDefaults?: Record<string, Record<string, string>>;
}

describe('Sprint 42 P6-T1 — engine × role spawn resolution', () => {
  let modelsData: ModelsJsonShape;

  beforeAll(() => {
    expect(existsSync(MODELS_JSON)).toBe(true);
    modelsData = JSON.parse(readFileSync(MODELS_JSON, 'utf-8'));
    expect(modelsData.version).toBe('1.4.0');
  });

  // ── Role × engine matrix from roleDefaults ─────────────────────────────
  const matrix = [
    { role: 'team-lead',         claude: 'sonnet', gemini: 'gemini-3-flash-preview',        grok: 'grok-4.20' },
    { role: 'backend-dev',       claude: 'sonnet', gemini: 'gemini-3-flash-preview',        grok: 'grok-4.20' },
    { role: 'frontend-dev',      claude: 'sonnet', gemini: 'gemini-3-flash-preview',        grok: 'grok-4.20' },
    { role: 'researcher',        claude: 'haiku',  gemini: 'gemini-3.1-flash-lite-preview', grok: 'grok-4-1-fast-non-reasoning' },
    { role: 'integration-agent', claude: 'sonnet', gemini: 'gemini-3-flash-preview',        grok: 'grok-4.20' },
    { role: 'axiom',             claude: 'haiku',  gemini: 'gemini-3.1-flash-lite-preview', grok: 'grok-4-1-fast-non-reasoning' },
  ] as const;

  for (const row of matrix) {
    describe(`role: ${row.role}`, () => {
      it(`claude engine → ${row.claude}`, () => {
        expect(resolveModelFromRegistry(`AgentFor-${row.role}`, row.role, 'claude')).toBe(row.claude);
      });
      it(`gemini engine → ${row.gemini}`, () => {
        expect(resolveModelFromRegistry(`AgentFor-${row.role}`, row.role, 'gemini')).toBe(row.gemini);
      });
      it(`grok engine → ${row.grok}`, () => {
        expect(resolveModelFromRegistry(`AgentFor-${row.role}`, row.role, 'grok')).toBe(row.grok);
      });
      it(`ollama engine → isDefault fallback (gemma4:26b)`, () => {
        // No roleDefaults[role].ollama anywhere in v1.4.0 → layer 3 kicks in.
        expect(resolveModelFromRegistry(`AgentFor-${row.role}`, row.role, 'ollama')).toBe('gemma4:26b');
      });
    });
  }

  // ── _default fallback for unknown role ─────────────────────────────────
  describe('unknown role → _default fallback', () => {
    it('claude _default → sonnet', () => {
      expect(resolveModelFromRegistry('UnknownAgent', 'no-such-role', 'claude')).toBe('sonnet');
    });
    it('gemini _default → gemini-3-flash-preview', () => {
      expect(resolveModelFromRegistry('UnknownAgent', 'no-such-role', 'gemini')).toBe('gemini-3-flash-preview');
    });
    it('grok _default → grok-4.20', () => {
      expect(resolveModelFromRegistry('UnknownAgent', 'no-such-role', 'grok')).toBe('grok-4.20');
    });
    it('ollama unknown role → isDefault gemma4:26b', () => {
      expect(resolveModelFromRegistry('UnknownAgent', 'no-such-role', 'ollama')).toBe('gemma4:26b');
    });
  });

  // ── apiId plumbing — Sprint 42 P2 1M-context contract ──────────────────
  describe('resolveApiIdForModel — Sprint 42 P2 apiId contract', () => {
    it('sonnet → claude-sonnet-5', () => {
      expect(resolveApiIdForModel('sonnet')).toBe('claude-sonnet-5');
    });
    it('opus → claude-opus-4-8[1m]', () => {
      expect(resolveApiIdForModel('opus')).toBe('claude-opus-4-8[1m]');
    });
    it('haiku → claude-haiku-4-5-20251001', () => {
      expect(resolveApiIdForModel('haiku')).toBe('claude-haiku-4-5-20251001');
    });
    it('grok-4.20 has no apiId → returns id unchanged', () => {
      expect(resolveApiIdForModel('grok-4.20')).toBe('grok-4.20');
    });
    it('gemma4:26b has no apiId → returns id unchanged', () => {
      expect(resolveApiIdForModel('gemma4:26b')).toBe('gemma4:26b');
    });
    it('unknown id passes through', () => {
      expect(resolveApiIdForModel('not-a-model')).toBe('not-a-model');
    });
  });

  // ── configuredModels.json override wins over roleDefaults ──────────────
  describe('configuredModels.json override (layer 1 beats roleDefaults)', () => {
    const OVERRIDE_AGENT = 'SpawnTestOverrideAgent';
    let backup: string | null = null;

    beforeAll(() => {
      if (existsSync(CONFIGURED_MODELS_JSON)) {
        backup = readFileSync(CONFIGURED_MODELS_JSON, 'utf-8');
      } else {
        mkdirSync(APPDATA_DIR, { recursive: true });
      }
      const current = backup ? JSON.parse(backup) : { overrides: {} };
      current.overrides = current.overrides || {};
      current.overrides[OVERRIDE_AGENT] = { model: 'haiku' };
      writeFileSync(CONFIGURED_MODELS_JSON, JSON.stringify(current, null, 2));
    });

    afterAll(() => {
      if (backup !== null) {
        writeFileSync(CONFIGURED_MODELS_JSON, backup);
      } else {
        rmSync(CONFIGURED_MODELS_JSON, { force: true });
      }
    });

    it('per-agent override beats backend-dev claude default', () => {
      // backend-dev claude default is sonnet, override forces haiku.
      expect(resolveModelFromRegistry(OVERRIDE_AGENT, 'backend-dev', 'claude')).toBe('haiku');
    });

    it('non-overridden agent still gets backend-dev default', () => {
      expect(resolveModelFromRegistry('NotOverridden', 'backend-dev', 'claude')).toBe('sonnet');
    });
  });

  // ── Capability flags surface through the registry ──────────────────────
  describe('capability flags on key models (Sprint 42 P1)', () => {
    const findModel = (id: string) => modelsData.models.find(m => m.id === id);

    it('grok-4 is flagged reasoningOnly', () => {
      const e = findModel('grok-4') as { capabilities?: { reasoningOnly?: boolean } } | undefined;
      expect(e?.capabilities?.reasoningOnly).toBe(true);
    });
    it('sonnet advertises 1M contextWindow', () => {
      const e = findModel('sonnet') as { capabilities?: { contextWindow?: number } } | undefined;
      expect(e?.capabilities?.contextWindow).toBe(1_000_000);
    });
    it('opus advertises 1M contextWindow', () => {
      const e = findModel('opus') as { capabilities?: { contextWindow?: number } } | undefined;
      expect(e?.capabilities?.contextWindow).toBe(1_000_000);
    });
    it('gemma4:26b advertises toolUse', () => {
      const e = findModel('gemma4:26b') as { capabilities?: { toolUse?: boolean } } | undefined;
      expect(e?.capabilities?.toolUse).toBe(true);
    });
  });
});
