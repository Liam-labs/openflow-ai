#!/usr/bin/env python3

import importlib.util
import hashlib
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
SYNC_PATH = ROOT / "data/scaffolding/sync.py"
SPEC = importlib.util.spec_from_file_location("scaffolding_safety_sync", SYNC_PATH)
assert SPEC and SPEC.loader
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


def test_outlook_migration_preserves_unrelated_mcp_configuration():
    existing = json.dumps({
        "custom": {"keep": True},
        "mcpServers": {
            "snapshot": {"command": "snapshot-server"},
            "outlook": {"command": "node", "args": ["old-outlook.js"]},
        },
    })
    master = (ROOT / "data/scaffolding/masters/global/mcp-outlook.json").read_text()

    merged = json.loads(sync.merge_managed_outlook_config(existing, master))

    assert merged["custom"] == {"keep": True}
    assert merged["mcpServers"]["snapshot"] == {"command": "snapshot-server"}
    assert merged["mcpServers"]["outlook"] == {
        "type": "http",
        "url": "http://localhost:7003/mcp",
    }


def test_outlook_migration_rejects_malformed_json_instead_of_overwriting_it():
    master = (ROOT / "data/scaffolding/masters/global/mcp-outlook.json").read_text()
    with pytest.raises(json.JSONDecodeError):
        sync.merge_managed_outlook_config("{not-json", master)


def test_managed_write_replaces_legacy_symlink_without_touching_shared_target(tmp_path):
    shared = tmp_path / "CLAUDE.md"
    shared.write_text("# Project-owned instructions\n")
    agent_dir = tmp_path / "Team" / "Dave"
    agent_dir.mkdir(parents=True)
    entrypoint = agent_dir / "CLAUDE.md"
    entrypoint.symlink_to(shared)

    sync.write_managed_text(entrypoint, "# Agent entrypoint\n")

    assert not entrypoint.is_symlink()
    assert entrypoint.read_text() == "# Agent entrypoint\n"
    assert shared.read_text() == "# Project-owned instructions\n"


def test_old_team_lead_hash_migrates_but_custom_override_is_preserved(tmp_path, monkeypatch):
    canonical_key = "roles/team-lead.md"
    assert "183b003362ea9e27283b3bfae4849a2e1f86a9ea3b6484443aa9ee0ec72e7cfc" in (
        sync._LEGACY_IDENTITY_SHA256[canonical_key]
    )

    # Exercise the exact-hash migration path with a compact fixture. The
    # production registry above binds the real pre-change Team Lead bytes.
    legacy_fixture = "# Team Lead\n\nLegacy canonical regression fixture.\n"
    legacy_hash = hashlib.sha256(legacy_fixture.encode()).hexdigest()
    monkeypatch.setitem(sync._LEGACY_IDENTITY_SHA256, canonical_key, frozenset({legacy_hash}))

    old_workspace = tmp_path / "Old" / "Team" / "Lead"
    old_rules = old_workspace / ".claude" / "rules"
    old_rules.mkdir(parents=True)
    (old_rules / "Directives.md").write_text(legacy_fixture)
    sync.sync_identity_files({"name": "Lead", "role": "Team Lead"}, str(old_workspace))
    assert (old_rules / "Directives.md").read_text().strip() == (
        f"@{sync._ROLES_DIR}/team-lead.md"
    )

    custom_workspace = tmp_path / "Custom" / "Team" / "Lead"
    custom_rules = custom_workspace / ".claude" / "rules"
    custom_rules.mkdir(parents=True)
    custom = "Keep this one-line project-specific release boundary.\n"
    (custom_rules / "Directives.md").write_text(custom)
    sync.sync_identity_files({"name": "Lead", "role": "Team Lead"}, str(custom_workspace))
    assert (custom_rules / "Directives.md").read_text() == custom


def test_targeted_sync_uses_roster_role_instead_of_agent_home_role(tmp_path, monkeypatch):
    workspace = tmp_path / "Project" / "Team" / "Margaret"
    rules = workspace / ".claude" / "rules"
    rules.mkdir(parents=True)
    architect_pointer = f"@{sync._ROLES_DIR}/architect.md\n"
    (rules / "Directives.md").write_text(architect_pointer)
    (rules / "Personality.md").write_text(
        f"@{sync._ROLES_DIR}/personalities/Margaret.md\n"
    )
    monkeypatch.setattr(sync, "discover_agent_presences", lambda _name: [{
        "workingDirectory": str(workspace),
        "agentType": "claude",
        "roleId": "a3f1d8e2-6c74-4b9f-8e5a-2d7c1b4f9e36",
        "personality": "Margaret",
    }])
    monkeypatch.setattr(sync, "_deploy_skills_silent", lambda *args, **kwargs: None)

    sync.run_sync(
        teams={"test": {"projectDir": str(tmp_path / "Project"), "teamDir": str(tmp_path / "Project/Team")}},
        agents=[{
            "name": "Margaret",
            "teamId": "test",
            "role": "Team Lead",
            "models": ["claude"],
        }],
        manifest={"files": []},
        agent_filter="Margaret",
        target_dir_override=str(workspace),
    )

    assert (rules / "Directives.md").read_text() == architect_pointer


def test_targeted_sync_uses_selected_runtime_instead_of_same_name_home_runtime(tmp_path, monkeypatch):
    workspace = tmp_path / "Ledger" / "Team" / "Dave"
    workspace.mkdir(parents=True)
    masters = tmp_path / "masters"
    claude_master = masters / "per-model" / "claude" / "alignment-claude.md"
    codex_master = masters / "per-model" / "codex" / "alignment-codex.md"
    claude_master.parent.mkdir(parents=True)
    codex_master.parent.mkdir(parents=True)
    claude_master.write_text("# Claude alignment\n")
    codex_master.write_text("# Codex alignment\n")
    monkeypatch.setattr(sync, "MASTERS_DIR", masters)
    monkeypatch.setattr(sync, "_deploy_skills_silent", lambda *args, **kwargs: None)
    monkeypatch.setattr(sync, "discover_agent_presences", lambda _name: [{
        "workingDirectory": str(workspace),
        "agentType": "claude",
    }])

    manifest = {"files": [
        {
            "id": "alignment-claude",
            "category": "per-model",
            "master": "per-model/claude/alignment-claude.md",
            "targets": ["{agent_dir}/.claude/rules/alignment-claude.md"],
            "condition": "agentType:claude",
            "overwrite": True,
        },
        {
            "id": "alignment-codex",
            "category": "per-model",
            "master": "per-model/codex/alignment-codex.md",
            "targets": ["{agent_dir}/alignment-codex.md"],
            "condition": "agentType:codex",
            "overwrite": True,
        },
    ]}
    home_agent = {
        "name": "Dave",
        "teamId": "sg1",
        "agentType": "codex",
        "models": ["codex"],
    }

    sync.run_sync(
        teams={"sg1": {"projectDir": str(tmp_path), "teamDir": str(tmp_path / "Team")}},
        agents=[home_agent],
        manifest=manifest,
        agent_filter="Dave",
        target_dir_override=str(workspace),
    )

    assert (workspace / ".claude/rules/alignment-claude.md").read_text() == "# Claude alignment\n"
    assert not (workspace / "alignment-codex.md").exists()


def test_unknown_explicit_roster_role_never_falls_back_to_home_role(tmp_path, monkeypatch):
    workspace = tmp_path / "Project" / "Team" / "Margaret"
    rules = workspace / ".claude" / "rules"
    rules.mkdir(parents=True)
    current_pointer = f"@{sync._ROLES_DIR}/architect.md\n"
    (rules / "Directives.md").write_text(current_pointer)
    (rules / "Personality.md").write_text(
        f"@{sync._ROLES_DIR}/personalities/Margaret.md\n"
    )
    monkeypatch.setattr(sync, "discover_agent_presences", lambda _name: [{
        "workingDirectory": str(workspace),
        "agentType": "claude",
        "roleId": "deleted-role-id",
        "personality": "Margaret",
    }])
    monkeypatch.setattr(sync, "_deploy_skills_silent", lambda *args, **kwargs: None)

    sync.run_sync(
        teams={"test": {"projectDir": str(tmp_path / "Project"), "teamDir": str(tmp_path / "Project/Team")}},
        agents=[{"name": "Margaret", "teamId": "test", "role": "Team Lead", "models": ["claude"]}],
        manifest={"files": []},
        target_dir_override=str(workspace),
    )

    assert sync._matching_identity_presence({"name": "Margaret", "role": "Team Lead"}, str(workspace))[1] == "unresolved"
    assert (rules / "Directives.md").read_text() == current_pointer


def test_missing_agent_verify_has_json_error_and_exit_two(capsys):
    exit_code = sync.run_verify({}, [{"name": "Margaret"}], {"files": []}, "Missing", as_json=True)
    payload = json.loads(capsys.readouterr().out)

    assert exit_code == 2
    assert payload == {
        "error": "ERROR: Agent 'Missing' not found in agents.json",
        "exit": 2,
    }


def test_dedicated_entrypoint_imports_resolve_and_shared_root_is_external(tmp_path, monkeypatch, capsys):
    project = tmp_path / "Project"
    dedicated = project / "Team" / "TestAgent"
    shared = tmp_path / "SharedProject"
    dedicated.mkdir(parents=True)
    shared.mkdir()

    masters = tmp_path / "masters"
    entry_master = masters / "per-model" / "codex" / "AGENTS.md.tmpl"
    entry_master.parent.mkdir(parents=True)
    entry_master.write_text("@./.claude/rules/Directives.md\n")
    monkeypatch.setattr(sync, "MASTERS_DIR", masters)
    monkeypatch.setattr(sync, "apply_adapter_postprocess", lambda _entry, rendered, _agent=None: rendered)
    monkeypatch.setattr(sync, "_deploy_skills_silent", lambda *args, **kwargs: None)
    monkeypatch.setattr(sync, "discover_agent_presences", lambda _name: [{
        "workingDirectory": str(shared),
        "agentType": "codex",
        "roleId": "a3f1d8e2-6c74-4b9f-8e5a-2d7c1b4f9e36",
        "channelName": "Shared",
    }])

    teams = {"test": {"projectDir": str(project), "teamDir": str(project / "Team")}}
    agent = {
        "name": "TestAgent",
        "teamId": "test",
        "projectDir": str(project),
        "teamDir": str(dedicated),
        "agentDir": str(dedicated),
        "agentType": "codex",
        "models": ["codex"],
        "role": "Architect",
    }
    manifest = {"files": [{
        "id": "test-entrypoint",
        "category": "per-model",
        "master": "per-model/codex/AGENTS.md.tmpl",
        "targets": ["{agent_dir}/AGENTS.md"],
        "condition": "agentType:codex",
        "overwrite": True,
    }]}

    sync.run_sync(teams, [agent], manifest, agent_filter="TestAgent")
    output = capsys.readouterr().out

    assert (dedicated / "AGENTS.md").is_file()
    imported = dedicated / ".claude" / "rules" / "Directives.md"
    assert imported.is_file()
    assert not (shared / "AGENTS.md").exists()
    assert "externally managed shared root" in output

    verify_exit = sync.run_verify(teams, [agent], manifest, agent_filter="TestAgent", as_json=True)
    verify_payload = json.loads(capsys.readouterr().out)
    assert verify_exit == 0
    files = verify_payload["agents"][0]["files"]
    assert not any("unresolved import" in row.get("reason", "") for row in files)
    assert any(
        row["entryId"] == "shared-root-presence"
        and row["status"] == "skipped"
        and "externally managed" in row["reason"]
        for row in files
    )


def test_entrypoint_verifier_flags_unmanifested_dangling_import(tmp_path):
    entrypoint = tmp_path / "AGENTS.md"
    entrypoint.write_text("@./.claude/rules/not-manifested.md\n")

    failures = sync.verify_resolved_entrypoint_imports([{
        "entryId": "agents-md",
        "source": "per-model",
        "masterPath": "master/AGENTS.md.tmpl",
        "path": str(entrypoint),
        "status": "synced",
    }])

    assert len(failures) == 1
    assert failures[0]["status"] == "missing"
    assert failures[0]["path"].endswith("/.claude/rules/not-manifested.md")
    assert "unresolved import" in failures[0]["reason"]


def test_manifest_has_one_target_per_resolved_agent_path_and_manages_thin_claude_entrypoint():
    manifest = json.loads((ROOT / "data/scaffolding/manifest.json").read_text())

    for entry in manifest["files"]:
        assert len(entry["targets"]) == len(set(entry["targets"]))
        assert not any("{team_dir}" in target for target in entry["targets"])

    claude_entry = next(
        entry for entry in manifest["files"] if entry["id"] == "claude-project-entrypoint"
    )
    assert claude_entry["targets"] == ["{agent_dir}/CLAUDE.md"]
    assert claude_entry["category"] == "per-agent"
    assert claude_entry["overwrite"] is True


def test_spawn_uses_canonical_sync_without_role_or_handwritten_scaffold_duplication():
    source = (ROOT / "app/api/collab/pty/_handlers/message-inject.ts").read_text()

    assert "FALLING BACK to hand-written scaffold" not in source
    assert "DIRECTIVES_TEMPLATE_DIR" not in source
    assert "parseRoleFrontmatter" not in source
    assert "const workspaceMd = `# Workspace" not in source
    assert "The canonical role is already loaded through the local" in source
    assert "Canonical scaffolding could not be prepared" in source
    assert "[patchHooksPy, '--workspace', agentWorkDir, '--agent', agentName]" in source
    assert "Re-rostering a dormant workspace" in source
    assert "'--agent-type', scaffoldRuntime" in source
    assert "validateHarnessScaffold(agentWorkDir, scaffoldRuntime)" in source


def test_gemini_bootstrap_does_not_teach_a_second_channel_send():
    source = (ROOT / "scripts/collab-gemini.py").read_text()
    bootstrap = source[source.index("MESSAGE DELIVERY:"):source.index("Messages from others:")]

    assert "posts the final response automatically" in bootstrap
    assert "Do not call curl, collab_helper.py" in bootstrap
    assert "HOW TO POST MESSAGES" not in bootstrap


def test_lifecycle_generators_share_one_canonical_policy_module():
    canonical = (ROOT / "scripts/agent_lifecycle_hooks.py").read_text()
    rollout = (ROOT / "scripts/rollout-agent-dirs.py").read_text()
    patcher = (ROOT / "scripts/patch-hooks.py").read_text()
    hook_rollout = (ROOT / "scripts/hooks/rollout-hooks.py").read_text()

    assert "def build_hooks" in canonical
    assert "pre-compact-write owns flush-before-atomic-snapshot ordering" in canonical
    assert "write-session-end.sh" in canonical  # migration filter, never a configured hook
    for consumer in (rollout, patcher, hook_rollout):
        assert "agent_lifecycle_hooks import" in consumer
        assert "DESIGN_GATE_MATCHER =" not in consumer


def test_devflow_project_entrypoint_is_a_small_router_not_an_operating_manual():
    entrypoint = (ROOT / "CLAUDE.md").read_text()

    assert len(entrypoint.splitlines()) <= 35
    assert ".claude/rules/DEVFLOW.md" in entrypoint
    assert ".claude/rules/approval-protocol.md" in entrypoint
    assert "sprint-plan --create" not in entrypoint
    assert "pm2 restart devflow" not in entrypoint
    assert "Create tokens" not in entrypoint


def test_live_shared_project_roots_have_no_generated_agent_scaffold():
    """Shared roots may contain project policy, never one agent's identity layer."""
    channels_path = ROOT / ".AppData" / "collab-channels.json"
    if not channels_path.exists():
        pytest.skip("live channel registry is not present in this environment")

    payload = json.loads(channels_path.read_text())
    channels = payload if isinstance(payload, list) else payload.get("channels", [])
    shared_roots = set()
    for channel in channels:
        for agent in (channel.get("roster") or {}).get("agents", []):
            working = agent.get("workingDirectory")
            effective = agent.get("effectiveWorkingDirectory")
            if not working:
                continue
            working_path = Path(working).resolve()
            if (
                (effective and working_path != Path(effective).resolve())
                or "/Team/" not in str(working_path)
            ):
                shared_roots.add(working_path)

    stale_markers = (
        "Agent Context (Auto-generated)",
        "Every new session, before doing anything else:",
        "CLAUDE_PID=$PPID python3 " + str(ROOT) + "/scripts/collab_helper.py",
        "The Five Laws",
        "# Dave's Personality",
    )
    stale_paths = []
    for root in shared_roots:
        candidates = [
            root / name
            for name in (
                "AGENTS.md",
                "GEMINI.md",
                "GROK.md",
                "alignment-antigravity.md",
                "alignment-codex.md",
                "alignment-grok.md",
            )
        ]
        rules_dir = root / ".claude" / "rules"
        if rules_dir.is_dir():
            candidates.extend(rules_dir.glob("*.md"))
        for path in candidates:
            if path.is_file() and any(
                marker in path.read_text(errors="replace") for marker in stale_markers
            ):
                stale_paths.append(str(path))

    assert stale_paths == []


def _memory_seed_context(tmp_path, monkeypatch):
    home = tmp_path / "home"
    workspace = home / "New Project" / "Team" / "McRae"
    monkeypatch.setitem(sync._MACHINE_CONFIG, "homeDir", str(home))
    agent = {"name": "McRae", "teamId": "test", "teamDir": str(workspace),
             "agentDir": str(workspace), "projectDir": str(workspace.parent.parent),
             "agentType": "codex"}
    teams = {"test": {"projectDir": str(workspace.parent.parent), "teamDir": str(workspace.parent)}}
    entries = {e["id"]: e for e in json.loads((ROOT / "data/scaffolding/manifest.json").read_text())["files"]}
    return workspace, agent, teams, entries


def test_fresh_spawn_manifest_seeds_memory_and_empty_ownership_without_rollout(tmp_path, monkeypatch):
    workspace, agent, teams, entries = _memory_seed_context(tmp_path, monkeypatch)
    memory = sync.resolve_target("{agent_memory_path}", agent, teams)
    ownership = workspace / "SystemOwnership.json"
    for entry_id in ["agent-memory-md", "agent-system-ownership"]:
        rows = sync.sync_file_entry(teams, entries[entry_id], agent, dry_run=True)
        assert rows[0]["action"] == "CREATE"
    assert not memory.exists() and not ownership.exists()
    for entry_id in ["agent-memory-md", "agent-system-ownership"]:
        sync.sync_file_entry(teams, entries[entry_id], agent)
    assert memory.read_text() == (ROOT / "data/scaffolding/masters/per-agent/MEMORY.md").read_text()
    assert json.loads(ownership.read_text()) == {"systems": []}
    assert str(memory) in sync.render_template(
        (ROOT / "data/scaffolding/masters/per-agent/startup.md.tmpl").read_text(),
        sync.build_vars(agent, teams),
    )
    memory.write_text("# Durable lesson\nPreserve this learned fact.\n")
    ownership.write_text('{"systems":[{"name":"Orders"}]}\n')
    for entry_id in ["agent-memory-md", "agent-system-ownership"]:
        rows = sync.sync_file_entry(teams, entries[entry_id], agent)
        assert rows[0]["action"] == "SKIP"
    assert "Preserve this learned fact" in memory.read_text()
    assert json.loads(ownership.read_text())["systems"][0]["name"] == "Orders"


def test_memory_seed_preserves_local_fallback_without_shadowing_it(tmp_path, monkeypatch):
    workspace, agent, teams, entries = _memory_seed_context(tmp_path, monkeypatch)
    canonical = sync.resolve_target("{agent_memory_path}", agent, teams)
    workspace.mkdir(parents=True)
    local = workspace / "MEMORY.md"
    local.write_text("# Existing local knowledge\n")
    assert sync.resolve_target("{agent_memory_path}", agent, teams) == local
    sync.sync_file_entry(teams, entries["agent-memory-md"], agent)
    assert not canonical.exists()
    assert local.read_text() == "# Existing local knowledge\n"
    canonical.parent.mkdir(parents=True)
    canonical.write_text("# Existing canonical knowledge\n")
    assert sync.resolve_target("{agent_memory_path}", agent, teams) == canonical
    sync.sync_file_entry(teams, entries["agent-memory-md"], agent)
    assert canonical.read_text() == "# Existing canonical knowledge\n"


def test_memory_seed_is_per_presence_and_not_global_dave_only(tmp_path, monkeypatch):
    workspace, agent, teams, entries = _memory_seed_context(tmp_path, monkeypatch)
    first = sync.resolve_target("{agent_memory_path}", agent, teams)
    second_agent = sync._agent_with_dir_override(agent, str(tmp_path / "Other" / "Team" / "McRae"), "claude")
    second = sync.resolve_target("{agent_memory_path}", second_agent, teams)
    assert first != second
    for candidate in [agent, second_agent]:
        for entry_id in ["agent-memory-md", "agent-system-ownership"]:
            assert sync.agent_matches_condition(candidate, entries[entry_id]["condition"])
            assert sync.sync_file_entry(teams, entries[entry_id], candidate)[0]["action"] == "CREATE"
    assert first.exists() and second.exists()
