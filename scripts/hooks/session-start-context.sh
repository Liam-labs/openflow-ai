#!/bin/bash
# session-start-context.sh — Preload an agent's operational context at session
# start (startup / resume / clear). Stdout from a SessionStart hook is added to
# Claude's context, so the agent begins its first turn already holding its
# handoff, expertise, ownership and today's log instead of reading them only
# after the first channel message arrives (2026-09-23: Coffee Shop Jack answered
# the owner's first question before it had read any startup file).
#
# Mirrors collab-codex.py _build_scaffolded_prompt() so both runtimes start with
# the same pack. MEMORY.md is omitted: Claude Code auto-loads it natively.
# Compaction is handled separately by post-compact-reinject.sh.
#
# Claude Code replaces SessionStart output over ~10,000 characters with a file
# pointer the agent never reads, so each section has a character budget (total
# stays under ~9,300) and a truncated section names its file.
#
# Usage: session-start-context.sh <AgentDir>

set -uo pipefail

AGENT_DIR="${1:-}"
[ -n "$AGENT_DIR" ] && [ -d "$AGENT_DIR" ] || exit 0

emitted=0
emit_header() {
    if [ "$emitted" -eq 0 ]; then
        echo "=== SESSION START CONTEXT (preloaded — no need to re-read these files) ==="
        echo ""
        echo "The current role rules and current user or Team Lead assignment govern how work is done. Handoff, expertise, ownership and memory are required operational context: apply their durable facts and preferences, treat old task process as inactive unless the current handoff or assignment keeps it pending. Current explicit instructions and files resolve conflicts."
        emitted=1
    fi
}
section() {
    # section <heading> <file> <max_lines> <max_chars> [display_path]
    local heading="$1" file="$2" max="$3" chars="$4" shown="${5:-$2}" body
    [ -s "$file" ] || return 0
    body=$(head -n "$max" "$file" 2>/dev/null) || return 0
    if [ "${#body}" -gt "$chars" ]; then
        body="${body:0:$chars}"
        body="${body%$'\n'*}"
        body+=$'\n'"[… truncated — read ${shown} for the rest]"
    fi
    [ -n "${body//[[:space:]]/}" ] || return 0
    emit_header
    printf '\n---\n\n# %s\n\n%s\n' "$heading" "$body"
}


# shellcheck source=_portable.sh
. "${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/_portable.sh" 2>/dev/null || true
type portable_timeout >/dev/null 2>&1 || portable_timeout() { shift; "$@"; }

# Which machine this session runs on (desktop or laptop). Printed first and kept
# short; it is do-not-save, so an agent that later moves holds no stale location.
LOCATION_NOTE=$(portable_timeout 5 python3 "${DEVFLOW_HOME:-$HOME/DevFlow}/data/scaffolding/runtime_location.py" session-note 2>/dev/null || true)
if [ -n "${LOCATION_NOTE//[[:space:]]/}" ]; then
    emit_header
    printf '\n---\n\n%s\n' "$LOCATION_NOTE"
fi

section "Pending Handoff" "${AGENT_DIR}/logs/handoff.md" 80 3400
section "Agent Expertise" "${AGENT_DIR}/Expertise.md" 200 2200
section "System Ownership" "${AGENT_DIR}/SystemOwnership.json" 120 700

TODAY="${AGENT_DIR}/logs/today.md"
if [ -s "$TODAY" ] && grep -q "$(date +%F)" "$TODAY" 2>/dev/null; then
    tail_file=$(mktemp)
    tail -n 40 "$TODAY" > "$tail_file"
    section "Current-Date Log Tail" "$tail_file" 40 1500 "$TODAY"
    rm -f "$tail_file"
fi

exit 0
