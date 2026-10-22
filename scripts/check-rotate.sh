#!/bin/bash
# check-rotate.sh — Startup date-rotation check for SG-1 agents
# Compatibility date/size rotation helper for legacy hook settings.
# Rotates today.md → yesterday.md + daily/ archive if the date has changed.
# It deliberately emits no behavioural prompt text.
#
# Usage: check-rotate.sh <AgentName>
#   e.g. check-rotate.sh an agent

set -euo pipefail

AGENT="${1:-}"
if [ -z "$AGENT" ]; then
    echo "check-rotate.sh: missing agent name" >&2
    exit 1
fi

TEAM_DIR="${2:-}"
if [ -z "$TEAM_DIR" ]; then
    echo "check-rotate.sh: missing team dir (arg 2)" >&2
    exit 1
fi
LOGS="${TEAM_DIR}/logs"
TODAY_MD="${LOGS}/today.md"
TODAY=$(date +%Y-%m-%d)

# If no today.md, create a fresh one and exit
if [ ! -f "$TODAY_MD" ]; then
    mkdir -p "$LOGS"
    printf "# Today — %s\n\n" "$TODAY" > "$TODAY_MD"
    exit 0
fi

# Read the date header from today.md (first line)
HEADER=$(head -1 "$TODAY_MD" 2>/dev/null || true)
EXPECTED="# Today — ${TODAY}"

# If already today's date, enforce the rotation cap and exit silently.
# Ordinary turn completion never creates or enforces log markers.
if [ "$HEADER" = "$EXPECTED" ]; then
    # Sprint 38 T5.1: mid-day rotation cap
    # If today.md exceeds 300 lines, move the oldest lines to daily/YYYY-MM-DD-early.md
    # and keep the newest 200 in today.md. This bounds the @file-imported content size
    # even before nightly rotation. Safe no-op under 300 lines.
    MAX_LINES="${TODAY_MD_MAX_LINES:-300}"
    KEEP_LINES="${TODAY_MD_KEEP_LINES:-200}"
    CURRENT_LINES=$(wc -l < "$TODAY_MD" 2>/dev/null || echo 0)
    if [ "${CURRENT_LINES:-0}" -gt "$MAX_LINES" ]; then
        DAILY="${LOGS}/daily"
        mkdir -p "$DAILY"
        EARLY="${DAILY}/${TODAY}-early.md"
        OVERFLOW=$((CURRENT_LINES - KEEP_LINES))
        # Append the oldest OVERFLOW lines to the early file (create or append).
        # Header "# Today — YYYY-MM-DD" on line 1 goes to the early file too so
        # future readers have context.
        if [ ! -f "$EARLY" ]; then
            printf "# Early — %s (rotated from today.md)\n\n" "$TODAY" > "$EARLY"
        fi
        head -n "$OVERFLOW" "$TODAY_MD" >> "$EARLY"
        # Write tail back with a fresh header on line 1 so the file still parses.
        TMP="${TODAY_MD}.rotate.tmp"
        printf "# Today — %s\n\n" "$TODAY" > "$TMP"
        tail -n "$KEEP_LINES" "$TODAY_MD" >> "$TMP"
        mv "$TMP" "$TODAY_MD"
        echo "[check-rotate] ${AGENT}: mid-day rotation — moved ${OVERFLOW} lines to daily/${TODAY}-early.md" >&2
    fi

    exit 0
fi

# Date has changed — rotate
# 2026-05-19: archive under the date written IN today.md's header, not
# bash's $(date -d yesterday). The previous behaviour silently mis-archived
# logs when an agent was idle across multiple days (e.g. Friday content
# rotating on Monday landed under Sunday's date instead of Friday's),
# or under DST shifts where the bash "yesterday" calc drifts.
HEADER_DATE=$(printf '%s' "$HEADER" | sed -nE 's/^# Today[[:space:]]*[—-][[:space:]]*([0-9]{4}-[0-9]{2}-[0-9]{2}).*/\1/p')
if [ -z "$HEADER_DATE" ]; then
    HEADER_DATE=$(date -d "yesterday" +%Y-%m-%d)
fi
DAILY="${LOGS}/daily"
mkdir -p "$DAILY"

# Archive and rotate only if file has content beyond the header
LINES=$(wc -l < "$TODAY_MD" 2>/dev/null || echo 0)
if [ "$LINES" -gt 1 ]; then
    cp "$TODAY_MD" "${LOGS}/yesterday.md"
    cp "$TODAY_MD" "${DAILY}/${HEADER_DATE}.md"
    echo "[check-rotate] ${AGENT}: rotated today.md → daily/${HEADER_DATE}.md"
fi

# Write fresh today.md
printf "# Today — %s\n\n" "$TODAY" > "$TODAY_MD"
