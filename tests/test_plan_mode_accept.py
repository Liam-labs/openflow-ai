#!/usr/bin/env python3
"""
Sprint 56 T2 — Plan Mode accept keystroke + telemetry + timeout escalation.

Extends T1's tracker with a two-state lifecycle:

    pending   — ExitPlanMode seen, awaiting 3s debounce
    accepted  — accept keystroke sent, awaiting tool_result (or 10s timeout fail)

APIs under test on CollabClaudeWrapper:
  - self._accepted_plan_mode: dict[str, float]
        tool_use_id -> monotonic timestamp of accept-keystroke send.
  - PLAN_MODE_DEBOUNCE_SECONDS = 3.0
  - PLAN_MODE_ACCEPT_TIMEOUT_SECONDS = 10.0
  - _accept_plan_mode_gate(tool_use_id, now) -> bool
        Sends '1' + Enter via _tmux_send. On success: removes from pending,
        adds to accepted, logs plan_auto_accepted. On _tmux_send failure:
        removes from pending, does NOT add to accepted, logs
        plan_auto_accept_failed with reason 'tmux_send_failed'. Single attempt.
  - _check_plan_mode_debounce(now) -> None
        For every pending id whose age >= PLAN_MODE_DEBOUNCE_SECONDS,
        call _accept_plan_mode_gate(id, now).
  - _check_plan_mode_accept_timeout(now) -> None
        For every accepted id whose age >= PLAN_MODE_ACCEPT_TIMEOUT_SECONDS,
        log plan_auto_accept_failed (reason='no_tool_result'), remove from accepted.
  - _log_plan_mode_event(event_type, tool_use_id, extra=None) -> None
        Structured log hook — tests monkeypatch to capture.
  - Observer (from T1) extended so tool_result also clears _accepted_plan_mode,
        and a fresh ExitPlanMode record whose id is already in _accepted does
        NOT re-enter pending.
"""

import importlib
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
collab_claude = importlib.import_module('collab-claude')
CollabClaudeWrapper = collab_claude.CollabClaudeWrapper


def _make_wrapper():
    with patch.object(CollabClaudeWrapper, '_detect_tmux_pane', return_value=None):
        w = CollabClaudeWrapper(
            channel_id='test-channel',
            participant_name='TestAgent',
            claude_args=[],
        )
    w._tmux_send = MagicMock(return_value=True)
    w.api_call = MagicMock(return_value={})
    w.broadcast_activity = MagicMock()
    # Capture every _log_plan_mode_event call instead of hitting debug/HTTP.
    w._plan_events = []
    def _capture(event_type, tool_use_id, extra=None):
        w._plan_events.append({
            'event_type': event_type,
            'tool_use_id': tool_use_id,
            'extra': dict(extra) if extra else None,
        })
    w._log_plan_mode_event = _capture
    return w


def _exit_plan_assistant(tool_use_id):
    return {
        'type': 'assistant',
        'message': {
            'role': 'assistant',
            'stop_reason': 'tool_use',
            'content': [{
                'type': 'tool_use', 'id': tool_use_id,
                'name': 'ExitPlanMode', 'input': {'plan': 'x'},
            }],
        },
    }


def _tool_result_user(tool_use_id):
    return {
        'type': 'user',
        'message': {
            'role': 'user',
            'content': [{
                'type': 'tool_result',
                'tool_use_id': tool_use_id,
                'content': 'User has approved your plan.',
            }],
        },
    }


# ─── Constants ────────────────────────────────────────────────────────────────

class TestPlanModeConstants(unittest.TestCase):
    def test_debounce_is_three_seconds(self):
        self.assertEqual(collab_claude.PLAN_MODE_DEBOUNCE_SECONDS, 3.0)

    def test_accept_timeout_is_ten_seconds(self):
        self.assertEqual(collab_claude.PLAN_MODE_ACCEPT_TIMEOUT_SECONDS, 10.0)


# ─── _accepted_plan_mode state dict ───────────────────────────────────────────

class TestAcceptedPlanModeInit(unittest.TestCase):
    def test_accepted_dict_initialized_empty(self):
        w = _make_wrapper()
        self.assertIsInstance(w._accepted_plan_mode, dict)
        self.assertEqual(w._accepted_plan_mode, {})


# ─── _accept_plan_mode_gate ───────────────────────────────────────────────────

class TestAcceptPlanModeGate(unittest.TestCase):
    def setUp(self):
        self.w = _make_wrapper()
        # Pre-seed pending as if observer had seen an ExitPlanMode at t=0.
        self.w._pending_plan_mode['toolu_GATE'] = 0.0

    def test_success_sends_one_and_enter(self):
        self.w._tmux_send.return_value = True
        ok = self.w._accept_plan_mode_gate('toolu_GATE', now=3.5)
        self.assertTrue(ok)
        self.w._tmux_send.assert_called_once_with('1', enter=True)

    def test_success_moves_pending_to_accepted(self):
        self.w._tmux_send.return_value = True
        self.w._accept_plan_mode_gate('toolu_GATE', now=3.5)
        self.assertNotIn('toolu_GATE', self.w._pending_plan_mode)
        self.assertIn('toolu_GATE', self.w._accepted_plan_mode)
        self.assertEqual(self.w._accepted_plan_mode['toolu_GATE'], 3.5)

    def test_success_logs_plan_auto_accepted(self):
        self.w._tmux_send.return_value = True
        self.w._accept_plan_mode_gate('toolu_GATE', now=3.5)
        events = [e for e in self.w._plan_events if e['event_type'] == 'plan_auto_accepted']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['tool_use_id'], 'toolu_GATE')

    def test_failure_logs_failed_with_tmux_reason(self):
        self.w._tmux_send.return_value = False
        ok = self.w._accept_plan_mode_gate('toolu_GATE', now=3.5)
        self.assertFalse(ok)
        failed = [e for e in self.w._plan_events if e['event_type'] == 'plan_auto_accept_failed']
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]['tool_use_id'], 'toolu_GATE')
        self.assertEqual(failed[0]['extra']['reason'], 'tmux_send_failed')

    def test_failure_does_not_add_to_accepted(self):
        """Per spec: no retry, no escalation. If _tmux_send returned False, we
        never saw the menu render either, so observing for 10s is pointless."""
        self.w._tmux_send.return_value = False
        self.w._accept_plan_mode_gate('toolu_GATE', now=3.5)
        self.assertNotIn('toolu_GATE', self.w._accepted_plan_mode)

    def test_failure_removes_from_pending(self):
        """Single attempt — spec is explicit 'no retry'. Pending must be cleared
        so the debounce driver doesn't re-attempt on the next tick."""
        self.w._tmux_send.return_value = False
        self.w._accept_plan_mode_gate('toolu_GATE', now=3.5)
        self.assertNotIn('toolu_GATE', self.w._pending_plan_mode)

    def test_accept_for_unknown_id_is_safe_noop(self):
        """Defensive — should not raise or emit telemetry."""
        self.w._pending_plan_mode.clear()
        self.w._accept_plan_mode_gate('toolu_GHOST', now=3.5)
        self.assertEqual(self.w._pending_plan_mode, {})
        self.assertEqual(self.w._accepted_plan_mode, {})
        self.assertEqual(self.w._plan_events, [])
        self.w._tmux_send.assert_not_called()


# ─── _check_plan_mode_debounce ────────────────────────────────────────────────

class TestCheckPlanModeDebounce(unittest.TestCase):
    def setUp(self):
        self.w = _make_wrapper()
        self.w._tmux_send.return_value = True

    def test_under_three_seconds_does_not_accept(self):
        self.w._pending_plan_mode['toolu_A'] = 100.0
        self.w._check_plan_mode_debounce(now=102.9)
        self.w._tmux_send.assert_not_called()
        self.assertIn('toolu_A', self.w._pending_plan_mode)
        self.assertNotIn('toolu_A', self.w._accepted_plan_mode)

    def test_exactly_three_seconds_accepts(self):
        self.w._pending_plan_mode['toolu_A'] = 100.0
        self.w._check_plan_mode_debounce(now=103.0)
        self.w._tmux_send.assert_called_once_with('1', enter=True)
        self.assertNotIn('toolu_A', self.w._pending_plan_mode)
        self.assertIn('toolu_A', self.w._accepted_plan_mode)

    def test_over_three_seconds_accepts(self):
        self.w._pending_plan_mode['toolu_A'] = 100.0
        self.w._check_plan_mode_debounce(now=108.0)
        self.w._tmux_send.assert_called_once_with('1', enter=True)
        self.assertIn('toolu_A', self.w._accepted_plan_mode)

    def test_multiple_pending_only_eligible_accepted(self):
        self.w._pending_plan_mode.update({
            'toolu_OLD':   100.0,
            'toolu_FRESH': 104.0,
        })
        self.w._check_plan_mode_debounce(now=105.0)
        # toolu_OLD was 5s old → accept fired.
        # toolu_FRESH was 1s old → left pending.
        self.assertEqual(self.w._tmux_send.call_count, 1)
        self.assertNotIn('toolu_OLD', self.w._pending_plan_mode)
        self.assertIn('toolu_OLD', self.w._accepted_plan_mode)
        self.assertIn('toolu_FRESH', self.w._pending_plan_mode)
        self.assertNotIn('toolu_FRESH', self.w._accepted_plan_mode)

    def test_empty_pending_is_noop(self):
        self.w._check_plan_mode_debounce(now=1000.0)
        self.w._tmux_send.assert_not_called()
        self.assertEqual(self.w._plan_events, [])

    def test_debounce_is_safe_to_call_concurrently_without_crash(self):
        """Iterates over a snapshot of keys, so mid-loop mutation can't raise."""
        for i in range(5):
            self.w._pending_plan_mode[f'toolu_{i}'] = 0.0
        self.w._check_plan_mode_debounce(now=100.0)
        self.assertEqual(len(self.w._accepted_plan_mode), 5)
        self.assertEqual(self.w._pending_plan_mode, {})


# ─── _check_plan_mode_accept_timeout ──────────────────────────────────────────

class TestCheckPlanModeAcceptTimeout(unittest.TestCase):
    def setUp(self):
        self.w = _make_wrapper()

    def test_accepted_under_ten_seconds_is_not_failed(self):
        self.w._accepted_plan_mode['toolu_A'] = 100.0
        self.w._check_plan_mode_accept_timeout(now=109.9)
        self.assertIn('toolu_A', self.w._accepted_plan_mode)
        self.assertEqual(self.w._plan_events, [])

    def test_accepted_exactly_ten_seconds_fails(self):
        self.w._accepted_plan_mode['toolu_A'] = 100.0
        self.w._check_plan_mode_accept_timeout(now=110.0)
        self.assertNotIn('toolu_A', self.w._accepted_plan_mode)
        events = [e for e in self.w._plan_events if e['event_type'] == 'plan_auto_accept_failed']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['tool_use_id'], 'toolu_A')
        self.assertEqual(events[0]['extra']['reason'], 'no_tool_result')

    def test_accepted_over_ten_seconds_fails(self):
        self.w._accepted_plan_mode['toolu_A'] = 100.0
        self.w._check_plan_mode_accept_timeout(now=115.0)
        self.assertNotIn('toolu_A', self.w._accepted_plan_mode)

    def test_multiple_accepted_only_expired_fail(self):
        self.w._accepted_plan_mode.update({
            'toolu_OLD':   100.0,
            'toolu_YOUNG': 103.0,
        })
        self.w._check_plan_mode_accept_timeout(now=111.0)
        # OLD was 11s → failed. YOUNG was 8s → stays.
        self.assertNotIn('toolu_OLD', self.w._accepted_plan_mode)
        self.assertIn('toolu_YOUNG', self.w._accepted_plan_mode)
        failed = [e for e in self.w._plan_events if e['event_type'] == 'plan_auto_accept_failed']
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]['tool_use_id'], 'toolu_OLD')

    def test_empty_accepted_is_noop(self):
        self.w._check_plan_mode_accept_timeout(now=10_000.0)
        self.assertEqual(self.w._plan_events, [])


# ─── Observer extension — tool_result clears _accepted_plan_mode ──────────────

class TestObserverClearsAccepted(unittest.TestCase):
    def setUp(self):
        self.w = _make_wrapper()

    def test_tool_result_clears_accepted_entry(self):
        self.w._accepted_plan_mode['toolu_A'] = 5.0
        self.w._observe_jsonl_record_for_plan_mode(
            _tool_result_user('toolu_A'), now=6.0,
        )
        self.assertNotIn('toolu_A', self.w._accepted_plan_mode)

    def test_tool_result_clears_both_pending_and_accepted(self):
        """If an id ever appears in both (shouldn't, but defensively), clear both."""
        self.w._pending_plan_mode['toolu_A'] = 0.0
        self.w._accepted_plan_mode['toolu_A'] = 3.0
        self.w._observe_jsonl_record_for_plan_mode(
            _tool_result_user('toolu_A'), now=6.0,
        )
        self.assertNotIn('toolu_A', self.w._pending_plan_mode)
        self.assertNotIn('toolu_A', self.w._accepted_plan_mode)

    def test_duplicate_exit_plan_for_already_accepted_id_does_not_requeue(self):
        """Tail scan may re-read the same ExitPlanMode record after accept.
        Observer must not push an id that's already in accepted back to pending
        — otherwise the next debounce tick would double-keystroke."""
        self.w._accepted_plan_mode['toolu_A'] = 3.0
        self.w._observe_jsonl_record_for_plan_mode(
            _exit_plan_assistant('toolu_A'), now=7.0,
        )
        self.assertNotIn('toolu_A', self.w._pending_plan_mode)
        self.assertEqual(self.w._accepted_plan_mode, {'toolu_A': 3.0})


# ─── End-to-end lifecycle (deterministic clock, no sleeps) ────────────────────

class TestPlanModeLifecycle(unittest.TestCase):
    def setUp(self):
        self.w = _make_wrapper()
        self.w._tmux_send.return_value = True

    def test_happy_path_plan_auto_accepted_and_resolved(self):
        """tool_use @ t=0  →  pending.
        check @ t=1        →  still pending (under debounce).
        check @ t=3.5      →  accept fired, moved to accepted.
        tool_result @ t=4  →  observer clears accepted. No timeout fail."""
        self.w._observe_jsonl_record_for_plan_mode(_exit_plan_assistant('toolu_HAPPY'), now=0.0)
        self.w._check_plan_mode_debounce(now=1.0)
        self.assertIn('toolu_HAPPY', self.w._pending_plan_mode)
        self.assertNotIn('toolu_HAPPY', self.w._accepted_plan_mode)
        self.w._tmux_send.assert_not_called()

        self.w._check_plan_mode_debounce(now=3.5)
        self.w._tmux_send.assert_called_once_with('1', enter=True)
        self.assertIn('toolu_HAPPY', self.w._accepted_plan_mode)

        self.w._observe_jsonl_record_for_plan_mode(_tool_result_user('toolu_HAPPY'), now=4.0)
        self.assertNotIn('toolu_HAPPY', self.w._accepted_plan_mode)

        self.w._check_plan_mode_accept_timeout(now=20.0)
        failed = [e for e in self.w._plan_events if e['event_type'] == 'plan_auto_accept_failed']
        self.assertEqual(failed, [], 'no timeout fail expected when tool_result arrived')

    def test_timeout_path_plan_auto_accept_failed_after_ten_seconds(self):
        """tool_use @ t=0 → pending; accept @ t=3.5 → accepted; no tool_result;
        timeout check @ t=13.5 → failed."""
        self.w._observe_jsonl_record_for_plan_mode(_exit_plan_assistant('toolu_LOST'), now=0.0)
        self.w._check_plan_mode_debounce(now=3.5)
        self.assertIn('toolu_LOST', self.w._accepted_plan_mode)

        self.w._check_plan_mode_accept_timeout(now=13.5)
        self.assertNotIn('toolu_LOST', self.w._accepted_plan_mode)
        failed = [e for e in self.w._plan_events if e['event_type'] == 'plan_auto_accept_failed']
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]['tool_use_id'], 'toolu_LOST')
        self.assertEqual(failed[0]['extra']['reason'], 'no_tool_result')

    def test_user_declined_before_debounce_does_not_keystroke(self):
        """If the real user hit option 3 (keep planning) before our 3s debounce,
        the tool_result will fire and clear pending. We must NOT send a keystroke."""
        self.w._observe_jsonl_record_for_plan_mode(_exit_plan_assistant('toolu_MANUAL'), now=0.0)
        self.w._observe_jsonl_record_for_plan_mode(_tool_result_user('toolu_MANUAL'), now=1.0)
        self.w._check_plan_mode_debounce(now=5.0)
        self.w._tmux_send.assert_not_called()
        self.assertEqual(self.w._pending_plan_mode, {})
        self.assertEqual(self.w._accepted_plan_mode, {})


if __name__ == '__main__':
    unittest.main()
