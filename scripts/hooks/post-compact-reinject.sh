#!/bin/bash
# post-compact-reinject.sh — Re-injects core identity after context compaction
# Called by SessionStart hook with "compact" matcher.
# Outputs critical rules to stdout → Claude injects into context automatically.
#
# Usage: post-compact-reinject.sh <AgentDir>
#   e.g. post-compact-reinject.sh /path/to/Team/AgentName

set -euo pipefail

# Hook firing telemetry — capture start time, emit on exit
# shellcheck source=_telemetry.sh
. "${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/_telemetry.sh" 2>/dev/null || true
_T_START=$(_telemetry_now_ms 2>/dev/null || echo 0)

AGENT_DIR="${1:-.}"
RULES_DIR="${AGENT_DIR}/.claude/rules"
# Derive an agent name from the working dir (last segment) since this hook
# takes only AGENT_DIR positionally — keeps telemetry queryable by agent.
AGENT="$(basename "$AGENT_DIR")"
trap 'record_fire "${AGENT:-?}" "post-compact-reinject" "SessionStart" "$?" "$(( $(_telemetry_now_ms 2>/dev/null || echo 0) - _T_START ))" 2>/dev/null || true' EXIT

echo "=== CONTEXT COMPACTED — RESUME ==="
echo ""

# Which machine this session runs on: do-not-save, and lost with the compacted context.
LOCATION_NOTE=$(timeout 5 python3 "${DEVFLOW_HOME:-$HOME/DevFlow}/data/scaffolding/runtime_location.py" session-note 2>/dev/null || true)
if [ -n "${LOCATION_NOTE//[[:space:]]/}" ]; then
    printf '%s\n\n---\n\n' "$LOCATION_NOTE"
fi

emit_rule_excerpt() {
    local source="$1"
    # Line budget. 40 suited short identity files. A role now carries the whole
    # design process, and truncating it mid-way is worse than omitting it: the
    # agent resumes knowing to research and not what to do with the result.
    local budget="${2:-40}"
    local first_line include_path
    [ -f "$source" ] || return 0

    first_line=$(head -1 "$source" 2>/dev/null || true)
    include_path=""
    if [[ "$first_line" == @/* ]]; then
        include_path="${first_line#@}"
    elif [[ "$first_line" == @./* ]]; then
        include_path="$(dirname "$source")/${first_line#@./}"
    fi

    # Identity files are normally tiny pointers to canonical role/personality
    # sources. Reinject the actual boundary, not a one-line pointer literal.
    if [ -n "$include_path" ] && [ -f "$include_path" ]; then
        head -"$budget" "$include_path"
    else
        head -"$budget" "$source"
    fi
}

# 1. Personality — who you are
PERSONALITY="${RULES_DIR}/Personality.md"
if [ -f "$PERSONALITY" ]; then
    emit_rule_excerpt "$PERSONALITY"
    echo ""
    echo "---"
    echo ""
fi

# 2. Directives — concise role boundaries
DIRECTIVES="${RULES_DIR}/Directives.md"
if [ -f "$DIRECTIVES" ]; then
    # The role is the agent's job description and now contains the design
    # process end to end. It must survive a compaction whole. 400 covers the
    # longest role (designer.md, 293 lines on 2026-10-17). tests/unit/
    # frontend-quality-contract.test.ts fails when a role outgrows this budget.
    emit_rule_excerpt "$DIRECTIVES" 400
    echo ""
    echo "---"
    echo ""
fi

# 3. Alignment guardrails (first 40 lines only)
ALIGNMENT="${RULES_DIR}/alignment-claude.md"
if [ -f "$ALIGNMENT" ]; then
    head -40 "$ALIGNMENT"
    echo ""
    echo "---"
    echo ""
fi

# 3b. Channel etiquette — addressing/routing decays fastest across compaction.
# Measured: a constraint dropped by the summarizer moves from 0% to 30-59%
# violation (arXiv 2606.22528). This is the rule that tells an agent to address
# one person rather than broadcast, so it must be pinned, not summarised.
CHANNEL_COMMS="${RULES_DIR}/channel-communication.md"
if [ -f "$CHANNEL_COMMS" ]; then
    head -23 "$CHANNEL_COMMS"
    echo ""
    echo "---"
    echo ""
fi

# 4. Existing handoff state (kept agent-owned by PreCompact)
HANDOFF="${AGENT_DIR}/logs/handoff.md"
if [ -f "$HANDOFF" ]; then
    echo "## Resume State"
    echo ""
    head -80 "$HANDOFF"
    echo ""
    echo "---"
    echo ""
fi

echo "Resume the assigned outcome from the state above. Read extra context only when the task needs it; update the handoff only for meaningful new resume state."
