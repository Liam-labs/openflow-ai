"""
Tests for JSONL transcript state reader.

P1-T1: _check_jsonl_state() + unit tests
P1-T2: _resolve_transcript_path() + tests
Sprint 39 T1.1: last_tool_name extraction from tool_use content blocks
"""
import json
import os
import tempfile
import pytest

# Import the standalone functions (not the class methods — testable without the wrapper)
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'scripts'))
from jsonl_state_reader import check_jsonl_state, resolve_transcript_path, JsonlState, tool_to_label, TOOL_LABELS, verify_message_ingested


# ─── Fixtures ────────────────────────────────────────────────────────────

def _write_jsonl(path: str, entries: list[dict]):
    with open(path, 'w') as f:
        for entry in entries:
            f.write(json.dumps(entry) + '\n')


def _assistant_entry(stop_reason: str, ts: str = "2026-04-12T10:00:00Z", tools: list[str] | None = None) -> dict:
    content: list[dict] = []
    if tools:
        for tool_name in tools:
            content.append({"type": "tool_use", "id": f"toolu_{tool_name}", "name": tool_name, "input": {}})
    return {
        "type": "assistant",
        "message": {"role": "assistant", "stop_reason": stop_reason, "content": content},
        "timestamp": ts,
    }


def _user_entry(ts: str = "2026-04-12T10:00:01Z") -> dict:
    return {
        "type": "user",
        "message": {"role": "user", "content": [{"type": "text", "text": "hello"}]},
        "timestamp": ts,
    }


def _tool_result_entry(ts: str = "2026-04-12T10:00:02Z") -> dict:
    return {
        "type": "user",
        "message": {"role": "user", "content": []},
        "timestamp": ts,
        "toolUseResult": {"content": "result"},
    }


# ─── check_jsonl_state ──────────────────────────────────────────────────

class TestCheckJsonlState:

    def test_returns_tool_use_when_last_assistant_is_tool_use(self, tmp_path):
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _assistant_entry("end_turn", "2026-04-12T10:00:00Z"),
            _user_entry("2026-04-12T10:00:01Z"),
            _assistant_entry("tool_use", "2026-04-12T10:00:02Z", tools=["Bash"]),
            _tool_result_entry("2026-04-12T10:00:03Z"),
        ])
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "tool_use"
        assert result.last_tool_name == "Bash"

    def test_returns_end_turn_when_last_assistant_is_end_turn(self, tmp_path):
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _assistant_entry("tool_use", "2026-04-12T10:00:00Z", tools=["Read"]),
            _tool_result_entry("2026-04-12T10:00:01Z"),
            _assistant_entry("end_turn", "2026-04-12T10:00:02Z"),
        ])
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "end_turn"
        assert result.last_tool_name is None

    def test_returns_none_when_file_missing(self):
        assert check_jsonl_state("/nonexistent/path.jsonl") is None

    def test_returns_none_when_file_empty(self, tmp_path):
        jsonl = tmp_path / "session.jsonl"
        jsonl.write_text("")
        assert check_jsonl_state(str(jsonl)) is None

    def test_returns_none_when_no_assistant_entries(self, tmp_path):
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _user_entry("2026-04-12T10:00:00Z"),
            _user_entry("2026-04-12T10:00:01Z"),
        ])
        assert check_jsonl_state(str(jsonl)) is None

    def test_skips_user_entries_to_find_last_assistant(self, tmp_path):
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _assistant_entry("tool_use", "2026-04-12T10:00:00Z", tools=["Grep"]),
            _user_entry("2026-04-12T10:00:01Z"),
            _user_entry("2026-04-12T10:00:02Z"),
            _user_entry("2026-04-12T10:00:03Z"),
        ])
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "tool_use"
        assert result.last_tool_name == "Grep"

    def test_handles_corrupt_last_line(self, tmp_path):
        jsonl = tmp_path / "session.jsonl"
        with open(str(jsonl), 'w') as f:
            f.write(json.dumps(_assistant_entry("end_turn")) + '\n')
            f.write('{"broken json\n')
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "end_turn"

    def test_handles_assistant_without_stop_reason(self, tmp_path):
        jsonl = tmp_path / "session.jsonl"
        entries = [
            {"type": "assistant", "message": {"role": "assistant", "content": []}, "timestamp": "2026-04-12T10:00:00Z"},
            _assistant_entry("tool_use", "2026-04-12T09:59:00Z", tools=["Edit"]),
        ]
        _write_jsonl(str(jsonl), entries)
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "tool_use"
        assert result.last_tool_name == "Edit"

    def test_returns_max_tokens(self, tmp_path):
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [_assistant_entry("max_tokens")])
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "max_tokens"
        assert result.last_tool_name is None

    def test_handles_large_file_tailing(self, tmp_path):
        """Verify we only read the tail, not the whole file."""
        jsonl = tmp_path / "session.jsonl"
        with open(str(jsonl), 'w') as f:
            padding = json.dumps(_user_entry()) + '\n'
            for _ in range(3000):  # ~200KB of user entries
                f.write(padding)
            f.write(json.dumps(_assistant_entry("tool_use", tools=["Agent"])) + '\n')
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "tool_use"
        assert result.last_tool_name == "Agent"

    def test_handles_trailing_newlines(self, tmp_path):
        jsonl = tmp_path / "session.jsonl"
        with open(str(jsonl), 'w') as f:
            f.write(json.dumps(_assistant_entry("end_turn")) + '\n\n\n')
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "end_turn"

    def test_returns_none_on_permission_error(self, tmp_path):
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [_assistant_entry("tool_use", tools=["Bash"])])
        os.chmod(str(jsonl), 0o000)
        try:
            assert check_jsonl_state(str(jsonl)) is None
        finally:
            os.chmod(str(jsonl), 0o644)

    # ─── Sprint 39 T1.1: last_tool_name extraction ──────────────────────

    def test_extracts_last_tool_name_from_single_tool_use(self, tmp_path):
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _assistant_entry("tool_use", tools=["Read"]),
        ])
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "tool_use"
        assert result.last_tool_name == "Read"

    def test_extracts_last_tool_from_multiple_tool_uses(self, tmp_path):
        """When assistant makes multiple tool calls, return the LAST one."""
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _assistant_entry("tool_use", tools=["Read", "Grep", "Edit"]),
        ])
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "tool_use"
        assert result.last_tool_name == "Edit"

    def test_no_tool_name_on_end_turn(self, tmp_path):
        """end_turn entries should not return a tool name."""
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _assistant_entry("end_turn"),
        ])
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "end_turn"
        assert result.last_tool_name is None

    def test_no_tool_name_when_content_has_only_text(self, tmp_path):
        """tool_use stop_reason but content has no tool_use blocks (edge case)."""
        jsonl = tmp_path / "session.jsonl"
        entry = {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "stop_reason": "tool_use",
                "content": [{"type": "text", "text": "Let me check that."}],
            },
        }
        _write_jsonl(str(jsonl), [entry])
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "tool_use"
        assert result.last_tool_name is None

    def test_tool_name_with_mixed_content_blocks(self, tmp_path):
        """Content has text + tool_use blocks — extract from tool_use only."""
        jsonl = tmp_path / "session.jsonl"
        entry = {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "stop_reason": "tool_use",
                "content": [
                    {"type": "text", "text": "Reading the file now."},
                    {"type": "tool_use", "id": "toolu_abc", "name": "Read", "input": {"file_path": "/tmp/x"}},
                ],
            },
        }
        _write_jsonl(str(jsonl), [entry])
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "tool_use"
        assert result.last_tool_name == "Read"

    def test_tool_name_not_leaked_from_earlier_entry(self, tmp_path):
        """Tool name comes from the LAST assistant entry, not earlier ones."""
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _assistant_entry("tool_use", "2026-04-12T10:00:00Z", tools=["Bash"]),
            _tool_result_entry("2026-04-12T10:00:01Z"),
            _assistant_entry("end_turn", "2026-04-12T10:00:02Z"),
        ])
        result = check_jsonl_state(str(jsonl))
        assert result.stop_reason == "end_turn"
        assert result.last_tool_name is None

    def test_jsonl_state_is_namedtuple(self, tmp_path):
        """Verify JsonlState is a proper NamedTuple with expected fields."""
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [_assistant_entry("tool_use", tools=["Write"])])
        result = check_jsonl_state(str(jsonl))
        assert isinstance(result, JsonlState)
        assert result.stop_reason == "tool_use"
        assert result.last_tool_name == "Write"
        # NamedTuple unpacking
        sr, tname = result
        assert sr == "tool_use"
        assert tname == "Write"


# ─── resolve_transcript_path ─────────────────────────────────────────────

class TestResolveTranscriptPath:

    def test_reads_transcript_path_from_scratch(self, tmp_path):
        scratch = tmp_path / ".session-scratch"
        scratch.mkdir()
        (scratch / "transcript-path").write_text("/home/user/.claude/projects/key/abc.jsonl\n")
        result = resolve_transcript_path(str(tmp_path))
        assert result == "/home/user/.claude/projects/key/abc.jsonl"

    def test_strips_trailing_whitespace(self, tmp_path):
        scratch = tmp_path / ".session-scratch"
        scratch.mkdir()
        (scratch / "transcript-path").write_text("  /path/to/file.jsonl  \n\n")
        result = resolve_transcript_path(str(tmp_path))
        assert result == "/path/to/file.jsonl"

    def test_returns_none_when_scratch_dir_missing(self, tmp_path):
        assert resolve_transcript_path(str(tmp_path)) is None

    def test_returns_none_when_transcript_path_file_missing(self, tmp_path):
        scratch = tmp_path / ".session-scratch"
        scratch.mkdir()
        assert resolve_transcript_path(str(tmp_path)) is None

    def test_returns_none_when_file_is_empty(self, tmp_path):
        scratch = tmp_path / ".session-scratch"
        scratch.mkdir()
        (scratch / "transcript-path").write_text("")
        assert resolve_transcript_path(str(tmp_path)) is None

    def test_returns_none_when_file_is_whitespace_only(self, tmp_path):
        scratch = tmp_path / ".session-scratch"
        scratch.mkdir()
        (scratch / "transcript-path").write_text("   \n\n  ")
        assert resolve_transcript_path(str(tmp_path)) is None


# ─── Sprint 39 T1.2: tool_to_label mapping ────────────────────────────

class TestToolToLabel:

    def test_known_tools_map_correctly(self):
        assert tool_to_label('Read') == 'Reading file...'
        assert tool_to_label('Bash') == 'Running command...'
        assert tool_to_label('Edit') == 'Editing file...'
        assert tool_to_label('Write') == 'Writing file...'
        assert tool_to_label('Grep') == 'Searching...'
        assert tool_to_label('Glob') == 'Searching...'
        assert tool_to_label('Agent') == 'Delegating...'

    def test_unknown_tool_returns_none(self):
        assert tool_to_label('SomeUnknownTool') is None

    def test_none_input_returns_none(self):
        assert tool_to_label(None) is None

    def test_all_label_entries_are_strings(self):
        for tool, label in TOOL_LABELS.items():
            assert isinstance(tool, str)
            assert isinstance(label, str)
            assert label.endswith('...')


# ─── Sprint 45 T2.1: verify_message_ingested ────────────────────────────

def _queue_op_entry(operation: str, content: str = '', ts: str = "2026-04-17T10:00:00Z") -> dict:
    return {
        "type": "queue-operation",
        "operation": operation,
        "content": content,
        "timestamp": ts,
        "sessionId": "test-session-123",
    }


class TestVerifyMessageIngested:

    def test_finds_matching_enqueue_entry(self, tmp_path):
        """Returns True when JSONL contains a queue-operation enqueue with matching text."""
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _assistant_entry("end_turn"),
            _queue_op_entry("enqueue", "[Channel message from Jack in ch-123]: @Builder do the thing"),
        ])
        assert verify_message_ingested(str(jsonl), "[Channel message from Jack") is True

    def test_returns_false_when_no_matching_content(self, tmp_path):
        """Returns False when enqueue entries exist but none match the search text."""
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _queue_op_entry("enqueue", "[Channel message from Daniel in ch-123]: hello"),
        ])
        assert verify_message_ingested(str(jsonl), "[Channel message from Jack") is False

    def test_returns_false_on_empty_file(self, tmp_path):
        jsonl = tmp_path / "session.jsonl"
        jsonl.write_text("")
        assert verify_message_ingested(str(jsonl), "anything") is False

    def test_returns_false_on_missing_file(self):
        assert verify_message_ingested("/nonexistent/path.jsonl", "anything") is False

    def test_respects_after_byte_offset(self, tmp_path):
        """Enqueue entry before the byte offset is NOT found."""
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _queue_op_entry("enqueue", "[Channel message from Jack in ch-123]: old message"),
        ])
        file_size = os.path.getsize(str(jsonl))
        with open(str(jsonl), 'a') as f:
            f.write(json.dumps(_assistant_entry("end_turn")) + '\n')
        assert verify_message_ingested(str(jsonl), "[Channel message from Jack", after_byte=file_size) is False

    def test_finds_entry_after_byte_offset(self, tmp_path):
        """Enqueue entry after the byte offset IS found."""
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _assistant_entry("end_turn"),
        ])
        offset = os.path.getsize(str(jsonl))
        with open(str(jsonl), 'a') as f:
            f.write(json.dumps(_queue_op_entry("enqueue", "[Channel message from Jack in ch-123]: new msg")) + '\n')
        assert verify_message_ingested(str(jsonl), "[Channel message from Jack", after_byte=offset) is True

    def test_ignores_dequeue_operations(self, tmp_path):
        """Dequeue entries are not treated as ingestion proof."""
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _queue_op_entry("dequeue", "[Channel message from Jack in ch-123]: something"),
        ])
        assert verify_message_ingested(str(jsonl), "[Channel message from Jack") is False

    def test_handles_corrupt_json_lines(self, tmp_path):
        """Corrupt lines are skipped; valid entries after them are still found."""
        jsonl = tmp_path / "session.jsonl"
        with open(str(jsonl), 'w') as f:
            f.write('{"broken json\n')
            f.write(json.dumps(_queue_op_entry("enqueue", "[Channel message from Jack in ch-123]: test")) + '\n')
        assert verify_message_ingested(str(jsonl), "[Channel message from Jack") is True

    def test_returns_false_on_permission_error(self, tmp_path):
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _queue_op_entry("enqueue", "[Channel message from Jack in ch-123]: test"),
        ])
        os.chmod(str(jsonl), 0o000)
        try:
            assert verify_message_ingested(str(jsonl), "[Channel message from Jack") is False
        finally:
            os.chmod(str(jsonl), 0o644)
