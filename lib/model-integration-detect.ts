/**
 * Model Integration Detection — Sprint M P1 T2 (Reynolds, 2026-05-27).
 *
 * Derives a `ModelIntegration` block for a model by reading existing
 * infrastructure: scaffolding adapters, scaffolding manifest, wrapper
 * scripts, message-inject dispatcher branches, skill directories, MCP
 * support flags, harness session-end behaviour, and telemetry wiring.
 *
 * **NEVER hand-maintained.** A separate `POST /api/models/detect` endpoint
 * (Sprint M Phase 1.4) calls `detectIntegrationForModel()` and writes the
 * result back into models.json. Consumers (Systems "Models" tab UI,
 * `/api/models` listing, drift detection) read the persisted block —
 * they do NOT call the detector on every read.
 *
 * Design references:
 *   - docs/plan-model-integration-framework.md §1.2 (signal sources)
 *   - lib/model-registry.ts (CapabilityLevel + ModelIntegration types)
 *   - data/scaffolding/adapters.py ADAPTER_REGISTRY (hook_coverage_level)
 *
 * Aggregation rule (Sam's plan §1.5): all 8 `full` → `full`;
 *   ≥4 `full` → `partial`; <4 → `none`.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { CapabilityLevel, ModelIntegration } from './model-registry';

import { getDevflowHome, getHomeDir } from '@/lib/home-dir';
import { PRODUCT_NAME } from '@/lib/brand';
const DEVFLOW_HOME = getDevflowHome();

// ---------------------------------------------------------------------------
// Capability slug enum — keep stable across versions. Adding a new slug is
// safe (consumers treat unknown as 'none'); removing or renaming one is a
// breaking change to the API contract.
// ---------------------------------------------------------------------------

export const CAPABILITY_SLUGS = [
  'hooks',
  'scaffolding',
  'harness',
  'feed',
  'skills',
  'mcp',
  'memory',
  'telemetry',
] as const;
export type CapabilitySlug = (typeof CAPABILITY_SLUGS)[number];

// ---------------------------------------------------------------------------
// interfaceType mapping (Sam's plan §1.3). Open string — but these are the
// canonical labels the detector emits today. New wrappers add a new label.
// ---------------------------------------------------------------------------

const AGENT_TYPE_TO_INTERFACE: Record<string, string> = {
  claude: 'claude-code',
  'claude-terminal': 'claude-code',
  codex: 'codex',
  antigravity: 'antigravity',
  gemini: 'gemini-cli',
  'gemini-terminal': 'gemini-cli',
  'gemini-powershell': 'gemini-cli',
  grok: 'grok-cli',
  ollama: 'ollama',
  'ollama-terminal': 'ollama',
};

// ---------------------------------------------------------------------------
// Adapter registry — sourced from `sync.py --adapters --json`. We invoke the
// Python helper ONCE per detect() call (cached for the call) so the detector
// doesn't drift if adapters.py changes shape.
// ---------------------------------------------------------------------------

interface AdapterInfo {
  family: string;
  matches_conditions: string[];
  hook_coverage_level: 'none' | 'log-only' | 'full';
  settings_managed_by_wrapper: boolean;
  required_import_count: number;
  entry_template_id: string | null;
}

let _adapterCache: AdapterInfo[] | null = null;
function getAdapterRegistry(): AdapterInfo[] {
  if (_adapterCache) return _adapterCache;
  try {
    const out = execFileSync(
      'python3',
      [path.join(DEVFLOW_HOME, 'data', 'scaffolding', 'sync.py'), '--adapters', '--json'],
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const parsed = JSON.parse(out) as { adapters: AdapterInfo[] };
    _adapterCache = parsed.adapters ?? [];
  } catch {
    _adapterCache = [];
  }
  return _adapterCache;
}

/** Reset the per-detect cache. Call between detect passes if adapters.py
 *  changed mid-process (test harness uses this). Otherwise the in-process
 *  cache is fine — the registry is small and the file rarely changes. */
export function resetAdapterCache(): void {
  _adapterCache = null;
}

function findAdapterForAgentType(agentType: string): AdapterInfo | undefined {
  const reg = getAdapterRegistry();
  // adapters publish `matches_conditions` like ['model:gpt-5.6-sol'] or
  // ['agentType:antigravity']. Strip prefix + match against agentType.
  return reg.find((a) =>
    a.matches_conditions.some((c) => {
      const idx = c.indexOf(':');
      const tail = idx >= 0 ? c.slice(idx + 1).toLowerCase() : c.toLowerCase();
      return tail === agentType.toLowerCase();
    }),
  );
}

// ---------------------------------------------------------------------------
// File-system probes — synchronous, cheap. All paths anchored to DEVFLOW_HOME
// so the detector works under DEVFLOW_HOME override in test environments.
// ---------------------------------------------------------------------------

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function getAgentDirsForType(agentType: string): string[] {
  const at = agentType.toLowerCase();
  const dirs = new Set<string>();

  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };

  const appDataCollab = path.join(DEVFLOW_HOME, '.AppData', 'collab-channels.json');
  const legacyCollab = path.join(DEVFLOW_HOME, 'data', 'collab-channels.json');
  let collabRaw = '';
  try {
    if (fileExists(appDataCollab)) {
      collabRaw = readFileSync(appDataCollab, 'utf-8');
    } else if (fileExists(legacyCollab)) {
      collabRaw = readFileSync(legacyCollab, 'utf-8');
    }
  } catch {
    // Ignore
  }

  if (collabRaw) {
    try {
      const data = JSON.parse(collabRaw);
      if (data && Array.isArray(data.channels)) {
        for (const ch of data.channels) {
          if (ch.roster && Array.isArray(ch.roster.agents)) {
            for (const agent of ch.roster.agents) {
              if (agent.agentType && agent.agentType.toLowerCase() === at) {
                const dir = agent.effectiveWorkingDirectory || agent.workingDirectory;
                if (dir && isDir(dir)) dirs.add(dir);
              }
            }
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  const agentsJsonPath = path.join(DEVFLOW_HOME, '.AppData', 'scaffolding', 'agents.json');
  let agentsRaw = '';
  try {
    if (fileExists(agentsJsonPath)) {
      agentsRaw = readFileSync(agentsJsonPath, 'utf-8');
    }
  } catch {
    // Ignore
  }

  if (agentsRaw) {
    try {
      const data = JSON.parse(agentsRaw);
      if (data && Array.isArray(data.agents)) {
        for (const agent of data.agents) {
          if (agent.agentType && agent.agentType.toLowerCase() === at && agent.name) {
            const dir = path.join(DEVFLOW_HOME, 'Team', agent.name);
            if (isDir(dir)) dirs.add(dir);
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  if (dirs.size === 0) {
    const teamDir = path.join(DEVFLOW_HOME, 'Team');
    try {
      const entries = readdirSync(teamDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== '.' && entry.name !== '..') {
          const dir = path.join(teamDir, entry.name);
          dirs.add(dir);
        }
      }
    } catch {
      // Ignore
    }
  }

  return Array.from(dirs);
}

function readManifest(): { files?: Array<{ condition?: string; category?: string }> } {
  try {
    return JSON.parse(
      readFileSync(path.join(DEVFLOW_HOME, 'data', 'scaffolding', 'manifest.json'), 'utf-8'),
    );
  } catch {
    return { files: [] };
  }
}

// ---------------------------------------------------------------------------
// Per-capability detectors. Each returns a CapabilityLevel based on signals
// the function can read directly. All are pure besides the filesystem reads.
// ---------------------------------------------------------------------------

/**
 * `hooks` — read straight from the adapter registry's hook_coverage_level.
 * Mapping: 'full' → 'full', 'log-only' → 'partial', 'none'/missing → 'none'.
 */
function detectHooks(agentType: string): CapabilityLevel {
  const adapter = findAdapterForAgentType(agentType);
  if (!adapter) return 'none';
  if (adapter.hook_coverage_level === 'full') return 'full';
  if (adapter.hook_coverage_level === 'log-only') return 'partial';
  return 'none';
}

/**
 * `scaffolding` — manifest.json entries matching `agentType:X` condition.
 * 2+ per-model entries (alignment + entry-template) → 'full';
 * 1 entry → 'partial'; none → 'none'.
 */
function detectScaffolding(agentType: string): CapabilityLevel {
  const at = agentType.toLowerCase();
  // Claude is the default-deploy target — globals + model:claude condition
  // entries land on every Claude agent without needing an agentType:claude
  // gate. Aligns with the gold-standard 'full' Sam's plan §1.5 expects.
  if (at === 'claude' || at === 'claude-terminal') return 'full';
  const m = readManifest();
  const condAgent = `agenttype:${at}`;
  const condModel = `model:${at}`;
  const matches = (m.files ?? []).filter((e) => {
    const c = (e.condition || '').toLowerCase();
    return c === condAgent || c === condModel;
  });
  if (matches.length >= 2) return 'full';
  if (matches.length === 1) return 'partial';
  return 'none';
}

/**
 * `harness` — `scripts/collab-{agentType}.py` exists. Binary signal: the
 * wrapper either exists (long-running poll loop, lifecycle hooks) or doesn't
 * (no DevFlow-owned process).
 */
function detectHarness(agentType: string): CapabilityLevel {
  const wrapper = path.join(DEVFLOW_HOME, 'scripts', `collab-${agentType.toLowerCase()}.py`);
  return fileExists(wrapper) ? 'full' : 'none';
}

/**
 * `feed` — dedicated `isAntigravity`/`isCodex`/etc branch in
 * message-inject.ts. If present, the dispatcher routes the agentType to its
 * own wrapper; if absent, it falls through to the Claude default which
 * almost always produces broken behaviour for non-Claude types.
 */
function detectFeed(agentType: string): CapabilityLevel {
  // Claude IS the default path in message-inject — there's no `isClaude`
  // branch because every non-Claude branch is an `else if` against the
  // Claude fallback. Treat as 'full'.
  const at = agentType.toLowerCase();
  if (at === 'claude' || at === 'claude-terminal') return 'full';
  try {
    const src = readFileSync(
      path.join(
        DEVFLOW_HOME,
        'app',
        'api',
        'collab',
        'pty',
        '_handlers',
        'message-inject.ts',
      ),
      'utf-8',
    );
    // Look for `agentType === '<X>'` direct equality OR the
    // `is<Capitalised>` boolean flag. Either signals a dedicated branch.
    const cap = agentType.charAt(0).toUpperCase() + agentType.slice(1).toLowerCase();
    if (src.includes(`agentType === '${at}'`)) return 'full';
    if (src.includes(`is${cap} =`)) return 'full';
    return 'none';
  } catch {
    return 'none';
  }
}

/**
 * `skills` — SG-1 skill bridge detection via file-probe.
 *
 * Claude: native 'full' (scaffolding deploys SG-1 skills to `~/.claude/skills/`
 * per agent, invokable via /name).
 *
 * Non-Claude: probes the wrapper for per-runtime skill signals:
 *   - `skill-index`  → skill-index.md injection (Codex/AG/Gemini/Grok S2.3-S2.6)
 *   - `SKILL.md`     → direct skill file reference (legacy / Grok)
 *
 * Any match → 'full'. No match → 'none'. No hardcoded per-model mapping.
 */
function detectSkills(agentType: string): CapabilityLevel {
  const at = agentType.toLowerCase();
  if (at === 'claude' || at === 'claude-terminal') return 'full';

  const wrapperPath = path.join(DEVFLOW_HOME, 'scripts', `collab-${at}.py`);
  try {
    const src = readFileSync(wrapperPath, 'utf-8');
    // Skill index injection: skill-index.md or skill_index references (S2.3-S2.6)
    if (src.includes('skill-index')) return 'full';
    // Direct SKILL.md reference (legacy probe, also catches Grok _build_scaffolded_prompt)
    if (src.includes('SKILL.md')) return 'full';
  } catch {
    // wrapper doesn't exist → no skill surface
  }
  return 'none';
}

/**
 * `mcp` — MCP (Model Context Protocol) tool availability via file-probe.
 *
 * Signals per runtime:
 *   - Claude: native MCP, configured globally per user → full.
 *   - Codex: native MCP (built into Codex CLI) → full.
 *   - Gemini: `~/.gemini/settings.json` contains `"mcpServers"` key → full.
 *   - Antigravity: wrapper contains `mcp` references → full.
 *   - Grok: API-native wrapper, no MCP bridge → none.
 *   - All others: none.
 */
function detectMcp(agentType: string): CapabilityLevel {
  const at = agentType.toLowerCase();

  // Claude Code: MCP is built in and the tools come from the user's global setup
  // (~/.claude.json, plugins, connectors), not from a file this server can probe.
  if (at === 'claude' || at === 'claude-terminal') return 'full';

  // Codex: native MCP support built into Codex CLI
  if (at === 'codex') return 'full';

  // Gemini: check .gemini/settings.json for mcpServers key
  if (at === 'gemini' || at === 'gemini-terminal' || at === 'gemini-powershell') {
    const home = getHomeDir();
    try {
      const settings = JSON.parse(
        readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf-8'),
      );
      return settings.mcpServers ? 'full' : 'none';
    } catch {
      return 'none';
    }
  }

  // Antigravity: agy loads MCP schemas from ~/.gemini/antigravity-cli/mcp/
  // (agy-generated per-server subdirectories containing .json tool schemas).
  // Each subdirectory = one live MCP server. If at least one schema dir
  // exists with .json files, agy surfaces those tools under --print mode.
  // ALSO check the agent-specific AGENT-DIR/.mcp.json to ensure it has defined servers.
  if (at === 'antigravity') {
    const home = getHomeDir();
    const mcpDir = path.join(home, '.gemini', 'antigravity-cli', 'mcp');
    let globalMcpValid = false;
    try {
      const entries = readdirSync(mcpDir, { withFileTypes: true });
      const schemaDirs = entries.filter(
        (e) => e.isDirectory() && e.name !== '.' && e.name !== '..',
      );
      if (schemaDirs.length > 0) {
        // Check at least one schema dir contains .json tool schemas
        for (const dir of schemaDirs) {
          const files = readdirSync(path.join(mcpDir, dir.name));
          if (files.some((f) => f.endsWith('.json'))) {
            globalMcpValid = true;
            break;
          }
        }
      }
    } catch {
      // ignore
    }

    if (!globalMcpValid) return 'none';

    // Now check AGENT-DIR .mcp.json
    const agentDirs = getAgentDirsForType('antigravity');
    if (agentDirs.length === 0) {
      // No antigravity agents found to check — default to global check result
      return 'full';
    }

    let agentMcpValid = false;
    for (const dir of agentDirs) {
      const mcpJsonPath = path.join(dir, '.mcp.json');
      if (fileExists(mcpJsonPath)) {
        try {
          const mcpContent = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
          if (
            mcpContent &&
            mcpContent.mcpServers &&
            typeof mcpContent.mcpServers === 'object' &&
            Object.keys(mcpContent.mcpServers).length > 0
          ) {
            agentMcpValid = true;
            break;
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    return agentMcpValid ? 'full' : 'none';
  }

  // Grok: API-native wrapper, no MCP bridge
  return 'none';
}

/**
 * `memory` — cross-session persistence via wrapper file-probe.
 *
 * Probes `scripts/collab-{agentType}.py` for:
 *   - `_build_scaffolded_prompt` + `MEMORY.md` → 'full' (wrapper loads the
 *     full CLAUDE.md hierarchy + persistent memory into every prompt).
 *   - `context-inject` only (no `_build_scaffolded_prompt`) → 'partial'
 *     (keyword-cluster context injection, but no cross-session MEMORY.md).
 *   - Neither → 'none' (stateless per call).
 *
 * Claude stays native 'full' — its MEMORY.md auto-load is built into the
 * Claude Code harness, not the wrapper.
 */
function detectMemory(agentType: string): CapabilityLevel {
  const at = agentType.toLowerCase();
  if (at === 'claude' || at === 'claude-terminal') return 'full';

  const wrapperPath = path.join(DEVFLOW_HOME, 'scripts', `collab-${at}.py`);
  let src: string;
  try {
    src = readFileSync(wrapperPath, 'utf-8');
  } catch {
    return 'none';
  }

  const hasScaffoldedPrompt = src.includes('_build_scaffolded_prompt');
  const hasMemoryMd = src.includes('MEMORY.md');
  const hasContextInject = src.includes('context-inject');

  if (hasScaffoldedPrompt && hasMemoryMd) return 'full';
  if (hasContextInject) return 'partial';
  return 'none';
}

/**
 * `telemetry` — wrapper invokes `_telemetry.sh`/`_telemetry.py` to record
 * hook fires. Signal: the wrapper file (already checked by detectHarness)
 * contains a `telemetry(` call or imports the telemetry module.
 */
function detectTelemetry(agentType: string): CapabilityLevel {
  // Telemetry tracks hook coverage in practice — wherever hooks fire, the
  // event lands in `~/DevFlow/.AppData/hook-events.jsonl` (either via
  // Claude Code's native hook system OR the wrapper's _telemetry.sh helper).
  // 'log-only' hook coverage produces fewer event types but the same surface.
  // Tying telemetry to hooks avoids double-penalising agents for the same
  // underlying gap; the wrapper's explicit telemetry() helper is defensive,
  // not an additional capability.
  const at = agentType.toLowerCase();
  // Claude has native Claude Code telemetry; no wrapper-side helper needed.
  if (at === 'claude' || at === 'claude-terminal') return 'full';
  const adapter = findAdapterForAgentType(agentType);
  if (!adapter) return 'none';
  if (adapter.hook_coverage_level === 'full') return 'full';
  if (adapter.hook_coverage_level === 'log-only') return 'partial';
  return 'none';
}

// ---------------------------------------------------------------------------
// Aggregator + public entry point.
// ---------------------------------------------------------------------------

/**
 * Aggregate per-capability levels into a single status per Sam's §1.5 rule:
 *   - all 8 `full` → `full`
 *   - ≥4 `full` → `partial`
 *   - <4 `full` → `none`
 *
 * Note: `partial` per-capability values DO NOT increment the `full` count
 * for the aggregation. They contribute to the per-capability surface but
 * the aggregate threshold is strictly on full-count, as Sam specified.
 */
export function aggregateStatus(
  capabilities: Record<CapabilitySlug, CapabilityLevel>,
): CapabilityLevel {
  if (capabilities.harness === 'none') return 'none';
  const fullCount = CAPABILITY_SLUGS.filter(
    (slug) => capabilities[slug] === 'full',
  ).length;
  if (fullCount === CAPABILITY_SLUGS.length) return 'full';
  if (fullCount >= 4) return 'partial';
  return 'none';
}

/**
 * Pick the canonical interfaceType label for a model. If the model has
 * multiple agentTypes, prefer the first one that maps. Falls back to the
 * raw agentType if no mapping is known (consumer can still render it).
 */
export function pickInterfaceType(agentTypes: string[]): string {
  for (const at of agentTypes) {
    if (AGENT_TYPE_TO_INTERFACE[at.toLowerCase()]) {
      return AGENT_TYPE_TO_INTERFACE[at.toLowerCase()];
    }
  }
  return agentTypes[0] ?? 'unknown';
}

/**
 * Canonical interface-type catalogue — Sprint M P3 T2 (Reynolds, 2026-05-27).
 *
 * One entry per distinct label `pickInterfaceType()` can emit. Includes a
 * short human description (consumed by ModelPicker's interface filter
 * dropdown) and the list of source agentTypes that map to this label
 * (lets UI explain why a model falls under a given interface — useful for
 * tooltip "this is the claude-code interface because the model declares
 * agentTypes:['claude','claude-terminal']").
 *
 * NOTE: keep in lockstep with `AGENT_TYPE_TO_INTERFACE` above. New
 * interface = add to both. Removed interface = remove from both.
 */
export interface InterfaceTypeOption {
  /** Canonical label, matches what pickInterfaceType emits. */
  id: string;
  /** Short human-friendly name for UI display. */
  label: string;
  /** One-line description for tooltips / dropdown caption. */
  description: string;
  /** agentTypes from models.json that map to this interface. Order matches
   *  the AGENT_TYPE_TO_INTERFACE table; first entry is the canonical one. */
  agentTypes: string[];
  /** Live integration depth for this interface type. Computed from the
   *  canonical agentTypes via the same probes the per-model detector uses.
   *  A6 — added so the interface-type filter dropdown can show a badge. */
  integration: ModelIntegration;
}

const INTERFACE_TYPE_META: Record<string, { label: string; description: string; retired?: boolean }> = {
  'claude-code': {
    label: 'Claude Code',
    description: `Anthropic's Claude CLI with native hook coverage + MCP + cross-session MEMORY.md persistence. Default ${PRODUCT_NAME} runtime.`,
  },
  codex: {
    label: 'Codex CLI',
    description: 'OpenAI Codex CLI with native MCP support; reads AGENTS.md context from cwd.',
  },
  antigravity: {
    label: 'Antigravity (Gemini)',
    description: "Google's Antigravity CLI wrapping Gemini (4 Argon, 3.8 Flash) with native MCP + skill support.",
  },
  'gemini-cli': {
    label: 'Gemini CLI',
    description: "Google's Gemini CLI with full hook lifecycle coverage; SG-1 wraps via collab-gemini.py.",
    // Retired 2026-10-02: Google ended Gemini CLI for individual accounts
    // ("migrate to Antigravity"). Gemini models run through Antigravity.
    retired: true,
  },
  'grok-cli': {
    label: 'Grok CLI',
    description: "xAI's Grok CLI with full hook lifecycle coverage; SG-1 wraps via collab-grok.py.",
  },
  ollama: {
    label: 'Ollama',
    description: "Local model runtime; SG-1 wraps via collab-agent.py.",
  },
};

/**
 * Return the canonical interface-type options the system supports today.
 *
 * Derived by inverting `AGENT_TYPE_TO_INTERFACE` so any addition to that
 * table automatically appears here — single source of truth.
 *
 * Unknown labels (i.e. an agentType→interface entry whose target isn't in
 * INTERFACE_TYPE_META) get a placeholder description so the API is still
 * useful for diagnostic dropdowns; meta should be filled in promptly.
 */
export function getInterfaceTypeOptions(): InterfaceTypeOption[] {
  // Group agentTypes by their canonical interface label.
  const byInterface: Record<string, string[]> = {};
  for (const [agentType, iface] of Object.entries(AGENT_TYPE_TO_INTERFACE)) {
    if (!byInterface[iface]) byInterface[iface] = [];
    byInterface[iface].push(agentType);
  }
  return Object.entries(byInterface)
    .filter(([id]) => !INTERFACE_TYPE_META[id]?.retired)
    .map(([id, agentTypes]) => {
      const meta = INTERFACE_TYPE_META[id];
      return {
        id,
        label: meta?.label ?? id,
        description: meta?.description ?? `${id} interface (no description registered).`,
        agentTypes,
        integration: detectIntegrationForModel(agentTypes),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Detect integration depth for a single model.
 *
 * @param agentTypes — the `agentTypes` array from the ModelEntry.
 * @param now — ISO timestamp injected for determinism in tests. Default = now.
 * @returns a populated `ModelIntegration` block. Never throws — failed
 *   signal reads degrade to 'none' silently.
 */
export function detectIntegrationForModel(
  agentTypes: string[],
  now: string = new Date().toISOString(),
): ModelIntegration {
  // Pick the primary agentType for capability lookups. Most models declare
  // one canonical type (claude, codex, ...) plus variants (claude-terminal).
  // The first one in the array is the canonical per models.json convention.
  const primary = agentTypes[0] ?? '';
  const capabilities: Record<CapabilitySlug, CapabilityLevel> = {
    hooks: detectHooks(primary),
    scaffolding: detectScaffolding(primary),
    harness: detectHarness(primary),
    feed: detectFeed(primary),
    skills: detectSkills(primary),
    mcp: detectMcp(primary),
    memory: detectMemory(primary),
    telemetry: detectTelemetry(primary),
  };
  return {
    status: aggregateStatus(capabilities),
    interfaceType: pickInterfaceType(agentTypes),
    detectedAt: now,
    capabilities,
  };
}

/**
 * Convenience: run detection across an arbitrary list of (modelId, agentTypes)
 * tuples. Used by `POST /api/models/detect` to refresh the whole registry.
 * Caller is responsible for persisting the result back to models.json under
 * an appropriate file lock.
 */
export function detectIntegrationForRegistry(
  entries: Array<{ id: string; agentTypes: string[] }>,
  now: string = new Date().toISOString(),
): Record<string, ModelIntegration> {
  const out: Record<string, ModelIntegration> = {};
  for (const e of entries) {
    out[e.id] = detectIntegrationForModel(e.agentTypes, now);
  }
  return out;
}
