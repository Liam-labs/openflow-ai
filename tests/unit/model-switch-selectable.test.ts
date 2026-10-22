/**
 * Model Switcher P3.1 — pure selector for the Switch-Model picker.
 *
 * Builds the list of switchable target models for a live agent: registered
 * models grouped by their canonical agentType, EXCLUDING the agent's current
 * model (so the backend's same-model no-op is unreachable from the UI) and
 * any model with no wrapper (empty agentTypes).
 */

import { describe, it, expect } from 'vitest';
import { selectSwitchTargets } from '@/lib/model-switch/selectable';
import type { ModelEntry } from '@/components/colab-types';

const m = (
  id: string,
  agentTypes: string[],
  extra: Partial<ModelEntry> = {},
): ModelEntry => ({
  id,
  provider: 'p',
  label: extra.label ?? id,
  tier: 'standard',
  agentTypes,
  ...extra,
});

const REGISTRY: ModelEntry[] = [
  m('claude-opus-4-8[1m]', ['claude'], { label: 'Opus 4.8', apiId: 'claude-opus-4-8[1m]' }),
  m('claude-sonnet-4-6', ['claude'], { label: 'Sonnet 4.6' }),
  m('gemini-2.5-flash', ['gemini'], { label: 'Gemini 2.5 Flash' }),
  m('grok-build-0.1', ['grok'], { label: 'Grok Build', capabilities: { reasoningOnly: true } as never }),
  m('orphan-model', [], { label: 'Orphan' }), // no wrapper → excluded
];

describe('selectSwitchTargets', () => {
  it('excludes the agent current model', () => {
    const groups = selectSwitchTargets(REGISTRY, 'claude-sonnet-4-6');
    const ids = groups.flatMap((g) => g.models.map((x) => x.id));
    expect(ids).not.toContain('claude-sonnet-4-6');
    expect(ids).toContain('claude-opus-4-8[1m]');
    expect(ids).toContain('gemini-2.5-flash');
  });

  it('groups by canonical agentType (agentTypes[0])', () => {
    const groups = selectSwitchTargets(REGISTRY, 'none');
    const byType = Object.fromEntries(groups.map((g) => [g.agentType, g.models.map((x) => x.id)]));
    expect(byType.claude).toEqual(['claude-opus-4-8[1m]', 'claude-sonnet-4-6'].sort());
    expect(byType.gemini).toEqual(['gemini-2.5-flash']);
    expect(byType.grok).toEqual(['grok-build-0.1']);
  });

  it('groups a Codex-first GPT model under Codex, not Hermes', () => {
    const registry = [
      ...REGISTRY,
      m('gpt-5.6-sol', ['codex', 'hermes'], { label: 'GPT-5.6 Sol' }),
    ];
    const groups = selectSwitchTargets(registry, 'claude-sonnet-4-6');
    const byType = Object.fromEntries(groups.map((g) => [g.agentType, g.models.map((x) => x.id)]));
    expect(byType.codex).toContain('gpt-5.6-sol');
    expect(byType.hermes).toBeUndefined();
  });

  it('excludes models with no wrapper (empty agentTypes)', () => {
    const ids = selectSwitchTargets(REGISTRY, 'none').flatMap((g) => g.models.map((x) => x.id));
    expect(ids).not.toContain('orphan-model');
  });

  it('labels via getModelLabel (verbatim registry label) + reasoningOnly flag', () => {
    const groups = selectSwitchTargets(REGISTRY, 'none');
    const all = groups.flatMap((g) => g.models);
    const opus = all.find((x) => x.id === 'claude-opus-4-8[1m]')!;
    expect(opus.label).toBe('Opus 4.8');
    const grok = all.find((x) => x.id === 'grok-build-0.1')!;
    expect(grok.reasoningOnly).toBe(true);
    const flash = all.find((x) => x.id === 'gemini-2.5-flash')!;
    expect(flash.reasoningOnly).toBe(false);
  });

  it('is deterministically sorted (groups + models)', () => {
    const groups = selectSwitchTargets(REGISTRY, 'none');
    expect(groups.map((g) => g.agentType)).toEqual([...groups.map((g) => g.agentType)].sort());
    for (const g of groups) {
      expect(g.models.map((x) => x.label)).toEqual([...g.models.map((x) => x.label)].sort());
    }
  });

  it('tolerates undefined / non-array registry', () => {
    expect(selectSwitchTargets(undefined, 'x')).toEqual([]);
    // @ts-expect-error defensive runtime guard
    expect(selectSwitchTargets(null, 'x')).toEqual([]);
  });
});

// Two registry entries (`opus`, `opus[1m]`) deliberately share one apiId —
// they invoke the identical model. The picker must never offer both, and must
// never offer one when the agent is already on the other.
const DUP_REGISTRY: ModelEntry[] = [
  m('opus', ['claude'], { label: 'Opus 4.8 · 1M', apiId: 'claude-opus-4-8[1m]' }),
  m('opus[1m]', ['claude'], { label: 'Opus 4.8 · 1M', apiId: 'claude-opus-4-8[1m]' }),
  m('sonnet', ['claude'], { label: 'Sonnet 4.6', apiId: 'claude-sonnet-4-6' }),
];

describe('selectSwitchTargets — apiId dedup', () => {
  it('collapses entries sharing an apiId to one target (canonical/first wins)', () => {
    const ids = selectSwitchTargets(DUP_REGISTRY, 'none').flatMap((g) => g.models.map((x) => x.id));
    expect(ids).toContain('opus');
    expect(ids).not.toContain('opus[1m]');
    expect(ids).toContain('sonnet');
    expect(ids.filter((id) => id === 'opus')).toHaveLength(1);
  });

  it('excludes every alias of the current model (same apiId, different id)', () => {
    // Agent is on the opus[1m] alias → must not be offered `opus` (identical model).
    const ids = selectSwitchTargets(DUP_REGISTRY, 'opus[1m]').flatMap((g) => g.models.map((x) => x.id));
    expect(ids).not.toContain('opus');
    expect(ids).not.toContain('opus[1m]');
    expect(ids).toEqual(['sonnet']);
  });

  it('treats a declared legacy ID as the current canonical model', () => {
    const registry = [
      m('deepseek-flash', ['claude'], {
        aliases: ['deepseek-v4-flash'],
        apiId: 'deepseek-flash[1m]',
        label: 'DeepSeek V4.1 Flash',
      }),
      m('sonnet', ['claude']),
    ];
    const ids = selectSwitchTargets(registry, 'deepseek-v4-flash')
      .flatMap(group => group.models.map(model => model.id));
    expect(ids).not.toContain('deepseek-flash');
    expect(ids).toContain('sonnet');
  });

  it('resolves the current model apiId through the registry', () => {
    // Current id 'opus' → apiId claude-opus-4-8[1m]; its alias opus[1m] is also hidden.
    const ids = selectSwitchTargets(DUP_REGISTRY, 'opus').flatMap((g) => g.models.map((x) => x.id));
    expect(ids).toEqual(['sonnet']);
  });
});
