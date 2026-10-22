#!/bin/bash
# session-scratch-init.sh — Create per-agent .session-scratch/ layout if missing.
# Sprint 38 T1b.1 — Token Efficiency Pass. Foundation for the session-journal
# buffer. Downstream T1b.2 (flush.sh) reads/writes these files; T1b.4 PreCompact
# hook calls flush; T1b.5 UserPromptSubmit turn-counter is the safety net.
#
# Sprint 36 T3 — also reads Claude Code's SessionStart hook stdin JSON and
# writes:
#   <AgentDir>/.session-scratch/session-id       — current sessionId (one line)
#   <AgentDir>/.session-scratch/transcript-path  — absolute path to live JSONL
# These give the Sprint 36 agent-stream resolver a reliable primary lookup
# path instead of newest-file-in-dir heuristics. Silent fallback if stdin is
# empty or non-JSON (backward compatible with manual invocation).
#
# Layout (per agent):
#   <AgentDir>/.session-scratch/journal.md           — flushes to logs/today.md
#   <AgentDir>/.session-scratch/memory-pending.md    — flushes to MEMORY.md
#   <AgentDir>/.session-scratch/expertise-pending.md — flushes to Expertise.md
#   <AgentDir>/.session-scratch/flush.lock           — flock target for flush.sh
#   <AgentDir>/.session-scratch/session-id           — Sprint 36 T3
#   <AgentDir>/.session-scratch/transcript-path      — Sprint 36 T3
#
# Idempotent: re-running leaves existing buffer files untouched. session-id
# and transcript-path are overwritten on every SessionStart (each boot gets
# a fresh value from Claude Code's hook payload).
#
# Usage: session-scratch-init.sh <AgentName> <AgentDir>
#   e.g. session-scratch-init.sh AgentName /path/to/Team/AgentName

set -euo pipefail

# Hook firing telemetry — capture start time, emit on exit
# shellcheck source=_telemetry.sh
. "${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/_telemetry.sh" 2>/dev/null || true
_T_START=$(_telemetry_now_ms 2>/dev/null || echo 0)
trap 'record_fire "${AGENT:-?}" "session-scratch-init" "SessionStart" "$?" "$(( $(_telemetry_now_ms 2>/dev/null || echo 0) - _T_START ))" 2>/dev/null || true' EXIT

AGENT="${1:-}"
AGENT_DIR="${2:-}"

if [ -z "$AGENT" ] || [ -z "$AGENT_DIR" ]; then
    echo "session-scratch-init.sh: usage: session-scratch-init.sh <AgentName> <AgentDir>" >&2
    exit 1
fi

if [ ! -d "$AGENT_DIR" ]; then
    echo "session-scratch-init.sh: AgentDir not found: $AGENT_DIR" >&2
    exit 1
fi

SCRATCH_DIR="${AGENT_DIR}/.session-scratch"

# mkdir -p is idempotent
mkdir -p "$SCRATCH_DIR"

# Create each buffer file only if missing — preserve any existing buffer
# content. These are raw scratch buffers; flush.sh is the only thing that
# should ever truncate them.
for name in journal.md memory-pending.md expertise-pending.md flush.lock; do
    target="${SCRATCH_DIR}/${name}"
    if [ ! -e "$target" ]; then
        : > "$target"
    fi
done

# Sprint 36 T3 — capture session_id and transcript_path from Claude Code's
# SessionStart hook JSON payload on stdin. Claude Code pipes a JSON object
# containing at least {session_id, transcript_path, hook_event_name, source}.
# When the script is invoked manually (no pipe), stdin is a TTY and we skip.
if [ ! -t 0 ]; then
    HOOK_INPUT=$(cat || true)
    if [ -n "$HOOK_INPUT" ] && command -v jq >/dev/null 2>&1; then
        SESSION_ID=$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
        TRANSCRIPT_PATH=$(printf '%s' "$HOOK_INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)
        if [ -n "$SESSION_ID" ]; then
            printf '%s\n' "$SESSION_ID" > "${SCRATCH_DIR}/session-id"
        fi
        if [ -n "$TRANSCRIPT_PATH" ]; then
            printf '%s\n' "$TRANSCRIPT_PATH" > "${SCRATCH_DIR}/transcript-path"
        fi
    fi
fi

# Hermes Sprint T3 — inject any pending synthesis suggestion from the
# previous session's synthesis_gate (flush.sh). Clear after injection
# so it only fires once.
SYNTHESIS_PENDING="${SCRATCH_DIR}/synthesis-pending.md"
if [ -s "$SYNTHESIS_PENDING" ]; then
    echo ""
    echo "💡 SKILL SYNTHESIS SUGGESTION"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    cat "$SYNTHESIS_PENDING"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    : > "$SYNTHESIS_PENDING"
fi

# Preload handoff/expertise/ownership/today on a fresh start, resume or clear.
# Compaction has its own reinject hook (matcher "compact"); skip it here.
HOOK_SOURCE=""
if [ -n "${HOOK_INPUT:-}" ] && command -v jq >/dev/null 2>&1; then
    HOOK_SOURCE=$(printf '%s' "$HOOK_INPUT" | jq -r '.source // empty' 2>/dev/null || true)
fi
if [ "$HOOK_SOURCE" != "compact" ]; then
    bash "${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/session-start-context.sh" "$AGENT_DIR" || true
fi

# Keep the hook silent on the happy path — SessionStart logs are noisy.
exit 0
