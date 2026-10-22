#!/usr/bin/env python3
"""Provision agent-owned runtime directories, then delegate scaffolding to sync.py.

This script intentionally contains no role, personality, workspace, model
entrypoint, or shared-policy templates. Those have one source of truth under
``data/scaffolding/masters`` and ``data/roles``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from codex_workspace_trust import ensure_codex_workspace_trusted
from agent_lifecycle_hooks import build_hooks


DEVFLOW_DIR = Path(os.environ.get("DEVFLOW_HOME") or str(Path.home() / "DevFlow"))
CHANNELS_FILE = DEVFLOW_DIR / ".AppData" / "collab-channels.json"
ROLES_FILE = DEVFLOW_DIR / "data" / "roles" / "roles.json"
TEAMS_FILE = DEVFLOW_DIR / ".AppData" / "scaffolding" / "teams.json"
SCAFFOLDING_AGENTS = DEVFLOW_DIR / ".AppData" / "scaffolding" / "agents.json"
SYNC_SCRIPT = DEVFLOW_DIR / "data" / "scaffolding" / "sync.py"
CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
HANDOFF_MASTER = DEVFLOW_DIR / "data" / "scaffolding" / "masters" / "per-agent" / "handoff.md"

def load_teams() -> dict[str, dict]:
    if not TEAMS_FILE.exists():
        raise FileNotFoundError(f"teams.json not found at {TEAMS_FILE}")
    data = json.loads(TEAMS_FILE.read_text(encoding="utf-8"))
    return {team["id"]: team for team in data.get("teams", [])}


def safe_name(name: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9_-]", "-", name)
    value = re.sub(r"-+", "-", value).strip("-")
    return value or "agent"


def resolve_agent_dir(base_work_dir: str, agent_name: str) -> Path:
    """Resolve either a Team directory or an already-dedicated agent directory."""
    base = Path(base_work_dir)
    name = safe_name(agent_name)
    if base.name == name:
        return base
    return base / name


def get_project_key(agent_dir: Path) -> str:
    return str(agent_dir).replace("/", "-")


def get_agent_logs_path(agent_dir: Path) -> Path:
    return agent_dir / "logs"


def _write_if_missing(path: Path, content: str) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _initial_hooks(agent_name: str, agent_dir: Path) -> dict:
    return build_hooks(agent_name, agent_dir)


def _bootstrap_agent_state(agent_dir: Path, agent_name: str) -> None:
    """Create runtime-owned empty state only; sync.py creates all instructions."""
    (agent_dir / ".claude" / "rules").mkdir(parents=True, exist_ok=True)
    (agent_dir / "logs" / "daily").mkdir(parents=True, exist_ok=True)

    _write_if_missing(
        agent_dir / "logs" / "today.md",
        f"# Today - {datetime.now().strftime('%Y-%m-%d')}\n\n",
    )
    _write_if_missing(
        agent_dir / "logs" / "yesterday.md",
        "# Yesterday - (no prior session)\n\nNo previous session log available.\n",
    )
    handoff = HANDOFF_MASTER.read_text(encoding="utf-8") if HANDOFF_MASTER.exists() else (
        "STATUS: No prior session.\nLAST_ACTED: none\nPENDING: none\nDO_NOT_REPEAT: none\n"
    )
    _write_if_missing(agent_dir / "logs" / "handoff.md", handoff)

    memory_path = CLAUDE_PROJECTS_DIR / get_project_key(agent_dir) / "memory" / "MEMORY.md"
    _write_if_missing(
        memory_path,
        f"# {agent_name}'s Memory\n\n"
        "Durable agent-specific facts and preferences only. Routine activity and "
        "conversation summaries do not belong here.\n",
    )

    settings_path = agent_dir / ".claude" / "settings.json"
    _write_if_missing(
        settings_path,
        json.dumps({"hooks": _initial_hooks(agent_name, agent_dir)}, indent=2) + "\n",
    )


def setup_agent(
    base_work_dir: str,
    agent_name: str,
    role_slug: str = "",
    team_name: str = "",
    project_dir: str = "",
    team_dir_path: str = "",
    personality: str = "",
) -> str:
    """Compatibility entrypoint: initialise state without duplicating scaffolding."""
    del role_slug, team_name, project_dir, team_dir_path, personality
    agent_dir = resolve_agent_dir(base_work_dir, agent_name)
    _bootstrap_agent_state(agent_dir, agent_name)
    return str(agent_dir)


def setup_grok_agent(
    base_work_dir: str,
    agent_name: str,
    role_slug: str = "",
    team_name: str = "",
    project_dir: str = "",
) -> str:
    """Grok uses the same canonical scaffold; only its runtime-state dir is extra."""
    agent_dir = Path(setup_agent(base_work_dir, agent_name))
    (agent_dir / ".grok").mkdir(parents=True, exist_ok=True)
    return str(agent_dir)


def _ensure_in_agents_json(
    name: str,
    agent_type: str,
    role_slug: str,
    agent_dir: Path,
    team_id: str = "sg1",
    personality: str = "",
) -> None:
    """Register a missing default agent without conflating model and harness."""
    if not SCAFFOLDING_AGENTS.exists():
        return
    data = json.loads(SCAFFOLDING_AGENTS.read_text(encoding="utf-8"))
    agents = data.get("agents", [])
    if any(str(agent.get("name", "")).casefold() == name.casefold() for agent in agents):
        return
    agents.append({
        "name": name,
        "teamId": team_id,
        "role": role_slug or "agent",
        "domain": "",
        "models": [],
        "agentType": agent_type,
        "agentDir": str(agent_dir),
        "teamDir": str(agent_dir),
        **({"personality": personality} if personality else {}),
    })
    data["agents"] = agents
    SCAFFOLDING_AGENTS.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _run_scaffolding_sync(name: str, target_dir: Path) -> None:
    if not SYNC_SCRIPT.exists():
        raise FileNotFoundError(f"scaffolding sync not found: {SYNC_SCRIPT}")
    result = subprocess.run(
        ["python3", str(SYNC_SCRIPT), "--agent", name, "--target-dir", str(target_dir)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise RuntimeError(detail[-1] if detail else f"sync.py exited {result.returncode}")
    required = [
        target_dir / "CLAUDE.md",
        target_dir / ".claude" / "rules" / "startup.md",
        target_dir / ".claude" / "rules" / "base-role-boilerplate.md",
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError(f"sync completed without required scaffold: {', '.join(missing)}")


def ensure_scaffolding_state(working_dir: str, team_id: str) -> None:
    """A fresh install has no scaffolding state yet: create the team and agent lists on first use.

    Files that exist are never touched. The new team's folder is the folder the agent is being created in.
    """
    state_dir = TEAMS_FILE.parent
    state_dir.mkdir(parents=True, exist_ok=True)
    if not TEAMS_FILE.exists():
        folder = Path(working_dir)
        team = {"id": team_id, "name": team_id, "projectDir": str(folder.parent if folder.name == "Team" else folder), "teamDir": str(folder)}
        TEAMS_FILE.write_text(json.dumps({"teams": [team]}, indent=2) + "\n", encoding="utf-8")
    if not SCAFFOLDING_AGENTS.exists():
        SCAFFOLDING_AGENTS.write_text(json.dumps({"version": 1, "agents": []}, indent=2) + "\n", encoding="utf-8")


def run_single_agent(
    name: str,
    working_dir: str,
    role_slug: str = "",
    agent_type: str = "claude",
    team_id: str = "sg1",
    personality: str = "",
) -> None:
    ensure_scaffolding_state(working_dir, team_id)
    teams = load_teams()
    team = teams.get(team_id)
    if not team:
        raise ValueError(f"Unknown team '{team_id}'. Available: {sorted(teams)}")
    effective_dir = Path(setup_agent(working_dir, name))
    if agent_type == "grok":
        (effective_dir / ".grok").mkdir(parents=True, exist_ok=True)
    ensure_codex_workspace_trusted(str(effective_dir))
    _ensure_in_agents_json(
        name, agent_type, role_slug, effective_dir, team_id=team_id, personality=personality,
    )
    _run_scaffolding_sync(name, effective_dir)
    print(f"Done. Effective directory: {effective_dir}")


def _role_slugs() -> dict[str, str]:
    if not ROLES_FILE.exists():
        return {}
    data = json.loads(ROLES_FILE.read_text(encoding="utf-8"))
    roles = data if isinstance(data, list) else data.get("roles", [])
    return {role["id"]: role["slug"] for role in roles if role.get("id") and role.get("slug")}


def main() -> None:
    parser = argparse.ArgumentParser(description="Provision agent state and canonical scaffolding")
    parser.add_argument("--single-agent", action="store_true")
    parser.add_argument("--name", default="")
    parser.add_argument("--working-dir", default="")
    parser.add_argument("--role-slug", default="")
    parser.add_argument("--agent-type", default="claude")
    parser.add_argument("--team-id", default="sg1")
    parser.add_argument("--personality", default="")
    args = parser.parse_args()

    if args.single_agent:
        if not args.name or not args.working_dir:
            parser.error("--single-agent requires --name and --working-dir")
        run_single_agent(
            args.name,
            args.working_dir,
            role_slug=args.role_slug,
            agent_type=args.agent_type,
            team_id=args.team_id,
            personality=args.personality,
        )
        return

    data = json.loads(CHANNELS_FILE.read_text(encoding="utf-8"))
    channels = data if isinstance(data, list) else data.get("channels", [])
    roles = _role_slugs()
    modified = False
    seen: set[tuple[str, str]] = set()

    for channel in channels:
        roster = channel.get("roster") or {}
        agents = roster.get("agents", []) if isinstance(roster, dict) else []
        for agent in agents:
            name = agent.get("name")
            base_dir = agent.get("workingDirectory")
            if not name or not base_dir:
                continue
            base = Path(base_dir)
            if base.name != "Team" and base.name != safe_name(name):
                base = base / "Team"
            effective = resolve_agent_dir(str(base), name)
            key = (name.casefold(), str(effective))
            if key in seen:
                continue
            seen.add(key)
            setup_agent(str(base), name)
            ensure_codex_workspace_trusted(str(effective))
            _ensure_in_agents_json(
                name,
                agent.get("agentType") or "claude",
                roles.get(agent.get("roleId", ""), ""),
                effective,
                team_id=agent.get("teamId") or "sg1",
                personality=agent.get("personality") or "",
            )
            _run_scaffolding_sync(name, effective)
            if agent.get("effectiveWorkingDirectory") != str(effective):
                agent["effectiveWorkingDirectory"] = str(effective)
                modified = True

    if modified:
        temp = CHANNELS_FILE.with_suffix(CHANNELS_FILE.suffix + ".tmp")
        temp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.replace(temp, CHANNELS_FILE)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
