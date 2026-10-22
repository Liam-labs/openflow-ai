#!/bin/bash
# Hook firing telemetry — shell helper.
#
# Source from a shell hook script, then call record_fire near the end:
#
#     . "${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/_telemetry.sh"
#     _T_START=$(_telemetry_now_ms)
#     # ... hook does its work ...
#     record_fire "$AGENT" "pre-compact-write" "PreCompact" 0 $(($(_telemetry_now_ms) - _T_START))
#
# Pure bash — no python3 fork per fire, so cheap enough for shell hooks that
# fire on every UserPromptSubmit. Never breaks the caller: every step is
# guarded by `|| true`.
#
# Append-only writes <PIPE_BUF (4 KiB on Linux) are atomic with O_APPEND, so
# concurrent writes from multiple hook processes are safe without locking.
#
# Bounded rotation: when the file exceeds HOOK_EVENTS_MAX_BYTES (default
# 5 MiB), atomically rename to .1. Worst-case data loss = one event window
# during the rename, accepted.

HOOK_EVENTS_PATH="${HOOK_EVENTS_PATH:-$HOME/DevFlow/.AppData/hook-events.jsonl}"
HOOK_EVENTS_MAX_BYTES="${HOOK_EVENTS_MAX_BYTES:-5242880}"

# Current ms since epoch — used for ms-elapsed math. Avoid `date +%s%3N`
# portability issues by composing seconds + nanos manually.
_telemetry_now_ms() {
    local ns
    ns=$(date +%s%N 2>/dev/null) || { date +%s 2>/dev/null | awk '{print $1*1000}'; return; }
    echo $(( ns / 1000000 ))
}

_telemetry_rotate_if_needed() {
    local size
    [ -f "$HOOK_EVENTS_PATH" ] || return 0
    size=$(stat -c%s "$HOOK_EVENTS_PATH" 2>/dev/null || echo 0)
    if [ "${size:-0}" -gt "$HOOK_EVENTS_MAX_BYTES" ]; then
        mv -f "$HOOK_EVENTS_PATH" "${HOOK_EVENTS_PATH}.1" 2>/dev/null || true
    fi
}

# JSON-string-escape a value: backslash → \\, quote → \", control chars dropped.
# Good enough for our small, agent-controlled string set (agent names, hook
# names, event names — no user-supplied content lands here).
_telemetry_jstr() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/[\x00-\x1f\x7f]//g'
}

# record_fire <agent> <hook> <event> <exit_code> <ms> [extras_json_fragment]
# extras_json_fragment, if provided, is appended raw — caller responsible for
# valid JSON (e.g. ',"note":"some note","tail":"abc"').
record_fire() {
    local agent="${1:-?}" hook="${2:-?}" event="${3:-?}" exit_code="${4:-0}" ms="${5:-0}" extras="${6:-}"
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null) || ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    mkdir -p "$(dirname "$HOOK_EVENTS_PATH")" 2>/dev/null || true
    _telemetry_rotate_if_needed

    # Compose JSON line. Order matches Python helper for downstream parser
    # compatibility.
    local line
    line=$(printf '{"ts":"%s","agent":"%s","hook":"%s","event":"%s","exit":%d,"ms":%d%s}' \
        "$ts" \
        "$(_telemetry_jstr "$agent")" \
        "$(_telemetry_jstr "$hook")" \
        "$(_telemetry_jstr "$event")" \
        "${exit_code:-0}" \
        "${ms:-0}" \
        "${extras}")

    # Append in one write — line is well under PIPE_BUF so O_APPEND is atomic
    echo "$line" >> "$HOOK_EVENTS_PATH" 2>/dev/null || true
}

# Convenience wrapper that captures start time, runs the rest of the hook in
# a subshell, and records on exit. Use as the LAST set of statements in a
# shell hook for the minimum-friction case where you don't already track time.
#
# Usage at end of a hook script:
#     # ... hook work happens above ...
#     record_fire_simple "$AGENT" "pre-compact-write" "PreCompact"
record_fire_simple() {
    # Best-effort: we don't have a start-time anchor here, so we emit ms=0.
    # Prefer the explicit _T_START + record_fire pattern when timing matters.
    record_fire "${1:-?}" "${2:-?}" "${3:-?}" "${4:-0}" "0" ""
}
