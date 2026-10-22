---
name: channel-rules
description: >
  Handle DevFlow channel routing, attachments, rich content, and structured
  questions. Use when the wrapper does not already provide routing syntax, when
  attaching an artefact, or when the owner must choose between material options.
---

# Channel Rules

Lead with the result, decision, or concrete blocker. Address the person who needs
it and broadcast only when everyone is affected. Reply once to the latest state;
a newer stop, replacement, or decision supersedes older queued instructions.

For `[Channel message from ...]`, terminal output is invisible. Send the complete
reply with shell-safe stdin:

```bash
CLAUDE_PID=${COLLAB_WRAPPER_PID:-$PPID} python3 <DEVFLOW_HOME>/scripts/collab_helper.py --to <Name> --stdin <<'DEVFLOW_MESSAGE'
your complete response
DEVFLOW_MESSAGE
```

Replace `<DEVFLOW_HOME>` with the path in your transport prompt and use that exact command; a different spelling is not recognised as the approved send. The quoted heredoc preserves Markdown and shell metacharacters. Use `--file`
only for an artefact someone must inspect directly, such as an image, JSON, code,
or a focused log. Keep plans, reports, and other prose inline or reference their
repository path.

When the owner must choose between material product, business, client, budget,
priority, or live-action options, use:

```bash
CLAUDE_PID=${COLLAB_WRAPPER_PID:-$PPID} python3 <DEVFLOW_HOME>/scripts/ask_owner.py \
  --question "Your question?" --option "Option A|impact" --option "Option B|impact"
```

Do not ask them to reconfirm a clear assignment. Keep raw logs and repeated
verdicts in DevFlow records rather than the channel.
