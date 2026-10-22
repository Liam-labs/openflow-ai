"""Canonical routing/load boundaries; live execution is verified separately."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]


def read(path):
    return (ROOT / path).read_text()


def test_legacy_aliases_are_redirects_without_executable_procedures():
    for name in ("edge", "native-browser-use"):
        content = read(f"data/skills/{name}/SKILL.md")
        assert "~/DevFlow/data/skills/browser/SKILL.md" in content
        assert len(content.splitlines()) <= 25
        assert "```" not in content
        assert "http://" not in content
        assert "curl " not in content
        assert "does not activate a legacy adapter" in content


def test_startup_router_is_small_and_points_to_browser():
    content = read("data/scaffolding/masters/global/computer-use.md")
    assert "/browser" in content
    assert len(content.splitlines()) <= 8
    assert "`/computer-use` with its desktop-control boundary" in content


def test_router_has_local_reference_and_separate_account_boundary():
    content = read("data/skills/browser/SKILL.md")
    for link in re.findall(r"\]\((references/[^)]+)\)", content):
        assert (ROOT / "data/skills/browser" / link).is_file()
    assert "/account-access" in content and "/onepassword" in content
    assert "whole select-observe-act-verify sequence" in content
    assert "unknown outcome" in content
    assert "not isolate hostile" in content
    assert "Do not infer Edge" in content


def test_computer_use_adapter_does_not_select_retired_browser_route():
    content = read("data/skills/computer-use/SKILL.md")
    assert "/native-browser-use" not in content
    assert "Every web task starts" not in content
    assert "`/browser` owns route selection" in content
    assert "mode: 'headless'" in content
    assert "physical Windows desktop" in content
