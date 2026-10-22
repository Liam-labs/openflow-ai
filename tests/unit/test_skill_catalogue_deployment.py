#!/usr/bin/env python3
"""Focused contracts for the canonical skill catalogue deployment path."""

import importlib.util
import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SYNC_PATH = ROOT / "data/scaffolding/sync.py"
SPEC = importlib.util.spec_from_file_location("skill_catalogue_sync", SYNC_PATH)
assert SPEC and SPEC.loader
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


def _skill(directory: Path, name: str, description: str = "Test skill.") -> Path:
    skill_dir = directory / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n",
        encoding="utf-8",
    )
    return skill_dir


def _isolate_catalogue(monkeypatch, tmp_path: Path) -> tuple[Path, Path, Path]:
    catalogue = tmp_path / "catalogue"
    matrix = catalogue / "matrix.json"
    host_skills = tmp_path / "host-skills"
    catalogue.mkdir()
    monkeypatch.setattr(sync, "SKILLS_MASTER_DIR", catalogue)
    monkeypatch.setattr(sync, "SKILLS_MATRIX_PATH", matrix)
    monkeypatch.setattr(sync, "HOST_SKILLS_DIR", host_skills)
    monkeypatch.setattr(sync, "WINDOWS_SKILLS_DIR", tmp_path / "windows-skills")
    monkeypatch.setitem(sync._MACHINE_CONFIG, "homeDir", str(tmp_path / "home"))
    return catalogue, matrix, host_skills


def test_missing_skill_warning_prints_a_working_isolated_restore_command(
    tmp_path, monkeypatch, capsys
):
    catalogue, _, _ = _isolate_catalogue(monkeypatch, tmp_path)
    missing = catalogue / "edge"
    missing.mkdir()

    deployed = (
        tmp_path
        / "home"
        / "Project"
        / "Team"
        / "Tester"
        / ".claude"
        / "skills"
        / "edge"
        / "SKILL.md"
    )
    deployed.parent.mkdir(parents=True)
    deployed.write_text("restorable edge bytes\n", encoding="utf-8")

    # The temp catalogue is not a git repo, so the committed-source gate would
    # refuse first; it has its own tests below. Opt out to reach the warning.
    sync.deploy_skills({}, [], dry_run=True, allow_dirty=True)
    output = capsys.readouterr().out

    assert "WARNING: skill 'edge' has no SKILL.md" in output
    restore_line = next(
        line.strip() for line in output.splitlines() if line.strip().startswith("Restore with:")
    )
    restore_command = restore_line.removeprefix("Restore with:").strip()
    subprocess.run(["bash", "-c", restore_command], check=True)

    assert (missing / "SKILL.md").read_bytes() == deployed.read_bytes()


def test_healthy_catalogue_is_quiet_and_nested_non_skill_directories_do_not_warn(
    tmp_path, monkeypatch, capsys
):
    catalogue, _, _ = _isolate_catalogue(monkeypatch, tmp_path)
    skill_dir = _skill(catalogue, "design-reference-discovery")
    references = skill_dir / "references"
    references.mkdir()
    (references / "source-library.md").write_text("# Sources\n", encoding="utf-8")

    sync.deploy_skills({}, [], dry_run=True, allow_dirty=True)
    output = capsys.readouterr().out

    assert "WARNING:" not in output
    assert "has no SKILL.md" not in output


def test_deploy_skills_copies_sibling_reference_files_to_agent_presence(
    tmp_path, monkeypatch
):
    catalogue, _, _ = _isolate_catalogue(monkeypatch, tmp_path)
    skill_dir = _skill(catalogue, "design-reference-discovery")
    source_reference = skill_dir / "references" / "source-library.md"
    source_reference.parent.mkdir()
    source_reference.write_text("# Source library\n\nCanonical details.\n", encoding="utf-8")
    agent_dir = tmp_path / "Project" / "Team" / "Tester"
    monkeypatch.setattr(sync, "skill_target_dirs", lambda _teams, _agent: [agent_dir])

    sync.deploy_skills({}, [{"name": "Tester"}], allow_dirty=True)  # not a repo; gate tested below

    target = (
        agent_dir
        / ".claude"
        / "skills"
        / "design-reference-discovery"
        / "references"
        / "source-library.md"
    )
    assert target.read_bytes() == source_reference.read_bytes()


def test_nested_skill_reference_reaches_agent_and_host_without_replacing_entrypoint(
    tmp_path, monkeypatch
):
    catalogue, _, host = _isolate_catalogue(monkeypatch, tmp_path)
    skill_dir = _skill(catalogue, "typesafe-ai")
    nested = skill_dir / "references" / "community" / "SKILL.md"
    nested.parent.mkdir(parents=True)
    nested.write_text("# Community reference\n", encoding="utf-8")
    agent_dir = tmp_path / "Project" / "Team" / "Tester"
    monkeypatch.setattr(sync, "skill_target_dirs", lambda _teams, _agent: [agent_dir])

    stats = sync.deploy_skills(
        {}, [{"name": "Tester"}], allow_dirty=True, symlink_host=True,
        skill_filter="typesafe-ai",
    )

    assert stats["errors"] == 0
    for target in [agent_dir / ".claude/skills/typesafe-ai", host / "typesafe-ai",
                   sync.WINDOWS_SKILLS_DIR / "typesafe-ai"]:
        assert (target / "SKILL.md").read_bytes() == (skill_dir / "SKILL.md").read_bytes()
        assert (target / "references/community/SKILL.md").read_bytes() == nested.read_bytes()


def test_matrix_lists_every_canonical_skill_with_its_description():
    matrix = json.loads((ROOT / "data/skills/matrix.json").read_text(encoding="utf-8"))
    canonical = sorted((ROOT / "data/skills").glob("*/SKILL.md"))
    expected_descriptions = {
        skill.parent.name: sync._skill_description(skill) for skill in canonical
    }

    # The catalogue grows; the contract is that matrix.json mirrors it exactly.
    assert matrix["skillCount"] == len(canonical) == len(matrix["skills"])
    assert {item["name"] for item in matrix["skills"]} == {
        skill.parent.name for skill in canonical
    }
    assert all(item.get("description", "").strip() for item in matrix["skills"])
    assert {
        item["name"]: item["description"] for item in matrix["skills"]
    } == expected_descriptions


# ---------------------------------------------------------------------------
# Committed-source deployment gate (fail-closed, path-scoped, with override)
# ---------------------------------------------------------------------------


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout


def _init_repo(repo: Path) -> None:
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "user@example.com")
    _git(repo, "config", "user.name", "gate test")


def _committed_catalogue(monkeypatch, tmp_path: Path) -> tuple[Path, Path]:
    """A catalogue that is the root of its own repo, with one committed skill."""
    catalogue, _, _ = _isolate_catalogue(monkeypatch, tmp_path)
    _init_repo(catalogue)
    _skill(catalogue, "alpha")
    _git(catalogue, "add", ".")
    _git(catalogue, "commit", "-q", "-m", "alpha")
    agent_dir = tmp_path / "Project" / "Team" / "Tester"
    monkeypatch.setattr(sync, "skill_target_dirs", lambda _teams, _agent: [agent_dir])
    return catalogue, agent_dir


def _deployed(agent_dir: Path, name: str) -> Path:
    return agent_dir / ".claude" / "skills" / name / "SKILL.md"


def test_clean_committed_catalogue_deploys(tmp_path, monkeypatch, capsys):
    catalogue, agent_dir = _committed_catalogue(monkeypatch, tmp_path)

    stats = sync.deploy_skills({}, [{"name": "Tester"}])

    assert stats["refused"] is False
    assert _deployed(agent_dir, "alpha").exists()
    assert "REFUSED" not in capsys.readouterr().out


def test_modified_skill_refuses_and_names_path_commit_and_override(
    tmp_path, monkeypatch, capsys
):
    catalogue, agent_dir = _committed_catalogue(monkeypatch, tmp_path)
    (catalogue / "alpha" / "SKILL.md").write_text("# edited, uncommitted\n", encoding="utf-8")

    stats = sync.deploy_skills({}, [{"name": "Tester"}])
    out = capsys.readouterr().out

    assert stats["refused"] is True
    assert not _deployed(agent_dir, "alpha").exists()
    assert "SKILLS DEPLOYMENT REFUSED" in out
    assert "alpha/SKILL.md" in out
    assert "git -C" in out and " add " in out and " commit " in out
    assert "--skills-allow-dirty" in out


def test_untracked_new_skill_refuses(tmp_path, monkeypatch, capsys):
    catalogue, agent_dir = _committed_catalogue(monkeypatch, tmp_path)
    _skill(catalogue, "beta")  # never added to git

    stats = sync.deploy_skills({}, [{"name": "Tester"}])
    out = capsys.readouterr().out

    assert stats["refused"] is True
    assert "?? beta/SKILL.md" in out
    assert not _deployed(agent_dir, "alpha").exists()
    assert not _deployed(agent_dir, "beta").exists()


def test_regenerated_matrix_alone_never_refuses(tmp_path, monkeypatch):
    catalogue, agent_dir = _committed_catalogue(monkeypatch, tmp_path)
    # untracked matrix.json (the sync's own output)
    (catalogue / "matrix.json").write_text("{}", encoding="utf-8")
    assert sync.deploy_skills({}, [{"name": "Tester"}])["refused"] is False
    assert _deployed(agent_dir, "alpha").exists()

    # tracked-then-modified matrix.json must be ignored too
    _git(catalogue, "add", "matrix.json")
    _git(catalogue, "commit", "-q", "-m", "matrix")
    (catalogue / "matrix.json").write_text('{"changed": true}', encoding="utf-8")
    assert sync.deploy_skills({}, [{"name": "Tester"}])["refused"] is False


def test_gate_is_scoped_to_the_catalogue_inside_a_larger_repo(
    tmp_path, monkeypatch, capsys
):
    # Real layout: repo root with the catalogue at data/skills and dirt elsewhere.
    repo = tmp_path / "repo"
    _init_repo(repo)
    catalogue = repo / "data" / "skills"
    catalogue.mkdir(parents=True)
    _skill(catalogue, "alpha")
    (repo / "lib").mkdir()
    (repo / "lib" / "x.ts").write_text("export const x = 1;\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "base")
    (repo / "lib" / "x.ts").write_text("export const x = 2;\n", encoding="utf-8")
    (repo / "untracked.txt").write_text("noise\n", encoding="utf-8")
    (catalogue / "matrix.json").write_text("{}", encoding="utf-8")  # generated, prefixed path
    monkeypatch.setattr(sync, "SKILLS_MASTER_DIR", catalogue)
    monkeypatch.setattr(sync, "SKILLS_MATRIX_PATH", catalogue / "matrix.json")
    monkeypatch.setattr(sync, "HOST_SKILLS_DIR", tmp_path / "host-skills")
    monkeypatch.setitem(sync._MACHINE_CONFIG, "homeDir", str(tmp_path / "home"))
    agent_dir = tmp_path / "Project" / "Team" / "Tester"
    monkeypatch.setattr(sync, "skill_target_dirs", lambda _teams, _agent: [agent_dir])

    assert sync.skills_catalogue_dirty_paths() == []
    assert sync.deploy_skills({}, [{"name": "Tester"}])["refused"] is False
    assert _deployed(agent_dir, "alpha").exists()

    # ...and dirt inside the catalogue is still caught, reported repo-root relative.
    (catalogue / "alpha" / "SKILL.md").write_text("# edited\n", encoding="utf-8")
    assert sync.skills_catalogue_dirty_paths() == [" M data/skills/alpha/SKILL.md"]
    assert sync.deploy_skills({}, [{"name": "Tester"}])["refused"] is True
    assert "data/skills/alpha/SKILL.md" in capsys.readouterr().out


def test_override_deploys_dirty_catalogue_and_says_so(tmp_path, monkeypatch, capsys):
    catalogue, agent_dir = _committed_catalogue(monkeypatch, tmp_path)
    (catalogue / "alpha" / "SKILL.md").write_text("# edited, uncommitted\n", encoding="utf-8")

    stats = sync.deploy_skills({}, [{"name": "Tester"}], allow_dirty=True)
    out = capsys.readouterr().out

    assert stats["refused"] is False
    assert _deployed(agent_dir, "alpha").read_text(encoding="utf-8") == "# edited, uncommitted\n"
    assert "UNCOMMITTED skill catalogue on explicit override" in out
    assert "REFUSED" not in out


def test_not_a_repository_fails_closed(tmp_path, monkeypatch, capsys):
    catalogue, _, _ = _isolate_catalogue(monkeypatch, tmp_path)
    _skill(catalogue, "alpha")
    agent_dir = tmp_path / "Project" / "Team" / "Tester"
    monkeypatch.setattr(sync, "skill_target_dirs", lambda _teams, _agent: [agent_dir])
    # Never discover a repository above the temp dir, wherever pytest puts it.
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path.parent))

    assert sync.skills_catalogue_dirty_paths() is None
    stats = sync.deploy_skills({}, [{"name": "Tester"}])
    out = capsys.readouterr().out

    assert stats["refused"] is True
    assert "git could not report" in out
    assert "--skills-allow-dirty" in out
    assert not _deployed(agent_dir, "alpha").exists()


def test_git_failure_fails_closed(tmp_path, monkeypatch, capsys):
    catalogue, agent_dir = _committed_catalogue(monkeypatch, tmp_path)

    def boom(*_args, **_kwargs):
        raise OSError("git vanished")

    monkeypatch.setattr(sync.subprocess, "run", boom)

    assert sync.skills_catalogue_dirty_paths() is None
    assert sync.deploy_skills({}, [{"name": "Tester"}])["refused"] is True
    assert not _deployed(agent_dir, "alpha").exists()
    assert "REFUSED" in capsys.readouterr().out


def test_silent_sync_path_honours_the_gate(tmp_path, monkeypatch, capsys):
    catalogue, agent_dir = _committed_catalogue(monkeypatch, tmp_path)
    (catalogue / "alpha" / "SKILL.md").write_text("# edited\n", encoding="utf-8")

    sync._deploy_skills_silent({}, [{"name": "Tester"}])
    assert not _deployed(agent_dir, "alpha").exists()
    assert "SKILLS DEPLOYMENT REFUSED" in capsys.readouterr().out

    sync._deploy_skills_silent({}, [{"name": "Tester"}], allow_dirty=True)
    assert _deployed(agent_dir, "alpha").exists()


def test_dry_run_reports_the_refusal_without_writing(tmp_path, monkeypatch, capsys):
    catalogue, agent_dir = _committed_catalogue(monkeypatch, tmp_path)
    _skill(catalogue, "beta")

    stats = sync.deploy_skills({}, [{"name": "Tester"}], dry_run=True)

    assert stats["refused"] is True
    assert "REFUSED (dry run)" in capsys.readouterr().out
    assert not agent_dir.exists()


def test_staged_rename_is_reported_by_its_new_path(tmp_path, monkeypatch):
    catalogue, _ = _committed_catalogue(monkeypatch, tmp_path)
    _git(catalogue, "mv", "alpha", "alpha-renamed")

    dirty = sync.skills_catalogue_dirty_paths()

    assert dirty is not None and len(dirty) == 1
    assert dirty[0].startswith("R") and "alpha-renamed/SKILL.md" in dirty[0]
