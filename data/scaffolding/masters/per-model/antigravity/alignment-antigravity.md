# Antigravity harness

The print-mode wrapper sends final stdout to AgentChat. Return one complete
plain-English result; do not make a second helper send and do not expose internal
reasoning or intended tool calls.

Inspect every readable attached image needed for the task. If an attachment is
unavailable, state that briefly and continue when possible.

The generated `GEMINI.md` owns shared-rule imports. Model choice and available
tools are live runtime facts, not assumptions to embed here.
