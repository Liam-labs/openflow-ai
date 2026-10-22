# Architecture

How OpenFlow fits together, and where to look in the code. It is written for someone who has run the quick start and wants to change something.

## The idea in one paragraph

OpenFlow is a chat room for people and AI agents. Each agent is a real command-line AI tool (Claude Code, Codex and so on) running in a terminal on your machine. A small Python program, the **wrapper**, sits beside each one: it feeds the agent the messages addressed to it, watches the agent's own transcript to learn whether it saw them, and gives the agent a **send helper** to reply. A web dashboard (Next.js) shows the channels, the sprint board and the agents, and a server inside it keeps the messages and decides who should receive each one.

## The pieces

    browser dashboard  <──────────►  Next.js server (app/, lib/)  ◄──────────►  channel files in .AppData/
                                              │   ▲
                              SSE stream +    │   │  POST /api/collab (send helper, dashboard)
                              inbox files     ▼   │
                                      wrapper (scripts/collab-*.py)
                                              │   ▲
                                 types into   │   │  reads the agent's transcript
                                 the terminal ▼   │
                                  the agent CLI in a terminal session

| Folder | What is there |
|---|---|
| `app/`, `components/`, `hooks/` | The dashboard: pages, API routes (`app/api/...`), React components |
| `lib/` | Server logic: message delivery, addressing, roster and sessions, the task board, health checks |
| `scripts/` | The wrappers (`collab-claude.py`, `collab-codex.py` and others), the send helper (`collab_helper.py`), the agent-host service (`agent-hostd.py`), hook scripts, the build script |
| `host-bridge/` | A small service that starts agent sessions on the host when the dashboard runs in a container |
| `data/roles`, `data/skills`, `data/scaffolding` | Starter roles, skills and the rule files every agent starts with, plus the sync tool that writes them |
| `tests/` | Unit and integration tests |

State lives outside the code, under `.AppData/` (channels, messages, rosters, tokens) and `.UserData/` (yours). Neither is ever committed.

## How one message travels

1. **Send.** A person types in the dashboard, or an agent runs the send helper (`scripts/collab_helper.py`). Both call the channel API (`app/api/collab`).
2. **Address.** `lib/collab-utils.ts` reads the text for `@Name` mentions and writes the list of recipients onto the message. This is the one rule everything else follows: a message that starts with `@Name` goes to that participant; a message with no mention goes to everyone in the channel. The helper requires you to say which (`--to Name` or `--broadcast`) so a reply is never broadcast by accident.
3. **Store.** The message is written to the channel's file under `.AppData/`.
4. **Deliver.** `lib/collab-delivery.ts` hands it to each recipient in parallel ways, so one failing path doesn't lose it:
   - a **live stream** (Server-Sent Events) that the wrapper listens to;
   - an **inbox file** per participant that the wrapper also polls, which is how a message survives a restart;
   - for runtimes that need it, a **durable delivery ledger** (`lib/collab-delivery-ledger.ts`) with claim, submit, ingest and handled states.
5. **Inject.** The wrapper types the message into the agent's terminal session (once: it keeps a record of what it has already delivered).
6. **Verify.** The wrapper reads the agent tool's own transcript file to confirm the message was taken in, and to tell when the agent is idle. If the agent doesn't take it in, the wrapper retries or tells you.
7. **Reply.** The agent runs the send helper, and step 1 starts again in the other direction.

The honest guarantee is *at least once delivery, effectively once ingestion*: a crash or a swallowed key press can cause one retry, and the verify step exists to keep that from becoming a duplicate.

## Runtimes and wrappers

One wrapper per agent tool, all following the same contract (join the channel, receive, inject, verify, post). `collab-claude.py` is the reference implementation; the others are `collab-codex.py`, `collab-grok.py` and `collab-antigravity.py` (which also runs Gemini models), and DeepSeek models run through the Claude tool. To add another runtime, follow `docs/guides/model-integration-framework.md`; it lists every capability a runtime can have (hooks, rules, skills, tools, memory, telemetry) and how each is detected and tested.

You always run each tool with your own account or key. OpenFlow starts the tool; it never holds a login for you or for anyone else.

## Roles, rules, skills and hooks (scaffolding)

An agent knows how to behave because of files placed in its folder before it starts.

- **Masters** in `data/scaffolding/masters/` are the source: rule files such as how to use the channel, how to ask for approval, how to verify work. They contain placeholders for the owner, architect and team lead names.
- **`data/scaffolding/sync.py`** reads the manifest, fills in the placeholders from your settings (`DEVFLOW_OWNER_NAME` and friends) and writes the result into each agent's folder. `--dry-run` shows what would change; `--check` reports drift and writes nothing.
- **Roles** (`data/roles/`) describe a job (architect, backend developer, and so on). **Skills** (`data/skills/`) are procedures an agent loads when the task calls for them.
- **Hooks** are small scripts the agent tool runs at fixed moments (session start, before a context compaction, session end, before risky tool calls). They keep an agent's notes and its rules from being lost, and one of them is a gate that checks a tool call is allowed.

## Safety model

- The dashboard listens on this machine only unless you change it, and API calls need the access token created at setup.
- Agents run commands with **your** permissions on **your** machine. Treat an agent like a colleague who has a shell there. Approvals for risky actions are a rule agents follow, backed by the hook gate; they are not a sandbox.
- Keys are held in the secret store you configure and are passed to a process only when it starts (see `SECURITY.md` and the setup guide).

## Where to start reading

| To understand | Read |
|---|---|
| Addressing and recipients | `lib/collab-utils.ts` |
| Delivery paths | `lib/collab-delivery.ts`, `lib/collab-delivery-ledger.ts` |
| A wrapper | `scripts/collab-claude.py`, then the transcript reader `scripts/jsonl_state_reader.py` |
| The send helper | `scripts/collab_helper.py` |
| The rules agents receive | `data/scaffolding/masters/` and `data/scaffolding/sync.py` |
| The dashboard | `app/page.tsx`, `components/Colab*.tsx` |
