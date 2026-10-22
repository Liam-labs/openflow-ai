#!/bin/bash
# flush.sh — Drain per-agent session scratch buffers into their canonical
# long-lived files. Sprint 38 T1b.2 — Token Efficiency Pass.
#
# Buffers (created by session-scratch-init.sh, T1b.1):
#   <AgentDir>/.session-scratch/journal.md           → <AgentDir>/logs/today.md
#   <AgentDir>/.session-scratch/memory-pending.md    → $HOME/.claude/projects/<key>/memory/MEMORY.md
#   <AgentDir>/.session-scratch/expertise-pending.md → <AgentDir>/Expertise.md
#
# <key> is derived from AgentDir by replacing every "/" with "-" (so
# /path/to/Team/AgentName → -path-to-Team-AgentName), matching the
# Claude Code project-key convention.
#
# Semantics:
#   - Empty buffer → no-op, no log entry
#   - Non-empty buffer → append to target via atomic rename, truncate buffer
#   - Concurrent flush → flock -n, second caller exits 0 with a skip log entry
#     (buffer is preserved for the next flush trigger)
#   - Target directory auto-created if missing
#   - flush.log records every actual flush and every lock-skip, for debugging
#
# The atomic rename pattern (cp → cat → mv) guarantees that an observer reading
# the target file always sees either the pre-flush state or the post-flush
# state, never a half-written blend. The buffer is truncated only after the
# rename succeeds.
#
# Usage: flush.sh <AgentName> <AgentDir> [journal|memory|expertise|all]
#   e.g. flush.sh AgentName /path/to/Team/AgentName           # flush all 3
#        flush.sh AgentName /path/to/Team/AgentName journal   # journal only

set -euo pipefail

# Hook firing telemetry — capture start time, emit on exit
# shellcheck source=_telemetry.sh
. "${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/_telemetry.sh" 2>/dev/null || true
# shellcheck source=_portable.sh
. "${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/_portable.sh" 2>/dev/null || true
type portable_try_lock >/dev/null 2>&1 || portable_try_lock() { flock -n "$1"; }
_T_START=$(_telemetry_now_ms 2>/dev/null || echo 0)
trap 'record_fire "${AGENT:-?}" "flush" "${DEVFLOW_HOOK_EVENT:-Stop}" "$?" "$(( $(_telemetry_now_ms 2>/dev/null || echo 0) - _T_START ))" 2>/dev/null || true' EXIT

AGENT="${1:-}"
AGENT_DIR="${2:-}"
WHICH="${3:-all}"

if [ -z "$AGENT" ] || [ -z "$AGENT_DIR" ]; then
    echo "flush.sh: usage: flush.sh <AgentName> <AgentDir> [journal|memory|expertise|all]" >&2
    exit 1
fi

if [ ! -d "$AGENT_DIR" ]; then
    echo "flush.sh: AgentDir not found: $AGENT_DIR" >&2
    exit 1
fi

SCRATCH_DIR="${AGENT_DIR}/.session-scratch"
if [ ! -d "$SCRATCH_DIR" ]; then
    echo "flush.sh: scratch dir missing: $SCRATCH_DIR (run session-scratch-init.sh first)" >&2
    exit 1
fi

LOCK_FILE="${SCRATCH_DIR}/flush.lock"
LOG_FILE="${SCRATCH_DIR}/flush.log"

# Derive the Claude Code project key from the agent directory path.
# Example: /path/to/Team/AgentName → -path-to-Team-AgentName
PROJECT_KEY="${AGENT_DIR//\//-}"

JOURNAL_BUF="${SCRATCH_DIR}/journal.md"
JOURNAL_TGT="${AGENT_DIR}/logs/today.md"

MEMORY_BUF="${SCRATCH_DIR}/memory-pending.md"
MEMORY_TGT="${HOME}/.claude/projects/${PROJECT_KEY}/memory/MEMORY.md"

EXPERTISE_BUF="${SCRATCH_DIR}/expertise-pending.md"
EXPERTISE_TGT="${AGENT_DIR}/Expertise.md"

# Path to the memory cap check script (sibling of flush.sh)
CAP_CHECK="$(dirname "$0")/memory-cap-check.sh"

# Path to the synthesis trigger runner (sibling of flush.sh in hooks/)
SYNTHESIS_CHECK="$(dirname "$0")/synthesis-check.ts"
SYNTHESIS_PENDING="${SCRATCH_DIR}/synthesis-pending.md"

# Run the memory cap gate before flushing memory or expertise.
# Exit 1 → cap exceeded, buffer is preserved so the agent can consolidate.
# Exit 0 or 2 → proceed (2 = check script not found / usage error, non-blocking).
cap_gate() {
    local file_type="$1" target="$2" pending="$3"
    if [ -x "$CAP_CHECK" ]; then
        if "$CAP_CHECK" "$file_type" "$target" "$pending"; then
            return 0
        else
            local rc=$?
            if [ $rc -eq 1 ]; then
                log_line "cap-gate: BLOCKED ${file_type} flush (cap exceeded), buffer preserved for consolidation"
                return 1
            fi
        fi
    fi
    return 0
}

# Run the synthesis trigger gate at session end.
# Inspects the session transcript for tool-count and workaround patterns.
# If triggered, writes a suggestion to the synthesis pending file which the
# next SessionStart injects. Never blocks — this is a best-effort suggestion.
# Exit 0 always.
synthesis_gate() {
    # A suggestion already waiting for the next SessionStart makes another scan pointless (16 Oct: Weir's
    # Stop hook spent ~2 minutes per turn re-scanning a 13 MB transcript, so hearing requests expired).
    if [ -s "$SYNTHESIS_PENDING" ]; then
        return 0
    fi
    local transcript_path
    transcript_path=$(cat "${SCRATCH_DIR}/transcript-path" 2>/dev/null || true)
    if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
        return 0
    fi
    if [ -f "$SYNTHESIS_CHECK" ]; then
        # Detached and without the flush lock: the Stop hook never waits for this best-effort scan.
        ( setsid bash -c 'out=$(npx tsx "$1" "$2" "$3" 2>&1) || true; if [ -n "$out" ]; then printf "[%s] synthesis-gate: %s\n" "$(date -Iseconds)" "$out" >> "$4"; fi' \
            _ "$SYNTHESIS_CHECK" "$transcript_path" "$SYNTHESIS_PENDING" "$LOG_FILE" </dev/null >/dev/null 2>&1 9>&- & )
    fi
    return 0
}

log_line() {
    printf "[%s] %s\n" "$(date -Iseconds)" "$1" >> "$LOG_FILE"
}

flush_one() {
    local label="$1" buf="$2" tgt="$3"

    # Empty buffer → nothing to do.
    if [ ! -s "$buf" ]; then
        return 0
    fi

    # Ensure the target directory exists.
    mkdir -p "$(dirname "$tgt")"

    # Atomic rename pattern: build the new target in a sibling tmp file, then
    # rename. Either the full append is visible or nothing is.
    local tmp="${tgt}.flush.$$.tmp"
    if [ -f "$tgt" ]; then
        cp "$tgt" "$tmp"
    else
        : > "$tmp"
    fi
    cat "$buf" >> "$tmp"
    mv "$tmp" "$tgt"

    # Truncate the buffer only after the rename succeeded.
    : > "$buf"

    log_line "flushed ${label} -> ${tgt}"
}

# Acquire the per-agent flush lock. Non-blocking: if another flush is already
# running, emit a skip log and exit cleanly — the buffer survives and the next
# trigger will pick it up.
exec 9>"$LOCK_FILE"
if ! portable_try_lock 9; then
    log_line "skip: another flush holds the lock"
    exit 0
fi

case "$WHICH" in
    journal)
        flush_one "journal" "$JOURNAL_BUF" "$JOURNAL_TGT"
        ;;
    memory)
        cap_gate "memory" "$MEMORY_TGT" "$MEMORY_BUF" && flush_one "memory" "$MEMORY_BUF" "$MEMORY_TGT"
        ;;
    expertise)
        cap_gate "expertise" "$EXPERTISE_TGT" "$EXPERTISE_BUF" && flush_one "expertise" "$EXPERTISE_BUF" "$EXPERTISE_TGT"
        ;;
    all)
        flush_one "journal" "$JOURNAL_BUF" "$JOURNAL_TGT"
        cap_gate "memory" "$MEMORY_TGT" "$MEMORY_BUF" && flush_one "memory" "$MEMORY_BUF" "$MEMORY_TGT"
        cap_gate "expertise" "$EXPERTISE_TGT" "$EXPERTISE_BUF" && flush_one "expertise" "$EXPERTISE_BUF" "$EXPERTISE_TGT"
        synthesis_gate
        ;;
    *)
        echo "flush.sh: unknown buffer type: $WHICH (expected journal|memory|expertise|all)" >&2
        exit 1
        ;;
esac

exit 0
