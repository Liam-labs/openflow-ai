#!/bin/bash
# Small helpers so the shell hooks behave the same on Linux and macOS. macOS has no `timeout` or `flock` command, and its
# `date` has no %N. Source it (guarded with `|| true`), then call:
#
#     portable_timeout 5 python3 script.py     # runs without a time limit when no timeout program exists
#     exec 9>"$LOCK"; portable_try_lock 9      # non-blocking exclusive lock on the open descriptor; false when someone holds it
#
# Never breaks the caller on a system that has the GNU tools: they are used as before.

portable_timeout() {
    local secs="$1"; shift
    if command -v timeout >/dev/null 2>&1; then
        timeout "$secs" "$@"
    elif command -v gtimeout >/dev/null 2>&1; then      # Homebrew coreutils
        gtimeout "$secs" "$@"
    else
        "$@"
    fi
}

portable_try_lock() {
    local fd="$1"
    if command -v flock >/dev/null 2>&1; then
        flock -n "$fd"
    else
        # The child inherits the descriptor, so the lock it takes belongs to the same open file and lasts as long as this shell holds it.
        python3 -c 'import fcntl, sys
try:
    fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(1)' "$fd"
    fi
}
