#!/bin/bash
# TaskCompleted hook — exit 0 = allow, exit 2 = block with message
# Checks if DevFlow TypeScript compiles before allowing task completion.
# Only runs if DevFlow source was modified in the last 5 minutes.

# Hook firing telemetry — capture start time, emit on exit
# shellcheck source=_telemetry.sh
. "${DEVFLOW_HOME:-$HOME/DevFlow}/scripts/hooks/_telemetry.sh" 2>/dev/null || true
_T_START=$(_telemetry_now_ms 2>/dev/null || echo 0)
_T_AGENT="$(basename "$PWD")"
trap 'record_fire "${_T_AGENT:-?}" "verify-task-complete" "TaskCompleted" "$?" "$(( $(_telemetry_now_ms 2>/dev/null || echo 0) - _T_START ))" 2>/dev/null || true' EXIT

DEVFLOW_DIR="${DEVFLOW_HOME:-$HOME/DevFlow}"

# Check if any DevFlow source files were modified recently
RECENT_CHANGES=$(find "$DEVFLOW_DIR/app" "$DEVFLOW_DIR/lib" "$DEVFLOW_DIR/components" \
  \( -name "*.ts" -o -name "*.tsx" \) -newermt "5 minutes ago" 2>/dev/null | head -1)

if [ -n "$RECENT_CHANGES" ]; then
  cd "$DEVFLOW_DIR" && npx tsc --noEmit 2>/tmp/tsc-verify.txt
  if [ $? -ne 0 ]; then
    echo "TypeScript errors found — fix before marking task done:"
    head -15 /tmp/tsc-verify.txt
    exit 2
  fi
fi

exit 0
