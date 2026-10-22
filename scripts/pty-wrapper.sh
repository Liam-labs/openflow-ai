#!/bin/bash
# PTY wrapper script for Claude sessions
# Keeps stdin open and handles signals properly

# Usage: pty-wrapper.sh <session-id> <log-file>
SESSION_ID="$1"
LOG_FILE="$2"

# Create fifo for commands if it doesn't exist
FIFO="/tmp/claude-pty-${SESSION_ID}.fifo"
rm -f "$FIFO" 2>/dev/null
mkfifo "$FIFO"

# Trap to clean up on exit
cleanup() {
  rm -f "$FIFO" 2>/dev/null
  exit 0
}
trap cleanup EXIT INT TERM

# Log startup
echo "[$(date -Iseconds)] Starting Claude session: $SESSION_ID" >> "$LOG_FILE"

# Start Claude with script for PTY and keep reading from fifo
# The exec keeps stdin open, tail -f keeps the fifo open
exec script -q -c "claude --dangerously-skip-permissions" "$LOG_FILE" < <(
  # Keep reading from fifo
  while true; do
    if read -r line < "$FIFO" 2>/dev/null; then
      echo "$line"
    fi
    sleep 0.1
  done
)
