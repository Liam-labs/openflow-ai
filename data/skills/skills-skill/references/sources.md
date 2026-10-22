# Sources and DevFlow Adaptation

Checked 8 October 2026 against the owner's ten supplied recommendations and these
primary sources:

- [Anthropic skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices): entrypoint length, reference discovery, descriptions, instruction freedom and model evaluation.
- [Complete Guide to Building Skills for Claude](https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf): use cases, workflow patterns, testing and distribution.
- [Anthropic skills repository](https://github.com/anthropics/skills): maintained examples and specification links. Example counts and licenses vary; inspect the individual license before reuse.
- [Claude Code hooks guide](https://code.claude.com/docs/en/hooks-guide): automatic lifecycle actions and checks; verify each hook's actual blocking behavior and coverage.

Distinctions:

- The official filename is uppercase `SKILL.md`.
- The 500-line target is authoring guidance; it is not a parser rejection limit.
- Anthropic calls for contents lists in references longer than 100 lines. DevFlow
  also applies the owner's requested convention to long entrypoints, after frontmatter.
- The partial-read concern is a reason to avoid nested dependencies, not a claim
  that every runtime always truncates every referenced file at 100 lines.
- Checklists are maintained in the reply or task record as appropriate; they do
  not override DevFlow's quiet channel-execution policy.
- Hard guardrails require tested enforcement at the relevant operation boundary.
  A hook cannot be assumed to cover every harness, alternate tool or direct API.
- The example invoice approval amount is not a new DevFlow financial policy.
- Existing canonical skill routing and targeted sync are DevFlow conventions.
  This update introduces authoring guidance, not new hooks or global permissions.
