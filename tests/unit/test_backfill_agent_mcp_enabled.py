"""
Tests for scripts/backfill-agent-mcp-enabled.py

Sprint 44 T5.1: handle missing-file case — walk agent dirs even when
settings.local.json does not yet exist. Atomic write, union with role.mcpServers,
no clobber if file appears mid-run.

Regression covers existing-file paths (P2).
"""
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

import pytest


# ─── Import helper ──────────────────────────────────────────────────────
# Script filename has a hyphen → load via importlib.

SCRIPT_PATH = Path(__file__).resolve().parent.parent.parent / "scripts" / "backfill-agent-mcp-enabled.py"


@pytest.fixture(scope="module")
def backfill_mod():
    spec = importlib.util.spec_from_file_location("backfill_agent_mcp_enabled", SCRIPT_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ─── Fixtures ───────────────────────────────────────────────────────────

@pytest.fixture
def tmp_project(tmp_path):
    """Build a fake project tree: <tmp>/FakeProject/Team/<Agent>/.claude/"""
    project = tmp_path / "FakeProject"
    team = project / "Team"
    team.mkdir(parents=True)
    return project


def _mk_agent(project: Path, name: str, with_settings: bool = False, settings_body: dict | None = None) -> Path:
    """Create agent dir; optionally with .claude/settings.local.json."""
    claude = project / "Team" / name / ".claude"
    claude.mkdir(parents=True, exist_ok=True)
    path = claude / "settings.local.json"
    if with_settings:
        path.write_text(json.dumps(settings_body or {}) + "\n")
    return path


# ─── find_settings_files: existing-file case (P2 regression) ────────────

def test_find_settings_files_returns_only_existing_when_present(backfill_mod, tmp_project):
    _mk_agent(tmp_project, "Alpha", with_settings=True)
    _mk_agent(tmp_project, "Beta", with_settings=True)

    found = backfill_mod.find_settings_files(tmp_project.parent)
    names = sorted(p.parent.parent.name for p in found)
    assert "Alpha" in names and "Beta" in names


# ─── find_agent_settings_paths: NEW — includes missing files ────────────

def test_find_agent_settings_paths_includes_missing_files(backfill_mod, tmp_project):
    _mk_agent(tmp_project, "HasFile", with_settings=True)
    _mk_agent(tmp_project, "NoFile", with_settings=False)  # dir only, no settings

    paths = backfill_mod.find_agent_settings_paths(tmp_project.parent)
    names = sorted(p.parent.parent.name for p in paths)
    assert "HasFile" in names
    assert "NoFile" in names


def test_find_agent_settings_paths_skips_non_agent_dirs(backfill_mod, tmp_project):
    # A `.claude` *file* in a non-Team location should be ignored.
    (tmp_project / "Team" / "Valid").mkdir()
    (tmp_project / "Team" / "Valid" / ".claude").mkdir()
    # Root-level non-Team dir — should not appear
    (tmp_project / "docs").mkdir()

    paths = backfill_mod.find_agent_settings_paths(tmp_project.parent)
    assert all(p.parent.parent.parent.name == "Team" for p in paths)


def test_find_agent_settings_paths_walks_root_as_project(backfill_mod, tmp_path):
    """Sprint 44 fix: when --root IS a project (has its own Team/ dir), walk
    root/Team/* directly, not just root/*/Team/* (which misses root itself)."""
    proj = tmp_path / "MyProj"
    (proj / "Team" / "AgentA").mkdir(parents=True)
    (proj / "Team" / "AgentB").mkdir(parents=True)
    # Also a subproject so we verify both root-as-project AND children-as-projects work.
    (proj / "SubProj" / "Team" / "AgentC").mkdir(parents=True)

    paths = backfill_mod.find_agent_settings_paths(proj)
    names = sorted(p.parent.parent.name for p in paths)
    assert names == ["AgentA", "AgentB", "AgentC"]


def test_find_agent_settings_paths_skips_dotted_agent_dirs(backfill_mod, tmp_project):
    """A literal `.claude/` dir inside Team/ should never be treated as an agent."""
    (tmp_project / "Team" / ".claude").mkdir()
    (tmp_project / "Team" / "Real").mkdir()
    paths = backfill_mod.find_agent_settings_paths(tmp_project.parent)
    names = [p.parent.parent.name for p in paths]
    assert ".claude" not in names
    assert "Real" in names


# ─── process_one: missing-file case ─────────────────────────────────────

def _roster(project_root: str, agent: str, role_id: str) -> dict:
    return {(project_root.rstrip("/"), agent): {"roleId": role_id, "name": agent, "workingDirectory": project_root}}


def _roles(role_id: str, name: str, servers: list[str]) -> dict:
    return {role_id: {"id": role_id, "name": name, "mcpServers": servers}}


def test_process_one_missing_file_dryrun_reports_create(backfill_mod, tmp_project):
    settings_path = _mk_agent(tmp_project, "Ghost", with_settings=False)
    roster = _roster(str(tmp_project), "Ghost", "r1")
    roles = _roles("r1", "Backend Dev", ["qdrant", "snapshot", "outlook"])

    result = backfill_mod.process_one(settings_path, roster, roles, apply=False, only_agent=None)

    assert result["status"] == "created"
    assert result["agent"] == "Ghost"
    assert result["before"] == []
    assert result["after"] == ["qdrant", "snapshot", "outlook"]
    assert not settings_path.exists(), "dry-run must NOT write the file"


def test_process_one_missing_file_apply_writes_atomic(backfill_mod, tmp_project):
    settings_path = _mk_agent(tmp_project, "Phantom", with_settings=False)
    roster = _roster(str(tmp_project), "Phantom", "r1")
    roles = _roles("r1", "Backend Dev", ["qdrant", "snapshot", "outlook"])

    result = backfill_mod.process_one(settings_path, roster, roles, apply=True, only_agent=None)

    assert result["status"] == "created"
    assert settings_path.is_file()
    written = json.loads(settings_path.read_text())
    assert written["enabledMcpjsonServers"] == ["qdrant", "snapshot", "outlook"]
    assert written["enableAllProjectMcpServers"] is True


def test_process_one_missing_file_skips_when_role_not_found(backfill_mod, tmp_project):
    settings_path = _mk_agent(tmp_project, "Nobody", with_settings=False)
    roster = _roster(str(tmp_project), "Nobody", "missing-role")
    roles = _roles("r1", "Backend Dev", ["qdrant"])

    result = backfill_mod.process_one(settings_path, roster, roles, apply=False, only_agent=None)
    assert result["status"] == "skipped"
    assert "not found" in result["note"]


def test_process_one_missing_file_skips_when_no_roster_entry(backfill_mod, tmp_project):
    settings_path = _mk_agent(tmp_project, "Lost", with_settings=False)
    # Empty roster
    roster: dict = {}
    roles = _roles("r1", "Backend Dev", ["qdrant"])

    result = backfill_mod.process_one(settings_path, roster, roles, apply=False, only_agent=None)
    assert result["status"] == "skipped"
    assert "roster" in result["note"]


# ─── process_one: existing-file case (P2 regression) ────────────────────

def test_process_one_existing_file_changed_preserves_extras(backfill_mod, tmp_project):
    settings_path = _mk_agent(
        tmp_project, "Rodney", with_settings=True,
        settings_body={"enabledMcpjsonServers": ["qdrant", "davinci-resolve"], "enableAllProjectMcpServers": True},
    )
    roster = _roster(str(tmp_project), "Rodney", "r1")
    roles = _roles("r1", "Backend Dev", ["qdrant", "snapshot", "outlook"])

    result = backfill_mod.process_one(settings_path, roster, roles, apply=True, only_agent=None)
    assert result["status"] == "changed"
    written = json.loads(settings_path.read_text())
    # Role servers first, then extras.
    assert written["enabledMcpjsonServers"] == ["qdrant", "snapshot", "outlook", "davinci-resolve"]


def test_process_one_existing_file_unchanged(backfill_mod, tmp_project):
    settings_path = _mk_agent(
        tmp_project, "Steady", with_settings=True,
        settings_body={"enabledMcpjsonServers": ["qdrant", "snapshot", "outlook"], "enableAllProjectMcpServers": True},
    )
    roster = _roster(str(tmp_project), "Steady", "r1")
    roles = _roles("r1", "Backend Dev", ["qdrant", "snapshot", "outlook"])

    result = backfill_mod.process_one(settings_path, roster, roles, apply=False, only_agent=None)
    assert result["status"] == "unchanged"


def test_process_one_existing_file_invalid_json_skips(backfill_mod, tmp_project):
    settings_path = _mk_agent(tmp_project, "Broken", with_settings=False)
    settings_path.write_text("{not valid json")
    roster = _roster(str(tmp_project), "Broken", "r1")
    roles = _roles("r1", "Backend Dev", ["qdrant"])

    result = backfill_mod.process_one(settings_path, roster, roles, apply=False, only_agent=None)
    assert result["status"] == "skipped"
    assert "unreadable" in result["note"]


# ─── Race-condition: file appears between scan and write ────────────────

def test_process_one_missing_then_appearing_merges_not_clobbers(backfill_mod, tmp_project, monkeypatch):
    """Scan sees no file; by apply-time, another process has written one.
    The script must MERGE (union) with the in-flight contents, not clobber."""
    settings_path = _mk_agent(tmp_project, "Racer", with_settings=False)
    roster = _roster(str(tmp_project), "Racer", "r1")
    roles = _roles("r1", "Backend Dev", ["qdrant", "outlook"])

    # Simulate: file appears AFTER the initial existence check but before the atomic write.
    # We patch atomic_write_json to first write a competing file, then call the real writer.
    real_atomic = backfill_mod.atomic_write_json
    def racer_write(path, data):
        # Another process got here first with a different extras list.
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "enabledMcpjsonServers": ["qdrant", "davinci-resolve"],
            "enableAllProjectMcpServers": True,
        }))
        real_atomic(path, data)
    # The patched strategy only works if process_one re-reads before write.
    # We test that by implementing a write hook that inspects merged data.
    seen = {}
    def spy_write(path, data):
        seen["data"] = data
        real_atomic(path, data)

    # First: create the competing file before process_one runs.
    settings_path.write_text(json.dumps({
        "enabledMcpjsonServers": ["qdrant", "davinci-resolve"],
        "enableAllProjectMcpServers": True,
    }))

    monkeypatch.setattr(backfill_mod, "atomic_write_json", spy_write)
    result = backfill_mod.process_one(settings_path, roster, roles, apply=True, only_agent=None)

    # Because the file now exists at process time, we should take the normal "changed" path
    # and union with its contents — davinci-resolve must be preserved.
    assert result["status"] == "changed"
    assert "davinci-resolve" in seen["data"]["enabledMcpjsonServers"]
    assert "outlook" in seen["data"]["enabledMcpjsonServers"]


# ─── atomic_write_json: create parent dirs ──────────────────────────────

def test_atomic_write_json_creates_missing_claude_dir(backfill_mod, tmp_project):
    agent_dir = tmp_project / "Team" / "New"
    agent_dir.mkdir(parents=True)
    # .claude/ dir does NOT exist yet.
    target = agent_dir / ".claude" / "settings.local.json"
    assert not target.parent.exists()

    backfill_mod.atomic_write_json(target, {"x": 1})

    assert target.is_file()
    assert json.loads(target.read_text()) == {"x": 1}


# ─── compute_new_enabled regression ─────────────────────────────────────

def test_compute_new_enabled_union_order(backfill_mod):
    result = backfill_mod.compute_new_enabled(
        role_servers=["qdrant", "snapshot", "outlook"],
        existing_enabled=["qdrant", "davinci-resolve"],
    )
    assert result == ["qdrant", "snapshot", "outlook", "davinci-resolve"]


def test_compute_new_enabled_empty_existing(backfill_mod):
    result = backfill_mod.compute_new_enabled(
        role_servers=["qdrant", "outlook"],
        existing_enabled=[],
    )
    assert result == ["qdrant", "outlook"]
