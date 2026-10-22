#!/bin/bash
# write-session-end.sh — compatibility shim for legacy Stop-hook settings.
#
# A Claude Stop event is ordinary turn completion, not session termination.
# It must not create synthetic log entries, nag for a second turn, or replace a
# richer handoff. Current settings call hooks/flush.sh directly; this shim stays
# safe for agents whose settings have not yet been refreshed.

set -euo pipefail

AGENT="${1:-}"
AGENT_DIR="${2:-}"

if [ -z "$AGENT" ] || [ -z "$AGENT_DIR" ]; then
    echo "write-session-end.sh: usage: write-session-end.sh <AgentName> <AgentDir>" >&2
    exit 1
fi

FLUSH_SCRIPT="$(dirname "$0")/hooks/flush.sh"

# Older workspaces may not have session scratch yet. A Stop hook is not a
# failure gate, so leave their logs and handoff untouched and exit cleanly.
if [ ! -d "${AGENT_DIR}/.session-scratch" ]; then
    exit 0
fi

if [ -x "$FLUSH_SCRIPT" ]; then
    exec "$FLUSH_SCRIPT" "$AGENT" "$AGENT_DIR" all
fi

exit 0
