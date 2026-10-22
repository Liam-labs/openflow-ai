#!/bin/bash
# pre-compact-write.sh — Pre-compaction state preservation for Claude agents
# Called by the PreCompact hook (type: command) before context is compacted.
# Replaces the old "type: prompt" hook which is unsupported in PTY/collab-claude mode.
#
# Flushes scratch buffers first, then writes current session state to
# handoff.md atomically so the agent can rehydrate after compaction.
#
# Usage: pre-compact-write.sh <AgentName> <AgentDir>
#   e.g. pre-compact-write.sh AgentName /path/to/Team/AgentName

set -euo pipefail

# Hook firing telemetry — capture start time, emit on exit
# shellcheck source=_telemetry.sh
. "${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/_telemetry.sh" 2>/dev/null || true
_T_START=$(_telemetry_now_ms 2>/dev/null || echo 0)
TMP_HANDOFF=""
cleanup_and_record() {
    local rc=$?
    if [ -n "$TMP_HANDOFF" ] && [ -e "$TMP_HANDOFF" ]; then
        rm -f "$TMP_HANDOFF"
    fi
    record_fire "${AGENT:-?}" "pre-compact-write" "PreCompact" "$rc" \
        "$(( $(_telemetry_now_ms 2>/dev/null || echo 0) - _T_START ))" \
        2>/dev/null || true
    return "$rc"
}
trap cleanup_and_record EXIT

AGENT="${1:-}"
AGENT_DIR="${2:-}"

if [ -z "$AGENT" ] || [ -z "$AGENT_DIR" ]; then
    echo "pre-compact-write.sh: usage: pre-compact-write.sh <AgentName> <AgentDir>" >&2
    exit 1
fi

LOGS="${AGENT_DIR}/logs"
TODAY_MD="${LOGS}/today.md"
HANDOFF_MD="${LOGS}/handoff.md"
NOW=$(date +%H:%M)
TIMESTAMP=$(date -Iseconds)

mkdir -p "$LOGS"

# Flush journal, memory, and expertise before reading state for the handoff.
# A flush failure is reported but does not sacrifice the compaction snapshot;
# flush.sh itself preserves blocked buffers when its safety gates fire.
FLUSH_SCRIPT="$(dirname "$0")/flush.sh"
if [ -x "$FLUSH_SCRIPT" ] && [ -d "${AGENT_DIR}/.session-scratch" ]; then
    if ! DEVFLOW_HOOK_EVENT=PreCompact "$FLUSH_SCRIPT" "$AGENT" "$AGENT_DIR" all; then
        echo "pre-compact-write.sh: scratch flush failed; preserving handoff from available state" >&2
    fi
fi

# A handoff is agent-owned resume state.  PreCompact must never replace a
# specific plan with a generic counter/snapshot: keep an existing handoff
# byte-for-byte and merely make buffered writes durable before compaction.
if [ -f "$HANDOFF_MD" ]; then
    exit 0
fi

# A first compaction may occur before an agent has written any handoff.  Supply
# only the stable four-field base so the next SessionStart has a valid target,
# without inventing task state or telemetry.
TMP_HANDOFF=$(mktemp "${HANDOFF_MD}.tmp.XXXXXX")
{
    printf "STATUS: Pre-compaction boundary at %s\n" "$NOW"
    printf "LAST_ACTED: %s\n" "$TIMESTAMP"
    printf "PENDING: none\n"
    printf "DO_NOT_REPEAT: none\n"
} > "$TMP_HANDOFF"

mv "$TMP_HANDOFF" "$HANDOFF_MD"
TMP_HANDOFF=""
