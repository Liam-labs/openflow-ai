#!/usr/bin/env python3
"""Skill packs: niche skills reach only opted-in projects' agents."""

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("skill_packs_sync", ROOT / "data/scaffolding/sync.py")
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


def _skill(catalogue: Path, name: str) -> Path:
    d = catalogue / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {name} skill.\n---\n", encoding="utf-8")
    return d


def _setup(tmp_path, monkeypatch, packs):
    catalogue = tmp_path / "catalogue"
    catalogue.mkdir()
    home = tmp_path / "home"
    host = home / ".claude" / "skills"
    monkeypatch.setattr(sync, "SKILLS_MASTER_DIR", catalogue)
    monkeypatch.setattr(sync, "SKILLS_MATRIX_PATH", catalogue / "matrix.json")
    monkeypatch.setattr(sync, "HOST_SKILLS_DIR", host)
    monkeypatch.setitem(sync._MACHINE_CONFIG, "homeDir", str(home))
    if packs is not None:
        (catalogue / "packs.json").write_text(json.dumps(packs), encoding="utf-8")
    game = tmp_path / "Costa-Vida" / "Team" / "Builder"
    web = tmp_path / "Website" / "Team" / "Builder"
    lookalike = tmp_path / "Costa-Vida-Old" / "Team" / "Builder"
    for d in (game, web, lookalike):
        d.mkdir(parents=True)
    monkeypatch.setattr(sync, "skill_target_dirs", lambda _t, _a: [game, web, lookalike])
    return catalogue, home, host, game, web, lookalike


GAMES = lambda tmp: {"games": {"description": "Game dev", "skills": ["unreal-engine"],
                               "projects": [str(tmp / "Costa-Vida")]}}


def test_pack_skill_reaches_only_opted_in_project(tmp_path, monkeypatch):
    catalogue, _, _, game, web, lookalike = _setup(tmp_path, monkeypatch, GAMES(tmp_path))
    _skill(catalogue, "unreal-engine")
    sync.deploy_skills({}, [{"name": "Builder"}], allow_dirty=True)
    assert (game / ".claude/skills/unreal-engine/SKILL.md").is_file()
    assert not (web / ".claude/skills/unreal-engine").exists()
    # A folder whose name merely starts with the project name is not inside it.
    assert not (lookalike / ".claude/skills/unreal-engine").exists()


def test_existing_global_copy_is_removed_outside_the_pack(tmp_path, monkeypatch):
    catalogue, _, _, _, web, _ = _setup(tmp_path, monkeypatch, GAMES(tmp_path))
    _skill(catalogue, "unreal-engine")
    stale = web / ".claude/skills/unreal-engine/references"
    stale.mkdir(parents=True)
    (stale / "x.md").write_text("old", encoding="utf-8")
    stats = sync.deploy_skills({}, [{"name": "Builder"}], allow_dirty=True)
    assert not (web / ".claude/skills/unreal-engine").exists()
    assert stats["removed"] >= 1


def test_dry_run_removes_nothing(tmp_path, monkeypatch):
    catalogue, _, _, _, web, _ = _setup(tmp_path, monkeypatch, GAMES(tmp_path))
    _skill(catalogue, "unreal-engine")
    (web / ".claude/skills/unreal-engine").mkdir(parents=True)
    sync.deploy_skills({}, [{"name": "Builder"}], allow_dirty=True, dry_run=True)
    assert (web / ".claude/skills/unreal-engine").exists()


def test_pack_skill_is_taken_out_of_machine_wide_lists(tmp_path, monkeypatch):
    catalogue, home, host, _, _, _ = _setup(tmp_path, monkeypatch, GAMES(tmp_path))
    skill_dir = _skill(catalogue, "unreal-engine")
    host.mkdir(parents=True)
    (host / "unreal-engine").symlink_to(skill_dir)
    shared = home / ".agents" / "skills"
    shared.mkdir(parents=True)
    (shared / "unreal-engine").symlink_to(skill_dir)
    sync.deploy_skills({}, [{"name": "Builder"}], allow_dirty=True, symlink_host=True)
    assert not (host / "unreal-engine").exists() and not (host / "unreal-engine").is_symlink()
    assert not (shared / "unreal-engine").is_symlink()
    assert skill_dir.is_dir()  # the catalogue itself is untouched


def test_host_entry_the_catalogue_did_not_create_is_left_alone(tmp_path, monkeypatch, capsys):
    catalogue, _, host, _, _, _ = _setup(tmp_path, monkeypatch, GAMES(tmp_path))
    _skill(catalogue, "unreal-engine")
    foreign = host / "unreal-engine"
    foreign.mkdir(parents=True)
    (foreign / "SKILL.md").write_text("someone else's skill", encoding="utf-8")
    sync.deploy_skills({}, [{"name": "Builder"}], allow_dirty=True, symlink_host=True)
    assert (foreign / "SKILL.md").read_text(encoding="utf-8") == "someone else's skill"
    assert "not a catalogue copy" in capsys.readouterr().out


def test_ordinary_skill_is_still_global(tmp_path, monkeypatch):
    catalogue, _, host, game, web, _ = _setup(tmp_path, monkeypatch, GAMES(tmp_path))
    _skill(catalogue, "unreal-engine")
    _skill(catalogue, "code-review")
    sync.deploy_skills({}, [{"name": "Builder"}], allow_dirty=True, symlink_host=True)
    for d in (game, web):
        assert (d / ".claude/skills/code-review/SKILL.md").is_file()
    assert (host / "code-review").is_symlink()


def test_no_packs_file_keeps_old_behaviour(tmp_path, monkeypatch):
    catalogue, _, _, game, web, _ = _setup(tmp_path, monkeypatch, None)
    _skill(catalogue, "unreal-engine")
    sync.deploy_skills({}, [{"name": "Builder"}], allow_dirty=True)
    assert (web / ".claude/skills/unreal-engine/SKILL.md").is_file()
    assert (game / ".claude/skills/unreal-engine/SKILL.md").is_file()


def test_skill_in_two_packs_refuses_and_writes_nothing(tmp_path, monkeypatch, capsys):
    packs = {"a": {"skills": ["unreal-engine"], "projects": [str(tmp_path / "Costa-Vida")]},
             "b": {"skills": ["unreal-engine"], "projects": [str(tmp_path / "Website")]}}
    catalogue, _, _, game, web, _ = _setup(tmp_path, monkeypatch, packs)
    _skill(catalogue, "unreal-engine")
    stats = sync.deploy_skills({}, [{"name": "Builder"}], allow_dirty=True)
    assert stats["refused"]
    assert not (game / ".claude/skills").exists() and not (web / ".claude/skills").exists()
    assert "in both pack" in capsys.readouterr().out


def test_relative_project_path_refuses(tmp_path, monkeypatch):
    packs = {"games": {"skills": ["unreal-engine"], "projects": ["Costa-Vida"]}}
    catalogue, _, _, _, _, _ = _setup(tmp_path, monkeypatch, packs)
    _skill(catalogue, "unreal-engine")
    assert sync.deploy_skills({}, [{"name": "Builder"}], allow_dirty=True)["refused"]


def test_malformed_packs_file_refuses(tmp_path, monkeypatch):
    catalogue, _, _, _, _, _ = _setup(tmp_path, monkeypatch, None)
    (catalogue / "packs.json").write_text("{not json", encoding="utf-8")
    _skill(catalogue, "unreal-engine")
    assert sync.deploy_skills({}, [{"name": "Builder"}], allow_dirty=True)["refused"]


def test_symlinked_workspace_inside_project_counts_as_opted_in(tmp_path, monkeypatch):
    catalogue, _, _, game, _, _ = _setup(tmp_path, monkeypatch, GAMES(tmp_path))
    _skill(catalogue, "unreal-engine")
    alias = tmp_path / "alias-Builder"
    alias.symlink_to(game)
    monkeypatch.setattr(sync, "skill_target_dirs", lambda _t, _a: [alias])
    sync.deploy_skills({}, [{"name": "Builder"}], allow_dirty=True)
    assert (game / ".claude/skills/unreal-engine/SKILL.md").is_file()


def test_matrix_marks_pack_members_and_lists_packs(tmp_path, monkeypatch):
    catalogue, _, _, _, _, _ = _setup(tmp_path, monkeypatch, GAMES(tmp_path))
    _skill(catalogue, "unreal-engine")
    _skill(catalogue, "code-review")
    sync.deploy_skills({}, [{"name": "Builder"}], allow_dirty=True)
    matrix = json.loads((catalogue / "matrix.json").read_text(encoding="utf-8"))
    by_name = {s["name"]: s for s in matrix["skills"]}
    assert by_name["unreal-engine"]["pack"] == "games"
    assert "pack" not in by_name["code-review"]
    assert matrix["packs"]["games"]["projects"] == [str(tmp_path / "Costa-Vida")]


def test_packs_json_listing_a_missing_skill_warns(tmp_path, monkeypatch, capsys):
    packs = {"games": {"skills": ["no-such-skill"], "projects": [str(tmp_path / "Costa-Vida")]}}
    catalogue, _, _, _, _, _ = _setup(tmp_path, monkeypatch, packs)
    _skill(catalogue, "code-review")
    sync.deploy_skills({}, [{"name": "Builder"}], allow_dirty=True)
    assert "not in the catalogue" in capsys.readouterr().out
