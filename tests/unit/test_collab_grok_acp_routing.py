#!/usr/bin/env python3
"""Regression tests for Grok ACP inbound identity and addressed replies."""

import importlib.util
from pathlib import Path
import sys
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "collab-grok-acp.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("collab_grok_acp_routing_test", SCRIPT)
assert SPEC and SPEC.loader
grok_acp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(grok_acp)


class _FakeAcp:
    def __init__(self, response: str = "done"):
        self.response = response
        self.prompts: list[str] = []

    def send_prompt(self, prompt: str) -> str:
        self.prompts.append(prompt)
        return self.response


def _wrapper():
    wrapper = grok_acp.CollabGrokACPWrapper.__new__(grok_acp.CollabGrokACPWrapper)
    wrapper.participant_name = "Data"
    wrapper.pid = 12345
    wrapper.cwd = "/tmp"
    wrapper._last_processed_message_id = ""
    wrapper.acp = _FakeAcp()
    wrapper.conversation_history = []
    return wrapper


def test_post_response_uses_explicit_recipient_and_stdin():
    wrapper = _wrapper()

    with patch.object(grok_acp.subprocess, "run") as run:
        run.return_value.returncode = 0
        run.return_value.stderr = ""
        wrapper._post_response("result with `markdown` and $shell", "Pete")

    args, kwargs = run.call_args
    assert args[0] == [
        "python3",
        str(Path(grok_acp.DEVFLOW_HOME) / "scripts" / "collab_helper.py"),
        "--to",
        "Pete",
        "--stdin",
    ]
    assert kwargs["input"] == "result with `markdown` and $shell"


def test_process_message_reads_live_from_shape_and_routes_reply_to_sender():
    wrapper = _wrapper()
    posted: list[tuple[str, str]] = []
    wrapper._post_response = lambda text, recipient: posted.append((text, recipient))
    message = {
        "id": "message-1",
        "from": {"id": "human-1", "name": "Pete", "type": "user"},
        "content": "@Data check the account plan",
    }

    with patch.object(grok_acp, "safe_append_stream_message"):
        wrapper._process_message(message)

    assert wrapper.acp.prompts == [
        "[Channel message from Pete]: @Data check the account plan"
    ]
    assert posted == [("done", "Pete")]
    assert wrapper._last_processed_message_id == "message-1"


def test_blank_recipient_fails_closed_without_posting():
    wrapper = _wrapper()

    with patch.object(grok_acp.subprocess, "run") as run:
        wrapper._post_response("would otherwise broadcast", "")

    run.assert_not_called()
