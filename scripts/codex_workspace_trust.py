#!/usr/bin/env python3
"""Register DevFlow-managed workspaces as trusted Codex projects.

Codex stores trust per exact workspace path in ``~/.codex/config.toml``.  This
module provides one lock-safe writer shared by provisioning and the Codex
collaboration wrapper, plus a small CLI for backfilling existing roster paths.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import stat
import tempfile
import tomllib
from pathlib import Path


DEFAULT_CODEX_CONFIG = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "config.toml"
_TABLE_HEADER_RE = re.compile(r"^\s*\[[^\]]+\]\s*(?:#.*)?$")
_TRUST_LEVEL_RE = re.compile(r'^(\s*)trust_level\s*=\s*(?:"[^"]*"|\'[^\']*\')(\s*(?:#.*)?)$')


def _normalise_workspace(workspace: str | os.PathLike[str]) -> str:
    return str(Path(workspace).expanduser().resolve(strict=False))


def _toml_string(value: str) -> str:
    # JSON strings are valid TOML basic strings for normal POSIX paths and give
    # us correct quoting for spaces, quotes, and backslashes.
    return json.dumps(value, ensure_ascii=False)


def _project_path_from_header(header: str) -> str | None:
    """Return the project key represented by one TOML table header."""
    try:
        parsed = tomllib.loads(f"{header}\n__devflow_probe = true\n")
    except tomllib.TOMLDecodeError:
        return None
    projects = parsed.get("projects")
    if not isinstance(projects, dict) or len(projects) != 1:
        return None
    project_path, values = next(iter(projects.items()))
    if isinstance(values, dict) and values.get("__devflow_probe") is True:
        return project_path
    return None


def _render_trusted_config(content: str, workspace: str) -> tuple[str, bool]:
    """Return updated TOML text and whether a material change was needed."""
    try:
        parsed = tomllib.loads(content) if content.strip() else {}
    except tomllib.TOMLDecodeError as error:
        raise RuntimeError(f"Cannot update invalid Codex config: {error}") from error

    projects = parsed.get("projects", {})
    existing = projects.get(workspace) if isinstance(projects, dict) else None
    if isinstance(existing, dict) and existing.get("trust_level") == "trusted":
        return content, False

    lines = content.splitlines(keepends=True)
    target_start = None
    target_end = len(lines)
    for index, line in enumerate(lines):
        if not _TABLE_HEADER_RE.match(line.rstrip("\r\n")):
            continue
        if target_start is not None:
            target_end = index
            break
        if _project_path_from_header(line.rstrip("\r\n")) == workspace:
            target_start = index

    if target_start is not None:
        for index in range(target_start + 1, target_end):
            raw = lines[index].rstrip("\r\n")
            match = _TRUST_LEVEL_RE.match(raw)
            if match:
                newline = "\r\n" if lines[index].endswith("\r\n") else "\n"
                lines[index] = f'{match.group(1)}trust_level = "trusted"{match.group(2)}{newline}'
                return "".join(lines), True
        lines.insert(target_start + 1, 'trust_level = "trusted"\n')
        return "".join(lines), True

    separator = "" if not content or content.endswith("\n\n") else ("\n" if content.endswith("\n") else "\n\n")
    block = f'[projects.{_toml_string(workspace)}]\ntrust_level = "trusted"\n'
    return f"{content}{separator}{block}", True


def ensure_codex_workspace_trusted(
    workspace: str | os.PathLike[str],
    config_file: str | os.PathLike[str] = DEFAULT_CODEX_CONFIG,
) -> bool:
    """Trust one exact workspace, returning ``True`` when config changed."""
    normalised = _normalise_workspace(workspace)
    config_path = Path(config_file).expanduser()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = config_path.with_name(f"{config_path.name}.lock")

    with lock_path.open("a+", encoding="utf-8") as lock_file:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        content = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
        updated, changed = _render_trusted_config(content, normalised)
        if not changed:
            return False

        previous_mode = stat.S_IMODE(config_path.stat().st_mode) if config_path.exists() else 0o600
        fd, temporary_name = tempfile.mkstemp(
            prefix=f".{config_path.name}.", suffix=".tmp", dir=config_path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as temporary_file:
                temporary_file.write(updated)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            os.chmod(temporary_name, previous_mode)
            os.replace(temporary_name, config_path)
        finally:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
        return True


def workspaces_from_channels(channels_file: str | os.PathLike[str]) -> list[str]:
    """Extract unique managed agent workspaces from DevFlow channel rosters."""
    data = json.loads(Path(channels_file).read_text(encoding="utf-8"))
    channels = data if isinstance(data, list) else data.get("channels", [])
    workspaces: set[str] = set()
    for channel in channels:
        if not isinstance(channel, dict):
            continue
        roster = channel.get("roster", {})
        agents = roster.get("agents", []) if isinstance(roster, dict) else roster
        if not isinstance(agents, list):
            continue
        for agent in agents:
            if not isinstance(agent, dict):
                continue
            workspace = agent.get("effectiveWorkingDirectory") or agent.get("workingDirectory")
            if workspace:
                workspaces.add(_normalise_workspace(workspace))
    return sorted(workspaces)


def main() -> int:
    parser = argparse.ArgumentParser(description="Trust DevFlow-managed Codex workspaces")
    parser.add_argument("--workspace", action="append", default=[], help="Exact workspace to trust")
    parser.add_argument("--from-channels", help="Backfill workspaces from collab-channels.json")
    parser.add_argument("--config", default=str(DEFAULT_CODEX_CONFIG), help="Codex config.toml path")
    args = parser.parse_args()

    workspaces = {_normalise_workspace(path) for path in args.workspace}
    if args.from_channels:
        workspaces.update(workspaces_from_channels(args.from_channels))
    if not workspaces:
        parser.error("provide --workspace or --from-channels")

    changed = 0
    for workspace in sorted(workspaces):
        changed += int(ensure_codex_workspace_trusted(workspace, args.config))
    print(f"Trusted {len(workspaces)} managed workspace(s); {changed} config entr{'y' if changed == 1 else 'ies'} updated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
