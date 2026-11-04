#!/usr/bin/env python3
"""The OpenFlow edition of the shipped rules (data/scaffolding/EDITION).

Without an EDITION file DevFlow must render exactly what it always did.
"""

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("scaffolding_edition_sync", ROOT / "data/scaffolding/sync.py")
assert SPEC and SPEC.loader
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)

BASE = json.loads((ROOT / "data/scaffolding/manifest.json").read_text())


def _agent(tmp_path: Path, name: str = "Tester"):
    team_dir = tmp_path / "Project" / "Team"
    teams = {"sg1": {"id": "sg1", "projectDir": str(tmp_path / "Project"), "teamDir": str(team_dir)}}
    agent = {"name": name, "teamId": "sg1", "role": "backend-dev", "domain": "tests",
             "agentDir": str(team_dir / name), "teamDir": str(team_dir / name)}
    return teams, agent


def _deploy(manifest: dict, teams: dict, agent: dict) -> None:
    """What run_sync does for one agent, limited to files inside the agent's own folder."""
    for entry in manifest["files"]:
        if not all(t.startswith(("{agent_dir}", "{team_dir}")) for t in entry["targets"]):
            continue
        if sync.agent_matches_condition(agent, entry.get("condition", "always")):
            sync.sync_file_entry(teams, entry, agent)
        else:
            sync.retire_unmatched_entry(teams, entry, agent)


def _tree(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def test_devflow_edition_returns_the_same_manifest_object():
    assert sync.apply_edition(BASE, "devflow") is BASE


def test_devflow_output_is_byte_for_byte_unchanged_without_the_edition_file(tmp_path, monkeypatch):
    monkeypatch.setattr(sync, "EDITION_PATH", tmp_path / "no-such-EDITION")
    assert sync.current_edition() == "devflow"
    old_teams, old_agent = _agent(tmp_path / "old")
    new_teams, new_agent = _agent(tmp_path / "new")
    _deploy(BASE, old_teams, old_agent)                      # the raw manifest, as before this change
    _deploy(sync.load_manifest(), new_teams, new_agent)      # through the edition loader
    old = _tree(Path(old_agent["agentDir"]))
    new = _tree(Path(new_agent["agentDir"]))
    assert old, "nothing was rendered, the comparison would prove nothing"
    def neutral(files: dict[str, bytes], which: str) -> dict[str, bytes]:
        base = str(tmp_path / which)
        return {k: v.replace(base.encode(), b"@").replace(base.replace("/", "-").encode(), b"@")
                for k, v in files.items()}
    old, new = neutral(old, "old"), neutral(new, "new")
    assert old == new
    assert ".claude/rules/DEVFLOW.md" in old


def test_openflow_edition_swaps_the_devflow_files(tmp_path):
    manifest = sync.apply_edition(BASE, "openflow")
    teams, agent = _agent(tmp_path)
    _deploy(manifest, teams, agent)
    rules = Path(agent["agentDir"]) / ".claude" / "rules"
    names = {p.name for p in rules.iterdir()}
    assert "OPENFLOW.md" in names and "startup.md" in names and "Workspace.md" in names
    for gone in ("DEVFLOW.md", "rag-memory.md", "skill-index.md", "computer-use.md"):
        assert gone not in names
    assert not (Path(agent["agentDir"]) / ".mcp.json").exists()
    for name in ("startup.md", "Workspace.md", "OPENFLOW.md"):
        assert "devflow" not in (rules / name).read_text().lower()
    assert str(Path(agent["agentDir"])) in (rules / "Workspace.md").read_text()


def test_openflow_edition_retires_old_files_but_keeps_hand_edited_ones(tmp_path):
    teams, agent = _agent(tmp_path)
    _deploy(BASE, teams, agent)                              # an agent set up before the switch
    agent_dir = Path(agent["agentDir"])
    rules = agent_dir / ".claude" / "rules"
    (rules / "skill-index.md").write_text("# My own skill notes\n")
    (agent_dir / ".mcp.json").write_text(json.dumps({"mcpServers": {
        "outlook": json.loads((ROOT / "data/scaffolding/masters/global/mcp-outlook.json").read_text())["mcpServers"]["outlook"],
        "mine": {"command": "my-server"}}}))
    assert (rules / "DEVFLOW.md").exists() and (rules / "rag-memory.md").exists()

    _deploy(sync.apply_edition(BASE, "openflow"), teams, agent)

    assert not (rules / "DEVFLOW.md").exists()
    assert not (rules / "rag-memory.md").exists()
    assert not (rules / "computer-use.md").exists()
    assert (rules / "skill-index.md").read_text() == "# My own skill notes\n"
    assert (rules / "OPENFLOW.md").exists()
    servers = json.loads((agent_dir / ".mcp.json").read_text())["mcpServers"]
    assert servers == {"mine": {"command": "my-server"}}


def test_missing_overlay_falls_back_to_the_base_manifest(tmp_path, capsys):
    assert sync.apply_edition(BASE, "nonesuch", tmp_path) is BASE
    assert "nonesuch" in capsys.readouterr().err


def test_edition_file_word_is_validated(tmp_path, monkeypatch):
    marker = tmp_path / "EDITION"
    monkeypatch.setattr(sync, "EDITION_PATH", marker)
    marker.write_text("../etc\n")
    assert sync.current_edition() == "devflow"
    marker.write_text("OpenFlow\n")
    assert sync.current_edition() == "openflow"
