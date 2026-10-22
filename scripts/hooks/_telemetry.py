#!/usr/bin/env python3
"""Hook firing telemetry — JSONL fire-event emitter.

Usage (Python module):
    from _telemetry import record_fire, time_block
    started = record_fire.now_ms()
    # ... hook does work ...
    record_fire(agent="Jack", hook="context-inject", event="UserPromptSubmit",
                exit_code=0, ms=record_fire.now_ms() - started)

    # Or as a context manager:
    with time_block() as t:
        # ... hook does work ...
    record_fire(agent=..., hook=..., event=..., exit_code=0, ms=t.ms)

Usage (CLI — for shell hooks that prefer not to source _telemetry.sh):
    python3 _telemetry.py emit \\
        --agent Jack --hook pre-compact-write \\
        --event PreCompact --exit 0 --ms 47

Output: append one JSONL line per fire to ~/DevFlow/.AppData/hook-events.jsonl

Bounded rotation: when file exceeds HOOK_EVENTS_MAX_BYTES (default 5 MiB),
atomically rename to .1 (one rotation kept). Worst-case data loss = one event
window during the rename, accepted.

Never throws — telemetry must not break the hook it's attached to. All errors
are silently swallowed; a missing AppData dir is created on demand.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

# ============================================================================
# Config (overridable via env)
# ============================================================================

EVENTS_PATH = Path(
    os.environ.get(
        "HOOK_EVENTS_PATH",
        os.path.expanduser("~/DevFlow/.AppData/hook-events.jsonl"),
    )
)
MAX_BYTES = int(os.environ.get("HOOK_EVENTS_MAX_BYTES", str(5 * 1024 * 1024)))


def _now_ms() -> int:
    return int(time.time() * 1000)


def _utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def _rotate_if_needed() -> None:
    """Move events file to .1 when it exceeds the cap. Idempotent + atomic."""
    try:
        if EVENTS_PATH.exists() and EVENTS_PATH.stat().st_size > MAX_BYTES:
            backup = EVENTS_PATH.with_suffix(EVENTS_PATH.suffix + ".1")
            # Overwrite any older .1 — we only keep one rotation worth
            os.replace(EVENTS_PATH, backup)
    except Exception:
        # If rotation fails, the worst case is the file grows past cap until
        # something else cleans it. Acceptable degradation.
        pass


def record_fire(
    *,
    agent: str,
    hook: str,
    event: str,
    exit_code: int = 0,
    ms: int = 0,
    **extras: object,
) -> None:
    """Append one fire-event JSONL line. Silent on any failure.

    Required fields per task spec: agent, hook, event, exit code, ms.
    Extras are merged into the payload (e.g. note, prompt_chars).
    """
    try:
        EVENTS_PATH.parent.mkdir(parents=True, exist_ok=True)
        _rotate_if_needed()

        payload = {
            "ts": _utc_iso(),
            "agent": agent or "?",
            "hook": hook or "?",
            "event": event or "?",
            "exit": int(exit_code) if exit_code is not None else 0,
            "ms": int(ms) if ms is not None else 0,
        }
        # Merge extras last but don't let them clobber required keys
        for k, v in (extras or {}).items():
            if k in payload:
                continue
            try:
                json.dumps(v)
                payload[k] = v
            except Exception:
                payload[k] = str(v)

        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        # Append in a single write — JSONL line is well under PIPE_BUF (4 KiB
        # on Linux), so O_APPEND guarantees atomic concurrent writes from
        # multiple hook processes.
        with open(EVENTS_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        # NEVER let telemetry crash the hook. Swallow and move on.
        pass


# Expose `now_ms` as an attribute on record_fire for ergonomic timing in
# Python hooks: `t0 = record_fire.now_ms(); ...; record_fire(ms=record_fire.now_ms()-t0)`.
record_fire.now_ms = _now_ms  # type: ignore[attr-defined]


class _TimeBlockResult:
    __slots__ = ("ms", "_started")

    def __init__(self) -> None:
        self._started = _now_ms()
        self.ms = 0


@contextmanager
def time_block():
    """Context manager: measures wall-clock ms inside the block.

    Usage:
        with time_block() as t:
            ...do hook work...
        record_fire(..., ms=t.ms, exit_code=0)
    """
    res = _TimeBlockResult()
    try:
        yield res
    finally:
        res.ms = _now_ms() - res._started


# ============================================================================
# CLI mode — for hooks that prefer to invoke this script rather than import
# ============================================================================


def _cli() -> int:
    parser = argparse.ArgumentParser(description="Hook firing telemetry emitter")
    subs = parser.add_subparsers(dest="cmd")

    emit = subs.add_parser("emit", help="Append one fire-event line")
    emit.add_argument("--agent", required=True)
    emit.add_argument("--hook", required=True)
    emit.add_argument("--event", required=True)
    emit.add_argument("--exit", dest="exit_code", type=int, default=0)
    emit.add_argument("--ms", type=int, default=0)
    emit.add_argument(
        "--extra",
        action="append",
        default=[],
        help="key=value pair (repeatable)",
    )

    tail = subs.add_parser("tail", help="Print the last N events")
    tail.add_argument("-n", type=int, default=20)

    rotate = subs.add_parser("rotate", help="Force rotation now")
    subs.add_parser("path", help="Print events file path")
    subs.add_parser("stats", help="Print event counts + file size")

    args = parser.parse_args()

    if args.cmd == "emit":
        extras: dict[str, object] = {}
        for kv in args.extra:
            if "=" in kv:
                k, v = kv.split("=", 1)
                extras[k] = v
        record_fire(
            agent=args.agent,
            hook=args.hook,
            event=args.event,
            exit_code=args.exit_code,
            ms=args.ms,
            **extras,
        )
        return 0

    if args.cmd == "tail":
        try:
            lines = EVENTS_PATH.read_text(encoding="utf-8").splitlines()
            for line in lines[-args.n :]:
                print(line)
            return 0
        except FileNotFoundError:
            return 0

    if args.cmd == "rotate":
        _rotate_if_needed()
        return 0

    if args.cmd == "path":
        print(EVENTS_PATH)
        return 0

    if args.cmd == "stats":
        try:
            size = EVENTS_PATH.stat().st_size if EVENTS_PATH.exists() else 0
            count = 0
            if EVENTS_PATH.exists():
                with open(EVENTS_PATH, "rb") as fh:
                    for _ in fh:
                        count += 1
            backup = EVENTS_PATH.with_suffix(EVENTS_PATH.suffix + ".1")
            backup_size = backup.stat().st_size if backup.exists() else 0
            print(
                json.dumps(
                    {
                        "path": str(EVENTS_PATH),
                        "bytes": size,
                        "events": count,
                        "rotated_bytes": backup_size,
                        "max_bytes": MAX_BYTES,
                    },
                    indent=2,
                )
            )
            return 0
        except Exception as exc:
            print(f"stats failed: {exc}", file=sys.stderr)
            return 1

    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
