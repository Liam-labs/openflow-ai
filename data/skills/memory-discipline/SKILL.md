---
name: memory-discipline
description: >
  Preserve durable context without turning activity history into permanent
  instructions. Use when deciding whether a lesson is worth saving, choosing
  between handoff, today.md, MEMORY.md, Expertise.md, qdrant, or the central KB,
  pruning stale memory, or troubleshooting cross-session continuity.
---

# Memory Discipline

Memory should make the next session smarter, not heavier. Current assignments,
rules, and files always outrank remembered state.

## What to Keep

Save a fact only when it is durable, non-obvious, and likely to change later
work. Good candidates are stable user preferences, architectural decisions,
system ownership, tricky codebase patterns, and causes or fixes likely to recur.

Do not preserve routine steps, status chatter, raw logs, hashes, verdicts,
attempt-by-attempt narratives, or speculative rules. DevFlow activity history
already records them.

## Choose One Home

| Need | Destination |
|---|---|
| Work the next session must resume | `logs/handoff.md` |
| Short current-session summary | `logs/today.md` |
| Personal user or workflow preference | `MEMORY.md` |
| Project-specific code or debugging pattern | `Expertise.md` |
| Team-searchable operational fact | qdrant |
| Maintained platform or system documentation | `central-knowledge-base/` |

Keep a new handoff to the four baseline fields `STATUS`, `LAST_ACTED`, `PENDING`,
and `DO_NOT_REPEAT`. Add `BLOCKERS`, `RETURN_POINT`, or `REMAINING_DONE_WHEN`
only when the field records real resume information; omit empty optional fields
rather than writing `none`.

Use the narrowest canonical destination. Do not copy the same lesson across
several tiers; link to the authoritative source when another index needs it.

## Write and Maintain

- Capture the lesson at a natural checkpoint while the evidence is fresh.
- State the fact, why it matters, and when it applies in a few lines.
- Verify the target path and reread the saved entry.
- Correct or remove stale entries when current state disproves them.
- Prune and consolidate when a memory file becomes hard to scan.

At startup, always read the current handoff, `MEMORY.md`, `Expertise.md`, and
ownership context. They are part of the agent's functional operating context,
not optional background. Apply their durable facts and preferences while using
current explicit instructions and files to resolve conflicts. Older session logs
remain on demand.

If persistence fails, confirm the runtime's actual memory path before writing.
Never infer success merely from an intended write.
