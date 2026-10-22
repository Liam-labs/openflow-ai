---
name: scaffolding-sync
description: >
  Audit, deploy, verify, or provision DevFlow agent scaffolding from the
  canonical manifest, masters, harness adapters, roles and personalities.
---

# Scaffolding Sync

Use `data/scaffolding/sync.py` from the DevFlow root. It deploys canonical files
to every dedicated roster presence, keeps runtime entrypoints harness-specific,
and safely maintains role/personality pointers. Shared project roots are reported
as externally managed and are not written. Ambiguous project-owned identity
prose is preserved.

## Commands

| Need | Command |
|---|---|
| Read-only presence-aware drift | `python3 data/scaffolding/sync.py --check` |
| Structured read-only verification | `python3 data/scaffolding/sync.py --verify-only --json` |
| Preview all writes | `python3 data/scaffolding/sync.py --dry-run` |
| Deploy and auto-verify | `python3 data/scaffolding/sync.py` |
| One agent | `python3 data/scaffolding/sync.py --agent <Name>` |
| One manifest entry | `python3 data/scaffolding/sync.py --file <id>` |
| Adapter diagnostics | `python3 data/scaffolding/sync.py --adapters [--agent <Name>]` |
| Decision manifest | `python3 data/scaffolding/sync.py --manifest --agent <Name>` |
| New agent | `python3 data/scaffolding/sync.py --new-agent <Name> --role <Role> --models <list> --agent-type <harness>` |

`--check`, `--verify-only`, and `--dry-run` do not write. Do not use
`--skip-presences` for a fleet audit. `--no-verify` is a troubleshooting escape
hatch, not a normal deploy mode.

## Sources and precedence

- `manifest.json` declares static masters, targets, overwrite policy and
  `agentType:<harness>`/channel conditions.
- `masters/global/` contains common compact policy/context.
- `masters/per-agent/` contains rendered workspace/startup/handoff seeds.
- `masters/per-model/` is named historically; its entries are harness overlays.
- `adapters.py` owns entrypoint imports, hook capability and harness alignment.
- `.AppData/scaffolding/agents.json` is the baseline deploy roster.
- `.AppData/collab-channels.json` supplies live project presences, harness,
  role ID and personality.
- `data/roles/` and `data/roles/personalities/` are canonical identity sources.

Provider, model ID and harness are separate axes. Alignment coverage checks
adapters which declare an alignment file; it does not demand one file for every
provider. Model-registry differences are advisory and do not become file-drift
failure gates.

## Safe identity and MCP behaviour

`Directives.md` and `Personality.md` are tiny live pointers. Sync creates or
updates a missing file, placeholder, managed pointer, or exact frozen canonical
copy. It preserves any ambiguous custom prose as `agent-owned`; review that
override deliberately rather than overwriting it fleet-wide.

The Outlook master manages only `mcpServers.outlook`. Sync migrates that entry to
the shared HTTP service and preserves every unrelated server/key in `.mcp.json`.
Malformed JSON is an error because guessing would destroy configuration.

## Change procedure

1. Inspect the current master, manifest target, adapter/load path and relevant
   tests. Do not edit a deployed copy as the source of truth.
2. Make the smallest canonical change. Put detailed procedure in a skill/KB,
   shared behaviour in the operating agreement, and runtime-only behaviour in an
   alignment overlay.
3. Add or update a focused contract test.
4. Run targeted tests and `sync.py --dry-run`.
5. Deploy with `sync.py`; let its automatic presence-aware verifier run.
6. Run `--check` once more. Investigate real file/load defects; do not turn an
   advisory model warning or preserved project override into a blanket blocker.

## Troubleshooting

- **Wrong project in Workspace:** check the roster's
  `effectiveWorkingDirectory`; a dedicated presence must be
  `<project>/Team/<agent>`.
- **Alignment landed but is not read:** check the adapter's `entry_template_id`,
  required imports, and the wrapper's actual prompt builder.
- **Identity preserved as agent-owned:** compare it with the canonical role or
  personality and migrate only if it is a stale copy, not intentional local
  policy.
- **Fresh sync still differs:** compare the sync and verifier rendering paths;
  both must call the same adapter post-processor and managed-entry merge.
- **Seeds:** `data/scaffolding/seeds/` is a future design note. There is no
  `--seed-only` mode or `/api/agent/context` broker today.
