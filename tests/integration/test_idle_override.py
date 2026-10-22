"""
Integration test — JSONL idle override.

P1-T4: Simulate tool_use suppresses idle, end_turn allows idle.
P2-T1: Verify corrective suppression flows from idle-gate override.
P2-T2: Fallback — no transcript-path falls back to heuristic.

Tests the wrapper methods (_resolve_transcript, _check_jsonl_state)
integrated with the idle gate logic, without spawning a real Claude process.
"""
import json
import os
import sys
import time
import tempfile
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'scripts'))
from jsonl_state_reader import check_jsonl_state, resolve_transcript_path, JsonlState


def _write_jsonl(path: str, entries: list[dict]):
    with open(path, 'w') as f:
        for entry in entries:
            f.write(json.dumps(entry) + '\n')


def _assistant(stop_reason: str, ts: str = "2026-04-12T10:00:00Z") -> dict:
    return {
        "type": "assistant",
        "message": {"role": "assistant", "stop_reason": stop_reason, "content": []},
        "timestamp": ts,
    }


def _user(ts: str = "2026-04-12T10:00:01Z") -> dict:
    return {"type": "user", "message": {"role": "user", "content": []}, "timestamp": ts}


class TestIdleOverrideIntegration:
    """Simulates the idle gate logic from collab-claude.py lines 1744-1756."""

    def _simulate_idle_gate(self, cwd: str) -> str:
        """Simulate the idle detection gate.

        Returns:
            'suppressed' — JSONL says tool_use, idle transition blocked
            'idle'       — proceed with idle transition (end_turn, max_tokens, or fallback)
            'fallback'   — JSONL unavailable, fall back to heuristic
        """
        path = resolve_transcript_path(cwd)
        if not path:
            return 'fallback'

        state = check_jsonl_state(path)
        if state is not None and state.stop_reason == 'tool_use':
            return 'suppressed'
        if state is not None:
            return 'idle'
        return 'fallback'

    def test_tool_use_suppresses_idle(self, tmp_path):
        """When JSONL last entry is tool_use, idle gate blocks transition."""
        scratch = tmp_path / ".session-scratch"
        scratch.mkdir()
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _assistant("end_turn", "2026-04-12T09:59:00Z"),
            _user("2026-04-12T10:00:00Z"),
            _assistant("tool_use", "2026-04-12T10:00:01Z"),
            _user("2026-04-12T10:00:02Z"),  # tool result
        ])
        (scratch / "transcript-path").write_text(str(jsonl))

        result = self._simulate_idle_gate(str(tmp_path))
        assert result == 'suppressed'

    def test_end_turn_allows_idle(self, tmp_path):
        """When JSONL last entry is end_turn, idle gate allows transition."""
        scratch = tmp_path / ".session-scratch"
        scratch.mkdir()
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [
            _assistant("tool_use", "2026-04-12T10:00:00Z"),
            _user("2026-04-12T10:00:01Z"),
            _assistant("end_turn", "2026-04-12T10:00:02Z"),
        ])
        (scratch / "transcript-path").write_text(str(jsonl))

        result = self._simulate_idle_gate(str(tmp_path))
        assert result == 'idle'

    def test_max_tokens_allows_idle(self, tmp_path):
        """max_tokens is not tool_use — agent hit the limit, not actively working."""
        scratch = tmp_path / ".session-scratch"
        scratch.mkdir()
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [_assistant("max_tokens")])
        (scratch / "transcript-path").write_text(str(jsonl))

        result = self._simulate_idle_gate(str(tmp_path))
        assert result == 'idle'

    def test_no_transcript_path_falls_back(self, tmp_path):
        """No .session-scratch/transcript-path → fallback to heuristic."""
        result = self._simulate_idle_gate(str(tmp_path))
        assert result == 'fallback'

    def test_empty_transcript_path_falls_back(self, tmp_path):
        """Empty transcript-path file → fallback."""
        scratch = tmp_path / ".session-scratch"
        scratch.mkdir()
        (scratch / "transcript-path").write_text("")
        result = self._simulate_idle_gate(str(tmp_path))
        assert result == 'fallback'

    def test_missing_jsonl_file_falls_back(self, tmp_path):
        """transcript-path points to nonexistent JSONL → fallback."""
        scratch = tmp_path / ".session-scratch"
        scratch.mkdir()
        (scratch / "transcript-path").write_text("/nonexistent/session.jsonl")
        result = self._simulate_idle_gate(str(tmp_path))
        assert result == 'fallback'

    def test_state_transition_tool_use_to_end_turn(self, tmp_path):
        """Simulate a real flow: tool_use → suppressed, then end_turn → idle."""
        scratch = tmp_path / ".session-scratch"
        scratch.mkdir()
        jsonl = tmp_path / "session.jsonl"
        (scratch / "transcript-path").write_text(str(jsonl))

        # Step 1: Agent is in tool_use
        _write_jsonl(str(jsonl), [
            _assistant("tool_use", "2026-04-12T10:00:00Z"),
            _user("2026-04-12T10:00:01Z"),
        ])
        assert self._simulate_idle_gate(str(tmp_path)) == 'suppressed'

        # Step 2: Agent completes with end_turn
        _write_jsonl(str(jsonl), [
            _assistant("tool_use", "2026-04-12T10:00:00Z"),
            _user("2026-04-12T10:00:01Z"),
            _assistant("end_turn", "2026-04-12T10:00:05Z"),
        ])
        assert self._simulate_idle_gate(str(tmp_path)) == 'idle'


class TestCorrectiveSuppression:
    """P2-T1: Verify corrective doesn't fire when JSONL says tool_use.

    The corrective (line 1787) is inside the idle transition block.
    If the JSONL override prevents the idle transition (tool_use → continue),
    the corrective code is never reached.
    """

    def test_corrective_unreachable_during_tool_use(self, tmp_path):
        """tool_use prevents idle transition → corrective block is unreachable."""
        scratch = tmp_path / ".session-scratch"
        scratch.mkdir()
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [_assistant("tool_use")])
        (scratch / "transcript-path").write_text(str(jsonl))

        # Simulate: the idle gate returns 'suppressed', meaning the
        # entire idle-transition block (including corrective) is skipped
        path = resolve_transcript_path(str(tmp_path))
        state = check_jsonl_state(path)
        assert state.stop_reason == 'tool_use'
        # In the real code, `continue` skips the block.
        # This test proves the state value that triggers the skip.

    def test_corrective_reachable_after_end_turn(self, tmp_path):
        """end_turn allows idle transition → corrective can fire if needed."""
        scratch = tmp_path / ".session-scratch"
        scratch.mkdir()
        jsonl = tmp_path / "session.jsonl"
        _write_jsonl(str(jsonl), [_assistant("end_turn")])
        (scratch / "transcript-path").write_text(str(jsonl))

        path = resolve_transcript_path(str(tmp_path))
        state = check_jsonl_state(path)
        assert state.stop_reason == 'end_turn'
        # In the real code, this proceeds to idle transition,
        # where the corrective check runs.
