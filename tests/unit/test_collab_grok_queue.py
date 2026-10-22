#!/usr/bin/env python3
"""Regression tests for Grok's in-process delivery backlog."""

import importlib.util
from pathlib import Path
import queue
import sys
import threading


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "collab-grok.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("collab_grok_queue_test", SCRIPT)
assert SPEC and SPEC.loader
grok = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(grok)


def _wrapper():
    wrapper = grok.CollabGrokWrapper.__new__(grok.CollabGrokWrapper)
    wrapper.participant_id = "grok-participant"
    wrapper.injected_message_ids = set()
    wrapper.sse_message_queue = queue.Queue()
    wrapper.processing_lock = threading.Lock()
    wrapper.last_poll_time = "2026-08-31T10:00:00.000Z"
    return wrapper


def test_catchup_advances_cursor_and_queues_only_visible_messages():
    wrapper = _wrapper()
    messages = [
        {
            "id": "target-1",
            "timestamp": "2026-08-31T10:00:01.000Z",
            "from": {"id": "human"},
            "recipients": ["grok-participant"],
        },
        {
            "id": "other-agent",
            "timestamp": "2026-08-31T10:00:02.000Z",
            "from": {"id": "human"},
            "recipients": ["someone-else"],
        },
        {
            "id": "target-2",
            "timestamp": "2026-08-31T10:00:03.000Z",
            "from": {"id": "human"},
            "recipients": ["grok-participant"],
        },
    ]

    assert wrapper._queue_catchup_messages(messages) == 2
    assert wrapper.last_poll_time == "2026-08-31T10:00:03.000Z"
    assert [wrapper.sse_message_queue.get_nowait()["id"] for _ in range(2)] == [
        "target-1",
        "target-2",
    ]


def test_locked_worker_keeps_backlog_then_processes_every_message_in_order():
    wrapper = _wrapper()
    processed = []
    wrapper._process_message = processed.append
    for index in range(3):
        wrapper.sse_message_queue.put({"id": f"message-{index}"})

    wrapper.processing_lock.acquire()
    try:
        assert wrapper._process_next_queued_message() is False
        assert wrapper.sse_message_queue.qsize() == 3
    finally:
        wrapper.processing_lock.release()

    assert wrapper._process_next_queued_message() is True
    assert wrapper._process_next_queued_message() is True
    assert wrapper._process_next_queued_message() is True
    assert wrapper._process_next_queued_message() is False
    assert [message["id"] for message in processed] == [
        "message-0",
        "message-1",
        "message-2",
    ]


def test_direct_api_wrapper_addresses_reply_to_inbound_sender(monkeypatch):
    wrapper = _wrapper()
    wrapper.participant_name = "Data"
    wrapper.processing_start_time = 0.0
    wrapper._should_process_message = lambda _content, _sender_type: True
    wrapper._broadcast_activity = lambda _status: None
    wrapper._call_xai = lambda _sender, _content: "account plan ready"
    posted = []
    wrapper._post_message = lambda content, mentions=None: posted.append((content, mentions))
    monkeypatch.setattr(grok, "safe_append_stream_message", lambda *_args, **_kwargs: None)

    wrapper._process_message({
        "id": "message-1",
        "from": {"id": "human-1", "name": "Owner", "type": "user"},
        "content": "@Data plan access",
    })

    assert posted == [("account plan ready", ["human-1"])]


def test_call_xai_continues_short_progress_only_result(monkeypatch):
    wrapper = _wrapper()
    wrapper.system_prompt = "system"
    wrapper.conversation_history = []
    wrapper.model = "grok-4.5"
    wrapper.client = object()
    wrapper._accumulate_usage = lambda _usage: None
    replies = iter([
        "Replaying the byte-identical login, then re-checking status.",
        "Canary complete: replay ran no child and attempts remained one.",
    ])
    calls = []

    def fake_call(_client, _model, messages, usage_accumulator=None):
        calls.append([dict(message) for message in messages])
        return next(replies)

    monkeypatch.setattr(grok, "_TOOLS_AVAILABLE", True)
    monkeypatch.setattr(grok, "call_xai_with_tools", fake_call)
    monkeypatch.setattr(
        grok,
        "is_progress_only_response",
        lambda value: value.startswith("Replaying"),
    )

    reply = wrapper._call_xai("Builder", "finish the canary")

    assert reply.startswith("Canary complete")
    assert len(calls) == 2
    assert calls[1][-2]["role"] == "assistant"
    assert calls[1][-2]["content"].startswith("Replaying")
    assert calls[1][-1]["role"] == "user"
    assert "Finish every remaining" in calls[1][-1]["content"]


def test_call_xai_does_not_continue_terminal_blocker(monkeypatch):
    wrapper = _wrapper()
    wrapper.system_prompt = "system"
    wrapper.conversation_history = []
    wrapper.model = "grok-4.5"
    wrapper.client = object()
    wrapper._accumulate_usage = lambda _usage: None
    calls = []

    def fake_call(_client, _model, messages, usage_accumulator=None):
        calls.append(messages)
        return "Blocked: Owner must approve Windows Hello."

    monkeypatch.setattr(grok, "_TOOLS_AVAILABLE", True)
    monkeypatch.setattr(grok, "call_xai_with_tools", fake_call)
    monkeypatch.setattr(grok, "is_progress_only_response", lambda _value: False)

    assert wrapper._call_xai("Builder", "open the vault").startswith("Blocked:")
    assert len(calls) == 1
