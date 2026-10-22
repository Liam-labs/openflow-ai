---
name: hook-mgmt
description: >
  Manage DevFlow's session-bound hook system. Use when changing SessionStart,
  PreCompact, or Stop continuity hooks; auditing hook configuration; removing
  legacy UserPromptSubmit or TaskCompleted hooks; or troubleshooting hook
  telemetry and rollout.
---

# Hook Management

Hooks preserve continuity at session boundaries. Behavioural policy belongs in
the durable scaffold, not in per-message injections.

## Policy

- Supported canonical events: `SessionStart`, `PreCompact`, and `Stop`.
- Do not add `UserPromptSubmit` hooks for context injection, policy reminders,
  board nudges, logging counters, frontend reminders, or health sampling.
- Do not add `TaskCompleted` hooks that impose language-specific build gates.
  Task verification is chosen by the owner and sprint risk.
- Preserve DevFlow's startup memory loading, compaction recovery, handoff, and
  session-end journal mechanisms.

## Canonical Hooks

| Event | Purpose | Script |
|-------|---------|--------|
| `SessionStart` | scratch initialisation and post-compaction recovery | `session-scratch-init.sh`, `post-compact-reinject.sh` |
| `PreCompact` | preserve concise active state | `pre-compact-write.sh` |
| `Stop` | finish session log/handoff bookkeeping | `write-session-end.sh` |

Wrappers that lack a native event may perform the equivalent action once at
session start or stop. They should not run a behavioural subprocess before each
message.

## Change and Deploy

1. Update the canonical generator in `scripts/patch-hooks.py` and the new-agent
   template in `scripts/rollout-agent-dirs.py`.
2. Keep `scripts/hooks/rollout-hooks.py` consistent.
3. For wrapper-managed runtimes, remove per-message call sites from the relevant
   `scripts/collab-*.py` file.
4. Preview native settings changes:

   ```bash
   python3 scripts/patch-hooks.py --dry-run
   ```

5. Apply them, then inspect a representative generated `settings.json`.
6. Run focused syntax/unit checks for the files changed.

`scripts/hooks/context-inject.py` is a deprecated no-op retained only so stale
sessions fail safely until their settings reload.

## Troubleshooting

- Missing startup context: inspect the scaffold imports and `SessionStart`, not a
  prompt hook.
- Missing handoff: inspect `PreCompact`/`Stop` execution and the session log path.
- Stale agent settings: run `scripts/patch-hooks.py` for that agent or fleet.
- Wrapper still injecting `<system-reminder>`: search the wrapper for a call to a
  prompt-received or before-inject hook and remove the call.

Telemetry may observe runtime behaviour, but it must not inject instructions or
become an acceptance gate.
