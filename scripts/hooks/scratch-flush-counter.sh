#!/bin/bash
# scratch-flush-counter.sh — Turn-counter safety-net for session-scratch buffer
# flushes. Sprint 38 T1b.5 — Token Efficiency Pass.
#
# Called by the UserPromptSubmit hook. Maintains a per-agent counter; every N
# turns (default 25), invokes flush.sh in all-mode so buffered journal/memory/
# expertise content is committed without waiting for PreCompact, session end,
# or a manual /flush-journal.
#
# The counter survives agent restarts via the .claude/.scratch-flush-counter
# file. Corrupt or missing counter → recovers by starting at 1.
#
# Usage:
#   scratch-flush-counter.sh <AgentName> <AgentDir>
#
# Environment:
#   SCRATCH_FLUSH_INTERVAL  integer turns between flushes (default 25).
#                           Set lower for tests.
#
# Modelled on the existing counter pattern in context-inject.py but as a
# separate single-responsibility hook so it is independently testable and
# does not tangle with the context-injection side-effects.

set -euo pipefail

# Hook firing telemetry — capture start time, emit on exit
# shellcheck source=_telemetry.sh
. "${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/_telemetry.sh" 2>/dev/null || true
_T_START=$(_telemetry_now_ms 2>/dev/null || echo 0)
trap 'record_fire "${AGENT:-?}" "scratch-flush-counter" "UserPromptSubmit" "$?" "$(( $(_telemetry_now_ms 2>/dev/null || echo 0) - _T_START ))" 2>/dev/null || true' EXIT

AGENT="${1:-}"
AGENT_DIR="${2:-}"

if [ -z "$AGENT" ] || [ -z "$AGENT_DIR" ]; then
    echo "scratch-flush-counter.sh: usage: scratch-flush-counter.sh <AgentName> <AgentDir>" >&2
    exit 1
fi

if [ ! -d "$AGENT_DIR" ]; then
    echo "scratch-flush-counter.sh: AgentDir not found: $AGENT_DIR" >&2
    exit 1
fi

INTERVAL="${SCRATCH_FLUSH_INTERVAL:-25}"
# Guard against non-integer env values.
if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]]; then
    INTERVAL=25
fi
if [ "$INTERVAL" -lt 1 ]; then
    INTERVAL=25
fi

COUNTER_DIR="${AGENT_DIR}/.claude"
COUNTER_FILE="${COUNTER_DIR}/.scratch-flush-counter"
FLUSH_SH="${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/flush.sh"

mkdir -p "$COUNTER_DIR"

# --- Read current counter (recover from corruption silently) ----------
CURRENT=0
if [ -f "$COUNTER_FILE" ]; then
    raw=$(tr -d '\000' < "$COUNTER_FILE" 2>/dev/null || echo "")
    raw=$(printf "%s" "$raw" | tr -d '[:space:]')
    if [[ "$raw" =~ ^[0-9]+$ ]]; then
        CURRENT=$raw
    else
        CURRENT=0
    fi
fi

NEXT=$((CURRENT + 1))

write_counter() {
    local value="$1"
    local tmp="${COUNTER_FILE}.tmp.$$"
    printf "%s\n" "$value" > "$tmp"
    mv "$tmp" "$COUNTER_FILE"
}

if [ "$NEXT" -ge "$INTERVAL" ]; then
    # Hit the interval → fire flush.sh all-mode, then reset the counter.
    # We reset regardless of flush outcome so a persistently failing flush
    # doesn't stick the counter and fire every single turn. Failures are
    # recorded in .session-scratch/flush.log.
    bash "$FLUSH_SH" "$AGENT" "$AGENT_DIR" all >/dev/null 2>&1 || true
    write_counter 0
else
    write_counter "$NEXT"
fi

exit 0
