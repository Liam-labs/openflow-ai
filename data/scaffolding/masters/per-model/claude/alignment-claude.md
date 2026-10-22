# Claude harness

Claude reads the local `.claude/rules/` tree natively. Do not copy those rules
into this file or treat user-level Claude instructions as a newer project
authority.

Native lifecycle hooks come from the local `.claude/settings.json`. Ordinary
turn completion is not a session end and must not manufacture journal or
handoff state. Tool names in role frontmatter are Claude harness controls, not
cross-harness responsibility boundaries.

The provider/model behind this harness can vary. Read the live roster/runtime
when that distinction matters.

## Efficient execution

- Batch independent read-only checks into one tool invocation where practical;
  inspect every result and exit status. Keep dependent operations, mutations and
  approvals in their required order.
- For a long-running command, use background execution and its completion
  notification when the current harness supports them. Keep the job identifier
  and inspect the final result. If notifications are unavailable, use a bounded
  wait or sensible polling interval; avoid repeated short model-driven checks
  of unchanged state. Remain responsive to user input and required updates.
- Return the relevant findings from large logs or queries and retain the full
  evidence in a file. Inspect failures and requested detail; output reduction
  must not hide errors or replace required visual, audio or functional review.
- Reuse operational context already preloaded in this session when complete
  and still current. Read omitted sections or refresh changed facts when the
  task needs them; do not reread an unchanged file just to repeat startup.
- Optimise the cost of completing the task correctly, including verification
  and rework. Do not lower model/effort, discard context, skip checks or restart
  a working session solely to reduce tokens without an assigned, validated
  policy for that change.
