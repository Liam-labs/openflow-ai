---
name: task-discipline
description: >
  Keep team work owned, scoped, and moving without turning the board into a gate.
  Use when starting or finishing sprint work, handling adjacent discoveries, or
  deciding whether work is genuinely waiting or blocked.
---

# Lightweight Task Discipline

## Start

A clear instruction from the owner or the Team Lead authorises safe, in-scope work.
Start immediately and choose the technical approach. Use the board to make
planned team ownership visible, but do not wait for board ceremony before doing a
directly assigned task.

When a board task exists, claim it and keep its state broadly accurate. The board
is a coordination view; journals, task history, sprint records, and the working
tree provide the rest of the evidence.

## Scope

- Deliver the outcome, not just the first literal action.
- Make small, reversible adjacent fixes when required for a complete safe result.
- Carry nonessential discoveries as follow-ups instead of expanding the sprint.
- Ask for direction only when extra work changes product behaviour, architecture,
  cost, or risk in a meaningful way.

## States

- `in_progress`: useful work continues, including normal defects and failed tests.
- `waiting`: a named approval, decision, person, or external dependency is needed.
- `blocked`: no useful in-scope path remains; state the exact unblock action.
- `done`: the acceptance outcome has proportionate fresh verification.

Avoid invented lifecycle states and repeated status messages. Update the board
when ownership or state changes. Follow `channel-communication.md`: post only a
necessary decision, hard blocker, or completed finding that affects the next phase.
Mark ordinary completion on the board silently.

## API Reference

```bash
# List tasks
curl -s "${DEVFLOW_URL:-http://localhost:3000}/api/collab/tasks?channelId=<id>&status=todo"

# Claim
curl -s -X POST ${DEVFLOW_URL:-http://localhost:3000}/api/collab/tasks \
  -d '{"action":"claim","channelId":"<id>","participantId":"<pid>","taskId":"<id>"}'

# Complete
curl -s -X POST ${DEVFLOW_URL:-http://localhost:3000}/api/collab/tasks \
  -d '{"action":"complete","channelId":"<id>","participantId":"<pid>","taskId":"<id>"}'
```
