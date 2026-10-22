#!/bin/bash
# flush-journal.sh — Manual /flush-journal slash-command helper.
# Sprint 38 T1b.3 — Token Efficiency Pass.
#
# Discovers the caller's collab session file, reads displayName + projectPath,
# and invokes flush.sh in journal mode (or all-mode when --all is passed).
# Echoes the last flush.log entries so the user sees what happened.
#
# Usage (from a slash command):
#   flush-journal.sh            # flush journal only (default)
#   flush-journal.sh --all      # flush journal + memory + expertise
#
# Session discovery order:
#   1. $FLUSH_SESSION_FILE env var (used by tests and explicit callers)
#   2. $(pwd)/.claude/collab-session-$PPID.json (normal runtime)
#   3. $(pwd)/.claude/collab-session-*.json, most recent (fallback)

set -euo pipefail

# Hook firing telemetry — capture start time, emit on exit
# shellcheck source=_telemetry.sh
. "${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/_telemetry.sh" 2>/dev/null || true
_T_START=$(_telemetry_now_ms 2>/dev/null || echo 0)
trap 'record_fire "${AGENT_NAME:-?}" "flush-journal" "SlashCommand" "$?" "$(( $(_telemetry_now_ms 2>/dev/null || echo 0) - _T_START ))" 2>/dev/null || true' EXIT

MODE="journal"
if [ "${1:-}" = "--all" ]; then
    MODE="all"
    shift
fi

FLUSH_SH="${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/flush.sh"

# --- Resolve session file ------------------------------------------------
SESSION_FILE=""
SESSION_FILE_EXPLICIT=0
if [ -n "${FLUSH_SESSION_FILE:-}" ]; then
    SESSION_FILE="$FLUSH_SESSION_FILE"
    SESSION_FILE_EXPLICIT=1
else
    SESSION_DIR="$(pwd)/.claude"
    if [ -f "${SESSION_DIR}/collab-session-${PPID}.json" ]; then
        SESSION_FILE="${SESSION_DIR}/collab-session-${PPID}.json"
    elif ls "${SESSION_DIR}"/collab-session-*.json >/dev/null 2>&1; then
        SESSION_FILE=$(ls -t "${SESSION_DIR}"/collab-session-*.json 2>/dev/null | head -1)
    fi
fi

if [ -z "$SESSION_FILE" ] || [ ! -f "$SESSION_FILE" ]; then
    echo "flush-journal: no collab session file found (tried FLUSH_SESSION_FILE, \$PPID, fallback)" >&2
    exit 1
fi

# --- Parse displayName + projectPath -------------------------------------
AGENT_NAME=$(python3 -c "
import json, sys
try:
    with open('$SESSION_FILE') as f:
        d = json.load(f)
    print(d.get('displayName', '') or '')
except Exception:
    print('')
" 2>/dev/null || echo "")

AGENT_DIR=$(python3 -c "
import json, sys
try:
    with open('$SESSION_FILE') as f:
        d = json.load(f)
    print(d.get('projectPath', '') or '')
except Exception:
    print('')
" 2>/dev/null || echo "")

if [ -z "$AGENT_NAME" ]; then
    echo "flush-journal: session file missing displayName ($SESSION_FILE)" >&2
    exit 1
fi

if [ -z "$AGENT_DIR" ]; then
    SESSION_PARENT=$(basename "$(dirname "$SESSION_FILE")")
    PARENT_DIR=""
    if [ "$SESSION_FILE_EXPLICIT" -eq 0 ] && [ "$SESSION_PARENT" = ".claude" ]; then
        PARENT_DIR=$(cd "$(dirname "$(dirname "$SESSION_FILE")")" && pwd 2>/dev/null || echo "")
    fi
    if [ -n "$PARENT_DIR" ] && [ -d "${PARENT_DIR}/.session-scratch" ]; then
        AGENT_DIR="$PARENT_DIR"
    elif [ "$SESSION_FILE_EXPLICIT" -eq 0 ] && [ -d "$(pwd)/.session-scratch" ]; then
        AGENT_DIR="$(pwd)"
    else
        echo "flush-journal: session file missing projectPath ($SESSION_FILE) and cannot deduce agent directory" >&2
        exit 1
    fi
fi


# --- Invoke flush.sh -----------------------------------------------------
set +e
bash "$FLUSH_SH" "$AGENT_NAME" "$AGENT_DIR" "$MODE"
RC=$?
set -e

if [ $RC -ne 0 ]; then
    # flush.sh already wrote its own error to stderr
    exit $RC
fi

# --- User-facing feedback ------------------------------------------------
LOG="${AGENT_DIR}/.session-scratch/flush.log"
if [ -s "$LOG" ]; then
    echo "flush-journal: done"
    tail -3 "$LOG"
else
    echo "flush-journal: done (buffer was empty)"
fi

exit 0
