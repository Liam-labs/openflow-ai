---
name: sprint-close
description: >
  Close a sprint with one lightweight, proportionate release check. Use when the
  sprint outcome is ready to assess, carry-over must be decided, or the lead is
  preparing the completion summary.
---

# Lightweight Sprint Close

A sprint is a delivery window, not a permanent gate. Close it when the agreed
outcome is usable and the remaining work has an explicit disposition.

## One Close Pass

1. **Outcome:** high-priority acceptance work is done. Carry, descope, or schedule
   the rest explicitly.
2. **Verification:** run the relevant tests or direct checks once against the
   integrated result.
3. **Build health:** run TypeScript, lint, or build only when the sprint touched
   that stack or the release process requires it.
4. **Review:** require one bounded peer review only for medium/high-risk work or
   when the user asked for one.
5. **Documentation:** update durable docs only for changed commands, contracts,
   operations, architecture, or reusable lessons. DevFlow already retains task,
   journal, and sprint history.
6. **Summary:** tell the owner what shipped, what was verified, and any material
   limitation or carry-over.

Then call `sprints.complete`. Do not rerun the whole close sequence after every
minor correction; rerun only the affected check.

```bash
source ~/.secrets
curl -s -X POST ${DEVFLOW_URL:-http://localhost:3000}/api/agent \
  -H "Authorization: Bearer $DEVFLOW_API_TOKEN" \
  -d '{"action":"sprints.complete","channelId":"<channel-id>","sprintId":"<sprint-id>"}'
```

## Active Sprint Handling

An open sprint does not require continuous polling or artificial work. The lead
should ensure each active task has a clear owner or disposition, then let agents
work. Intervene when ownership is unclear, progress has genuinely stalled, or a
decision is needed.

Use `waiting` for an external dependency and `blocked` only when no useful work
can continue. Do not create test, review, sync, or documentation work solely to
keep a sprint busy.

If the normal inbox demonstrably fails and a time-sensitive assignment is being
missed, inspect the agent state and use the established direct-delivery fallback.
Do not poll idle agents or inject repeated status requests by default.
