"""Regression coverage for Antigravity model-profile routing.

AgentChat stores the selected Antigravity model on the roster entry.  The
polling wrapper must pass that exact native agy model profile into every
``agy --print`` invocation; otherwise the picker looks functional while the
runtime silently falls back to its default model.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest


def _load_wrapper() -> types.ModuleType:
    scripts_dir = Path(__file__).resolve().parents[2] / "scripts"
    path = scripts_dir / "collab-antigravity.py"
    sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location("collab_antigravity", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def antigravity():
    return _load_wrapper()


@pytest.mark.parametrize(
    "profile",
    (
        "gemini-3.6-flash-high",
        "gemini-3.6-flash-medium",
        "gemini-3.6-flash-low",
    ),
)
def test_print_turn_passes_selected_model_profile(antigravity, monkeypatch, profile):
    wrapper = object.__new__(antigravity.CollabAntigravityWrapper)
    wrapper.agent_dir = "/tmp"
    wrapper.system_prefix = ""
    wrapper.model = profile
    wrapper.effort = None
    recorded: list[str] = []
    wrapper._record_conversation_id = recorded.append

    captured: dict[str, object] = {}

    def fake_run(args, **kwargs):
        captured["args"] = args
        return subprocess.CompletedProcess(
            args,
            0,
            stdout=json.dumps(
                {
                    "conversation_id": "11111111-2222-3333-4444-555555555555",
                    "status": "SUCCESS",
                    "response": "CANARY\n",
                }
            ),
            stderr="",
        )

    monkeypatch.setattr(antigravity.subprocess, "run", fake_run)
    monkeypatch.setattr(
        antigravity,
        "ensure_antigravity_design_gate_hook",
        lambda _agent_dir: None,
    )

    code, stdout, stderr = wrapper._run_agy("canary")

    assert (code, stdout, stderr) == (0, "CANARY", "")
    args = captured["args"]
    assert args[args.index("--model") + 1] == profile
    assert args[args.index("--output-format") + 1] == "json"
    assert "--conversation" not in args
    assert recorded == ["11111111-2222-3333-4444-555555555555"]


@pytest.mark.parametrize("effort", ("low", "medium", "high"))
def test_print_turn_passes_supported_effort(antigravity, monkeypatch, effort):
    wrapper = object.__new__(antigravity.CollabAntigravityWrapper)
    wrapper.agent_dir = "/tmp"
    wrapper.system_prefix = ""
    wrapper.model = "gemini-3.6-flash-medium"
    wrapper.effort = effort
    wrapper._record_conversation_id = lambda _conversation_id: None

    captured: dict[str, object] = {}

    def fake_run(args, **kwargs):
        captured["args"] = args
        return subprocess.CompletedProcess(
            args,
            0,
            stdout=json.dumps(
                {
                    "conversation_id": "11111111-2222-3333-4444-555555555555",
                    "status": "SUCCESS",
                    "response": "CANARY",
                }
            ),
            stderr="",
        )

    monkeypatch.setattr(antigravity.subprocess, "run", fake_run)
    monkeypatch.setattr(
        antigravity,
        "ensure_antigravity_design_gate_hook",
        lambda _agent_dir: None,
    )

    wrapper._run_agy("canary")

    args = captured["args"]
    assert args[args.index("--effort") + 1] == effort


def test_print_turn_surfaces_malformed_json_as_failure(antigravity, monkeypatch):
    wrapper = object.__new__(antigravity.CollabAntigravityWrapper)
    wrapper.agent_dir = "/tmp"
    wrapper.system_prefix = ""
    wrapper.model = "gemini-3.5-flash"
    wrapper.effort = "high"
    wrapper._record_conversation_id = lambda _conversation_id: None

    monkeypatch.setattr(
        antigravity.subprocess,
        "run",
        lambda args, **kwargs: subprocess.CompletedProcess(
            args, 0, stdout="not-json", stderr=""
        ),
    )
    monkeypatch.setattr(
        antigravity,
        "ensure_antigravity_design_gate_hook",
        lambda _agent_dir: None,
    )

    code, stdout, stderr = wrapper._run_agy("canary")

    assert code == 1
    assert stdout == ""
    assert "invalid JSON" in stderr


def test_join_registers_server_correlated_launcher_identity(antigravity, monkeypatch, tmp_path):
    wrapper = object.__new__(antigravity.CollabAntigravityWrapper)
    wrapper.channel_id = "channel-1"
    wrapper.agent_name = "Architect"
    wrapper.agent_dir = str(tmp_path)
    wrapper.participant_id = None
    wrapper.joined = False
    captured = {}

    def fake_api_post(path, body):
        captured["path"] = path
        captured["body"] = body
        return {"success": True, "participantId": "roster-architect"}

    monkeypatch.setattr(antigravity, "api_post", fake_api_post)
    monkeypatch.setattr(antigravity, "pane_log", lambda _message: None)

    assert wrapper.join_channel()
    participant = captured["body"]["participant"]
    assert participant["pid"] == os.getpid()
    assert participant["projectPath"] == str(tmp_path)
    assert wrapper.participant_id == "roster-architect"
