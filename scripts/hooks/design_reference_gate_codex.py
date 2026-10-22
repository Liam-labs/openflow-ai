#!/usr/bin/env python3
"""Codex-native adapter for the strict Design Reference gate policy."""

from __future__ import annotations

import argparse
import json
import os
import sys

from design_reference_gate import fetch_active_design_reference_gate
from design_reference_gate_wrapper import (
    CODEX_SAFE_TOOL_IDENTITIES,
    check_registered_tool_use,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Gate every Codex tool on registered-safe identity or exact authorization"
    )
    parser.add_argument("--agent-dir", default=os.getcwd())
    parser.add_argument(
        "--api-base",
        default=os.environ.get("DESIGN_REFERENCE_API_BASE", os.environ.get("DEVFLOW_URL", "http://localhost:3000")),
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args(argv)
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    decision = check_registered_tool_use(
        args.agent_dir,
        payload,
        safe_tool_identities=CODEX_SAFE_TOOL_IDENTITIES,
        fetch_active_gate=lambda agent_dir, hook_payload: fetch_active_design_reference_gate(
            agent_dir,
            hook_payload,
            api_base=args.api_base,
        ),
    )
    if decision.allowed:
        return 0
    print(
        "DESIGN_REFERENCE_GATE_BLOCKED: "
        f"{decision.reason}. Wait for an exact current use/combine selection, or use the sanctioned "
        "design_reference_board.py helper to post the requested refinement.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
