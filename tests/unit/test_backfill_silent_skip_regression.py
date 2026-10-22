"""
Sprint 44 T5.5 — Silent-skip regression tests for both backfill scripts.

This file is the cross-cutting regression layer for Sprint 44 P5+P7. The original
P2 outlook-fleet-enable script silently skipped 32 of 40 SG-1 agent dirs because
its walker only iterated EXISTING settings.local.json files — missing-file cases
returned `created=0, exit=0` with no signal that anything was wrong. Same class
of failure was possible for the P7 .mcp.json backfill if its walker / gates /
race-recovery were broken.

The Iron Law for both backfill scripts (per Jack T5.5 brief):
  If a target directory is missing the file the script is responsible for AND
  all gates pass, the script either:
    (a) creates the file (correct path), OR
    (b) exits with non-zero status and a loud error message (defensive path).
  It MUST NOT report "0 created, exit 0" silently.

Tests run the full script via subprocess with --json --apply against fixture
trees, then assert end-to-end behavior — not just process_one() in isolation.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
ENABLED_SCRIPT = SCRIPTS_DIR / "backfill-agent-mcp-enabled.py"
JSON_SCRIPT = SCRIPTS_DIR / "backfill-agent-mcp-json.py"


# ─── Fixtures: fake roster.json + roles.json + project tree ──────────────


def _write_roster(roster_path: Path, agents: list[dict]) -> None:
    """Write a collab-channels.json shape that load_roster_by_key can parse."""
    roster_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "channels": {
            "fixture-channel": {
                "id": "fixture-channel",
                "name": "Fixture",
                "roster": {"agents": agents},
            }
        }
    }
    roster_path.write_text(json.dumps(payload))


def _write_roles(roles_path: Path, roles: list[dict]) -> None:
    roles_path.parent.mkdir(parents=True, exist_ok=True)
    roles_path.write_text(json.dumps({"roles": roles}))


def _agent_entry(name: str, project_root: str, role_id: str = "r-backend",
                 model: str = "sonnet") -> dict:
    return {
        "id": f"agent-{name.lower()}",
        "name": name,
        "workingDirectory": project_root,
        "roleId": role_id,
        "model": model,
        "createdAt": "2026-04-13T00:00:00Z",
        "updatedAt": "2026-04-13T00:00:00Z",
    }


def _role_entry(role_id: str, name: str, servers: list[str]) -> dict:
    return {"id": role_id, "name": name, "slug": name.lower().replace(" ", "-"),
            "mcpServers": servers}


def _run_script(script: Path, *, root: Path, roster: Path, roles: Path | None,
                apply: bool = True) -> dict:
    """Run script as subprocess, return parsed JSON output + exit code.

    Both scripts have ROSTER_FILE / ROLES_FILE module constants pointing at the
    real DevFlow paths. To redirect them at fixtures we patch the script via a
    short loader that monkeypatches before invoking main(). This avoids needing
    to refactor the production scripts to accept env-var paths.
    """
    loader = f"""
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('m', r'{script}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.ROSTER_FILE = Path(r'{roster}')
"""
    if roles is not None and hasattr_check(script, "ROLES_FILE"):
        loader += f"mod.ROLES_FILE = Path(r'{roles}')\n"
    args = ["--json", "--root", str(root)]
    if apply:
        args.append("--apply")
    loader += f"sys.argv = ['{script.name}'] + {args!r}\nsys.exit(mod.main())\n"

    result = subprocess.run([sys.executable, "-c", loader], capture_output=True,
                            text=True, timeout=30)
    try:
        parsed = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        parsed = None
    return {
        "exit": result.returncode,
        "results": parsed,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def hasattr_check(script_path: Path, attr: str) -> bool:
    """Quick textual check whether the script defines a constant — keeps the
    loader generic across both scripts (only ENABLED_SCRIPT defines ROLES_FILE)."""
    try:
        return attr in script_path.read_text()
    except OSError:
        return False


# ─── enabled script — silent-skip regression ────────────────────────────


@pytest.fixture
def enabled_fixture(tmp_path):
    """Build a project where 1 agent has settings.local.json and 1 doesn't.

    With the P2 bug (existence-only walker), only the WithFile agent would be
    processed; NoFile would be silently skipped → 0 created, 0 changed, exit 0.
    """
    proj = tmp_path / "FakeProj"
    (proj / "Team" / "WithFile" / ".claude").mkdir(parents=True)
    (proj / "Team" / "WithFile" / ".claude" / "settings.local.json").write_text(
        json.dumps({"enabledMcpjsonServers": ["qdrant"], "enableAllProjectMcpServers": True})
    )
    (proj / "Team" / "NoFile" / ".claude").mkdir(parents=True)
    # NoFile intentionally has no settings.local.json — this is the regression case.

    roster_path = tmp_path / "roster.json"
    roles_path = tmp_path / "roles.json"
    _write_roster(roster_path, [
        _agent_entry("WithFile", str(proj)),
        _agent_entry("NoFile", str(proj)),
    ])
    _write_roles(roles_path, [
        _role_entry("r-backend", "Backend Dev", ["qdrant", "snapshot", "outlook"]),
    ])
    return proj, roster_path, roles_path


def test_enabled_script_creates_for_missing_file_does_not_silently_skip(enabled_fixture):
    """The P2 bug: NoFile would silently disappear from results. Today it must
    appear with status='created'."""
    proj, roster, roles = enabled_fixture
    out = _run_script(ENABLED_SCRIPT, root=proj.parent, roster=roster, roles=roles, apply=True)
    assert out["exit"] == 0, f"script crashed: {out['stderr']}"
    assert out["results"] is not None, f"non-JSON output: {out['stdout'][:300]}"

    by_agent = {r["agent"]: r for r in out["results"] if r.get("agent")}
    assert "NoFile" in by_agent, "missing-file agent silently dropped from results"
    assert by_agent["NoFile"]["status"] == "created", \
        f"missing-file path must yield status='created', got {by_agent['NoFile']}"

    # The actual file must exist on disk after --apply.
    assert (proj / "Team" / "NoFile" / ".claude" / "settings.local.json").is_file(), \
        "--apply must materialize the missing settings.local.json"


def test_enabled_script_iron_law_holds_for_pure_missing_fleet(tmp_path):
    """If EVERY agent in a tree is missing-file (the original P2 fleet), --apply
    must produce N>0 created entries and exit 0 — NOT 'created=0, exit=0'."""
    proj = tmp_path / "Pure"
    for name in ("Alpha", "Beta", "Gamma", "Delta"):
        (proj / "Team" / name / ".claude").mkdir(parents=True)
    roster_path = tmp_path / "roster.json"
    roles_path = tmp_path / "roles.json"
    _write_roster(roster_path, [
        _agent_entry(n, str(proj)) for n in ("Alpha", "Beta", "Gamma", "Delta")
    ])
    _write_roles(roles_path, [
        _role_entry("r-backend", "Backend Dev", ["qdrant", "outlook"]),
    ])

    out = _run_script(ENABLED_SCRIPT, root=proj.parent, roster=roster_path, roles=roles_path, apply=True)
    assert out["exit"] == 0
    created = [r for r in out["results"] if r.get("status") == "created"]
    assert len(created) == 4, f"expected 4 creates, got {len(created)}: {[r.get('agent') for r in created]}"
    # And every dir now has the file.
    for name in ("Alpha", "Beta", "Gamma", "Delta"):
        assert (proj / "Team" / name / ".claude" / "settings.local.json").is_file()


def test_enabled_script_dry_run_reports_creates_does_not_write(tmp_path):
    """Dry-run must STILL surface the missing-file case — silent skip is the
    very thing the regression test is designed to catch, in either mode."""
    proj = tmp_path / "Dry"
    (proj / "Team" / "Ghost" / ".claude").mkdir(parents=True)
    roster_path = tmp_path / "roster.json"
    roles_path = tmp_path / "roles.json"
    _write_roster(roster_path, [_agent_entry("Ghost", str(proj))])
    _write_roles(roles_path, [_role_entry("r-backend", "Backend Dev", ["outlook"])])

    out = _run_script(ENABLED_SCRIPT, root=proj.parent, roster=roster_path, roles=roles_path, apply=False)
    assert out["exit"] == 0
    by_agent = {r["agent"]: r for r in out["results"] if r.get("agent")}
    assert by_agent.get("Ghost", {}).get("status") == "created"
    assert not (proj / "Team" / "Ghost" / ".claude" / "settings.local.json").exists(), \
        "dry-run must NOT write"


# ─── json script — silent-skip regression + gates ───────────────────────


def test_json_script_creates_for_missing_mcp_json_does_not_silently_skip(tmp_path):
    """The P7 mirror of the P5 regression. An agent dir with eligible
    settings.local.json but no .mcp.json must produce a 'created' result, not
    silently disappear."""
    proj = tmp_path / "Proj"
    (proj / "Team" / "Eligible" / ".claude").mkdir(parents=True)
    (proj / "Team" / "Eligible" / ".claude" / "settings.local.json").write_text(
        json.dumps({"enabledMcpjsonServers": ["outlook"], "enableAllProjectMcpServers": True})
    )
    roster_path = tmp_path / "roster.json"
    _write_roster(roster_path, [_agent_entry("Eligible", str(proj))])

    out = _run_script(JSON_SCRIPT, root=proj.parent, roster=roster_path, roles=None, apply=True)
    assert out["exit"] == 0, f"crashed: {out['stderr']}"
    by_agent = {r["agent"]: r for r in out["results"] if r.get("agent")}
    assert by_agent.get("Eligible", {}).get("status") == "created"
    assert (proj / "Team" / "Eligible" / ".mcp.json").is_file()


def test_json_script_grok_skip_is_explicit_not_silent(tmp_path):
    """Grok agents must be skipped with an explicit note — not silently
    produce 'updated 0' as if there were nothing to do."""
    proj = tmp_path / "Proj"
    (proj / "Team" / "GrokAgent" / ".claude").mkdir(parents=True)
    (proj / "Team" / "GrokAgent" / ".claude" / "settings.local.json").write_text(
        json.dumps({"enabledMcpjsonServers": ["outlook"], "enableAllProjectMcpServers": True})
    )
    roster_path = tmp_path / "roster.json"
    _write_roster(roster_path, [_agent_entry("GrokAgent", str(proj), model="grok-4-1-fast-non-reasoning")])

    out = _run_script(JSON_SCRIPT, root=proj.parent, roster=roster_path, roles=None, apply=True)
    assert out["exit"] == 0
    by_agent = {r["agent"]: r for r in out["results"] if r.get("agent")}
    g = by_agent.get("GrokAgent", {})
    assert g.get("status") == "skipped", f"grok agent must be explicit skip, got {g}"
    assert "grok" in g.get("note", "").lower(), \
        f"grok skip must include 'grok' in note for audit trail, got {g.get('note')!r}"
    # And critically: NO file written for grok.
    assert not (proj / "Team" / "GrokAgent" / ".mcp.json").exists()


def test_json_script_refuse_to_clobber_other_servers_is_explicit_skip(tmp_path):
    """If .mcp.json exists with non-outlook servers, refuse to overwrite — and
    surface that decision explicitly in the result, not silently."""
    proj = tmp_path / "Proj"
    (proj / "Team" / "OtherSrv").mkdir(parents=True)
    (proj / "Team" / "OtherSrv" / ".claude").mkdir(parents=True)
    (proj / "Team" / "OtherSrv" / ".claude" / "settings.local.json").write_text(
        json.dumps({"enabledMcpjsonServers": ["outlook"], "enableAllProjectMcpServers": True})
    )
    existing_mcp = {"mcpServers": {"davinci-resolve": {"command": "x"}}}
    (proj / "Team" / "OtherSrv" / ".mcp.json").write_text(json.dumps(existing_mcp))
    roster_path = tmp_path / "roster.json"
    _write_roster(roster_path, [_agent_entry("OtherSrv", str(proj))])

    out = _run_script(JSON_SCRIPT, root=proj.parent, roster=roster_path, roles=None, apply=True)
    assert out["exit"] == 0
    by_agent = {r["agent"]: r for r in out["results"] if r.get("agent")}
    g = by_agent.get("OtherSrv", {})
    assert g.get("status") == "skipped"
    note = g.get("note", "").lower()
    assert "manual merge" in note or "refus" in note or "other servers" in note, \
        f"refuse-to-clobber skip must explain itself, got {g.get('note')!r}"
    # File must be unchanged.
    body = json.loads((proj / "Team" / "OtherSrv" / ".mcp.json").read_text())
    assert body == existing_mcp, "refuse-to-clobber must NOT modify the file"


def test_json_script_iron_law_pure_missing_fleet(tmp_path):
    """Mirror of the enabled-script Iron Law test, for the json script."""
    proj = tmp_path / "Pure"
    for name in ("Hammond", "Morpheus", "Sheppard", "Developer"):
        ag = proj / "Team" / name
        (ag / ".claude").mkdir(parents=True)
        (ag / ".claude" / "settings.local.json").write_text(
            json.dumps({"enabledMcpjsonServers": ["outlook"], "enableAllProjectMcpServers": True})
        )
    roster_path = tmp_path / "roster.json"
    _write_roster(roster_path, [
        _agent_entry(n, str(proj)) for n in ("Hammond", "Morpheus", "Sheppard", "Developer")
    ])

    out = _run_script(JSON_SCRIPT, root=proj.parent, roster=roster_path, roles=None, apply=True)
    assert out["exit"] == 0
    created = [r for r in out["results"] if r.get("status") == "created"]
    assert len(created) == 4, f"expected 4 creates, got {len(created)}"
    for name in ("Hammond", "Morpheus", "Sheppard", "Developer"):
        assert (proj / "Team" / name / ".mcp.json").is_file()


# ─── Cross-cutting: BOTH scripts must explain non-creation ──────────────


@pytest.mark.parametrize("script", [ENABLED_SCRIPT, JSON_SCRIPT])
def test_no_silent_drop_every_walked_dir_in_results(script, tmp_path):
    """For any agent dir under root/Team/*, the script's --json output must
    include a result row for it. Silent dropping (where a dir is walked but
    not represented in output) is the failure mode that bit P2."""
    proj = tmp_path / "Proj"
    for name in ("X", "Y", "Z"):
        ag = proj / "Team" / name
        (ag / ".claude").mkdir(parents=True)
        (ag / ".claude" / "settings.local.json").write_text(
            json.dumps({"enabledMcpjsonServers": ["outlook"], "enableAllProjectMcpServers": True})
        )
    roster_path = tmp_path / "roster.json"
    roles_path = tmp_path / "roles.json"
    _write_roster(roster_path, [_agent_entry(n, str(proj)) for n in ("X", "Y", "Z")])
    _write_roles(roles_path, [_role_entry("r-backend", "Backend Dev", ["outlook"])])

    out = _run_script(script, root=proj.parent, roster=roster_path,
                      roles=roles_path if "ROLES_FILE" in script.read_text() else None,
                      apply=False)
    assert out["exit"] == 0
    agents_in_results = {r["agent"] for r in out["results"] if r.get("agent")}
    assert {"X", "Y", "Z"} <= agents_in_results, \
        f"silent drop detected for script {script.name}: missing {set('XYZ') - agents_in_results}"
