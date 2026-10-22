#!/usr/bin/env python3
"""Regression checks for the startup-style collaboration contract."""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


# The masters name the owner, architect and team lead through {{PLACEHOLDERS}} that sync.py fills in per instance.
# These stand-ins let the wording be checked without tying the test to any real person.
PEOPLE = {
    "{{OWNER_NAME}}": "Pat",
    "{{ARCHITECT_NAME}}": "Quinn",
    "{{LEAD_NAME}}": "Robin",
    "{{ARCHITECT_LABEL}}": "Quinn (Architect)",
    "{{LEAD_LABEL}}": "Robin (Team Lead)",
}


def _read_rendered(relative_path: str) -> str:
    text = _read(relative_path)
    for token, name in PEOPLE.items():
        text = text.replace(token, name)
    return text


def test_startup_keeps_memory_and_expertise_in_required_context():
    startup = _read("data/scaffolding/masters/per-agent/startup.md.tmpl")

    assert "handoff.md" in startup
    assert "current-date tail" in startup
    assert "persistent" in startup
    assert "`{{AGENT_MEMORY_PATH}}`" in startup
    assert "`{{AGENT_DIR}}/Expertise.md`" in startup
    assert "required operational context" in startup
    assert "Read older logs only when the active task needs" in startup


def test_auto_loaded_engineering_rules_are_small_skill_routers():
    routes = {
        "task-discipline.md": "/task-discipline",
        "verification-before-completion.md": "/methodology",
        "tdd-methodology.md": "/methodology",
        "systematic-debugging.md": "/methodology",
        "code-review-process.md": "/code-review",
        "computer-use.md": "/browser",
        "frontend-aesthetics-block.md": "/frontend-aesthetics",
    }

    for filename, skill in routes.items():
        content = _read(f"data/scaffolding/masters/global/{filename}")
        assert skill in content
        assert len(content.splitlines()) <= 8


def test_shared_agreement_is_compact_and_keeps_destructive_authority_boundary():
    agreement = _read("data/scaffolding/masters/global/base-role-boilerplate.md")

    assert len(agreement.split()) <= 550
    assert "Roles define expertise and ownership" in agreement
    assert "approval-protocol.md" in agreement
    assert "`MEMORY.md` and `Expertise.md`" in agreement
    assert "required operating context" in agreement or "required operational context" in agreement
    assert "Own the whole assigned outcome" in agreement
    assert "continue every\n  independent in-scope part" in agreement
    assert "Operational clarity outranks character voice" in agreement
    assert "Start automation from the event that creates the work" in agreement
    assert "Poll on a\n  timer only when no reliable trigger exists" in agreement


def test_direct_assignment_authorizes_reversible_operations_without_duplicate_gate():
    protocol = _read("data/scaffolding/masters/global/approval-protocol.md")
    skill = _read("data/skills/approval-protocol/SKILL.md")

    for content in (protocol, skill):
        normalized = " ".join(content.split())
        assert "same task twice" in normalized
        assert "service restarts" in normalized
        assert "cron/config" in normalized
        assert "External and Client Live Systems" in normalized
        assert "Stopping or restarting production services during working hours" not in normalized
        assert "Disabling cron jobs or systemd units" not in normalized
        assert "Modifying scaffolding masters" not in normalized

    for content in (protocol, skill):
        normalized = " ".join(content.split())
        assert "`supabase db reset` must never be run against valued" in normalized
        assert "ordinary task authority does not waive this prohibition" in normalized


def test_team_lead_tasks_are_outcome_contracts_not_gate_chains():
    role = _read("data/roles/team-lead.md")

    assert "Write outcome contracts, not procedures" in role
    assert "Outcome" in role
    assert "Done when" in role
    assert "newer stop" in role
    assert "supersedes older queued instructions" in role
    assert len(role.splitlines()) <= 60
    assert "Keep an open-work loop" in role
    assert "A silent or partial stop is not a sprint outcome" in " ".join(role.split())


def test_welcome_does_not_require_acknowledgement_or_prework_permission():
    welcome = _read("docs/WELCOME.md")

    assert "No acknowledgement post is required" in welcome
    assert "A direct mention does not by itself require a channel reply" in welcome
    assert "MUST respond" not in welcome
    assert "Acknowledge with" not in welcome
    assert "before writing any code" not in welcome


def test_runtime_join_prompts_match_current_collaboration_contract():
    lifecycle = _read("app/api/collab/_handlers/lifecycle.ts")
    gemini_bootstrap = _read("app/api/collab/pty/_handlers/message-inject.ts")

    for source in (lifecycle, gemini_bootstrap):
        assert "does not require an acknowledgement" in source or "acknowledgements are unnecessary" in source
        assert "supersedes older instructions" in source

    assert "When @mentioned, respond immediately" not in lifecycle
    assert "Standing by for assignment" not in gemini_bootstrap
    assert "Acknowledge with a brief message" not in gemini_bootstrap


def test_devflow_orientation_routes_to_owners_without_copying_procedures():
    context_map = _read("data/scaffolding/masters/global/DEVFLOW.md")

    for required in (
        "platform/agentchat-comms-system.md",
        "platform/devflow-doc-skill.md",
        "data/scaffolding/manifest.json",
        "/scaffolding-sync",
        "/devflow-ops",
        "channel-communication.md",
        "/task-discipline",
        "discovery map, not an operating manual",
    ):
        assert required in context_map

    for duplicated_procedure in (
        "npm run build",
        "next build",
        "outlook-graph-webhook",
        "polling cron jobs",
        "A blocked item does not stop",
    ):
        assert duplicated_procedure not in context_map


def test_handoff_has_four_field_base_and_optional_resume_fields_live_in_guidance():
    handoff = _read("data/scaffolding/masters/per-agent/handoff.md")
    memory_guidance = _read("data/skills/memory-discipline/SKILL.md")

    assert handoff.splitlines() == [
        "STATUS: No prior session.",
        "LAST_ACTED: none",
        "PENDING: none",
        "DO_NOT_REPEAT: none",
    ]
    for optional in ("BLOCKERS", "RETURN_POINT", "REMAINING_DONE_WHEN"):
        assert optional not in handoff
        assert optional in memory_guidance
    assert "omit empty optional fields" in memory_guidance


def test_skill_index_uses_generated_discovery_instead_of_static_inventory():
    index = _read("data/scaffolding/masters/global/skill-index.md")
    matrix = json.loads(_read("data/skills/matrix.json"))
    on_disk = {
        path.parent.name
        for path in (ROOT / "data/skills").glob("*/SKILL.md")
    }

    assert "data/skills/matrix.json" in index
    assert "files themselves are authoritative" in index
    assert "| Skill | Trigger |" not in index
    assert matrix["skillCount"] == len(on_disk)
    assert {item["name"] for item in matrix["skills"]} == on_disk


def test_channel_questions_are_an_internal_lens_not_a_message_formula():
    channel = _read_rendered("data/scaffolding/masters/global/channel-communication.md")

    assert "internal editing lens, not a mandatory formula" in channel
    assert "Do not mechanically answer all three" in channel
    assert "Start every substantive update" not in channel


def test_channel_mentions_require_attention_without_confirmation_posts():
    channel = " ".join(_read_rendered("data/scaffolding/masters/global/channel-communication.md").split())

    assert "A mention requires attention, not an acknowledgement" in channel
    assert "Carry out clear assignments without a confirmation post" in channel
    assert "Direct human questions and explicit human requests for status or confirmation still deserve an answer" in channel
    assert "Update task records silently" in channel


def test_material_decisions_for_the_owner_require_a_question_card():
    channel = _read_rendered("data/scaffolding/masters/global/channel-communication.md")

    normalized = " ".join(channel.split())
    assert "Questions for Pat" in channel
    assert "priority, approval, or live-action options" in normalized
    assert "do not ask in ordinary chat" in normalized
    assert "`/channel-rules` and post a clickable Question Card" in normalized
    assert "it does not replace the card" in normalized
    assert "reconfirm an assignment Pat already made clearly" in normalized


def test_behavioral_anchor_has_selective_journaling_without_flush_claim():
    anchor = json.loads(_read("data/scaffolding/behavioral-anchor.json"))
    journal_rule = next(rule["text"] for rule in anchor["rules"] if rule["id"] == 5)

    assert "unrecorded state would materially help" in journal_rule
    assert "Do not record routine activity" in journal_rule
    assert "create a task or journal record solely" in journal_rule
    assert "runtime-owned" in journal_rule
    assert "meaningful outcome boundary" not in journal_rule
    assert "flushes automatically" not in journal_rule


def test_rag_guidance_is_presence_local_harness_neutral_and_has_no_stale_count():
    manifest = json.loads(_read("data/scaffolding/manifest.json"))
    entry = next(item for item in manifest["files"] if item["id"] == "rag-memory-rules")
    rag = _read("data/scaffolding/masters/global/rag-memory.md")
    adapters = _read("data/scaffolding/adapters.py")

    assert entry["targets"] == ["{agent_dir}/.claude/rules/rag-memory.md"]
    assert "{team_dir}/.claude/rules/rag-memory.md" not in entry["targets"]
    assert "@./.claude/rules/rag-memory.md" in adapters
    assert "Other harnesses may expose different names" in rag
    assert "14,500" not in rag
    assert "volatile vector counts" in rag


def test_runtime_overlays_are_harness_conditioned_not_provider_conditioned():
    manifest = json.loads(_read("data/scaffolding/manifest.json"))
    runtime_ids = {
        "alignment-claude",
        "alignment-gemini",
        "alignment-grok",
        "gemini-md",
        "grok-md",
        "alignment-codex",
        "agents-md",
        "codex-config-toml",
        "alignment-antigravity",
        "antigravity-gemini-md",
    }
    runtime_entries = [entry for entry in manifest["files"] if entry["id"] in runtime_ids]

    assert len(runtime_entries) == len(runtime_ids)
    assert all(entry["condition"].startswith("agentType:") for entry in runtime_entries)


def test_outlook_master_uses_shared_http_service():
    outlook = json.loads(_read("data/scaffolding/masters/global/mcp-outlook.json"))
    assert outlook["mcpServers"]["outlook"] == {
        "type": "http",
        "url": "http://localhost:7003/mcp",
    }


def test_grok_wrappers_load_the_manifested_alignment_on_the_effective_path():
    for wrapper in ("scripts/collab-grok.py", "scripts/collab-grok-acp.py"):
        source = _read(wrapper)
        assert 'os.path.join(cwd, "alignment-grok.md")' in source


def test_every_canonical_role_is_registered():
    registry = json.loads(_read("data/roles/roles.json"))
    registered = {role["slug"] for role in registry["roles"]}
    role_files = {path.stem for path in (ROOT / "data/roles").glob("*.md")}

    assert role_files <= registered


def test_orphan_personalities_are_voice_only_and_do_not_require_fixed_workflows():
    personality_files = ("Mason", "Erin", "Quill", "Hermione", "Rook")
    forbidden = (
        "complaints.json",
        "FILE-MATRIX.md",
        "Magistrates",
        "Tribunal",
        "Stage 1",
        "dyslexia",
        "duty solicitor",
        "defence-solicitor",
        "pre-mortem",
        "prosecution",
        "lawyer",
        "legal",
        "client",
        "PDF",
    )

    for name in personality_files:
        content = _read(f"data/roles/personalities/{name}.md")
        lowered = content.lower()
        for phrase in forbidden:
            assert phrase.lower() not in lowered
        assert "In channel and in writing" in content

    for name in ("Heimdall", "Torres"):
        content = _read(f"data/roles/personalities/{name}.md").lower()
        assert "break rules" not in content
        assert "defy authority" not in content
        assert "doesn't wait for permission" not in content


def test_quiet_execution_contract_covers_planning_ownership_and_runtime_prompts():
    channel = " ".join(_read_rendered("data/scaffolding/masters/global/channel-communication.md").split())
    assert "Finalise the plan, then create the sprint" in channel
    assert "Ordinary defects, failed tests, review corrections" in channel
    assert "Mark ordinary completion in the task record silently" in channel
    assert "Robin monitors the board instead of asking agents for status" in channel
    # Each runtime builds the prompt from the configured architect name in its own syntax.
    for path, architect in (
        ("scripts/collab-codex.py", "{ARCHITECT_NAME}"),
        ("scripts/collab-gemini.py", "{ARCHITECT_NAME}"),
        ("lib/collab-utils.ts", "${ARCHITECT}"),
    ):
        source = _read(path)
        assert "assign sprint tasks, then execute quietly" in source
        assert f"hard blockers to {architect}" in source
        assert "milestone, or" not in source
    primer = _read("lib/collab-utils.ts")
    assert "acknowledge others' contributions" not in primer
    assert "Introduce yourself briefly" not in primer


def test_journey_scope_is_shared_and_not_duplicated_in_runtime_overlay():
    agreement = " ".join(_read("data/scaffolding/masters/global/base-role-boilerplate.md").split())
    overlay = _read("data/scaffolding/masters/per-model/codex/alignment-codex.md")
    for rule in ("interaction and approval counts", "new information or authority",
                 "concrete code-path evidence", "temporary commissioning",
                 "complete user journey", "without a fixed test quota"):
        assert rule in agreement
    assert "base-role-boilerplate.md" in overlay
    assert "Reserve extra gates" not in overlay


def test_planning_and_review_preserve_journey_and_existing_authority():
    architect = _read("data/roles/architect.md")
    lead = _read("data/roles/team-lead.md")
    review = _read("data/skills/code-review/SKILL.md")
    task = _read("data/skills/task-discipline/SKILL.md")
    assert "at the top of `Plan.md`" in architect
    assert "approval count" in lead
    assert "authority is missing" in lead
    assert "concrete code-path evidence" in review
    assert "one focused correction round" not in review
    assert "meaningful milestone" not in task
    for role in ("frontend-dev", "designer"):
        content = _read(f"data/roles/{role}.md")
        assert "user requested concept approval" in content
        assert 'including "your call"' in content
        assert 'even when the brief said "your call"' not in content
