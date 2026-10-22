# DevFlow Orientation

DevFlow is the coordination platform at `$DEVFLOW_URL`. Call it as
`${DEVFLOW_URL:-http://localhost:3000}` rather than hard-coding the address, so a
move needs only a new `DEVFLOW_URL`. This is a discovery map, not an operating
manual. Verify live facts rather than trusting old model names, ports,
counts, or sprint notes.

## Find the owner of the answer

- Current project intent: the project root's `PROJECT.md`, `CLAUDE.md`, README
  files, tests, and source.
- Platform knowledge: RAG, then `~/DevFlow/data/central-knowledge-base/`; if RAG
  is unavailable, search that tree with `rg`.
- Reusable procedures: the generated skill catalog named in `skill-index.md`,
  then the selected skill's `SKILL.md`.
- AgentChat architecture: RAG-search `current AgentChat communications
  architecture`, then open `platform/agentchat-comms-system.md`.
- Documentation placement: `platform/devflow-doc-skill.md` and the current
  project's conventions.
- Scaffolding source of truth: `~/DevFlow/data/scaffolding/manifest.json`, its
  masters, and `/scaffolding-sync`; deployed copies are outputs.
- Where each service runs and how to reach it from your machine: your
  `Runtime-Location.md` rule, generated from
  `~/DevFlow/data/scaffolding/service-locations.json`.
- DevFlow code contributions from any project/channel, preserving shared edits,
  remote deployment, live APIs and service operations: `/devflow-ops` and its
  directly linked contribution workflow.
- Browser interaction and current browser availability: `/browser`. Resolve
  browser failures through `platform/browser-use.md`. Native Windows
  applications use the `/computer-use` desktop adapter and its control boundary.
- Provider-backed capabilities shared across models: use the `devflow-gateway`
  MCP tools. For Claude Design, create a durable job with
  `design_session_create`, poll `design_session_status`, then use the feedback
  or export tool. If this runtime cannot load MCP, call the same contract via
  `~/DevFlow/scripts/devflow-gateway`. `/design-sync` remains a signed-in human
  action; `design_system_prepare_sync` returns the exact command instead of
  pretending the agent performed it.
- Tools for {{OWNER_NAME}} in your channel (the "Channel tools" launcher): the Channel tools section of
  your `Workspace.md`, then `platform/channel-tools.md`.
- Channel transport and message quality: `channel-communication.md`, with
  `/channel-rules` for attachments, routing, or structured questions.
- Shared task ownership and blocker state: `task-discipline.md` and
  `/task-discipline`.

Useful RAG queries include `current DevFlow scaffolding startup load order`,
`how to document a DevFlow change`, and `{{OWNER_NAME}} communication and working
preferences`. Prefer the narrow owning source and link to it instead of copying
its procedure into another startup file.
