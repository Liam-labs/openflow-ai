#!/usr/bin/env python3
"""Roll out DevFlow's session-bound hooks and conditional safety gate.

Behavioural UserPromptSubmit hooks and TaskCompleted gates are intentionally
removed. Durable scaffolding loads at session start; scratch buffers flush at
Stop, while PreCompact flushes before preserving handoff state. The PreToolUse
gate is dormant unless a Design Reference board artifact exists.
"""

import glob
import json
import os
import sys
from pathlib import Path


DEVFLOW_DIR = os.environ.get("DEVFLOW_HOME") or os.path.join(os.path.expanduser("~"), "DevFlow")
# Team folders to roll hooks out to: DEVFLOW_TEAM_DIRS (colon separated), else the DevFlow Team folder.
TEAM_DIRS = [d for d in os.environ.get("DEVFLOW_TEAM_DIRS", "").split(":") if d] or [os.path.join(DEVFLOW_DIR, "Team")]
sys.path.insert(0, str(Path(DEVFLOW_DIR) / "scripts"))
from agent_lifecycle_hooks import build_hooks, merge_session_hooks


def canonical_hooks(agent_name: str, agent_dir: str) -> dict:
    return build_hooks(agent_name, agent_dir)


def update_agent_settings(agent_dir: str) -> tuple[bool, str]:
    agent_name = os.path.basename(agent_dir)
    settings_path = os.path.join(agent_dir, ".claude", "settings.json")

    if not os.path.exists(settings_path):
        return False, f"No settings.json at {settings_path}"

    with open(settings_path, encoding="utf-8") as handle:
        settings = json.load(handle)

    expected = merge_session_hooks(
        settings.get("hooks", {}),
        canonical_hooks(agent_name, agent_dir),
    )
    if settings.get("hooks") == expected:
        return False, f"Already up to date: {agent_name}"

    settings["hooks"] = expected
    temp_path = settings_path + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(settings, handle, indent=2)
        handle.write("\n")
    os.replace(temp_path, settings_path)
    return True, f"Updated {agent_name}"


def main() -> None:
    updated = 0
    unchanged = 0

    agent_dirs: list[str] = []
    for team_dir in TEAM_DIRS:
        agent_dirs.extend(sorted(glob.glob(os.path.join(team_dir, "*"))))

    for agent_dir in agent_dirs:
        if not os.path.isdir(agent_dir):
            continue
        changed, message = update_agent_settings(agent_dir)
        print(message)
        if changed:
            updated += 1
        else:
            unchanged += 1

    print(f"\nDone: {updated} updated, {unchanged} unchanged")


if __name__ == "__main__":
    main()
