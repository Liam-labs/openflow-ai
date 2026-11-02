#!/bin/bash
# =============================================================================
# DevFlow Safe Build - Atomic build with swap
# =============================================================================
# Builds into .next-staging, validates, then atomically swaps to .next
# The production server stays up on the old build during the entire build.
#
# Features:
#   - flock-based locking (OS-level, no PID file races)
#   - Builds into staging directory (server unaffected)
#   - Validates build before swapping (catches Turbopack corruption)
#   - Atomic swap via rename (microseconds of exposure)
#   - Auto-restarts PM2 after successful swap
#
# Usage:
#   ./scripts/safe-build.sh          # Normal build + swap + PM2 restart
#   ./scripts/safe-build.sh --no-restart  # Build + swap only (no PM2 restart)
#   ./scripts/safe-build.sh --stage       # Build + validate into .next-ready only;
#                                          # production and PM2 are untouched
#   ./scripts/safe-build.sh --activate    # Swap a staged .next-ready in + restart
#                                          # (seconds; no compile)
# =============================================================================

set -euo pipefail

DEVFLOW_HOME="${DEVFLOW_HOME:-$HOME/DevFlow}"
DEVFLOW_DIR="$DEVFLOW_HOME"
STAGING_DIR="$DEVFLOW_DIR/.next-staging"
PROD_DIR="$DEVFLOW_DIR/.next"
OLD_DIR="$DEVFLOW_DIR/.next-old"
READY_DIR="$DEVFLOW_DIR/.next-ready"
LOCK_FILE="$DEVFLOW_DIR/.build.lock"
LOG_FILE="$DEVFLOW_DIR/logs/build.log"
EVENT_LOG_DIR="$DEVFLOW_DIR/logs/event-logs"
EVENT_LOG_FILE="$EVENT_LOG_DIR/current.jsonl"

NO_RESTART=false
MODE=full
case "${1:-}" in
    --no-restart) NO_RESTART=true ;;
    --stage) MODE=stage ;;
    --activate) MODE=activate ;;
esac

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [safe-build] $1" | tee -a "$LOG_FILE"
}

# Write a build event to the unified JSONL log
log_build_event() {
    local event="$1"
    local build_id="${2:-}"
    local duration_ms="${3:-}"
    local trigger="${4:-unknown}"
    local error="${5:-}"
    mkdir -p "$EVENT_LOG_DIR"
    local ts; ts=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
    local id; id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c "import uuid; print(uuid.uuid4())")
    local severity="info"
    [[ "$event" == "failed" ]] && severity="high"
    local title="Build $event"
    [[ -n "$build_id" ]] && title="Build $event (ID: $build_id)"
    # Build JSON without jq dependency
    local json="{\"id\":\"$id\",\"timestamp\":\"$ts\",\"source\":\"build\",\"severity\":\"$severity\",\"title\":\"$title\",\"metadata\":{\"event\":\"$event\""
    [[ -n "$build_id" ]] && json="$json,\"buildId\":\"$build_id\""
    [[ -n "$duration_ms" ]] && json="$json,\"durationMs\":$duration_ms"
    json="$json,\"trigger\":\"$trigger\""
    [[ -n "$error" ]] && json="$json,\"error\":\"$error\""
    json="$json}}"
    echo "$json" >> "$EVENT_LOG_FILE"
}

mkdir -p "$DEVFLOW_DIR/logs"

# ---- Acquire build lock (blocks if another build is running) ----
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "Another build is already running. Waiting for it to finish..."
    PRE_WAIT_BUILD_ID=$(cat "$PROD_DIR/BUILD_ID" 2>/dev/null || true)
    # A program that inherited the lock from an earlier build could hold it for good: give up after an hour instead of waiting forever.
    flock -w "${DEVFLOW_BUILD_LOCK_WAIT:-3600}" 9 || { log "ERROR: the build lock was still held after an hour (a leftover process?). Not building."; exit 1; }
    log "Lock acquired after waiting."
    # Skip only when the other build actually shipped a new build while we
    # waited. If it failed, the existing BUILD_ID is the old one and this
    # build must still run. --stage and --activate always do their own job.
    BUILD_ID=$(cat "$PROD_DIR/BUILD_ID" 2>/dev/null || true)
    if [ "$MODE" = full ] && [ -n "$BUILD_ID" ] && [ "$BUILD_ID" != "$PRE_WAIT_BUILD_ID" ] && [ -f "$PROD_DIR/server/app/page_client-reference-manifest.js" ]; then
        log "Other build produced valid output (ID: $BUILD_ID). Skipping redundant build."
        log_build_event "skipped" "$BUILD_ID" "" "safe-build.sh"
        exit 0
    fi
fi
# Lock is held for the duration of this script (fd 9 auto-closes on exit). Programs started below get 9>&- so none of them keeps it.

BUILD_START_MS=$(date +%s%3N)
log "=========================================="
log "Build started"
log_build_event "start" "" "" "safe-build.sh"

cd "$DEVFLOW_DIR"

# ---- Environment setup ----
unset npm_config_prefix 2>/dev/null || true
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
unset TURBOPACK

# Non-secret DevFlow settings (the owner's name, DevFlow home) come from this file, not from whoever's shell started the
# build: an empty DEVFLOW_OWNER_NAME in the caller's environment inlined "You" into the site on 21 Oct 2026.
if [ -f "$HOME/.config/devflow/env" ]; then set -a; . "$HOME/.config/devflow/env"; set +a; fi

# ---- Cap build memory to prevent OOM kills ----
# 6144 MB default: the 3072 MB cap OOM-killed four builds on 2026-09-04 (exit 134)
# with 20+ GB free. Operators can still override via DEVFLOW_BUILD_HEAP_MB.
BUILD_HEAP_MB="${DEVFLOW_BUILD_HEAP_MB:-6144}"
if ! [[ "$BUILD_HEAP_MB" =~ ^[1-9][0-9]*$ ]]; then
    log "ERROR: DEVFLOW_BUILD_HEAP_MB must be a positive integer."
    exit 1
fi
export NODE_OPTIONS="--max-old-space-size=$BUILD_HEAP_MB"

if [ "$MODE" = activate ]; then
    # A staged build compiled while production kept serving; only swap it in.
    if [ ! -f "$READY_DIR/BUILD_ID" ] || [ ! -f "$READY_DIR/server/app/page_client-reference-manifest.js" ]; then
        log "ERROR: No valid staged build in .next-ready. Run --stage first."
        exit 1
    fi
    if [ "$(cat "$READY_DIR/BASE_ID" 2>/dev/null)" != "$(cat "$PROD_DIR/BUILD_ID" 2>/dev/null)" ]; then
        log "ERROR: The staged build was made while another build was live; a newer build has shipped since. Run --stage again."
        exit 1
    fi
    rm -rf "$STAGING_DIR"
    mv "$READY_DIR" "$STAGING_DIR"
    log "Activating staged build (ID: $(cat "$STAGING_DIR/BUILD_ID"))"
else
# ---- Guard: only lib/collab-channel-store.ts may write collab-channels.json ----
# A second write path lets a stale copy overwrite a newer change (Jack's seat record,
# 15 Oct 2026). Fails before the compile, so a bad write never reaches a build.
log "Checking that collab-channels.json is written only through the channel store..."
set +e
CHANNEL_GUARD_OUTPUT=$(node "$DEVFLOW_DIR/scripts/check-channel-writes.mjs" 2>&1)
CHANNEL_GUARD_EXIT=$?
set -e
echo "$CHANNEL_GUARD_OUTPUT" | tee -a "$LOG_FILE"
if [ "$CHANNEL_GUARD_EXIT" -ne 0 ]; then
    BUILD_DURATION=$(( $(date +%s%3N) - BUILD_START_MS ))
    log "ERROR: channel write guard failed (exit $CHANNEL_GUARD_EXIT) - aborting before compile. Keeping current production build."
    log_build_event "failed" "" "$BUILD_DURATION" "safe-build.sh" "Channel write guard failed: $CHANNEL_GUARD_EXIT"
    exit 1
fi

# ---- Clean staging directory ----
rm -rf "$STAGING_DIR"

# ---- Build into staging directory ----
log "Building into .next-staging..."
export NEXT_BUILD_DIR=".next-staging"
unset TURBOPACK

# Non-secret DevFlow settings (the owner's name, DevFlow home) come from this file, not from whoever's shell started the
# build: an empty DEVFLOW_OWNER_NAME in the caller's environment inlined "You" into the site on 21 Oct 2026.
if [ -f "$HOME/.config/devflow/env" ]; then set -a; . "$HOME/.config/devflow/env"; set +a; fi

# Turbopack build (~1 min, ~4 GB) replaced webpack (20-26 min, OOM-killed under
# agent load) on 27 Sep 2026. Route code must build data paths with appPath()
# from lib/app-paths.ts, not path.join(process.cwd(), ...), or Turbopack traces
# .AppData and aborts on its venv symlinks. `npm run build:unsafe` stays webpack.
# set +e required so PIPESTATUS captures next build's exit code through the tee
# pipe; we check BUILD_EXIT immediately after and fail on non-zero.
set +e
# Build below DevFlow's priority: at equal priority its compile workers
# starved the live server and every wrapper's API calls timed out for the whole
# build (27 Sep 2026, 18:38-19:09). The build still uses all idle CPU.
# The build peaks at 12 to 16 GB. On the 30 GB server that, a loaded RAG worker and the Supabase stacks can reach swap and take DevFlow down
# (29 Oct 2026: an unlimited build ran over an hour at 12 GB with swap full). Run it in a scope with a hard ceiling: if it ever passes
# MemoryMax it is killed alone and everything else lives. MemoryHigh is deliberately NOT set: tested at 12G and 15G it throttled the build
# into reclaim (memory pressure 60 to 70 percent) so it never finished. DEVFLOW_BUILD_SCOPE=0 turns the scope off.
# Without the scope the build must not run unnoticed: when the scope cannot be made, the build stops with a message.
BUILD_SCOPE=()
if [ "${DEVFLOW_BUILD_SCOPE:-1}" != "0" ]; then
  # A build started from pm2, sudo or ssh can lack the user manager's address; point it at the usual place.
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  # The probe reads the ceiling back from inside a scope: systemd accepts MemoryMax and ignores it when memory is not delegated.
  # Probed in the same slice the build uses, so a broken slice is reported here, not later as a compile failure (cloud review 31 Oct 2026).
  SCOPE_PROBE=$(systemd-run --user --scope --quiet --slice=devflow-heavy.slice -p MemoryMax=1G -- sh -c 'cat "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.max"' 2>/dev/null)
  if [ "$SCOPE_PROBE" != "1073741824" ]; then
    log "ERROR: the memory-limited build scope is not available (systemd-run --user failed or MemoryMax is not applied; probe read '${SCOPE_PROBE:-nothing}'). Keeping current production build. DEVFLOW_BUILD_SCOPE=0 builds without a ceiling."
    log_build_event "failed" "" "$(( $(date +%s%3N) - BUILD_START_MS ))" "safe-build.sh" "No memory-limited build scope"
    rm -rf "$STAGING_DIR"
    exit 1
  fi
  # Run inside the shared devflow-heavy.slice (task ea958abf): the build keeps its own 18G ceiling, and the slice makes
  # builds and any heavy test/bisect runs (started with scripts/devflow-heavy) share ONE 18G budget, so other heavy work
  # can no longer stack on top of a build and stall the server (incident 30 Oct 2026). A single build is unchanged.
  BUILD_SCOPE=(systemd-run --user --scope --quiet --slice=devflow-heavy.slice --unit="devflow-next-build-$$" -p MemoryMax="${DEVFLOW_BUILD_MEMORY_MAX:-18G}" -p MemorySwapMax=2G --)
  log "Build runs in the devflow-heavy.slice memory budget (build ceiling ${DEVFLOW_BUILD_MEMORY_MAX:-18G})"
else
  log "WARNING: DEVFLOW_BUILD_SCOPE=0, the build runs without a memory ceiling"
fi
# Where the RAG embedding service runs here, ask it to unload its models first (about 2.7 GB) and warm them again afterwards (below): a build next
# to a loaded model worker and full swap did not finish on the 30 GB server (29 Oct 2026). A search during the build reloads the models.
RAG_URL="${DEVFLOW_RAG_EMBED_URL:-http://127.0.0.1:6900}"
if [ "${DEVFLOW_BUILD_UNLOAD_RAG:-1}" != "0" ] && curl -sf -m 3 "$RAG_URL/health" >/dev/null 2>&1; then
  curl -s -m 30 -X POST "$RAG_URL/admin/unload" >/dev/null 2>&1 && log "RAG models unloaded for the build"
fi
nice -n 15 "${BUILD_SCOPE[@]}" node_modules/.bin/next build --turbopack 2>&1 9>&- | tee -a "$LOG_FILE"
BUILD_EXIT=${PIPESTATUS[0]}
# Load the RAG models again in the background so the first search after the build is not cold.
if [ "${DEVFLOW_BUILD_UNLOAD_RAG:-1}" != "0" ]; then
  ( curl -s -m 120 -X POST "$RAG_URL/embed/hybrid" -H 'Content-Type: application/json' -d '{"texts":["warm up"]}' >/dev/null 2>&1; curl -s -m 120 -X POST "$RAG_URL/embed/colbert-query" -H 'Content-Type: application/json' -d '{"texts":["warm up"]}' >/dev/null 2>&1 ) >/dev/null 2>&1 9>&- &
fi
# next build can exit leaving SIGTERM-immune jest workers behind (1 Oct 2026).
bash "$DEVFLOW_DIR/scripts/kill-orphan-next-workers.sh" 9>&- | tee -a "$LOG_FILE"
set -e
if [ "$BUILD_EXIT" -ne 0 ]; then
    BUILD_DURATION=$(( $(date +%s%3N) - BUILD_START_MS ))
    log "ERROR: next build exited with code $BUILD_EXIT — aborting."
    log_build_event "failed" "" "$BUILD_DURATION" "safe-build.sh" "Build exited non-zero: $BUILD_EXIT"
    rm -rf "$STAGING_DIR"
    exit 1
fi
log "Build compilation succeeded"

# ---- Validate build output ----
CHECKS_PASSED=true

if [ ! -f "$STAGING_DIR/BUILD_ID" ]; then
    log "VALIDATION FAILED: No BUILD_ID"
    CHECKS_PASSED=false
fi
if [ ! -d "$STAGING_DIR/server" ]; then
    log "VALIDATION FAILED: No server directory"
    CHECKS_PASSED=false
fi
if [ ! -f "$STAGING_DIR/build-manifest.json" ]; then
    log "VALIDATION FAILED: No build-manifest.json"
    CHECKS_PASSED=false
fi
if [ ! -f "$STAGING_DIR/server/app/page_client-reference-manifest.js" ]; then
    log "VALIDATION FAILED: No client-reference-manifest (Turbopack corruption?)"
    CHECKS_PASSED=false
fi

if [ "$CHECKS_PASSED" = false ]; then
    log "ERROR: Build validation failed! Keeping current production build."
    BUILD_DURATION=$(( $(date +%s%3N) - BUILD_START_MS ))
    log_build_event "failed" "" "$BUILD_DURATION" "safe-build.sh" "Build validation failed"
    rm -rf "$STAGING_DIR"
    exit 1
fi

log "Build validated successfully (ID: $(cat "$STAGING_DIR/BUILD_ID"))"

if [ "$MODE" = stage ]; then
    rm -rf "$READY_DIR"
    cat "$PROD_DIR/BUILD_ID" > "$STAGING_DIR/BASE_ID" 2>/dev/null || true
    mv "$STAGING_DIR" "$READY_DIR"
    BUILD_DURATION=$(( $(date +%s%3N) - BUILD_START_MS ))
    log "Build staged in .next-ready (ID: $(cat "$READY_DIR/BUILD_ID")); run --activate to swap and restart"
    log_build_event "staged" "$(cat "$READY_DIR/BUILD_ID")" "$BUILD_DURATION" "safe-build.sh"
    exit 0
fi
fi

NEW_BUILD_ID=$(cat "$STAGING_DIR/BUILD_ID")

# ---- Atomic swap ----
# Two rename operations (~1ms total). Server may fail for this instant,
# but PM2 will restart it immediately with the new build.
# If interrupted between the two renames, devflow-wrapper.sh will recover
# from .next-old on next start.
log "Swapping .next-staging -> .next..."

rm -rf "$OLD_DIR"
if [ -d "$PROD_DIR" ]; then
    mv "$PROD_DIR" "$OLD_DIR"
fi
if ! mv "$STAGING_DIR" "$PROD_DIR"; then
    log "ERROR: could not move the new build into place. Putting the previous build back."
    [ -d "$OLD_DIR" ] && [ ! -e "$PROD_DIR" ] && mv "$OLD_DIR" "$PROD_DIR"
    log_build_event "failed" "" "$(( $(date +%s%3N) - BUILD_START_MS ))" "safe-build.sh" "Swap rename failed"
    exit 1
fi

# Verify swap landed correctly before cleaning up the backup
if [ ! -f "$PROD_DIR/BUILD_ID" ]; then
    log "ERROR: Swap failed — .next/BUILD_ID missing after rename. Restoring from backup..."
    rm -rf "$PROD_DIR"
    if [ -d "$OLD_DIR" ]; then
        mv "$OLD_DIR" "$PROD_DIR"
        log "Restored previous build from .next-old"
    fi
    BUILD_DURATION=$(( $(date +%s%3N) - BUILD_START_MS ))
    log_build_event "failed" "" "$BUILD_DURATION" "safe-build.sh" "Swap verification failed"
    exit 1
fi

log "Swap complete"

# The previous build stays in .next-old until the restarted app has answered (below).
RESTARTED=false

# ---- Restart PM2 if running ----
if [ "$NO_RESTART" = false ]; then
    if pm2 pid devflow > /dev/null 2>&1; then
        # Notify SSE clients before restart so they can handle graceful disconnect
        log "Notifying SSE clients of pending restart..."
        NOTIFY_RESULT=$(curl -sf -X POST http://localhost:3000/api/system/restart-notify 2>/dev/null || echo '{"notified":0}')
        NOTIFIED=$(echo "$NOTIFY_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('notified',0))" 2>/dev/null || echo 0)
        log "Notified $NOTIFIED SSE client(s)"
        # Brief delay for clients to process the event
        sleep 1

        log "Restarting PM2 devflow..."
        if pm2 restart devflow >> "$LOG_FILE" 2>&1 9>&-; then
            log "PM2 restarted"
        else
            log "ERROR: pm2 restart devflow failed"
        fi
        RESTARTED=true
    else
        log "PM2 devflow not running, skipping restart"
    fi
fi

# ---- Health check, then drop the old build ----
# A build can pass the file checks above and still crash or fail on start. Until DevFlow answers on the new build the old one is kept;
# if it never answers, the old build goes back and DevFlow is restarted on it (29 Oct 2026 review).
devflow_answers() {
    local i code
    for i in $(seq 1 "${DEVFLOW_HEALTH_TRIES:-40}"); do
        code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${DEVFLOW_PORT:-3000}/api/health" 2>/dev/null || true)
        [ "$code" = 200 ] && return 0
        sleep "${DEVFLOW_HEALTH_WAIT:-3}"
    done
    return 1
}
if [ "$RESTARTED" = true ] && ! devflow_answers; then
    BUILD_DURATION=$(( $(date +%s%3N) - BUILD_START_MS ))
    if [ -d "$OLD_DIR" ]; then
        log "ERROR: DevFlow did not answer on build $NEW_BUILD_ID. Putting the previous build back (the failed one is kept in .next-failed)."
        rm -rf "$DEVFLOW_DIR/.next-failed"
        mv "$PROD_DIR" "$DEVFLOW_DIR/.next-failed"
        mv "$OLD_DIR" "$PROD_DIR"
        pm2 restart devflow > /dev/null 2>&1 9>&- || true
        if devflow_answers; then
            log "DevFlow is back on the previous build (ID: $(cat "$PROD_DIR/BUILD_ID" 2>/dev/null))"
        else
            log "ERROR: DevFlow does not answer on the previous build either"
        fi
    else
        log "ERROR: DevFlow did not answer on build $NEW_BUILD_ID and there is no previous build to put back"
    fi
    log_build_event "failed" "$NEW_BUILD_ID" "$BUILD_DURATION" "safe-build.sh" "DevFlow did not answer after the restart"
    exit 1
fi
rm -rf "$OLD_DIR"

BUILD_DURATION=$(( $(date +%s%3N) - BUILD_START_MS ))
log_build_event "complete" "$NEW_BUILD_ID" "$BUILD_DURATION" "safe-build.sh"
log "Build complete (ID: $NEW_BUILD_ID)"
log "=========================================="
