---
name: approval-protocol
description: >
  Authorization protocol for destructive or materially out-of-scope operations.
  A clear direct assignment already authorizes normal reversible implementation
  work; use this skill only when authority is missing for an irreversible,
  high-blast-radius, external-live, or destructive action.
---

# Authorization Protocol — Destructive Operations

The protocol prevents destructive surprises. It must not make the owner approve the
same task twice.

## Core Rule

A clear direct instruction authorizes the normal reversible work required to
complete it, including builds, deployments, service restarts, cron/config
updates, and other in-scope operational steps. Proceed without a second gate.

Ask separately only when the next action is materially destructive or hard to
reverse, has a high blast radius, touches client or third-party live data without
direct authorization, or materially expands the assignment.

## Who Is the Coordinator?

| Context | Coordinator |
|---------|-------------|
| Team channels | **The Team Lead** |
| Project channel with a Team Lead | **That Team Lead** |
| Solo session | **The owner** |
| Coordinator needs to run a high-risk op | **Second coordinator or the owner** |

## Actions Requiring Separate Approval Unless Explicitly Ordered

### Git
- `git push --force` to any remote
- `git reset --hard` on a branch with unpushed work
- `git branch -D` on an unmerged branch
- Rewriting published history (`rebase -i`, `commit --amend` on pushed commits)

### Filesystem
- `rm -rf` outside `/tmp`, `~/.cache`, or build output dirs
- Mass file deletes (>10 files in one operation)
- Deleting `~/.secrets`, `~/.ssh`, `.env*`, or credential files
- Deleting DevFlow registrations, collab channels, or sprint data

### Services
- `pm2 delete <process>` or `pm2 kill`
- Removing a production service registration or causing material user downtime

### Databases
- `DROP DATABASE`, `DROP TABLE`, `TRUNCATE`
- `DELETE` without a `WHERE` clause
- Restoring a backup over a live database
- Operations rewriting >1000 rows

`supabase db reset` must never be run against valued, live, shared, client, or
otherwise non-disposable data. Use a proven backup/restore or targeted migration
path instead; ordinary task authority does not waive this prohibition.

### DevFlow / Infrastructure
- Removing app-registry entries or project registrations
- Rotating API tokens or credentials
- Destructive fleet-wide migrations without a tested rollback

## Decision Procedure

1. Check the current assignment. If the owner or the responsible coordinator directly
   requested the target and outcome, proceed; that instruction is authorization.
2. If authority is missing for a destructive/high-blast-radius action, post:

```
🛑 APPROVAL REQUEST — @<Coordinator>
Op: <exact command or action>
Target: <file / branch / service / table>
Reason: <why it's necessary>
Rollback: <how to undo>
Task ID: <sprint board ID or "ad-hoc">
```

No rollback plan = don't do it.

3. Act only on `APPROVED` for that newly requested operation. Silence is not
   consent. Log the request and verdict, then report the result.

## Emergency Exception

Active incident causing ongoing damage → act first, report within the same minute. Narrowly scoped to stopping the damage only.

## Normal In-Scope Work

Reading, code edits, creating files, tests, builds, routine deployments, service
restarts needed to load the requested fix, cron/systemd changes within the task,
reversible config changes, `git add`/`git commit`, and pulling from main. Do not
request duplicate approval.

## External and Client Live Systems

Do not infer authority for Rightmove, client production systems, DNS, or
third-party account writes from a general development task. The owner must directly
authorize the live target in the current conversation. Once they do, carry out
the ordinary in-scope steps without repeatedly reconfirming each command.

## Troubleshooting

**Unsure whether another gate is needed:**
First check whether the current assignment already authorizes the target and
outcome. If it does, proceed. If authority is genuinely missing, ask whether the
action is irreversible, likely to cause data loss, or an external/client-live
write; request approval only when one of those risks is real.

**Coordinator hasn't responded in 30+ minutes:**
Escalate to the owner directly. Don't proceed without approval.

**Already ran a high-risk op without approval:**
Report immediately. Describe what you did, why, and the result. Don't hide it — the audit trail exists regardless.
