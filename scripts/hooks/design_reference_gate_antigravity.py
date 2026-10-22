#!/usr/bin/env python3
"""Antigravity-native adapter for the shared Design Reference gate."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Callable


HOOKS_DIR = Path(__file__).resolve().parent
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

from design_reference_gate import (  # noqa: E402
    GateDecision,
    fetch_active_design_reference_gate,
)
from design_reference_gate_wrapper import (  # noqa: E402
    ANTIGRAVITY_SAFE_TOOL_IDENTITIES,
    check_registered_tool_use,
)


FILE_TOOL_MAP = {
    "write_to_file": "Write",
    "replace_file_content": "Edit",
    "multi_replace_file_content": "Edit",
}
DELEGATION_TOOL_MAP = {
    "invoke_subagent": "spawn_agent",
    "define_subagent": "spawn_agent",
    "schedule": "Task",
}


def normalize_antigravity_payload(payload: object) -> dict:
    """Translate Antigravity's camelCase hook payload to the shared contract."""
    if not isinstance(payload, dict):
        return {}
    tool_call = payload.get("toolCall")
    if not isinstance(tool_call, dict) or not isinstance(tool_call.get("name"), str):
        return {}
    name = tool_call["name"]
    args = tool_call.get("args") if isinstance(tool_call.get("args"), dict) else {}

    if name == "run_command":
        command = args.get("CommandLine")
        return {
            "tool_name": "Bash",
            "tool_input": {"command": command} if isinstance(command, str) else {},
        }
    if name in FILE_TOOL_MAP:
        return {"tool_name": FILE_TOOL_MAP[name], "tool_input": args}
    if name in DELEGATION_TOOL_MAP:
        return {"tool_name": DELEGATION_TOOL_MAP[name], "tool_input": args}
    if name in {"manage_task", "manage_subagents"}:
        return {"tool_name": "Task", "tool_input": args}
    return {"tool_name": name, "tool_input": args}


def antigravity_gate_decision(
    agent_dir: str,
    payload: object,
    *,
    fetch_active_gate: Callable[[str, dict], dict] | None = None,
    now: datetime | None = None,
) -> GateDecision:
    return check_registered_tool_use(
        agent_dir,
        normalize_antigravity_payload(payload),
        safe_tool_identities=ANTIGRAVITY_SAFE_TOOL_IDENTITIES,
        fetch_active_gate=fetch_active_gate,
        now=now,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Gate Antigravity mutation tools on exact design authorization"
    )
    parser.add_argument("--agent-dir", required=True)
    parser.add_argument(
        "--api-base",
        default=os.environ.get("DESIGN_REFERENCE_API_BASE", os.environ.get("DEVFLOW_URL", "http://localhost:3000")),
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args(argv)
    try:
        payload = json.load(sys.stdin)
        decision = antigravity_gate_decision(
            args.agent_dir,
            payload,
            fetch_active_gate=lambda agent_dir, hook_payload: fetch_active_design_reference_gate(
                agent_dir,
                hook_payload,
                api_base=args.api_base,
            ),
        )
    except BaseException as error:
        decision = GateDecision(
            False,
            f"design reference gate adapter failed closed: {error}",
        )
    print(
        json.dumps(
            {
                "decision": "allow" if decision.allowed else "deny",
                "reason": decision.reason,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
