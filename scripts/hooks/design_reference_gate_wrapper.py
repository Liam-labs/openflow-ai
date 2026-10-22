#!/usr/bin/env python3
"""Strict tool-identity policy shared by non-Claude harness adapters.

The canonical gate predates MCP/app tool proliferation and retains a
mutation-name heuristic for Claude compatibility.  Wrapper-native hooks must
not use that heuristic as their security boundary: only reviewed inspection
and research identities bypass live authorization, while every other tool is
forced through the exact-tuple check.
"""

from __future__ import annotations

from datetime import datetime
from typing import Callable, Collection

from design_reference_gate import GateDecision, check_pre_tool_use


CODEX_SAFE_TOOL_IDENTITIES = frozenset(
    {
        "get_goal",
        "list_mcp_resource_templates",
        "list_mcp_resources",
        "read_mcp_resource",
        "view_image",
        "web__run",
    }
)

ANTIGRAVITY_SAFE_TOOL_IDENTITIES = frozenset(
    {
        "find_by_name",
        "grep_search",
        "list_dir",
        "read_url_content",
        "search_web",
        "view_file",
    }
)

CANONICAL_SHELL_IDENTITIES = frozenset(
    {
        "Bash",
        "bash_exec",
        "exec_command",
        "powershell",
        "shell",
        "terminal",
    }
)


def check_registered_tool_use(
    agent_dir: str,
    payload: object,
    *,
    safe_tool_identities: Collection[str],
    fetch_active_gate: Callable[[str, dict], dict] | None = None,
    now: datetime | None = None,
) -> GateDecision:
    """Apply exact safe identities and authorization-required fallback.

    Shell identities retain their canonical payload only so the shared gate
    can recognize the two rigorously parsed collab/refine helper commands.
    Every other non-safe identity is rewritten to a known mutation identity;
    this makes arbitrary MCP/app/browser/deploy/delegation names require the
    same fresh selected-tuple authorization instead of relying on their verb.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("tool_name"), str):
        return check_pre_tool_use(
            agent_dir,
            payload,
            fetch_active_gate=fetch_active_gate,
            now=now,
        )

    tool_name = payload["tool_name"]
    if tool_name in safe_tool_identities:
        return GateDecision(True, "tool identity is registered as inspection or research")
    if tool_name in CANONICAL_SHELL_IDENTITIES:
        canonical_payload = payload
    else:
        canonical_payload = {
            "tool_name": "Write",
            "tool_input": payload.get("tool_input", {}),
        }
    return check_pre_tool_use(
        agent_dir,
        canonical_payload,
        fetch_active_gate=fetch_active_gate,
        now=now,
    )
