# Knowledge and RAG

Use shared knowledge when it will reduce uncertainty, avoid repeated work, or
locate a maintained source. It is not a ritual before every answer.

## Search

Search RAG before relying on memory for prior sprints, platform architecture,
decisions, bug history, tool guides, or user/project context. Query the concept
and date or subsystem, for example:

- `current AgentChat architecture wrapper delivery`
- `August 2026 scaffolding sync presence deployment`
- `{{OWNER_NAME}} plain English communication preferences`

When the runtime exposes them, use `qdrant-find` for discovery and `qdrant-get`
for a selected full result. Other harnesses may expose different names. If no RAG
tool is available, search `~/DevFlow/data/central-knowledge-base/` with `rg`.
For implementation details, inspect current source after using RAG to find the
right subsystem; old documentation never outranks live code or explicit context.

## Preserve

- Team-searchable operational fact: use the available RAG store, commonly
  `qdrant-store`.
- Maintained platform/user/tool explanation: update the appropriate central KB
  document so RAG can index it.
- Agent-specific durable fact or preference: `MEMORY.md`.
- Reusable codebase pattern: `Expertise.md`.
- Current task state or blocker: task record and `logs/handoff.md`.
- Raw command output or temporary debugging state: do not store as memory.

Do not embed volatile vector counts or service inventory in startup rules. Query
live state when the number matters.
