#!/usr/bin/env python3
"""
patch-hooks.py — Propagate hook template changes to all agent settings.json files.

Finds canonical homes, roster presences, and every existing filesystem
`Team/*/.claude/settings.json`, then safely merges the canonical hook policy.

Use this whenever the hook template changes (e.g. new script, fixed Stop hook type)
instead of manually patching every agent one by one.

Usage:
  python3 patch-hooks.py                    # Patch all agents, all teams
  python3 patch-hooks.py --team sg1         # Patch one team only
  python3 patch-hooks.py --agent NAME       # Patch one agent only
  python3 patch-hooks.py --workspace PATH --agent NAME  # Patch before spawn
  python3 patch-hooks.py --dry-run          # Preview changes without writing
"""

import argparse
import json
import os
import sys
from pathlib import Path

DEVFLOW_DIR = Path(os.environ.get('DEVFLOW_HOME') or str(Path.home() / 'DevFlow'))
sys.path.insert(0, str(DEVFLOW_DIR / "scripts"))
from agent_lifecycle_hooks import build_hooks, merge_session_hooks, remove_behavioural_hooks

AGENTS_FILE = DEVFLOW_DIR / ".AppData" / "scaffolding" / "agents.json"
TEAMS_FILE = DEVFLOW_DIR / ".AppData" / "scaffolding" / "teams.json"
CHANNELS_FILE = DEVFLOW_DIR / ".AppData" / "collab-channels.json"
GLOBAL_SETTINGS_FILE = Path.home() / '.claude' / 'settings.json'
_WALK_PRUNE = {
    ".git", ".next", ".cache", ".local", ".npm", ".cargo", ".rustup",
    ".vscode-server", "node_modules", "dist", "build", "coverage", "vendor",
    "venv", ".venv", "env",
}


def patch_global_settings(dry_run: bool = False) -> str:
    """Remove global per-message gates without touching safety/tool hooks."""
    if not GLOBAL_SETTINGS_FILE.exists():
        return f"SKIP  global: no settings.json at {GLOBAL_SETTINGS_FILE}"
    try:
        data = json.loads(GLOBAL_SETTINGS_FILE.read_text())
    except Exception as e:
        return f"ERROR global: failed to parse {GLOBAL_SETTINGS_FILE}: {e}"
    current_hooks = data.get("hooks", {})
    new_hooks = remove_behavioural_hooks(current_hooks)
    if current_hooks == new_hooks:
        return "NOOP  global: no behavioural hooks"
    data["hooks"] = new_hooks
    if dry_run:
        return f"WOULD global: remove behavioural hooks from {GLOBAL_SETTINGS_FILE}"
    tmp_path = str(GLOBAL_SETTINGS_FILE) + ".tmp"
    try:
        Path(tmp_path).write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(tmp_path, GLOBAL_SETTINGS_FILE)
        return f"PATCH global: behavioural hooks removed from {GLOBAL_SETTINGS_FILE}"
    except Exception as e:
        return f"ERROR global: failed to write {GLOBAL_SETTINGS_FILE}: {e}"


def discover_presence_dirs(agent_names: set[str]) -> list[tuple[str, Path]]:
    """Return active roster workspaces for the selected agents."""
    if not CHANNELS_FILE.exists():
        return []
    try:
        data = json.loads(CHANNELS_FILE.read_text())
    except Exception:
        return []
    channels = data if isinstance(data, list) else data.get("channels", [])
    seen: set[tuple[str, str]] = set()
    result = []
    wanted = {name.casefold() for name in agent_names}
    for channel in channels:
        roster = channel.get("roster") or {}
        entries = roster.get("agents", []) if isinstance(roster, dict) else []
        for entry in entries:
            name = entry.get("name", "")
            if not name or name.casefold() not in wanted:
                continue
            directory = entry.get("effectiveWorkingDirectory") or entry.get("workingDirectory")
            if not directory:
                continue
            key = (name.casefold(), directory)
            if key in seen:
                continue
            seen.add(key)
            result.append((name, Path(directory)))
    return result


def discover_filesystem_dirs(home_root: Path | None = None) -> list[tuple[str, Path]]:
    """Find dormant as well as rostered Team/<agent> settings workspaces."""
    root = home_root or Path.home()
    result: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for current, dirnames, _filenames in os.walk(root, topdown=True):
        dirnames[:] = [name for name in dirnames if name not in _WALK_PRUNE]
        directory = Path(current)
        if directory.parent.name != "Team":
            continue
        settings_path = directory / ".claude" / "settings.json"
        if not settings_path.is_file():
            continue
        key = str(directory)
        if key in seen:
            continue
        seen.add(key)
        result.append((directory.name, directory))
    return sorted(result, key=lambda item: str(item[1]))


def patch_agent(
    agent_name: str,
    agent_dir: Path,
    dry_run: bool = False,
    create_if_missing: bool = False,
) -> str:
    """Patch a single agent's settings.json hooks. Returns status string."""
    # Legacy aliases such as Team/CJack -> Team/Riley and case-normalising
    # aliases must converge on one physical settings file and one hook argument
    # set, regardless of which roster name discovers the workspace first.
    physical_dir = agent_dir.resolve(strict=False)
    physical_name = physical_dir.name if physical_dir != agent_dir else agent_name
    settings_path = physical_dir / ".claude" / "settings.json"

    if not settings_path.exists() and not create_if_missing:
        return f"SKIP  {agent_name}: no settings.json at {settings_path}"

    if settings_path.exists():
        try:
            data = json.loads(settings_path.read_text())
        except Exception as e:
            return f"ERROR {agent_name}: failed to parse {settings_path}: {e}"
    else:
        data = {}

    current_hooks = data.get("hooks", {})
    new_hooks = merge_session_hooks(
        current_hooks,
        build_hooks(physical_name, physical_dir),
    )

    if settings_path.exists() and current_hooks == new_hooks:
        return f"NOOP  {agent_name}: hooks already up to date"

    data["hooks"] = new_hooks

    if dry_run:
        verb = "create" if not settings_path.exists() else "update"
        return f"WOULD {agent_name}: {verb} hooks in {settings_path}"

    tmp_path = str(settings_path) + ".tmp"
    try:
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        Path(tmp_path).write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(tmp_path, settings_path)
        return f"PATCH {agent_name}: hooks canonical in {settings_path}"
    except Exception as e:
        return f"ERROR {agent_name}: failed to write {settings_path}: {e}"


def resolve_agent_dir(team_dir: str, agent_name: str) -> Path:
    """Derive the agent's effective directory (same logic as rollout-agent-dirs.py)."""
    base = Path(team_dir)
    if base.name == agent_name:
        return base
    return base / agent_name


def main() -> None:
    parser = argparse.ArgumentParser(description="Patch hooks for all agent settings.json files")
    parser.add_argument("--team", type=str, default="", help="Only patch agents in this team (e.g. sg1, devflow, pulse)")
    parser.add_argument("--agent", type=str, default="", help="Only patch this agent (name match)")
    parser.add_argument("--workspace", type=str, default="", help="Patch/create hooks in exactly this agent workspace")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
    args = parser.parse_args()

    if args.workspace:
        workspace = Path(args.workspace)
        name = args.agent or workspace.name
        result = patch_agent(name, workspace, dry_run=args.dry_run, create_if_missing=True)
        print(result)
        if result.startswith("ERROR"):
            sys.exit(1)
        return

    if not AGENTS_FILE.exists():
        print(f"ERROR: {AGENTS_FILE} not found", file=sys.stderr)
        sys.exit(1)
    if not TEAMS_FILE.exists():
        print(f"ERROR: {TEAMS_FILE} not found", file=sys.stderr)
        sys.exit(1)

    agents_data = json.loads(AGENTS_FILE.read_text())
    teams_data = json.loads(TEAMS_FILE.read_text())

    teams = {t["id"]: t for t in teams_data.get("teams", [])}
    agents = agents_data.get("agents", [])

    if args.dry_run:
        print("DRY RUN — no files will be modified\n")

    patched = skipped = errors = 0

    selected_names: set[str] = set()
    targets: list[tuple[str, Path]] = []
    for agent in agents:
        name = agent.get("name", "")
        team_id = agent.get("teamId", "")

        if not name or not team_id:
            continue

        if args.agent and name.lower() != args.agent.lower():
            continue

        if args.team and team_id != args.team:
            continue

        selected_names.add(name)

        team = teams.get(team_id)
        if not team:
            print(f"SKIP  {name}: unknown team '{team_id}'")
            skipped += 1
            continue

        targets.append((name, resolve_agent_dir(team["teamDir"], name)))

    targets.extend(discover_presence_dirs(selected_names))
    if not args.team:
        filesystem_targets = discover_filesystem_dirs()
        if args.agent:
            filesystem_targets = [
                item for item in filesystem_targets
                if item[0].casefold() == args.agent.casefold()
            ]
        targets.extend(filesystem_targets)
    seen_targets: set[str] = set()
    for name, agent_dir in targets:
        key = str(agent_dir.resolve(strict=False))
        if key in seen_targets:
            continue
        seen_targets.add(key)
        result = patch_agent(name, agent_dir, dry_run=args.dry_run)
        print(result)

        if result.startswith("PATCH") or result.startswith("WOULD"):
            patched += 1
        elif result.startswith("ERROR"):
            errors += 1
        else:
            skipped += 1

    if not args.agent and not args.team:
        result = patch_global_settings(dry_run=args.dry_run)
        print(result)
        if result.startswith("PATCH") or result.startswith("WOULD"):
            patched += 1
        elif result.startswith("ERROR"):
            errors += 1
        else:
            skipped += 1

    print(f"\nDone. Patched: {patched}  Skipped/noop: {skipped}  Errors: {errors}")
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
