#!/usr/bin/env python3
"""
Sprint 56 T1 — Plan Mode JSONL detector + pending-id tracker.

Pure classifier + state tracker. NO tmux, NO sleep, NO side effects.

APIs under test on CollabClaudeWrapper:
  - self._pending_plan_mode: dict[str, float]  (tool_use_id -> first-seen monotonic ts)
  - _detect_plan_mode(record) -> Optional[str]
        Pure classifier. Returns the ExitPlanMode tool_use_id for an assistant
        record whose message.content contains a tool_use block with
        name == 'ExitPlanMode'; else None.
  - _observe_jsonl_record_for_plan_mode(record, now) -> None
        State updater. Adds ExitPlanMode tool_use_ids to self._pending_plan_mode
        (keyed on tool_use_id, value = `now`). First-seen timestamp is preserved
        on duplicate. Clears pending entries on matching tool_result (user record
        with a content block whose tool_use_id is in self._pending_plan_mode).
        Records that are neither plan-mode tool_use nor plan-mode-resolving
        tool_result are no-ops.
"""

import importlib
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

# Add scripts dir to path so we can import the module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))

collab_claude = importlib.import_module('collab-claude')
CollabClaudeWrapper = collab_claude.CollabClaudeWrapper


def _make_wrapper():
    """Create a CollabClaudeWrapper with mocked externals. Side-effect-free."""
    with patch.object(CollabClaudeWrapper, '_detect_tmux_pane', return_value=None):
        w = CollabClaudeWrapper(
            channel_id='test-channel',
            participant_name='TestAgent',
            claude_args=[],
        )
    # Kill any outbound I/O path so tests stay hermetic.
    w._tmux_send = MagicMock(return_value=True)
    w.api_call = MagicMock(return_value={})
    w.broadcast_activity = MagicMock()
    return w


# ─── Fixture helpers (construct real-shape JSONL records) ─────────────────────

def _exit_plan_assistant(tool_use_id, plan_body='Plan body', file_path=None):
    """Shape matches live JSONL: assistant record with ExitPlanMode tool_use."""
    block = {
        'type': 'tool_use',
        'id': tool_use_id,
        'name': 'ExitPlanMode',
        'input': {
            'plan': plan_body,
        },
    }
    if file_path is not None:
        block['input']['planFilePath'] = file_path
    return {
        'type': 'assistant',
        'message': {
            'role': 'assistant',
            'stop_reason': 'tool_use',
            'content': [block],
        },
    }


def _tool_use_assistant(name, tool_use_id, inp=None):
    """Assistant record with an arbitrary non-plan-mode tool_use (Read/Bash/Edit)."""
    return {
        'type': 'assistant',
        'message': {
            'role': 'assistant',
            'stop_reason': 'tool_use',
            'content': [{
                'type': 'tool_use',
                'id': tool_use_id,
                'name': name,
                'input': inp or {},
            }],
        },
    }


def _tool_result_user(tool_use_id, content='User has approved your plan.'):
    """User record with tool_result pointing at a tool_use_id."""
    return {
        'type': 'user',
        'message': {
            'role': 'user',
            'content': [{
                'type': 'tool_result',
                'tool_use_id': tool_use_id,
                'content': content,
            }],
        },
    }


# ─── _detect_plan_mode — pure classifier ──────────────────────────────────────

class TestDetectPlanMode(unittest.TestCase):
    """Pure classifier: returns tool_use_id for ExitPlanMode, None otherwise.
    Must not mutate state, read files, or call tmux/subprocess."""

    def setUp(self):
        self.w = _make_wrapper()

    def test_exit_plan_mode_tool_use_returns_id(self):
        rec = _exit_plan_assistant('toolu_01ABC', plan_body='Refactor X')
        self.assertEqual(self.w._detect_plan_mode(rec), 'toolu_01ABC')

    def test_other_tool_use_returns_none(self):
        for tool in ('Read', 'Bash', 'Edit', 'Write', 'Grep', 'Glob', 'Agent'):
            rec = _tool_use_assistant(tool, 'toolu_other_' + tool)
            self.assertIsNone(self.w._detect_plan_mode(rec),
                              f'{tool} should not classify as plan mode')

    def test_user_tool_result_returns_none(self):
        rec = _tool_result_user('toolu_01XYZ')
        self.assertIsNone(self.w._detect_plan_mode(rec))

    def test_assistant_text_only_returns_none(self):
        rec = {
            'type': 'assistant',
            'message': {
                'role': 'assistant',
                'stop_reason': 'end_turn',
                'content': [{'type': 'text', 'text': 'Hello.'}],
            },
        }
        self.assertIsNone(self.w._detect_plan_mode(rec))

    def test_exit_plan_mode_without_id_returns_none(self):
        """Defensive: if structural shape is broken (no id), do not crash or lie."""
        rec = _exit_plan_assistant('toolu_placeholder')
        del rec['message']['content'][0]['id']
        self.assertIsNone(self.w._detect_plan_mode(rec))

    def test_mixed_blocks_exit_plan_mode_still_detected(self):
        """ExitPlanMode alongside text/thinking blocks should still register."""
        rec = _exit_plan_assistant('toolu_01MIX', plan_body='Mixed')
        rec['message']['content'] = [
            {'type': 'text', 'text': 'Here is my plan:'},
            rec['message']['content'][0],
        ]
        self.assertEqual(self.w._detect_plan_mode(rec), 'toolu_01MIX')

    def test_other_tool_use_alongside_exit_plan_mode_returns_exit_id(self):
        """Exit id wins over adjacent Bash/Read etc."""
        rec = _exit_plan_assistant('toolu_01EXIT')
        rec['message']['content'].insert(0, {
            'type': 'tool_use', 'id': 'toolu_01BASH', 'name': 'Bash', 'input': {},
        })
        self.assertEqual(self.w._detect_plan_mode(rec), 'toolu_01EXIT')

    def test_malformed_records_return_none(self):
        """Missing / wrong-type fields must not raise."""
        malformed = [
            {},
            {'type': 'assistant'},
            {'type': 'assistant', 'message': {}},
            {'type': 'assistant', 'message': {'content': None}},
            {'type': 'assistant', 'message': {'content': 'not a list'}},
            {'type': 'assistant', 'message': {'content': [None, 'string', 42]}},
            {'type': 'assistant', 'message': {'content': [{'type': 'tool_use'}]}},  # no name
            {'type': None},
            None,
        ]
        for rec in malformed:
            try:
                result = self.w._detect_plan_mode(rec)
            except Exception as e:
                self.fail(f'_detect_plan_mode raised on {rec!r}: {e}')
            self.assertIsNone(result, f'expected None for {rec!r}, got {result!r}')

    def test_classifier_is_side_effect_free(self):
        """Calling _detect_plan_mode must not mutate _pending_plan_mode."""
        rec = _exit_plan_assistant('toolu_01SIDE')
        before = dict(self.w._pending_plan_mode)
        self.w._detect_plan_mode(rec)
        self.assertEqual(self.w._pending_plan_mode, before,
                         'classifier mutated state')


# ─── _observe_jsonl_record_for_plan_mode — state tracker ──────────────────────

class TestObservePlanMode(unittest.TestCase):
    """State tracker populates self._pending_plan_mode and clears on tool_result.
    Must not call tmux, sleep, or touch I/O."""

    def setUp(self):
        self.w = _make_wrapper()

    def test_pending_dict_initialized_empty(self):
        """Wrapper construction must provide an empty dict (no state from last run)."""
        self.assertIsInstance(self.w._pending_plan_mode, dict)
        self.assertEqual(self.w._pending_plan_mode, {})

    def test_exit_plan_mode_tool_use_adds_pending(self):
        rec = _exit_plan_assistant('toolu_01AAA')
        self.w._observe_jsonl_record_for_plan_mode(rec, now=100.0)
        self.assertIn('toolu_01AAA', self.w._pending_plan_mode)
        self.assertEqual(self.w._pending_plan_mode['toolu_01AAA'], 100.0)

    def test_tool_result_clears_matching_pending(self):
        rec_tu = _exit_plan_assistant('toolu_01BBB')
        rec_tr = _tool_result_user('toolu_01BBB')
        self.w._observe_jsonl_record_for_plan_mode(rec_tu, now=10.0)
        self.assertIn('toolu_01BBB', self.w._pending_plan_mode)
        self.w._observe_jsonl_record_for_plan_mode(rec_tr, now=12.0)
        self.assertNotIn('toolu_01BBB', self.w._pending_plan_mode)
        self.assertEqual(self.w._pending_plan_mode, {})

    def test_tool_result_for_unknown_id_is_noop(self):
        """Bash/Read tool_results (not plan mode) must not crash or disturb pending."""
        rec_tu = _exit_plan_assistant('toolu_01CCC')
        rec_tr_other = _tool_result_user('toolu_01RANDOM_BASH')
        self.w._observe_jsonl_record_for_plan_mode(rec_tu, now=1.0)
        self.w._observe_jsonl_record_for_plan_mode(rec_tr_other, now=2.0)
        self.assertEqual(set(self.w._pending_plan_mode.keys()), {'toolu_01CCC'})
        self.assertEqual(self.w._pending_plan_mode['toolu_01CCC'], 1.0)

    def test_back_to_back_plans_tracked_independently(self):
        """Two ExitPlanMode gates in one session must both be pending until resolved."""
        rec_a = _exit_plan_assistant('toolu_PLAN_A')
        rec_b = _exit_plan_assistant('toolu_PLAN_B')
        self.w._observe_jsonl_record_for_plan_mode(rec_a, now=100.0)
        self.w._observe_jsonl_record_for_plan_mode(rec_b, now=105.0)
        self.assertEqual(
            set(self.w._pending_plan_mode.keys()),
            {'toolu_PLAN_A', 'toolu_PLAN_B'},
        )
        self.assertEqual(self.w._pending_plan_mode['toolu_PLAN_A'], 100.0)
        self.assertEqual(self.w._pending_plan_mode['toolu_PLAN_B'], 105.0)

        # Resolve A only — B must still be pending.
        self.w._observe_jsonl_record_for_plan_mode(
            _tool_result_user('toolu_PLAN_A'), now=110.0,
        )
        self.assertEqual(
            set(self.w._pending_plan_mode.keys()),
            {'toolu_PLAN_B'},
        )
        self.assertEqual(self.w._pending_plan_mode['toolu_PLAN_B'], 105.0)

    def test_duplicate_tool_use_preserves_first_seen_timestamp(self):
        """JSONL tail may re-read records. Duplicate must not re-stamp or double-accept."""
        rec = _exit_plan_assistant('toolu_DUP')
        self.w._observe_jsonl_record_for_plan_mode(rec, now=50.0)
        self.w._observe_jsonl_record_for_plan_mode(rec, now=99.0)
        self.assertEqual(self.w._pending_plan_mode['toolu_DUP'], 50.0,
                         'duplicate observation overwrote first-seen timestamp')

    def test_non_plan_tool_use_is_noop(self):
        """Read/Bash/Edit records must NOT add entries to _pending_plan_mode."""
        for tool in ('Read', 'Bash', 'Edit', 'Write', 'Grep', 'Glob'):
            self.w._observe_jsonl_record_for_plan_mode(
                _tool_use_assistant(tool, f'toolu_{tool}'), now=1.0,
            )
        self.assertEqual(self.w._pending_plan_mode, {})

    def test_exit_plan_surrounded_by_other_tool_use(self):
        """Simulate the real tail: Bash tool_use → Bash result → ExitPlanMode →
        Bash tool_use → Bash result → ExitPlanMode resolution. Only plan-mode
        entries flow into the pending dict; other tool_use/tool_results are noise."""
        events = [
            (_tool_use_assistant('Bash', 'toolu_BASH1'), 10.0),
            (_tool_result_user('toolu_BASH1'), 11.0),
            (_exit_plan_assistant('toolu_PLAN'), 12.0),
            (_tool_use_assistant('Read', 'toolu_READ1'), 13.0),
            (_tool_result_user('toolu_READ1'), 14.0),
        ]
        for rec, now in events:
            self.w._observe_jsonl_record_for_plan_mode(rec, now=now)
        self.assertEqual(list(self.w._pending_plan_mode.keys()), ['toolu_PLAN'])
        self.assertEqual(self.w._pending_plan_mode['toolu_PLAN'], 12.0)

        # Resolution record lands — pending empties.
        self.w._observe_jsonl_record_for_plan_mode(
            _tool_result_user('toolu_PLAN'), now=15.0,
        )
        self.assertEqual(self.w._pending_plan_mode, {})

    def test_observer_is_deterministic_and_isolated_from_tmux(self):
        """The observer must not touch tmux/subprocess. Mocks stay untouched."""
        rec_tu = _exit_plan_assistant('toolu_ISOLATE')
        rec_tr = _tool_result_user('toolu_ISOLATE')
        self.w._observe_jsonl_record_for_plan_mode(rec_tu, now=1.0)
        self.w._observe_jsonl_record_for_plan_mode(rec_tr, now=2.0)
        self.w._tmux_send.assert_not_called()
        self.w.api_call.assert_not_called()
        self.w.broadcast_activity.assert_not_called()

    def test_malformed_record_is_noop(self):
        """Same defensive contract as the classifier — no raising on junk."""
        self.w._pending_plan_mode['toolu_KEEP'] = 7.0
        for rec in (None, {}, {'type': 'user'}, {'type': 'assistant', 'message': None}):
            try:
                self.w._observe_jsonl_record_for_plan_mode(rec, now=1.0)
            except Exception as e:
                self.fail(f'observer raised on {rec!r}: {e}')
        # Existing pending entry must be untouched.
        self.assertEqual(self.w._pending_plan_mode, {'toolu_KEEP': 7.0})


if __name__ == '__main__':
    unittest.main()
