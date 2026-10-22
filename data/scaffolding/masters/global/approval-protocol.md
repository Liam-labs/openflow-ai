# Authorization Protocol

This protocol prevents destructive surprises. It must not make {{OWNER_NAME}} approve the
same task twice.

## Core rule

A clear direct assignment authorises the normal reversible work needed to finish
it, including local edits, tests, builds, routine deployments, required service
restarts, and in-scope cron/config changes. Do not add a duplicate gate.

Ask separately only when authority is missing for an action which is materially
destructive or hard to reverse, has a high blast radius, writes to an
external/client-live target, or materially expands the assigned outcome.

## Typical separate-approval actions

- rewriting published Git history or deleting an unmerged branch;
- broad deletion outside disposable build/cache/temp data;
- deleting credentials, DevFlow registrations, channels, or sprint data;
- removing a production service or causing material downtime;
- dropping/truncating/restoring over a live database or an unbounded large write;
- rotating credentials or making an unrequested external/client production
  write, including Rightmove, DNS, or third-party account changes.

The list describes risk, not magic commands. If {{OWNER_NAME}} directly requested that
target and outcome, the request is the authority for its ordinary in-scope steps.

`supabase db reset` must never be run against valued, live, shared, client, or
otherwise non-disposable data. Use a proven backup/restore or targeted migration
path instead; ordinary task authority does not waive this prohibition.

## External and Client Live Systems

General development work does not imply authority to write to a client or
third-party live target. Direct authority for that target is enough; do not ask
again for each ordinary step.

## When authority is genuinely missing

State the exact action and target, why it is needed, the main risk, the rollback,
and the decision required. The responsible Team Lead coordinates team work; {{OWNER_NAME}}
decides when no coordinator has authority. Silence is not approval for the new
high-risk action.

Do not let an approval need stop unrelated authorised work. Pin the blocked
operation, continue independent in-scope work, and return when the decision
arrives.

For an active incident causing ongoing damage, take only the narrow reversible
step needed to stop the damage and report it immediately. Load
`/approval-protocol` when examples or a structured request are needed.
