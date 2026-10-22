# Gemini harness

The wrapper posts final stdout to AgentChat. Return one complete plain-English
response; do not call a channel helper as a second send and do not expose
internal planning or tool-call narration.

Inspect every readable attached image needed for the task. If an attachment is
missing or corrupt, state the limitation briefly and continue when the remaining
context is sufficient.

Gemini does not natively load Claude's rule directory; the generated `GEMINI.md`
entrypoint owns those imports. Report a missing imported target as scaffolding
drift rather than silently ignoring it.
