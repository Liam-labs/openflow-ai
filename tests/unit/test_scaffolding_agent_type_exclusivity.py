"""Regression tests for runtime-specific scaffolding selection.

An agent's ``models`` list is historical capability data and can accumulate
entries as the harness changes.  Once ``agentType`` is explicit, only that
runtime may satisfy ``agentType:*`` conditions; otherwise a Codex respawn can
render Hermes's AGENTS.md over the Codex template.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path


SCAFFOLDING_DIR = Path(__file__).resolve().parents[2] / "data" / "scaffolding"
if str(SCAFFOLDING_DIR) not in sys.path:
    sys.path.insert(0, str(SCAFFOLDING_DIR))

sync = importlib.import_module("sync")
adapters = importlib.import_module("adapters")


def test_explicit_codex_agent_type_ignores_historical_runtime_models():
    agent = {
        "name": "Architect",
        "agentType": "codex",
        "models": ["claude", "gemini", "grok", "hermes", "antigravity", "codex"],
    }

    assert sync.agent_matches_condition(agent, "agentType:codex")
    assert not sync.agent_matches_condition(agent, "agentType:hermes")
    assert not sync.agent_matches_condition(agent, "agentType:antigravity")

    matched = adapters.select_adapters_for(agent, sync.agent_matches_condition)
    assert [adapter.family for adapter in matched] == ["codex"]


def test_legacy_agent_without_agent_type_still_uses_models_fallback():
    agent = {"name": "LegacyHermes", "models": ["claude", "hermes"]}

    assert sync.agent_matches_condition(agent, "agentType:hermes")


def test_agent_owned_presence_is_distinguished_from_shared_project_root():
    assert sync.is_agent_owned_presence(
        "Architect", "/home/user/SEO Engine/Team/Architect"
    )
    assert not sync.is_agent_owned_presence("Architect", "/home/user/SEO Engine")
    assert not sync.is_agent_owned_presence(
        "Architect", "/home/user/SEO Engine/Team/Dave"
    )


def test_skill_target_dirs_include_every_agent_owned_presence(monkeypatch):
    teams = {
        "sg1": {
            "projectDir": "/home/user/SG-1",
            "teamDir": "/home/user/SG-1/Team",
        }
    }
    agent = {"name": "Teyla", "teamId": "sg1"}
    monkeypatch.setattr(
        sync,
        "discover_agent_presences",
        lambda _name: [
            {
                "workingDirectory": "/home/user/SG-1/Team/Teyla",
                "agentType": "codex",
            },
            {
                "workingDirectory": "/home/user/BnG-CRM/Team/Teyla",
                "agentType": "codex",
            },
            {
                "workingDirectory": "/home/user/BnG-CRM",
                "agentType": "codex",
            },
        ],
    )

    assert sync.skill_target_dirs(teams, agent) == [
        Path("/home/user/BnG-CRM/Team/Teyla"),
        Path("/home/user/SG-1/Team/Teyla"),
    ]


def test_skill_target_dirs_resolves_legacy_project_root_presence(
    monkeypatch, tmp_path
):
    default_team = tmp_path / "Default" / "Team"
    project_root = tmp_path / "Client"
    inferred_agent_dir = project_root / "Team" / "Morpheus"
    inferred_agent_dir.mkdir(parents=True)
    teams = {
        "sg1": {
            "projectDir": str(tmp_path / "Default"),
            "teamDir": str(default_team),
        }
    }
    agent = {"name": "Morpheus", "teamId": "sg1"}
    monkeypatch.setattr(
        sync,
        "discover_agent_presences",
        lambda _name: [
            {
                "workingDirectory": str(project_root),
                "agentType": "claude",
            }
        ],
    )

    assert inferred_agent_dir in sync.skill_target_dirs(teams, agent)
    assert project_root not in sync.skill_target_dirs(teams, agent)


def test_skill_target_dirs_skip_windows_native_paths_on_posix(monkeypatch):
    teams = {
        "sg1": {
            "projectDir": "/home/user/SG-1",
            "teamDir": "/home/user/SG-1/Team",
        }
    }
    agent = {"name": "BrowserDev", "teamId": "sg1"}
    monkeypatch.setattr(
        sync,
        "discover_agent_presences",
        lambda _name: [
            {
                "workingDirectory": r"C:\Users\winuser\BrowserDev/Team/BrowserDev",
                "agentType": "claude",
            }
        ],
    )

    targets = sync.skill_target_dirs(teams, agent)

    assert targets == [Path("/home/user/SG-1/Team/BrowserDev")]
    assert all("C:" not in str(target) for target in targets)
