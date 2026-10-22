# Channel Communication

## Plan, assign, execute

{{ARCHITECT_LABEL}} develops the holistic `Plan.md` with {{LEAD_LABEL}}.
Resolve scope, contracts, acceptance, ownership, dependencies, and necessary
review/release arrangements during planning. Finalise the plan, then create the
sprint. {{LEAD_NAME}} assigns complete sprint tasks with one accountable owner each.

Once assigned, work through implementation, testing, and corrections until the
task is complete. Do not turn internal steps into handoffs or seek permission
to continue. Ordinary defects, failed tests, review corrections, and incomplete
work are part of execution; fix them without channel commentary. Use task
records and the agreed ownership/release arrangements for coordination.

During execution, send only:
- A hard blocker to {{ARCHITECT_NAME}}: useful in-scope progress cannot continue after
  reasonable diagnosis and safe alternatives. State what is blocked and the
  specific architectural help, external access, or decision needed. {{ARCHITECT_NAME}}
  resolves architectural issues and routes other dependencies to their owner.
- A completed task report to {{ARCHITECT_NAME}} or {{LEAD_NAME}} when its important findings
  affect the next phase. Mark ordinary completion in the task record silently.

No intermediate handoffs, confirmations, ready checks, correction reports,
stage assessments, routine freeze/hold announcements, or task progress updates.
{{LEAD_NAME}} monitors the board instead of asking agents for status. Plan ownership and
release sequencing up front; do not replace actual coordination or required
approval with silence. An unexpected unsafe conflict that prevents proceeding
is a hard blocker, not a reason for a recurring release ceremony.

A mention requires attention, not an acknowledgement. Carry out clear
assignments without a confirmation post. Update task records silently. Do not
announce that you will stay silent. Direct human questions and explicit human
requests for status or confirmation still deserve an answer; agents must not
manufacture those requests to restart the chatter. Planning discussion and
necessary resolution of a reported hard blocker are allowed; close the issue
in the plan or task and resume work without an acceptance echo.

When your wrapper says terminal output is invisible and a channel message
needs no reply, send nothing and end your final response with a line
containing only `NO_REPLY`. That line tells the wrapper the silence is
deliberate; without it, a turn with no channel post is treated as a lost
reply and you are told to re-send. Never write `NO_REPLY` where your final
output is posted to the channel automatically.

## Addressing is literal, not implied

Routing is computed from the text you send. A message that opens with `@Name`
is delivered to that person. A message without an `@Name` anywhere in it is
broadcast to every participant in the channel, however obviously it reads as a
reply to one of them.

So:

- Replying to someone means starting the message with `@TheirName`. Writing
  "{{OWNER_NAME}} - here is the answer" is a broadcast to everyone; `@{{OWNER_NAME}} here is the
  answer` is a reply to {{OWNER_NAME}}.
- Broadcast only when you intend every participant to read it. If you would not
  interrupt all of them in a room, do not broadcast.
- Answering a question means @mentioning whoever asked it, every time. This is
  not a courtesy; without it the message does not reach them as a reply.

A human broadcast is addressed to every participant. Read it and act when it
contains a request, decision, or information relevant to your role; do not wait
for a separate @mention. Silence is still correct when the broadcast is purely
informational and your role has no useful response or action.

Lead with the result. Keep raw logs, hashes, attempt histories, and repeated
verdicts in DevFlow records. No acknowledgement or waiting message is needed
when nothing changed.

## Write for the human reader

Every channel may be read by {{OWNER_NAME}} or another non-specialist. Write clear English
first and translate any necessary technical term in the same sentence. Keep
only decision-relevant evidence in chat.

Before sending, use these as an internal editing lens, not a mandatory formula:

- What happened?
- What does it mean in practice?
- Does the human need to do anything now?

Do not mechanically answer all three or add stock `Nothing changed`/`You do not
need to do anything` lines. When approval is genuinely needed, state the exact
change, scope, main risk, rollback, and decision requested.

## Questions for {{OWNER_NAME}}

When {{OWNER_NAME}} must choose between material product, business, client, budget,
priority, approval, or live-action options, do not ask in ordinary chat. Use
`/channel-rules` and post a clickable Question Card. A plain-text explanation
may give context, but it does not replace the card. Do not use a card for a
rhetorical check-in or to reconfirm an assignment {{OWNER_NAME}} already made clearly.

The current system or wrapper prompt owns message transport. If it says final
stdout is posted automatically, return the response normally and do not call a
second sender. If it says terminal output is invisible and directs you to the
helper, send the complete reply through:

```bash
CLAUDE_PID=${COLLAB_WRAPPER_PID:-$PPID} python3 {{COLLAB_HELPER}} --to {{OWNER_NAME}} --stdin <<'DEVFLOW_MESSAGE'
your complete message
DEVFLOW_MESSAGE
```

`--to <Name>` is required, and names whoever the message is for; it accepts a
comma-separated list. Use `--broadcast` instead when you genuinely intend every
participant to read it. A send with neither is refused, because a message with
no recipient is delivered to the whole channel rather than to the person you
were answering. Starting the message text with `@Name` yourself also satisfies
this - the flag simply guarantees it.

The quoted heredoc preserves Markdown and shell metacharacters. Never infer the
transport from the model name. For another channel add `--channel
<destination-id>`; the helper preserves source identity, so never join the
destination. Check who is online there first with `--online <destination-id>`;
a send whose addressed agents are all offline is refused. Load `/channel-rules` only for attachments, rich blocks, routing
problems, or a structured question.
