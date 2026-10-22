#!/bin/bash
# memory-cap-check.sh — Pre-write size gate for MEMORY.md / Expertise.md
# Hermes Sprint T1: Hard memory caps.
#
# Checks whether a pending memory/expertise buffer can be flushed into the
# target file without exceeding the character cap. Exit codes:
#   0 — OK, flush can proceed
#   1 — Cap exceeded, structured error emitted to stderr → agent must consolidate
#   2 — Usage error (missing/wrong args)
#
# Called by flush.sh before the memory/expertise flush step.
# Can also be wired as a standalone PreToolUse hook for direct Write/Edit calls.
#
# Usage: memory-cap-check.sh <memory|expertise> <target-file> <pending-file>

set -euo pipefail

# Hook firing telemetry — capture start time, emit on exit
# shellcheck source=_telemetry.sh
. "${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/_telemetry.sh" 2>/dev/null || true
_T_START=$(_telemetry_now_ms 2>/dev/null || echo 0)
# Agent inferred from PWD basename — this hook doesn't receive AgentName positionally
_T_AGENT="$(basename "$PWD")"
trap 'record_fire "${_T_AGENT:-?}" "memory-cap-check" "PreToolUse" "$?" "$(( $(_telemetry_now_ms 2>/dev/null || echo 0) - _T_START ))" 2>/dev/null || true' EXIT

MEMORY_CAP=2200
EXPERTISE_CAP=3000

FILE_TYPE="${1:-}"
TARGET_FILE="${2:-}"
PENDING_FILE="${3:-}"

if [ -z "$FILE_TYPE" ] || [ -z "$TARGET_FILE" ] || [ -z "$PENDING_FILE" ]; then
    echo "Usage: memory-cap-check.sh <memory|expertise> <target-file> <pending-file>" >&2
    exit 2
fi

case "$FILE_TYPE" in
    memory)    CAP=$MEMORY_CAP; LABEL="MEMORY.md" ;;
    expertise) CAP=$EXPERTISE_CAP; LABEL="Expertise.md" ;;
    *)
        echo "memory-cap-check.sh: unknown file type: $FILE_TYPE (expected memory|expertise)" >&2
        exit 2
        ;;
esac

# Get current target file char count (0 if doesn't exist)
CURRENT_SIZE=0
if [ -f "$TARGET_FILE" ]; then
    CURRENT_SIZE=$(wc -m < "$TARGET_FILE" 2>/dev/null || echo 0)
fi

# Get proposed (pending) content char count
PROPOSED_SIZE=0
if [ -f "$PENDING_FILE" ]; then
    PROPOSED_SIZE=$(wc -m < "$PENDING_FILE" 2>/dev/null || echo 0)
fi

# Empty pending buffer — nothing to check, always OK
if [ "$PROPOSED_SIZE" -eq 0 ]; then
    exit 0
fi

# Gate 1: proposed content alone exceeds the cap (write would fail regardless)
if [ "$PROPOSED_SIZE" -gt "$CAP" ]; then
    cat >&2 <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  MEMORY CAP EXCEEDED — ${LABEL}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Error: Proposed write alone exceeds capacity.
  File:      ${LABEL}
  Cap:       ${CAP} chars
  Proposed:  ${PROPOSED_SIZE} chars (${PROPOSED_SIZE} over cap)

You must reduce the content BEFORE writing.
  (1) Trim the pending content to ≤ ${CAP} chars
  (2) Remove verbose examples, stale notes, or redundant entries
  (3) Retry the write
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EOF
    exit 1
fi

# Gate 2: combined (existing + proposed) exceeds the cap
COMBINED=$((CURRENT_SIZE + PROPOSED_SIZE))
if [ "$COMBINED" -gt "$CAP" ]; then
    OVER=$((COMBINED - CAP))
    cat >&2 <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  MEMORY CAP EXCEEDED — ${LABEL}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Error: Append would exceed capacity.
  File:      ${LABEL}
  Cap:       ${CAP} chars
  Current:   ${CURRENT_SIZE} chars
  Proposed:  ${PROPOSED_SIZE} chars
  Combined:  ${COMBINED} chars (${OVER} over cap)

You must consolidate before appending:
  (1) Read the current file
  (2) Identify and remove stale/obsolete entries
  (3) Compress verbose entries to essentials
  (4) Retry the write — combined must be ≤ ${CAP} chars
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EOF
    exit 1
fi

exit 0
