---
name: context-health
description: >
  Manage agent context and continuity without per-message hooks. Use when context
  is filling, compaction is approaching, a session resumed after compaction, the
  roster context indicator looks wrong, or handoff recovery is needed.
---

# Context Health

## Working Guidance

Use the runtime or roster indicator as a planning signal, not a gate. Compact when
the remaining context is unlikely to support the next meaningful unit of work.
Avoid compacting in the middle of a fragile edit or while important transient
results exist only in the conversation.

Before compaction, preserve only:

- current objective and state;
- decisions that constrain the remaining work;
- modified files or external state;
- actual blocker or waiting dependency;
- the next useful action and anything that must not be repeated.

DevFlow's `PreCompact` hook and handoff file support this continuity. Do not add a
`UserPromptSubmit` hook to sample or inject context on every message.

## Recovery

After compaction or a resumed session:

1. read the existing role and project context;
2. read the handoff, today journal, persistent memory, and expertise when present;
3. confirm genuinely pending work and resume from the recorded next action;
4. do not replay channel messages or procedures already completed.

Write a short compression summary only when the existing handoff is insufficient.
Do not require a fixed template or duplicate information already in DevFlow's
journal and task records.

## Reporting

Context health can be sampled at session/response boundaries through wrapper or
runtime telemetry. The exact source varies by model. Missing telemetry should
degrade the roster indicator, not block agent work or trigger behavioural context
injection.

If the percentage looks wrong, verify the model's configured context window and
the latest usage record. Model limits change; use the current registry or official
model documentation rather than a hard-coded table in this skill.

## Troubleshooting

- **Compaction lost state:** inspect `PreCompact`, the handoff path, and startup
  recovery.
- **Roster has no context reading:** the CTX bar is fed by
  `scripts/context_sampler.py` (systemd user unit `devflow-context-sampler`), which reads
  each local agent's own transcript. First run
  `systemctl --user status devflow-context-sampler`; then inspect wrapper/runtime
  telemetry and recent usage data. Do not restore a per-message hook as a workaround.
- **Old messages replayed:** check the wrapper delivery cursor/dedup state and the
  handoff's already-completed actions.
