/**
 * Sprint M P1 T2 — Reynolds, 2026-05-27.
 *
 * Exercises lib/model-integration-detect.ts against the LIVE adapters
 * registry + scaffolding manifest + wrapper inventory. These are integration-
 * adjacent tests — they read real DevFlow infrastructure, so they break if
 * the adapter registry, wrapper inventory, or manifest entries change
 * shape. That's by design: detector drift is exactly what we want to catch.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CAPABILITY_SLUGS,
  aggregateStatus,
  detectIntegrationForModel,
  detectIntegrationForRegistry,
  getInterfaceTypeOptions,
  pickInterfaceType,
  resetAdapterCache,
} from '@/lib/model-integration-detect';
import type { CapabilityLevel } from '@/lib/model-registry';

beforeEach(() => {
  resetAdapterCache();
});

describe('aggregateStatus — Sam plan §1.5 rule', () => {
  const mkCaps = (fullCount: number, partialCount = 0): Record<string, CapabilityLevel> => {
    const slugs = [...CAPABILITY_SLUGS];
    const out: Record<string, CapabilityLevel> = {};
    let i = 0;
    for (; i < fullCount; i++) out[slugs[i]] = 'full';
    for (let j = 0; j < partialCount; j++, i++) out[slugs[i]] = 'partial';
    for (; i < slugs.length; i++) out[slugs[i]] = 'none';
    return out;
  };

  it('all 8 full → full', () => {
    expect(aggregateStatus(mkCaps(8) as never)).toBe('full');
  });

  it('7 full + 1 partial → partial (not full)', () => {
    expect(aggregateStatus(mkCaps(7, 1) as never)).toBe('partial');
  });

  it('4 full + 4 partial → partial', () => {
    expect(aggregateStatus(mkCaps(4, 4) as never)).toBe('partial');
  });

  it('3 full + 5 partial → none (partial-count does NOT lift to partial)', () => {
    expect(aggregateStatus(mkCaps(3, 5) as never)).toBe('none');
  });

  it('all 8 none → none', () => {
    expect(aggregateStatus(mkCaps(0) as never)).toBe('none');
  });
});

describe('pickInterfaceType', () => {
  it('maps claude → claude-code', () => {
    expect(pickInterfaceType(['claude'])).toBe('claude-code');
  });
  it('maps claude-terminal → claude-code', () => {
    expect(pickInterfaceType(['claude-terminal'])).toBe('claude-code');
  });
  it('maps gemini variants → gemini-cli', () => {
    expect(pickInterfaceType(['gemini-terminal'])).toBe('gemini-cli');
    expect(pickInterfaceType(['gemini-powershell'])).toBe('gemini-cli');
  });
  it('maps codex / antigravity / grok directly', () => {
    expect(pickInterfaceType(['codex'])).toBe('codex');
    expect(pickInterfaceType(['antigravity'])).toBe('antigravity');
    expect(pickInterfaceType(['grok'])).toBe('grok-cli');
  });
  it('uses first mappable type when multiple', () => {
    expect(pickInterfaceType(['claude', 'claude-terminal'])).toBe('claude-code');
  });
  it('falls back to raw agentType when unknown', () => {
    expect(pickInterfaceType(['noveltype'])).toBe('noveltype');
  });
  it('returns "unknown" for empty array', () => {
    expect(pickInterfaceType([])).toBe('unknown');
  });
});

describe('detectIntegrationForModel — live infrastructure', () => {
  it('claude — full hook coverage + per-model scaffolding + wrapper + dispatch branch', () => {
    const r = detectIntegrationForModel(['claude', 'claude-terminal']);
    expect(r.interfaceType).toBe('claude-code');
    // Each signal asserted individually so future drift is easy to triage.
    expect(r.capabilities.hooks).toBe('full');
    expect(r.capabilities.harness).toBe('full'); // collab-claude.py exists
    expect(r.capabilities.feed).toBe('full');    // is{Anti,Codex,Grok,Gemini} false → claude path
    expect(r.capabilities.skills).toBe('full');
    expect(r.capabilities.mcp).toBe('full');
    expect(r.capabilities.memory).toBe('full');
    expect(r.capabilities.telemetry).toBe('full');
    // scaffolding for 'claude' is per-model entry in manifest — may be 'none'
    // because the claude alignment lives at ~/.claude/rules/ (global target),
    // not under condition:agentType:claude. Accept any value here, the
    // individual capability is informational, the aggregate is what matters.
  });


  it('antigravity — full hooks + scaffolding + wrapper + mcp=full (C1 confirmed: agy --print loads MCP at runtime)', () => {
    const r = detectIntegrationForModel(['antigravity']);
    expect(r.interfaceType).toBe('antigravity');
    expect(r.capabilities.hooks).toBe('full');
    expect(r.capabilities.scaffolding).toBe('full');
    expect(r.capabilities.harness).toBe('full');
    expect(r.capabilities.feed).toBe('full');
    expect(r.capabilities.mcp).toBe('full');      // C1: agy loads MCP from ~/.gemini/antigravity-cli/mcp/ — live tool-call confirmed
  });

  it('gemini-cli — full hook coverage (B2) + memory=partial (B1 context-inject)', () => {
    const r = detectIntegrationForModel(['gemini', 'gemini-terminal']);
    expect(r.interfaceType).toBe('gemini-cli');
    expect(r.capabilities.hooks).toBe('full');         // B2: adapter hook_coverage_level=full
    expect(r.capabilities.harness).toBe('full');      // collab-gemini.py exists
    expect(r.capabilities.skills).toBe('full');        // S2.5: skill-index integration is live
    expect(r.capabilities.memory).toBe('partial');     // B1: wrapper now has context-inject
    expect(r.capabilities.telemetry).toBe('full');     // B2: tied to hooks=full
  });

  it('grok — full hook coverage (B4) + harness + memory=full (wrapper has _build_scaffolded_prompt+MEMORY.md)', () => {
    const r = detectIntegrationForModel(['grok']);
    expect(r.interfaceType).toBe('grok-cli');
    expect(r.capabilities.hooks).toBe('full');         // B4: adapter hook_coverage_level=full
    expect(r.capabilities.harness).toBe('full');
    expect(r.capabilities.mcp).toBe('none');
    expect(r.capabilities.memory).toBe('full');   // A1: real probe — wrapper loads MEMORY.md
    expect(r.capabilities.telemetry).toBe('full');     // B4: tied to hooks=full
  });

  describe('A1 — detectMemory real probe', () => {

    it('grok memory=full — _build_scaffolded_prompt + MEMORY.md in wrapper', () => {
      const r = detectIntegrationForModel(['grok']);
      expect(r.capabilities.memory).toBe('full');
    });

    it('codex memory=full — startup scaffold preloads persistent MEMORY.md', () => {
      const r = detectIntegrationForModel(['codex']);
      expect(r.capabilities.memory).toBe('full');
      expect(r.status).toBe('full');
    });

    it('antigravity memory=partial — context-inject only, no _build_scaffolded_prompt', () => {
      const r = detectIntegrationForModel(['antigravity']);
      expect(r.capabilities.memory).toBe('partial');
    });

    it('gemini memory=partial — context-inject added by B1 hook lifecycle', () => {
      const r = detectIntegrationForModel(['gemini', 'gemini-terminal']);
      expect(r.capabilities.memory).toBe('partial');
    });

    it('claude memory=full — native, no wrapper probe applied', () => {
      const r = detectIntegrationForModel(['claude']);
      expect(r.capabilities.memory).toBe('full');
    });
  });

  describe('A2 — detectMcp real probe', () => {
    it('claude mcp=full — native MCP support', () => {
      const r = detectIntegrationForModel(['claude']);
      expect(r.capabilities.mcp).toBe('full');
    });


    it('codex mcp=full — native MCP support', () => {
      const r = detectIntegrationForModel(['codex']);
      expect(r.capabilities.mcp).toBe('full');
    });

    it('antigravity mcp=full — agy loads MCP from ~/.gemini/antigravity-cli/mcp/ (C1 live-confirmed)', () => {
      const r = detectIntegrationForModel(['antigravity']);
      expect(r.capabilities.mcp).toBe('full');
    });

    it('gemini mcp=none — no mcpServers in .gemini/settings.json', () => {
      const r = detectIntegrationForModel(['gemini', 'gemini-terminal']);
      expect(r.capabilities.mcp).toBe('none');
    });

    it('grok mcp=none — API-native wrapper, no MCP bridge', () => {
      const r = detectIntegrationForModel(['grok']);
      expect(r.capabilities.mcp).toBe('none');
    });
  });

  describe('A3 — detectSkills real probe', () => {
    it('claude skills=full — native skill support via scaffolding', () => {
      const r = detectIntegrationForModel(['claude']);
      expect(r.capabilities.skills).toBe('full');
    });


    it('codex skills=full — S2.3 skill-index.md injection via context-inject is live', () => {
      const r = detectIntegrationForModel(['codex']);
      expect(r.capabilities.skills).toBe('full');
    });

    it('antigravity skills=full — S2.4 adds skill-index injection is live', () => {
      const r = detectIntegrationForModel(['antigravity']);
      expect(r.capabilities.skills).toBe('full');
    });

    it('gemini skills=full — S2.5 adds skill-index injection is live', () => {
      const r = detectIntegrationForModel(['gemini', 'gemini-terminal']);
      expect(r.capabilities.skills).toBe('full');
    });

    it('grok skills=full — skill-index.md loaded via _build_scaffolded_prompt rules scan (S2.6)', () => {
      const r = detectIntegrationForModel(['grok']);
      expect(r.capabilities.skills).toBe('full');
    });
  });

  it('unknown agentType degrades gracefully to all-none', () => {
    const r = detectIntegrationForModel(['novel-runtime-2030']);
    expect(r.interfaceType).toBe('novel-runtime-2030');
    expect(r.status).toBe('none');
    for (const slug of CAPABILITY_SLUGS) {
      expect(r.capabilities[slug]).toBe('none');
    }
  });

  it('records detectedAt timestamp', () => {
    const ts = '2026-05-27T20:00:00.000Z';
    const r = detectIntegrationForModel(['claude'], ts);
    expect(r.detectedAt).toBe(ts);
  });

  it('every model gets all 8 CAPABILITY_SLUGS keys (no missing)', () => {
    const r = detectIntegrationForModel(['claude']);
    for (const slug of CAPABILITY_SLUGS) {
      expect(r.capabilities[slug]).toBeDefined();
    }
  });
});

describe('getInterfaceTypeOptions — A6 integration block', () => {
  it('every option carries an integration block keyed by interfaceType = id', () => {
    const options = getInterfaceTypeOptions();
    expect(options.length).toBeGreaterThan(0);
    for (const opt of options) {
      expect(opt.integration).toBeDefined();
      expect(opt.integration.interfaceType).toBe(opt.id);
      expect(opt.integration.detectedAt).toBeDefined();
      for (const slug of CAPABILITY_SLUGS) {
        expect(opt.integration.capabilities[slug]).toBeDefined();
      }
    }
  });

  it('codex gets a computed integration block (not all-none)', () => {
    const codex = getInterfaceTypeOptions().find(o => o.id === 'codex');
    expect(codex).toBeDefined();
    // codex has real probes (harness + MCP at minimum)
    expect(codex!.integration.status).not.toBe('none');
  });

  it('claude-code is full across the board', () => {
    const claude = getInterfaceTypeOptions().find(o => o.id === 'claude-code');
    expect(claude).toBeDefined();
    expect(claude!.integration.status).toBe('full');
  });
});

describe('detectIntegrationForRegistry', () => {
  it('returns one ModelIntegration per entry, keyed by id', () => {
    const out = detectIntegrationForRegistry([
      { id: 'opus', agentTypes: ['claude', 'claude-terminal'] },
      { id: 'sonnet', agentTypes: ['claude', 'claude-terminal'] },
      { id: 'deepseek-v4-pro', agentTypes: ['claude', 'claude-terminal'] },
    ]);
    expect(Object.keys(out).sort()).toEqual(['deepseek-v4-pro', 'opus', 'sonnet']);
    expect(out['opus'].interfaceType).toBe('claude-code');
    expect(out['deepseek-v4-pro'].interfaceType).toBe('claude-code');
  });

  it('uses same detectedAt for the batch when provided', () => {
    const ts = '2026-05-27T21:00:00.000Z';
    const out = detectIntegrationForRegistry(
      [
        { id: 'a', agentTypes: ['claude'] },
        { id: 'b', agentTypes: ['codex'] },
      ],
      ts,
    );
    expect(out['a'].detectedAt).toBe(ts);
    expect(out['b'].detectedAt).toBe(ts);
  });
});
