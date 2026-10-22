# Adding a model runtime — operational guide

> How to add a new model runtime (another AI command-line tool) to OpenFlow, end to end.
> **Architecture:** see [ARCHITECTURE.md](../../ARCHITECTURE.md) for how a message reaches an agent.

---

## Overview

This guide walks through adding a new model runtime (e.g., `mistral-cli`, `llama-cpp`, or any future CLI tool) to OpenFlow's agent fleet. When complete, the new runtime will be:

- Provisionable via `roster.provision` in any channel
- Auto-detected by the Model Integration Framework (8 capability scores)
- Selectable in the ModelPicker UI (harness dropdown + model list)
- Optionally available as a Code Graph scan backend

**Prerequisites:** Familiarity with OpenFlow's scaffolding system (`data/scaffolding/adapters.py`, `manifest.json`) and the collab wrapper pattern (`scripts/collab-*.py`).

---

## Step 1: Register the Model

Add a `ModelEntry` to both `data/models.json` (seed) and `.AppData/models.json` (live). The seed file is the source of truth for fresh installs; the live file is what running code reads.

```json
{
  "id": "mistral-large",
  "label": "Mistral Large",
  "provider": "mistral",
  "classification": "llm",
  "tier": "powerful",
  "agentTypes": ["mistral"],
  "apiId": "mistral-large-latest",
  "capabilities": {
    "contextWindow": 128000,
    "toolUse": true,
    "supportsStreaming": true
  }
}
```

**Key fields:**

| Field | Purpose |
|-------|---------|
| `id` | Unique slug used in API calls and spawn commands |
| `agentTypes` | Which harnesses this model is compatible with. First entry is canonical — used by `inferAgentTypeForModel()` |
| `apiId` | The actual model string passed to the provider API (e.g., `-m <apiId>`) |
| `provider` | Which provider to use (must match a provider in the collab wrapper's config) |

**Verification:**
```bash
curl -s "http://localhost:3000/api/models?provider=mistral" | python3 -m json.tool | grep '"id"'
# Should show "mistral-large"
```

### Updating models for an existing runtime

When a provider releases a new model for a runtime OpenFlow already supports, do not repeat the new-runtime steps below. Use this shorter registry refresh:

1. Verify the provider/runtime model ID, then add the entry to both `data/models.json` (seed) and `.AppData/models.json` (live).
2. If a stable alias such as `opus` or `sonnet` means “latest”, repoint that alias to the new `apiId`; keep an explicit versioned entry as well.
3. Before removing an old ID, search live rosters and configured overrides for references. Coordinate any required roster migrations, then remove the retired release from both active registries so it no longer appears in selectors.
4. Append the retired IDs to the log below, trigger integration detection, then verify the public picker response and the Agent API response contain the intended active set and none of the retired rows.

The retirement log is the human-readable archive; do not create a second active registry.

#### Retirement log

| Retired | Provider family | IDs removed from active selectors | Replacement |
|---|---|---|---|
| 2026-09-02 | Claude Opus | `opus[1m]`, `opus-4-5`, `opus-4-6`, `opus-4-6-1m`, `opus-4-7`, `opus-4-7-1m`, `opus-4-8` | `opus` / `opus-5` |
| 2026-09-02 | Claude Sonnet | `sonnet-1m`, `sonnet-4-5`, `sonnet-4-6` | `sonnet` / `sonnet-5` |

---

## Step 2: Create the Scaffolding Adapter

Add an adapter class to `data/scaffolding/adapters.py`. The adapter tells `sync.py` what files to deploy and what hook coverage level to report.

```python
class MistralAdapter(BaseAdapter):
    family = 'mistral'
    matches_conditions = ['agentType:mistral']
    hook_coverage_level = 'log-only'  # Start here; promote to 'full' when hooks land
    settings_managed_by_wrapper = True
```

Register it in `ADAPTER_REGISTRY` — order matters: place it before the catch-all ClaudeAdapter:

```python
ADAPTER_REGISTRY = [
    AntigravityAdapter,
    HermesAdapter,
    MistralAdapter,       # ← new
    GeminiAdapter,
    # ...
]
```

**`hook_coverage_level` determines two capability scores:**
- `'none'` → hooks=`none`, telemetry=`none`
- `'log-only'` → hooks=`partial`, telemetry=`partial`
- `'full'` → hooks=`full`, telemetry=`full`

**Verification:**
```bash
cd ~/DevFlow && python3 data/scaffolding/sync.py --adapters --json | python3 -c "
import sys,json
data=json.load(sys.stdin)
for a in data['adapters']:
    if a['family']=='mistral': print(a)
"
# Should show family='mistral' with hook_coverage_level
```

---

## Step 3: Add Manifest Entries

Add entries to `data/scaffolding/manifest.json` gated on `"condition": "agentType:mistral"`. At minimum you need an AGENTS.md entry template — that's what `sync.py` deploys to each agent's working directory.

```json
{
  "condition": "agentType:mistral",
  "category": "alignment",
  "source": "templates/alignment-mistral.md",
  "target": "AGENTS.md"
},
{
  "condition": "agentType:mistral",
  "category": "settings",
  "source": "templates/settings-mistral.json",
  "target": ".mistral/settings.json"
}
```

The `detectScaffolding()` function auto-counts entries matching `agentType:mistral`:
- 2+ entries → `full`
- 1 entry → `partial`
- 0 entries → `none`

**Create the template file** at `data/scaffolding/masters/per-model/mistral/MISTRAL.md.tmpl` (or equivalent). Reference existing templates like `per-model/hermes/HERMES.md.tmpl` for the pattern.

**Verification:**
```bash
grep -c 'agentType:mistral' ~/DevFlow/data/scaffolding/manifest.json
# Should return ≥ 2
```

---

## Step 4: Create the Collab Wrapper

Create `scripts/collab-mistral.py`. Every non-Claude runtime needs a one-shot or long-lived wrapper that:

1. Polls the collab channel for new messages
2. Invokes the runtime CLI for each user message
3. Captures output and posts back
4. Optionally records hook fires to `hook-events.jsonl`

Follow the pattern from `scripts/collab-hermes.py` (one-shot per-turn) or `scripts/collab-gemini.py` (long-lived subprocess).

**Critical contract:** The file must exist at `scripts/collab-{agentType}.py`. `detectHarness()` checks for its presence — binary signal: exists → `full`, missing → `none`.

**Verification:**
```bash
ls -la ~/DevFlow/scripts/collab-mistral.py
# Should exist and be executable
```

---

## Step 5: Add Message Inject Branch

Add a branch to the PTY message-injection dispatcher (`lib/message-inject.ts` or equivalent) so the collab system knows how to send messages to your runtime:

```typescript
// In message-inject.ts spawn path (pseudocode)
if (agentType === 'mistral') {
  spawnArgs = ['python3', 'scripts/collab-mistral.py', '--channel', channelId];
}
```

`detectFeed()` searches for `agentType === 'mistral'` or `isMistral =` patterns in the file. Binary signal: found → `full`, not found → `none`.

**Verification:**
```bash
grep -c "agentType.*mistral\|isMistral" ~/DevFlow/lib/message-inject.ts
# Should return ≥ 1
```

---

## Step 6: Map the Interface Type

Add an entry to `AGENT_TYPE_TO_INTERFACE` in `lib/model-integration-detect.ts`:

```typescript
const AGENT_TYPE_TO_INTERFACE: Record<string, string> = {
  // ... existing entries ...
  mistral: 'mistral-cli',
};
```

Then add human-readable metadata to `INTERFACE_TYPE_META`:

```typescript
const INTERFACE_TYPE_META: Record<string, { label: string; description: string }> = {
  'mistral-cli': {
    label: 'Mistral CLI',
    description: "Mistral's CLI with native tool-use support; SG-1 wraps via collab-mistral.py.",
  },
};
```

This single map drives both `pickInterfaceType()` (used by detection) and `getInterfaceTypeOptions()` (used by the interface-types API). One entry → appears everywhere.

**Verification:**
```bash
curl -s "http://localhost:3000/api/models/interface-types" | python3 -m json.tool | grep mistral
# Should show the new interface type
```

---

## Step 7: Run Integration Detection

Trigger a fresh detection pass. This is idempotent — if nothing changed, it writes nothing:

```bash
cd ~/DevFlow   # or the folder you cloned; .env there holds DEVFLOW_API_TOKEN
set -a; source .env; set +a
curl -s -X POST http://localhost:3000/api/models/detect \
  -H "Authorization: Bearer $DEVFLOW_API_TOKEN" | python3 -m json.tool
```

Expected output:
```json
{
  "success": true,
  "modelsChecked": 12,
  "modelsWritten": 1,
  "wrote": true,
  "writes": ["mistral-large"]
}
```

**Verify the integration block:**
```bash
curl -s "http://localhost:3000/api/models?includeIntegration=true&agentType=mistral" | python3 -m json.tool
```

The `integration` block should show scores across all 8 capabilities:
```json
"integration": {
  "status": "partial",
  "interfaceType": "mistral-cli",
  "detectedAt": "2026-06-05T...",
  "capabilities": {
    "hooks": "partial",
    "scaffolding": "full",
    "harness": "full",
    "feed": "full",
    "skills": "none",
    "mcp": "none",
    "memory": "partial",
    "telemetry": "partial"
  }
}
```

---

## Step 8 (Optional): Enable Code Graph Backbone

To make this runtime a Code Graph scan backbone, add it to the `useDeepSeek` check (or equivalent) in `createLlmClientForModel()` in `lib/code-graph-worker.ts`:

```typescript
const useMistral = agentType === 'mistral';
if (useMistral) {
  return new MistralClient(config.model);
}
```

Without this step, Code Graph falls back to Anthropic SDK with a warning.

---

## Capability Reference

### Auto-detected (no code changes needed)

| Capability | Detection Source | Trigger |
|-----------|-----------------|---------|
| `hooks` | Adapter's `hook_coverage_level` | Step 2 |
| `scaffolding` | Manifest.json entry count | Step 3 |
| `harness` | `scripts/collab-{type}.py` exists | Step 4 |
| `feed` | Message-inject.ts branch exists | Step 5 |
| `telemetry` | Same as `hooks` | Step 2 |

### Manually assigned (code change required)

| Capability | File to Change | Default for New Runtimes |
|-----------|---------------|------------------------|
| `skills` | `detectSkills()` in `model-integration-detect.ts` | `none` — only Claude bridges SG-1 skills |
| `mcp` | `detectMcp()` in `model-integration-detect.ts` | `none` — add the runtime with `full`/`partial` if it natively loads MCP |
| `memory` | `detectMemory()` in `model-integration-detect.ts` | `none` — add with `partial` if session DB persistence exists |

---

## Common Pitfalls

### Seed vs Live drift
`data/models.json` (seed) and `.AppData/models.json` (live) must stay in sync. If you only update the live file, a fresh `npm run seed` will wipe your new model. Always update both.

### Missed agentType mapping
If `inferAgentTypeForModel()` returns `undefined` for your model, check that `agentTypes[0]` in models.json matches the string in `AGENT_TYPE_TO_INTERFACE`. The first entry is canonical.

### Adapter not in registry
`sync.py --adapters --json` only exposes adapters listed in `ADAPTER_REGISTRY`. Adding the class to `adapters.py` isn't enough — you must register it.

### Wrapper not picked up
`detectHarness()` does a simple `fs.existsSync` on `scripts/collab-{agentType}.py`. Case sensitivity matters. The filename must match exactly.

### Integration block missing after detection
If `POST /api/models/detect` returns `modelsWritten: 0` but the integration block is absent, check:
- Is the model's `agentTypes` array non-empty?
- Does the first `agentTypes` entry have an entry in `AGENT_TYPE_TO_INTERFACE`?
- Are manifest entries gated on the right condition string (`agentType:mistral`, not `agentType: mistral` with a space)?

---

## Quick Debug Commands

```bash
# What integration scores does the framework see right now?
curl -s "http://localhost:3000/api/models?includeIntegration=true" | python3 -c "
import sys,json
data=json.load(sys.stdin)
for m in data['models']:
    integ = m.get('integration',{})
    if integ:
        caps = integ.get('capabilities',{})
        fulls = sum(1 for v in caps.values() if v=='full')
        print(f'{m[\"id\"]:25} status={integ.get(\"status\",\"?\"):7} fulls={fulls}/8')
"

# Force a re-detect
curl -s -X POST http://localhost:3000/api/models/detect

# Filter by capability (e.g., find all models with full harness support)
curl -s "http://localhost:3000/api/models?includeIntegration=true&capability=harness:full"
```

---

## Next Steps After Integration

Once the runtime is live:
1. Provision a test agent: `roster.provision` with `agentType: 'mistral'`
2. Verify message delivery end-to-end (user message → agent responds → channel)
3. Check hook telemetry: `_telemetry tail --filter hook=mistral-shim`
4. File any gaps as tasks on the sprint board
5. Update the "When to choose" table in `hermes-agent.md` (or the runtime's equivalent KB page)
