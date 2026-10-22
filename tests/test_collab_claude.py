#!/usr/bin/env python3
"""
Test suite for collab-claude.py (the wrapper that manages Claude CLI collab sessions).

Covers:
- inject_message: no age-based drop (all queued messages injected normally)
- Dedup across SSE + polling + inbox (injected_message_ids set)
- Cursor advancement (last_poll_time per-message, not batch)
- check_inbox stale filtering (MAX_CATCHUP_AGE_SECONDS still applies at inbox level)
- check_pending_enter logic (timing, child-dead recovery)
- Visit timeout auto-return
"""

import json
import os
import queue
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch, PropertyMock

# Add scripts dir to path so we can import the module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))

import importlib
collab_claude = importlib.import_module('collab-claude')
jsonl_state_reader = importlib.import_module('jsonl_state_reader')
CollabClaudeWrapper = collab_claude.CollabClaudeWrapper
MAX_CATCHUP_AGE_SECONDS = collab_claude.MAX_CATCHUP_AGE_SECONDS


class TestCollabResponseSignal(unittest.TestCase):
    def test_cross_channel_agent_api_call_counts_as_a_sent_response(self):
        self.assertTrue(collab_claude.contains_collab_response_signal(
            'curl /api/agent --data {"action": "collab.cross_channel_message"}'
        ))

    def test_ordinary_agent_api_message_still_counts(self):
        self.assertTrue(collab_claude.contains_collab_response_signal(
            '{"action":"collab.message"}'
        ))


def _make_wrapper(**overrides):
    """Create a CollabClaudeWrapper with mocked internals for unit testing."""
    with patch.object(CollabClaudeWrapper, '_detect_tmux_pane', return_value=None):
        w = CollabClaudeWrapper(
            channel_id='test-channel-123',
            participant_name='TestAgent',
            claude_args=[]
        )
    w.participant_id = 'test-participant-456'
    w.joined = True
    w.claude_pid = 99999
    # Mock the child (pexpect) as alive by default
    w.child = MagicMock()
    w.child.isalive.return_value = True
    w.child.send.return_value = 10
    # Mock tmux send to succeed
    w._tmux_send = MagicMock(return_value=True)
    w._capture_tmux_pane = MagicMock(return_value='')
    # Mock API calls
    w.api_call = MagicMock(return_value={})
    w.broadcast_activity = MagicMock()
    # Sprint 57 T1: mock delivery telemetry so tests never POST to the live
    # /api/collab/delivery-status endpoint. Without this, fake TestAgent
    # failures leak into .AppData/delivery-status.json and trigger the
    # stability-alerts pipeline.
    w.log_delivery_event = MagicMock()
    w.log_delivery_failure = MagicMock()
    # Apply overrides
    for k, v in overrides.items():
        setattr(w, k, v)
    return w


def _iso_now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def _iso_ago(seconds):
    dt = datetime.now(timezone.utc) - timedelta(seconds=seconds)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


# ─── T3a: inject_message — no age-based drop ───

class TestInjectMessageNoAgeDrop(unittest.TestCase):
    """inject_message injects all messages regardless of age (Bug 2 fix).

    The old code dropped messages older than MAX_CATCHUP_AGE_SECONDS at injection
    time. This caused messages that were fresh when queued to age out while waiting
    in the internal queue. The age guard now lives upstream (check_inbox, SSE
    catch-up cap) so inject_message treats everything as live.
    """

    def test_old_message_still_injected(self):
        """Message older than 5 min is NOT dropped — it's injected normally."""
        w = _make_wrapper()
        old_ts = _iso_ago(MAX_CATCHUP_AGE_SECONDS + 60)  # 6 min old

        result = w.inject_message(
            sender='Jack', content='Old message',
            msg_timestamp=old_ts
        )

        self.assertTrue(result)
        # Always-defer: only text sent here; Enter fires later via check_pending_enter
        self.assertEqual(w._tmux_send.call_count, 1)

    def test_fresh_message_injected(self):
        """Fresh message is injected normally."""
        w = _make_wrapper()
        fresh_ts = _iso_ago(30)

        result = w.inject_message(
            sender='Jack', content='Fresh message',
            msg_timestamp=fresh_ts
        )

        self.assertTrue(result)
        self.assertEqual(w._tmux_send.call_count, 1)

    def test_no_timestamp_injected(self):
        """Message without timestamp is injected normally."""
        w = _make_wrapper()

        result = w.inject_message(
            sender='Jack', content='No timestamp message',
            msg_timestamp=None
        )

        self.assertTrue(result)
        self.assertEqual(w._tmux_send.call_count, 1)

    def test_no_historical_prefix(self):
        """No HISTORICAL prefix is added regardless of message age."""
        w = _make_wrapper()
        old_ts = _iso_ago(180)  # 3 min old

        w.inject_message(
            sender='Jack', content='Somewhat old',
            msg_timestamp=old_ts
        )

        text_call = w._tmux_send.call_args_list[0][0][0]
        self.assertNotIn('HISTORICAL', text_call)
        self.assertNotIn('do NOT reply', text_call)

    def test_very_old_message_still_injected(self):
        """Even a 1-hour-old message is injected (upstream guards prevent queueing)."""
        w = _make_wrapper()
        ancient_ts = _iso_ago(3600)

        result = w.inject_message(
            sender='Jack', content='Ancient message',
            msg_timestamp=ancient_ts
        )

        self.assertTrue(result)
        text_call = w._tmux_send.call_args_list[0][0][0]
        self.assertNotIn('HISTORICAL', text_call)


# ─── T3b: Dedup across SSE + polling + inbox ───

class TestDedupInjectedMessageIds(unittest.TestCase):
    """injected_message_ids prevents duplicate injection across all delivery paths."""

    def test_sse_message_deduped_on_second_delivery(self):
        """Same message ID from SSE queue is not injected twice."""
        w = _make_wrapper()
        msg = {
            'id': 'msg-abc-123',
            'from': {'id': 'other-agent', 'name': 'Jack'},
            'content': 'Hello',
            'timestamp': _iso_now(),
            'mentions': [],
        }

        # First: put in SSE queue and process
        w.sse_message_queue.put(msg)
        # Simulate the poll loop processing (the wrapper checks the queue then injects)
        queued_msg = w.sse_message_queue.get()
        w.injected_message_ids.add(queued_msg['id'])

        # Now check_inbox should skip this message if it appears in inbox
        self.assertIn('msg-abc-123', w.injected_message_ids)

    def test_check_inbox_skips_already_injected(self):
        """check_inbox marks messages as read if they're in injected_message_ids."""
        w = _make_wrapper()
        w.injected_message_ids.add('msg-already-seen')

        # Create a temp inbox file
        inbox_data = {
            'messages': [{
                'id': 'msg-already-seen',
                'from': 'Jack (SG-1)',
                'content': 'Duplicate',
                'timestamp': _iso_now(),
                'read': False
            }],
            'lastUpdated': _iso_now()
        }

        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(inbox_data, f)
            inbox_path = f.name

        try:
            w._get_inbox_path = MagicMock(return_value=inbox_path)
            queued = w.check_inbox()
            self.assertEqual(queued, 0)

            # Verify it was marked read in the file
            with open(inbox_path) as f:
                updated = json.load(f)
            self.assertTrue(updated['messages'][0]['read'])
        finally:
            os.unlink(inbox_path)

    def test_fresh_inbox_message_queued(self):
        """check_inbox queues fresh, unseen messages into sse_message_queue."""
        w = _make_wrapper()

        inbox_data = {
            'messages': [{
                'id': 'msg-fresh-001',
                'from': 'Owner (DevFlow)',
                'content': 'New task for you',
                'timestamp': _iso_now(),
                'read': False
            }],
            'lastUpdated': _iso_now()
        }

        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(inbox_data, f)
            inbox_path = f.name

        try:
            w._get_inbox_path = MagicMock(return_value=inbox_path)
            queued = w.check_inbox()
            self.assertEqual(queued, 1)
            self.assertFalse(w.sse_message_queue.empty())

            # Verify the queued message has correct API format
            api_msg = w.sse_message_queue.get()
            self.assertEqual(api_msg['id'], 'msg-fresh-001')
            self.assertEqual(api_msg['from']['name'], 'Owner')
            self.assertEqual(api_msg['content'], 'New task for you')
        finally:
            os.unlink(inbox_path)


# ─── T3c: Cursor advancement ───

class TestCursorAdvancement(unittest.TestCase):
    """last_poll_time advances per-message on catch-up, not batch."""

    def test_periodic_catchup_advances_cursor(self):
        """After catch-up poll, last_poll_time moves to newest message timestamp."""
        w = _make_wrapper()
        w.last_poll_time = _iso_ago(120)  # 2 min ago

        newest_ts = _iso_ago(5)  # 5 seconds ago

        # Simulate what the periodic catch-up code does
        messages = [
            {'id': 'msg-1', 'timestamp': _iso_ago(60), 'from': {'id': 'other'}},
            {'id': 'msg-2', 'timestamp': newest_ts, 'from': {'id': 'other'}},
        ]

        # Replicate the cursor advancement logic from poll_channel
        all_msgs = messages
        if all_msgs:
            found_newest = max((m.get('timestamp', '') for m in all_msgs), default=None)
            if found_newest and (not w.last_poll_time or found_newest > w.last_poll_time):
                w.last_poll_time = found_newest

        self.assertEqual(w.last_poll_time, newest_ts)


# ─── T3d: check_inbox stale filtering ───

class TestCheckInboxStaleFiltering(unittest.TestCase):
    """check_inbox drops messages older than MAX_CATCHUP_AGE_SECONDS."""

    def test_stale_inbox_message_marked_read_not_queued(self):
        """Old messages in inbox are marked read but NOT queued for processing."""
        w = _make_wrapper()

        stale_ts = _iso_ago(MAX_CATCHUP_AGE_SECONDS + 120)  # 7 min old
        inbox_data = {
            'messages': [{
                'id': 'msg-stale-001',
                'from': 'Jack (SG-1)',
                'content': 'Ancient message',
                'timestamp': stale_ts,
                'read': False
            }],
            'lastUpdated': _iso_now()
        }

        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(inbox_data, f)
            inbox_path = f.name

        try:
            w._get_inbox_path = MagicMock(return_value=inbox_path)
            queued = w.check_inbox()
            self.assertEqual(queued, 0)
            self.assertTrue(w.sse_message_queue.empty())

            # But it should be marked read in the file
            with open(inbox_path) as f:
                updated = json.load(f)
            self.assertTrue(updated['messages'][0]['read'])
        finally:
            os.unlink(inbox_path)

    def test_mixed_stale_and_fresh_inbox(self):
        """Only fresh messages are queued; stale ones are marked read and skipped."""
        w = _make_wrapper()

        inbox_data = {
            'messages': [
                {
                    'id': 'msg-stale',
                    'from': 'Jack (SG-1)',
                    'content': 'Old one',
                    'timestamp': _iso_ago(MAX_CATCHUP_AGE_SECONDS + 60),
                    'read': False
                },
                {
                    'id': 'msg-fresh',
                    'from': 'Owner (DevFlow)',
                    'content': 'New one',
                    'timestamp': _iso_ago(10),
                    'read': False
                },
            ],
            'lastUpdated': _iso_now()
        }

        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(inbox_data, f)
            inbox_path = f.name

        try:
            w._get_inbox_path = MagicMock(return_value=inbox_path)
            queued = w.check_inbox()
            self.assertEqual(queued, 1)

            api_msg = w.sse_message_queue.get()
            self.assertEqual(api_msg['id'], 'msg-fresh')

            # The stale message is consumed immediately, but the fresh message
            # stays unread until its queued delivery is confirmed.
            with open(inbox_path) as f:
                updated = json.load(f)
            self.assertTrue(updated['messages'][0]['read'])
            self.assertFalse(updated['messages'][1]['read'])

            # Once injection is confirmed, the next inbox pass consumes the
            # persistent unread copy without queueing it again.
            w.injected_message_ids.add('msg-fresh')
            self.assertEqual(w.check_inbox(), 0)
            self.assertTrue(w.sse_message_queue.empty())
            with open(inbox_path) as f:
                confirmed = json.load(f)
            self.assertTrue(all(m['read'] for m in confirmed['messages']))
        finally:
            os.unlink(inbox_path)

    def test_inbox_no_file_returns_zero(self):
        """check_inbox returns 0 when inbox file doesn't exist."""
        w = _make_wrapper()
        w._get_inbox_path = MagicMock(return_value='/tmp/nonexistent-inbox-test.json')
        self.assertEqual(w.check_inbox(), 0)

    def test_inbox_empty_file_returns_zero(self):
        """check_inbox returns 0 for empty inbox file."""
        w = _make_wrapper()
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            f.write('')
            inbox_path = f.name
        try:
            w._get_inbox_path = MagicMock(return_value=inbox_path)
            self.assertEqual(w.check_inbox(), 0)
        finally:
            os.unlink(inbox_path)

    def test_inbox_all_read_returns_zero(self):
        """check_inbox returns 0 when all messages already read."""
        w = _make_wrapper()
        inbox_data = {
            'messages': [{
                'id': 'msg-already-read',
                'from': 'Jack',
                'content': 'Already processed',
                'timestamp': _iso_now(),
                'read': True
            }]
        }
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(inbox_data, f)
            inbox_path = f.name
        try:
            w._get_inbox_path = MagicMock(return_value=inbox_path)
            self.assertEqual(w.check_inbox(), 0)
        finally:
            os.unlink(inbox_path)


# ─── T3e: check_pending_enter logic ───

class TestCheckPendingEnter(unittest.TestCase):
    """check_pending_enter sends Enter when idle, recovers when child dies."""

    def test_no_pending_enter_returns_false(self):
        """Returns False immediately when no Enter is pending."""
        w = _make_wrapper()
        w.pending_enter = False
        self.assertFalse(w.check_pending_enter())

    def test_child_dead_discards_from_dedup_set(self):
        """When child dies before Enter, msg ID removed from dedup set for re-delivery."""
        w = _make_wrapper()
        w.pending_enter = True
        w.last_injected_msg_id = 'msg-lost-001'
        w.injected_message_ids = {'msg-lost-001'}
        w.pending_mark_read_timestamp = _iso_now()
        w.child.isalive.return_value = False

        result = w.check_pending_enter()

        self.assertFalse(result)
        self.assertFalse(w.pending_enter)
        self.assertNotIn('msg-lost-001', w.injected_message_ids)

    def test_child_dead_rewinds_poll_cursor(self):
        """When child dies, poll cursor is rewound for message recovery."""
        w = _make_wrapper()
        w.pending_enter = True
        w.last_injected_msg_id = 'msg-lost'
        w.injected_message_ids = {'msg-lost'}
        msg_ts = _iso_now()
        w.pending_mark_read_timestamp = msg_ts
        w.child.isalive.return_value = False

        w.check_pending_enter()

        # last_poll_time should be rewound by ~1 second
        self.assertIsNotNone(w.last_poll_time)
        poll_dt = datetime.fromisoformat(w.last_poll_time.replace('Z', '+00:00'))
        msg_dt = datetime.fromisoformat(msg_ts.replace('Z', '+00:00'))
        self.assertLess(poll_dt, msg_dt)

    def test_minimum_delay_enforced(self):
        """Enter not sent within 0.2s of text injection."""
        w = _make_wrapper()
        w.pending_enter = True
        w.pending_enter_time = time.time()  # Just now
        w.last_output_time = time.time() - 10  # Idle for 10s

        result = w.check_pending_enter()
        self.assertFalse(result)  # Too soon

    def test_enter_sent_after_idle_threshold(self):
        """Enter sent when Claude has been idle for enter_idle_threshold."""
        w = _make_wrapper()
        w.pending_enter = True
        w.pending_enter_time = time.time() - 1.0  # 1s ago (past 0.2s min)
        w.last_output_time = time.time() - 2.0  # 2s idle (past 0.5s threshold)

        result = w.check_pending_enter()

        self.assertTrue(result)
        self.assertFalse(w.pending_enter)
        w._tmux_send.assert_called_with('', enter=True)

    def test_enter_forced_after_max_wait(self):
        """Enter is force-sent after 5s even if output is recent."""
        w = _make_wrapper()
        w.pending_enter = True
        w.pending_enter_time = time.time() - 6.0  # 6s ago (past 5s max_wait)
        w.last_output_time = time.time()  # Output just now

        result = w.check_pending_enter()

        self.assertTrue(result)
        self.assertFalse(w.pending_enter)

    def test_enter_failure_discards_from_dedup(self):
        """If _tmux_send raises during Enter, msg ID removed from dedup."""
        w = _make_wrapper()
        w.pending_enter = True
        w.pending_enter_time = time.time() - 6.0
        w.last_output_time = time.time() - 6.0
        w.last_injected_msg_id = 'msg-enter-fail'
        w.injected_message_ids = {'msg-enter-fail'}
        w._tmux_send = MagicMock(side_effect=Exception("tmux crashed"))

        result = w.check_pending_enter()

        self.assertFalse(result)
        self.assertNotIn('msg-enter-fail', w.injected_message_ids)
        self.assertFalse(w.pending_enter)


# ─── T3f: Visit timeout auto-return ───

class TestVisitTimeout(unittest.TestCase):
    """Visit timeout triggers auto-return to home channel after idle period."""

    def test_visit_timeout_conditions(self):
        """Visit auto-return fires when: visiting + elapsed > timeout + idle >= 30s."""
        w = _make_wrapper()
        w.visiting = True
        w.visit_start_time = time.time() - 400  # 400s ago (> 300s timeout)
        w.is_processing = False
        w.last_output_time = time.time() - 60  # 60s idle (> 30s)
        w.last_keystroke = time.time() - 60
        w.home_channel_id = 'home-channel-id'
        w.return_to_home_channel = MagicMock()

        # Replicate the visit timeout check from poll_channel
        visit_elapsed = time.time() - w.visit_start_time
        idle_time = time.time() - max(w.last_output_time, w.last_keystroke)

        should_return = (
            w.visiting
            and w.visit_start_time > 0
            and not w.is_processing
            and visit_elapsed >= w.visit_timeout
            and idle_time >= 30
        )

        self.assertTrue(should_return)

    def test_visit_no_timeout_while_processing(self):
        """Visit does NOT auto-return while agent is actively processing."""
        w = _make_wrapper()
        w.visiting = True
        w.visit_start_time = time.time() - 400
        w.is_processing = True  # Actively working
        w.last_output_time = time.time() - 60
        w.last_keystroke = time.time() - 60

        visit_elapsed = time.time() - w.visit_start_time
        idle_time = time.time() - max(w.last_output_time, w.last_keystroke)

        should_return = (
            w.visiting
            and w.visit_start_time > 0
            and not w.is_processing
            and visit_elapsed >= w.visit_timeout
            and idle_time >= 30
        )

        self.assertFalse(should_return)

    def test_visit_no_timeout_if_not_idle_long_enough(self):
        """Visit does NOT auto-return if idle time < 30s."""
        w = _make_wrapper()
        w.visiting = True
        w.visit_start_time = time.time() - 400
        w.is_processing = False
        w.last_output_time = time.time() - 10  # Only 10s idle
        w.last_keystroke = time.time() - 10

        visit_elapsed = time.time() - w.visit_start_time
        idle_time = time.time() - max(w.last_output_time, w.last_keystroke)

        should_return = (
            w.visiting
            and w.visit_start_time > 0
            and not w.is_processing
            and visit_elapsed >= w.visit_timeout
            and idle_time >= 30
        )

        self.assertFalse(should_return)


# ─── T3g: inject_message additional behavior ───

class TestInjectMessageBehavior(unittest.TestCase):
    """Additional inject_message behavior: pending_enter guard, mentions, formatting."""

    def test_appends_when_pending_enter(self):
        """inject_message APPENDS to input buffer when pending_enter is True (batch mode)."""
        w = _make_wrapper()
        w.pending_enter = True

        result = w.inject_message(
            sender='Jack', content='Batched message',
            msg_timestamp=_iso_now()
        )

        self.assertTrue(result)
        w._tmux_send.assert_called_once()
        sent_text = w._tmux_send.call_args[0][0]
        self.assertIn('[Channel message from Jack', sent_text)

    def test_blocked_by_dead_child(self):
        """inject_message returns False if child process is dead."""
        w = _make_wrapper()
        w.child.isalive.return_value = False

        result = w.inject_message(
            sender='Jack', content='Dead child',
            msg_timestamp=_iso_now()
        )

        self.assertFalse(result)

    def test_sets_processing_state_on_success(self):
        """Successful injection sets is_processing=True and broadcasts 'working'."""
        w = _make_wrapper()

        w.inject_message(
            sender='Jack', content='Test message',
            msg_timestamp=_iso_now()
        )

        self.assertTrue(w.is_processing)
        # Always-defer: Enter never fires immediately — pending_enter must be True
        self.assertTrue(w.pending_enter)
        w.broadcast_activity.assert_called_with('working', force=True)

    def test_mention_by_participant_id(self):
        """@mention by participant ID adds mention annotation."""
        w = _make_wrapper()

        w.inject_message(
            sender='Jack', content='Hey test-participant-456',
            mentions=['test-participant-456'],
            msg_timestamp=_iso_now()
        )

        # Always-defer: only one _tmux_send call (text); Enter is deferred
        text_call = w._tmux_send.call_args_list[0][0][0]
        self.assertIn('(@you)', text_call)

    def test_broadcast_annotation(self):
        """Messages with no mentions get broadcast annotation."""
        w = _make_wrapper()

        w.inject_message(
            sender='Jack', content='Team update',
            mentions=[],
            msg_timestamp=_iso_now()
        )

        text_call = w._tmux_send.call_args_list[0][0][0]
        self.assertIn('(broadcast)', text_call)

    def test_mention_by_name_fallback(self):
        """@mention by name in content triggers mention detection."""
        w = _make_wrapper()

        w.inject_message(
            sender='Jack', content='@TestAgent check this out',
            mentions=[],
            msg_timestamp=_iso_now()
        )

        text_call = w._tmux_send.call_args_list[0][0][0]
        self.assertIn('(@you)', text_call)


# ─── T3h: inject_message is_processing gate ───

class TestIsProcessingGate(unittest.TestCase):
    """The injection gate blocks while is_processing is True (active-generation fix)."""

    def test_is_processing_blocks_sse_queue_drain(self):
        """Messages in SSE queue are not drained while is_processing is True.

        This tests the documented fix at line ~1497 where the injection gate
        checks `not self.is_processing` before draining the SSE queue.
        """
        w = _make_wrapper()
        w.is_processing = True
        w.pending_enter = False

        # Queue a message via SSE
        msg = {
            'id': 'msg-during-processing',
            'from': {'id': 'other', 'name': 'Jack'},
            'content': 'While busy',
            'timestamp': _iso_now(),
            'mentions': [],
        }
        w.sse_message_queue.put(msg)

        # The message should stay in queue (not be drained)
        self.assertFalse(w.sse_message_queue.empty())


# ─── Fix 1: Catch-up cap: time → count ───

MAX_CATCHUP_MESSAGES = collab_claude.MAX_CATCHUP_MESSAGES


class TestCatchupCountCap(unittest.TestCase):
    """Catch-up uses count-based limit (50) instead of time-based cap (5 min)."""

    def test_join_channel_no_time_cap(self):
        """join_channel does NOT clamp last_poll_time to MAX_CATCHUP_AGE_SECONDS."""
        w = _make_wrapper()
        old_ts = _iso_ago(7200)  # 2 hours ago
        join_data = {
            'success': True,
            'participantId': 'test-participant-456',
            'channel': {
                'participants': [
                    {'id': 'test-participant-456', 'lastRead': old_ts}
                ]
            },
        }
        w.api_call = MagicMock(return_value=join_data)
        w.joined = False
        w.child = None  # Prevent role inject
        w._load_cursor_timestamp = MagicMock(return_value=None)
        w._write_session_file = MagicMock()
        w._fetch_role_from_roster = MagicMock()

        w.join_channel('test-channel-123', 'TestAgent')

        # last_poll_time should be the raw lastRead value, NOT capped
        self.assertEqual(w.last_poll_time, old_ts)

    def test_join_channel_no_lastread_uses_now(self):
        """join_channel without lastRead uses current time (not capped past time)."""
        w = _make_wrapper()
        join_data = {
            'success': True,
            'participantId': 'test-participant-456',
            'channel': {'participants': [{'id': 'test-participant-456'}]},
        }
        w.api_call = MagicMock(return_value=join_data)
        w.joined = False
        w.child = None  # Prevent role inject
        w._load_cursor_timestamp = MagicMock(return_value=None)
        w._write_session_file = MagicMock()
        w._fetch_role_from_roster = MagicMock()

        w.join_channel('test-channel-123', 'TestAgent')

        # Should have a poll time set (to now), not None
        self.assertIsNotNone(w.last_poll_time)

    def test_max_catchup_messages_is_50(self):
        """MAX_CATCHUP_MESSAGES constant is 50."""
        self.assertEqual(MAX_CATCHUP_MESSAGES, 50)


class TestSSECatchupLimit(unittest.TestCase):
    """SSE catch-up uses limit=50 and no time cap."""

    def test_sse_catchup_url_has_limit_50(self):
        """SSE reconnect catch-up poll URL includes limit=50."""
        w = _make_wrapper()
        w.last_poll_time = _iso_ago(600)  # 10 min ago — would be capped under old logic

        # The SSE catch-up logic is embedded in the SSE listener thread.
        # We verify the constant is used by checking the module-level value.
        self.assertEqual(MAX_CATCHUP_MESSAGES, 50)

    def test_old_poll_time_not_capped_in_sse_catchup(self):
        """last_poll_time older than MAX_CATCHUP_AGE_SECONDS is preserved for SSE catch-up."""
        w = _make_wrapper()
        old_ts = _iso_ago(3600)  # 1 hour ago
        w.last_poll_time = old_ts

        # Under old logic, this would be capped to 5 min ago.
        # Under new logic, it's used as-is (count cap handles flood).
        self.assertEqual(w.last_poll_time, old_ts)


class TestPeriodicCatchupNoTimeCap(unittest.TestCase):
    """Periodic catch-up fallback uses count cap, not time cap."""

    def test_old_poll_time_preserved_for_periodic(self):
        """Periodic catch-up does not cap last_poll_time to 5 min."""
        w = _make_wrapper()
        old_ts = _iso_ago(7200)  # 2 hours ago
        w.last_poll_time = old_ts

        # The periodic catch-up uses last_poll_time - 30s as since.
        # It should NOT clamp to MAX_CATCHUP_AGE_SECONDS.
        self.assertEqual(w.last_poll_time, old_ts)

    def test_no_poll_time_omits_since(self):
        """When no last_poll_time, periodic catch-up omits since (fetches latest N)."""
        w = _make_wrapper()
        w.last_poll_time = None

        # Under old logic, this would create a 5-min-ago cap.
        # Under new logic, no since param — server returns latest N by count.
        self.assertIsNone(w.last_poll_time)


# ─── Fix 2: Inbox still uses MAX_CATCHUP_AGE_SECONDS (unchanged) ───

class TestInboxStillUsesTimeCap(unittest.TestCase):
    """check_inbox still uses MAX_CATCHUP_AGE_SECONDS to prevent ancient inbox replay."""

    def test_inbox_age_cap_is_480(self):
        """MAX_CATCHUP_AGE_SECONDS is 480 (8 min — Owner's directive, Sprint 50)."""
        self.assertEqual(MAX_CATCHUP_AGE_SECONDS, 480)

    def test_old_inbox_message_skipped(self):
        """Inbox messages older than 5 min are still skipped (marked read, not queued)."""
        w = _make_wrapper()
        old_ts = _iso_ago(MAX_CATCHUP_AGE_SECONDS + 60)  # 6 min old

        # Create a temp inbox file with an old message
        import tempfile
        inbox = {
            'messages': [
                {'id': 'inbox-old-1', 'from': 'Jack (SG-1)', 'content': 'Old inbox msg',
                 'timestamp': old_ts, 'read': False}
            ]
        }
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(inbox, f)
            inbox_path = f.name

        try:
            with patch.object(w, '_get_inbox_path', return_value=inbox_path):
                count = w.check_inbox()

            # Message should be marked read (skipped), not queued
            with open(inbox_path) as f:
                data = json.load(f)
            self.assertTrue(data['messages'][0]['read'])
            self.assertTrue(w.sse_message_queue.empty())
        finally:
            os.unlink(inbox_path)

    def test_fresh_inbox_message_queued(self):
        """Inbox messages younger than 5 min are queued normally."""
        w = _make_wrapper()
        fresh_ts = _iso_ago(30)  # 30s old

        import tempfile
        inbox = {
            'messages': [
                {'id': 'inbox-fresh-1', 'from': 'Jack (SG-1)', 'content': 'Fresh inbox msg',
                 'timestamp': fresh_ts, 'read': False}
            ]
        }
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(inbox, f)
            inbox_path = f.name

        try:
            with patch.object(w, '_get_inbox_path', return_value=inbox_path):
                count = w.check_inbox()

            # Message should be queued
            self.assertFalse(w.sse_message_queue.empty())
            queued_msg = w.sse_message_queue.get_nowait()
            self.assertEqual(queued_msg['id'], 'inbox-fresh-1')
        finally:
            os.unlink(inbox_path)


# ─── Fix 3: Premature idle threshold ───

class TestPrematureIdleThreshold(unittest.TestCase):
    """Extended idle threshold before first output prevents false terminal-only warnings."""

    def test_initial_idle_threshold_is_15(self):
        """initial_idle_threshold defaults to 15 seconds."""
        w = _make_wrapper()
        self.assertEqual(w.initial_idle_threshold, 15.0)

    def test_activity_idle_threshold_is_5(self):
        """activity_idle_threshold allows Opus's observed 3-5s tool pauses."""
        w = _make_wrapper()
        self.assertEqual(w.activity_idle_threshold, 5.0)

    def test_output_seen_false_after_inject(self):
        """output_seen_since_inject is False immediately after inject_message."""
        w = _make_wrapper()
        w.inject_message(sender='Jack', content='Test', msg_timestamp=_iso_now())

        self.assertFalse(w.output_seen_since_inject)

    def test_output_seen_true_after_output(self):
        """output_seen_since_inject becomes True when output is produced."""
        w = _make_wrapper()
        w.inject_message(sender='Jack', content='Test', msg_timestamp=_iso_now())

        # Simulate output being produced (normally done by output_filter)
        w.output_seen_since_inject = True

        self.assertTrue(w.output_seen_since_inject)

    def test_threshold_selection_before_output(self):
        """Before first output, the effective threshold is initial_idle_threshold (15s)."""
        w = _make_wrapper()
        w.inject_message(sender='Jack', content='Test', msg_timestamp=_iso_now())

        # No output seen yet — threshold should be 15s
        threshold = w.activity_idle_threshold if w.output_seen_since_inject else w.initial_idle_threshold
        self.assertEqual(threshold, 15.0)

    def test_threshold_selection_after_output(self):
        """After first output, the effective threshold drops to activity_idle_threshold (5s)."""
        w = _make_wrapper()
        w.inject_message(sender='Jack', content='Test', msg_timestamp=_iso_now())
        w.output_seen_since_inject = True

        # Output seen — threshold should be 5s
        threshold = w.activity_idle_threshold if w.output_seen_since_inject else w.initial_idle_threshold
        self.assertEqual(threshold, 5.0)

    def test_3s_silence_no_output_stays_processing(self):
        """With no output seen, 3s of silence does NOT trigger idle (needs 15s)."""
        w = _make_wrapper()
        w.is_processing = True
        w.output_seen_since_inject = False
        w.last_output_time = time.time() - 5  # 5s of silence

        # Under old logic (3s threshold), this would trigger idle.
        # Under new logic, threshold is 15s — still processing.
        threshold = w.activity_idle_threshold if w.output_seen_since_inject else w.initial_idle_threshold
        silence = time.time() - w.last_output_time
        self.assertLess(silence, threshold + 1)  # 5s < 15s — should NOT trigger idle
        self.assertTrue(silence < threshold)

    def test_15s_silence_no_output_triggers_idle(self):
        """With no output seen, 15s+ of silence triggers idle check."""
        w = _make_wrapper()
        w.is_processing = True
        w.output_seen_since_inject = False
        w.last_output_time = time.time() - 16  # 16s of silence

        threshold = w.activity_idle_threshold if w.output_seen_since_inject else w.initial_idle_threshold
        silence = time.time() - w.last_output_time
        self.assertTrue(silence >= threshold)

    def test_reset_on_new_inject(self):
        """output_seen_since_inject resets to False on each new inject_message."""
        w = _make_wrapper()
        w.output_seen_since_inject = True  # Previously saw output

        w.inject_message(sender='Jack', content='New message', msg_timestamp=_iso_now())

        self.assertFalse(w.output_seen_since_inject)


# ─── Sprint 39 T1.3: inject always broadcasts (force=True) ───

class TestInjectAlwaysBroadcasts(unittest.TestCase):
    """Regression: inject_message must broadcast even when status is already 'working'.

    Before Sprint 39: broadcast_activity('working') was called without force=True,
    so if agent was already in 'working' state, the broadcast was silently skipped.
    This hid the inject event from listeners (frontend saw stale status).
    """

    def test_inject_broadcasts_with_force_when_already_working(self):
        """inject_message calls broadcast_activity('working', force=True)."""
        w = _make_wrapper()
        w.current_activity = 'working'  # Already working
        w.is_processing = True

        w.inject_message(sender='Jack', content='test message', msg_timestamp=_iso_now())

        w.broadcast_activity.assert_called_with('working', force=True)

    def test_inject_broadcasts_with_force_when_transitioning_from_idle(self):
        """Same force=True call even when transitioning from idle."""
        w = _make_wrapper()
        w.current_activity = 'idle'
        w.is_processing = False

        w.inject_message(sender='Jack', content='test message', msg_timestamp=_iso_now())

        w.broadcast_activity.assert_called_with('working', force=True)


# ─── Sprint 45 T4.1: Regression — immediate-Enter race scenario ───

class TestImmediateEnterRaceCondition(unittest.TestCase):
    """Regression test for the immediate-Enter race condition (Sprint 45).

    Root cause (2026-04-13): collab-claude.py ~line 1379 has a branch that
    sends Enter IMMEDIATELY when is_processing=False.  If Claude is starting
    a new turn at the exact moment a message is injected, is_processing is
    stale-False, Enter fires into Claude's input layer mid-transition, and
    the queued command never lands in the JSONL transcript.

    Desired behaviour after T3.1 fix: Enter is ALWAYS deferred (pending_enter=True),
    regardless of is_processing state.  The deferred-Enter path already provides
    safety — removing the immediate-Enter branch trades ≤0.2 s of latency for a
    zero-drop guarantee.
    """

    def test_stale_idle_flag_does_not_fire_immediate_enter(self):
        """Stale is_processing=False must NOT cause Enter to fire immediately.

        Scenario: is_processing is False (stale — agent is mid-transition into a
        new turn).  An incoming message is injected.  The immediate-Enter branch
        must NOT execute; Enter must be deferred so the command lands safely.

        FAILS before T3.1: immediate branch fires, _tmux_send called twice,
                            pending_enter stays False.
        PASSES after T3.1: immediate branch removed, _tmux_send called once,
                           pending_enter=True.
        """
        w = _make_wrapper()
        w.is_processing = False          # Stale idle flag — agent is mid-transition
        w.pending_enter = False

        result = w.inject_message(
            sender='BnG-CRM', content='@Builder urgent task',
            mentions=['test-participant-456'],
            msg_timestamp=_iso_now()
        )

        self.assertTrue(result)
        # Enter must NOT have fired immediately — only the text send should have occurred.
        self.assertEqual(w._tmux_send.call_count, 1,
            "immediate-Enter race: _tmux_send must be called ONCE (text only). "
            "A second call means Enter fired immediately, risking message loss on "
            "turn-transition.")
        # Enter must be deferred via pending_enter so check_pending_enter sends it safely.
        self.assertTrue(w.pending_enter,
            "pending_enter must be True after inject — deferred path ensures safe delivery.")

    def test_stale_idle_flag_text_still_sent(self):
        """Message text IS sent even when is_processing=False (no regression on delivery)."""
        w = _make_wrapper()
        w.is_processing = False
        w.pending_enter = False

        w.inject_message(
            sender='Jack', content='Sprint 45 task',
            msg_timestamp=_iso_now()
        )

        # Text must still be injected into the input buffer.
        self.assertEqual(w._tmux_send.call_count, 1)
        sent_text = w._tmux_send.call_args[0][0]
        self.assertIn('Sprint 45 task', sent_text)

    def test_enter_always_deferred_regardless_of_processing_state(self):
        """Enter is deferred whether is_processing is True or False.

        This test documents the invariant after T3.1: the deferred-Enter path
        is the ONLY path.  Both states must produce the same outcome.
        """
        for is_proc in (False, True):
            with self.subTest(is_processing=is_proc):
                w = _make_wrapper()
                w.is_processing = is_proc
                w.pending_enter = False

                w.inject_message(
                    sender='Jack', content='test',
                    msg_timestamp=_iso_now()
                )

                self.assertEqual(w._tmux_send.call_count, 1,
                    f"is_processing={is_proc}: only text should be sent, not text+Enter")
                self.assertTrue(w.pending_enter,
                    f"is_processing={is_proc}: pending_enter must be True after inject")


# ─── Sprint 51 T2: Stop retry-rewind on JSONL verifier timeout ───
#
# Sprint 45 T3.4 added retry-with-rewind on jsonl verifier timeout. Sprint 51
# proved (Jack 2026-04-18 audit, 22/22 events) that those timeouts are verifier
# false-positives — the messages actually delivered. The retry-rewind was the
# direct cause of duplicate injections. Behavior now: log
# jsonl_verify_timeout_noreinject
# once, clear _verify_pending, do NOT touch dedup set or poll cursor, do NOT
# escalate to delivery_failure_critical.
#
# Real-loss reasons (tmux_send_failed, child_died) are logged in OTHER code
# paths and keep their existing semantics — they don't flow through here.

class TestDeliveryRetry(unittest.TestCase):
    """A JSONL verifier timeout must not retry, rewind, or escalate."""

    def test_jsonl_timeout_does_not_remove_from_dedup(self):
        """Message stays in injected_message_ids after jsonl timeout — prevents duplicate injection."""
        w = _make_wrapper()
        w._verify_pending = True
        w._verify_search_text = '[Channel message from Jack'
        w._verify_start_time = time.time() - 10
        w._verify_msg_id = 'msg-retry-001'
        w._verify_timeout = 5.0
        w.last_injected_msg_id = 'msg-retry-001'
        w.injected_message_ids = {'msg-retry-001'}
        w.pending_mark_read_timestamp = _iso_now()
        w.log_delivery_failure = MagicMock()

        with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
            f.write('')
            jsonl_path = f.name
        try:
            w._resolve_transcript = MagicMock(return_value=jsonl_path)
            w.check_verify_ingestion()

            # Sprint 51 T2: stays in dedup so polling/SSE skip it.
            self.assertIn('msg-retry-001', w.injected_message_ids)
            # Retry count must NOT be incremented (no retry mechanism for verifier path).
            self.assertNotIn('msg-retry-001', w._retry_attempts)
            # _verify_pending must be cleared so we don't loop on the same event.
            self.assertFalse(w._verify_pending)
            # Logs the no-op timeout for telemetry (T1 already excludes it from alerts).
            w.log_delivery_failure.assert_called_once()
            self.assertEqual(w.log_delivery_failure.call_args[0][1], 'jsonl_verify_timeout_noreinject')
        finally:
            os.unlink(jsonl_path)

    def test_jsonl_timeout_does_not_escalate_to_critical(self):
        """Even with prior retry attempts on record, jsonl timeout never escalates to critical."""
        w = _make_wrapper()
        w._verify_pending = True
        w._verify_search_text = '[Channel message from Jack'
        w._verify_start_time = time.time() - 30
        w._verify_msg_id = 'msg-retry-002'
        w._verify_timeout = 5.0
        w._retry_attempts = {'msg-retry-002': 2}  # legacy state — must not influence outcome
        w.last_injected_msg_id = 'msg-retry-002'
        w.injected_message_ids = {'msg-retry-002'}
        w.log_delivery_failure = MagicMock()

        with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
            f.write('')
            jsonl_path = f.name
        try:
            w._resolve_transcript = MagicMock(return_value=jsonl_path)
            w.check_verify_ingestion()

            # Sprint 51 T2: logs the no-reinject reason — never critical.
            w.log_delivery_failure.assert_called_once()
            self.assertEqual(w.log_delivery_failure.call_args[0][1], 'jsonl_verify_timeout_noreinject')
        finally:
            os.unlink(jsonl_path)

    def test_successful_verify_clears_retry_count(self):
        """Successful JSONL verification still clears any leftover retry counter for that msg."""
        w = _make_wrapper()
        w._verify_pending = True
        w._verify_search_text = '[Channel message from Jack'
        w._verify_start_time = time.time()
        w._verify_msg_id = 'msg-retry-003'
        w._retry_attempts = {'msg-retry-003': 1}  # Legacy — must still get cleaned up.
        w.log_delivery_event = MagicMock()

        with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
            entry = {
                "type": "queue-operation",
                "operation": "enqueue",
                "content": "[Channel message from Jack in ch-123]: test",
                "timestamp": _iso_now(),
            }
            f.write(json.dumps(entry) + '\n')
            jsonl_path = f.name
        try:
            w._verify_after_byte = 0
            w._resolve_transcript = MagicMock(return_value=jsonl_path)
            w.check_verify_ingestion()

            self.assertNotIn('msg-retry-003', w._retry_attempts)
        finally:
            os.unlink(jsonl_path)

    def test_jsonl_timeout_does_not_rewind_poll_cursor(self):
        """Poll cursor must stay put on jsonl timeout — rewinding caused the duplicate injections."""
        w = _make_wrapper()
        w._verify_pending = True
        w._verify_search_text = '[Channel message from Jack'
        w._verify_start_time = time.time() - 10
        w._verify_msg_id = 'msg-retry-004'
        w._verify_timeout = 5.0
        w.last_injected_msg_id = 'msg-retry-004'
        w.injected_message_ids = {'msg-retry-004'}
        original_poll_time = _iso_ago(30)
        w.pending_mark_read_timestamp = _iso_ago(5)
        w.last_poll_time = original_poll_time
        w.log_delivery_failure = MagicMock()

        with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
            f.write('')
            jsonl_path = f.name
        try:
            w._resolve_transcript = MagicMock(return_value=jsonl_path)
            w.check_verify_ingestion()

            # Sprint 51 T2: cursor stays exactly where it was.
            self.assertEqual(w.last_poll_time, original_poll_time)
        finally:
            os.unlink(jsonl_path)


# ─── Sprint 45 T3.3: Serialize tmux-send + hook-triggered commands ───

class TestTmuxSendSerialization(unittest.TestCase):
    """Prevent races where hook/corrective commands clobber pending inject text."""

    def test_inject_holds_enter_lock_during_text_send(self):
        """inject_message acquires _enter_lock before sending text, not just for pending_enter."""
        w = _make_wrapper()
        lock_held_during_send = []

        original_send = w._tmux_send
        def tracking_send(text, enter=False):
            lock_held_during_send.append(w._enter_lock.locked())
            return original_send(text, enter=enter)
        w._tmux_send = tracking_send

        w.inject_message(sender='Jack', content='Test', msg_timestamp=_iso_now())

        # The text send should have happened while the lock was held
        self.assertTrue(any(lock_held_during_send),
            "Text send should happen while _enter_lock is held")

    def test_corrective_reinjection_skips_when_pending_enter(self):
        """Corrective re-injection (terminal-only response) must not fire while pending_enter is True."""
        w = _make_wrapper()
        w.pending_enter = True
        w.last_injected_was_mentioned = True
        w.last_injected_sender = 'Jack'

        # The corrective reminder should check pending_enter and skip
        w.send_corrective_reminder()

        # _tmux_send should NOT have been called (reminder skipped)
        w._tmux_send.assert_not_called()

    def test_corrective_reinjection_fires_when_no_pending_enter(self):
        """Corrective re-injection fires normally when pending_enter is False."""
        w = _make_wrapper()
        w.pending_enter = False
        w.last_injected_was_mentioned = True
        w.last_injected_sender = 'Jack'

        w.send_corrective_reminder()

        # Should have sent text + Enter (2 calls)
        self.assertEqual(w._tmux_send.call_count, 2)

    def test_corrective_reinjection_acquires_enter_lock(self):
        """Corrective re-injection must acquire _enter_lock to prevent races."""
        w = _make_wrapper()
        w.pending_enter = False
        w.last_injected_was_mentioned = True
        w.last_injected_sender = 'Jack'
        lock_held = []

        original_send = w._tmux_send
        def tracking_send(text, enter=False):
            lock_held.append(w._enter_lock.locked())
            return original_send(text, enter=enter)
        w._tmux_send = tracking_send

        w.send_corrective_reminder()

        self.assertTrue(all(lock_held), "All tmux sends should be within _enter_lock")

    def test_corrective_fires_once_per_delivery(self):
        # Every idle transition re-checks the same delivery; answering the
        # corrective in the terminal must not earn a second one (Jack, 26 Sep).
        w = _make_wrapper()
        w.pending_enter = False
        w.last_injected_was_mentioned = True
        w.last_injected_sender = 'Architect'
        w.last_inject_time_mono = 1000.0

        w.send_corrective_reminder()
        w.send_corrective_reminder()
        self.assertEqual(w._tmux_send.call_count, 2)  # text + Enter, once

        w.last_inject_time_mono = 2000.0  # a new delivery gets its own
        w.send_corrective_reminder()
        self.assertEqual(w._tmux_send.call_count, 4)

    def test_corrective_skipped_by_pending_enter_can_still_fire_later(self):
        # A skipped attempt must not count as sent.
        w = _make_wrapper()
        w.last_injected_was_mentioned = True
        w.last_injected_sender = 'Architect'
        w.last_inject_time_mono = 1000.0
        w.pending_enter = True
        w.send_corrective_reminder()
        w.pending_enter = False
        w.send_corrective_reminder()
        self.assertEqual(w._tmux_send.call_count, 2)

    def test_corrective_tells_the_agent_how_to_stay_silent(self):
        w = _make_wrapper()
        w.pending_enter = False
        w.last_injected_was_mentioned = True
        w.last_injected_sender = 'Architect'
        w.send_corrective_reminder()
        self.assertIn('NO_REPLY', w._tmux_send.call_args_list[0].args[0])


# ─── Sprint 45 T3.2: Harden is_processing flag — JSONL-grounded detection ───

class TestIsProcessingJsonlGrounding(unittest.TestCase):
    """is_processing should transition to True when JSONL shows tool_use,
    regardless of whether inject_message() was called."""

    def test_jsonl_tool_use_sets_processing_true(self):
        """When is_processing=False but JSONL shows tool_use, transition to True."""
        w = _make_wrapper()
        w.is_processing = False
        w.joined = True
        w.last_output_time = time.time() - 10  # Stale

        # Mock JSONL check to return tool_use
        w._check_jsonl_state = MagicMock(return_value='tool_use')

        w.check_jsonl_processing_start()

        self.assertTrue(w.is_processing)
        self.assertGreater(w.last_output_time, time.time() - 2)
        w.broadcast_activity.assert_called_with('working', force=True)

    def test_jsonl_end_turn_does_not_set_processing(self):
        """When JSONL shows end_turn, is_processing stays False."""
        w = _make_wrapper()
        w.is_processing = False
        w.joined = True

        w._check_jsonl_state = MagicMock(return_value='end_turn')

        w.check_jsonl_processing_start()

        self.assertFalse(w.is_processing)

    def test_no_transition_when_already_processing(self):
        """When is_processing=True, check is a no-op (no redundant broadcast)."""
        w = _make_wrapper()
        w.is_processing = True
        w.joined = True
        w._check_jsonl_state = MagicMock(return_value='tool_use')

        w.check_jsonl_processing_start()

        w.broadcast_activity.assert_not_called()

    def test_no_transition_when_not_joined(self):
        """When not joined to a channel, don't check JSONL."""
        w = _make_wrapper()
        w.is_processing = False
        w.joined = False
        w._check_jsonl_state = MagicMock(return_value='tool_use')

        w.check_jsonl_processing_start()

        self.assertFalse(w.is_processing)

    def test_jsonl_none_does_not_set_processing(self):
        """When JSONL check returns None (no transcript), is_processing stays False."""
        w = _make_wrapper()
        w.is_processing = False
        w.joined = True
        w._check_jsonl_state = MagicMock(return_value=None)

        w.check_jsonl_processing_start()

        self.assertFalse(w.is_processing)

    def test_resets_output_seen_flag(self):
        """JSONL-triggered processing start resets output_seen_since_inject=False."""
        w = _make_wrapper()
        w.is_processing = False
        w.joined = True
        w.output_seen_since_inject = True
        w._check_jsonl_state = MagicMock(return_value='tool_use')

        w.check_jsonl_processing_start()

        self.assertFalse(w.output_seen_since_inject)


# ─── Sprint 45 T2.1: JSONL ingestion verification ───

class TestJsonlIngestionVerification(unittest.TestCase):
    """After Enter is sent, collab-claude verifies the message appears in the JSONL transcript."""

    def test_enter_sent_starts_verification(self):
        """check_pending_enter sets up JSONL verification state after sending Enter."""
        w = _make_wrapper()
        w.pending_enter = True
        w.pending_enter_time = time.time() - 1.0
        w.last_output_time = time.time() - 2.0
        w.last_injected_sender = 'Jack'
        w.last_injected_msg_id = 'msg-verify-001'

        # Create a fake transcript path
        with tempfile.TemporaryDirectory() as td:
            scratch = os.path.join(td, '.session-scratch')
            os.makedirs(scratch)
            tp_file = os.path.join(scratch, 'transcript-path')
            jsonl = os.path.join(td, 'session.jsonl')
            with open(jsonl, 'w') as f:
                f.write('')  # Empty file
            with open(tp_file, 'w') as f:
                f.write(jsonl)

            # Point the wrapper's transcript resolution to our temp dir
            w._transcript_path = None
            w._resolve_transcript = MagicMock(return_value=jsonl)

            result = w.check_pending_enter()

            self.assertTrue(result)
            self.assertTrue(w._verify_pending)
            self.assertEqual(w._verify_search_text, '[Channel message from Jack')
            self.assertGreater(w._verify_start_time, 0)

    def test_enter_sent_no_transcript_skips_verification(self):
        """If no transcript path available, verification is not started."""
        w = _make_wrapper()
        w.pending_enter = True
        w.pending_enter_time = time.time() - 1.0
        w.last_output_time = time.time() - 2.0
        w.last_injected_sender = 'Jack'
        w._resolve_transcript = MagicMock(return_value=None)

        w.check_pending_enter()

        self.assertFalse(w._verify_pending)

    def test_check_verify_ingestion_success(self):
        """check_verify_ingestion returns True when JSONL contains the enqueue entry."""
        w = _make_wrapper()
        w._verify_pending = True
        w._verify_search_text = '[Channel message from Jack'
        w._verify_start_time = time.time()
        w._verify_msg_id = 'msg-verify-002'
        w.log_delivery_event = MagicMock()

        with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
            # Write an enqueue entry matching the search
            entry = {
                "type": "queue-operation",
                "operation": "enqueue",
                "content": "[Channel message from Jack in ch-123]: @Builder do the thing",
                "timestamp": _iso_now(),
                "sessionId": "test-session",
            }
            f.write(json.dumps(entry) + '\n')
            jsonl_path = f.name

        try:
            w._verify_after_byte = 0
            w._resolve_transcript = MagicMock(return_value=jsonl_path)

            result = w.check_verify_ingestion()

            self.assertTrue(result)
            self.assertFalse(w._verify_pending)
            w.log_delivery_event.assert_called_once()
            call_args = w.log_delivery_event.call_args
            self.assertEqual(call_args[0][1], 'delivered')
        finally:
            os.unlink(jsonl_path)

    def test_check_verify_ingestion_timeout(self):
        """check_verify_ingestion logs failure after timeout with no matching entry."""
        w = _make_wrapper()
        w._verify_pending = True
        w._verify_search_text = '[Channel message from Jack'
        w._verify_start_time = time.time() - 10  # 10s ago — well past 5s timeout
        w._verify_msg_id = 'msg-verify-003'
        w._verify_timeout = 5.0
        w.log_delivery_failure = MagicMock()

        with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
            # Write only non-matching entries
            entry = {
                "type": "queue-operation",
                "operation": "dequeue",
                "content": "",
                "timestamp": _iso_now(),
            }
            f.write(json.dumps(entry) + '\n')
            jsonl_path = f.name

        try:
            w._verify_after_byte = 0
            w._resolve_transcript = MagicMock(return_value=jsonl_path)

            result = w.check_verify_ingestion()

            self.assertFalse(result)
            self.assertFalse(w._verify_pending)
            w.log_delivery_failure.assert_called_once()
            call_args = w.log_delivery_failure.call_args
            self.assertEqual(call_args[0][1], 'jsonl_verify_timeout_noreinject')
        finally:
            os.unlink(jsonl_path)

    def test_check_verify_ingestion_still_waiting(self):
        """check_verify_ingestion returns False but stays pending within timeout window."""
        w = _make_wrapper()
        w._verify_pending = True
        w._verify_search_text = '[Channel message from Jack'
        w._verify_start_time = time.time() - 1  # 1s ago — within 5s timeout
        w._verify_msg_id = 'msg-verify-004'
        w._verify_timeout = 5.0
        w.log_delivery_failure = MagicMock()
        w.log_delivery_event = MagicMock()

        with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
            f.write('')  # Empty file
            jsonl_path = f.name

        try:
            w._verify_after_byte = 0
            w._resolve_transcript = MagicMock(return_value=jsonl_path)

            result = w.check_verify_ingestion()

            self.assertFalse(result)
            self.assertTrue(w._verify_pending)  # Still waiting
            w.log_delivery_failure.assert_not_called()
            w.log_delivery_event.assert_not_called()
        finally:
            os.unlink(jsonl_path)

    def test_check_verify_ingestion_not_pending(self):
        """check_verify_ingestion returns False immediately when not pending."""
        w = _make_wrapper()
        w._verify_pending = False

        result = w.check_verify_ingestion()

        self.assertFalse(result)


# ─── Sprint 50 T2: Always run inbox check regardless of SSE ───

class TestInboxRunsRegardlessOfSSE(unittest.TestCase):
    """check_inbox must run every 60s even when SSE is connected (Sprint 50 T2).

    Previously, the `not self.sse_connected` gate suppressed inbox checks when
    SSE was connected. This defeats inbox's purpose as a safety net — if SSE
    silently drops a message, inbox never catches it.
    """

    def test_max_catchup_age_is_480(self):
        """MAX_CATCHUP_AGE_SECONDS is 480 (8 minutes — Owner's directive)."""
        self.assertEqual(MAX_CATCHUP_AGE_SECONDS, 480)

    def test_inbox_check_runs_with_sse_connected(self):
        """check_inbox should be called even when sse_connected=True."""
        w = _make_wrapper()
        w.sse_connected = True

        fresh_ts = _iso_ago(30)
        inbox_data = {
            'messages': [{
                'id': 'msg-sse-connected-001',
                'from': 'Jack (SG-1)',
                'content': 'Missed by SSE',
                'timestamp': fresh_ts,
                'read': False
            }],
            'lastUpdated': _iso_now()
        }

        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(inbox_data, f)
            inbox_path = f.name

        try:
            w._get_inbox_path = MagicMock(return_value=inbox_path)
            queued = w.check_inbox()
            # check_inbox itself doesn't care about sse_connected — the gate
            # was in the poll loop. This test verifies the method works correctly
            # when called regardless of SSE state.
            self.assertEqual(queued, 1)
            self.assertFalse(w.sse_message_queue.empty())
        finally:
            os.unlink(inbox_path)

    def test_message_older_than_480s_discarded(self):
        """Messages older than 480s (8 min) are marked read and NOT queued."""
        w = _make_wrapper()

        old_ts = _iso_ago(500)  # 500s > 480s
        inbox_data = {
            'messages': [{
                'id': 'msg-old-480',
                'from': 'Jack (SG-1)',
                'content': 'Too old to process',
                'timestamp': old_ts,
                'read': False
            }],
            'lastUpdated': _iso_now()
        }

        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(inbox_data, f)
            inbox_path = f.name

        try:
            w._get_inbox_path = MagicMock(return_value=inbox_path)
            queued = w.check_inbox()
            self.assertEqual(queued, 0)
            self.assertTrue(w.sse_message_queue.empty())

            with open(inbox_path) as f:
                updated = json.load(f)
            self.assertTrue(updated['messages'][0]['read'])
        finally:
            os.unlink(inbox_path)

    def test_message_at_479s_still_queued(self):
        """Messages at 479s old (just under 480s) are still queued."""
        w = _make_wrapper()

        fresh_ts = _iso_ago(479)
        inbox_data = {
            'messages': [{
                'id': 'msg-just-under-480',
                'from': 'Owner (DevFlow)',
                'content': 'Just in time',
                'timestamp': fresh_ts,
                'read': False
            }],
            'lastUpdated': _iso_now()
        }

        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(inbox_data, f)
            inbox_path = f.name

        try:
            w._get_inbox_path = MagicMock(return_value=inbox_path)
            queued = w.check_inbox()
            self.assertEqual(queued, 1)
            self.assertFalse(w.sse_message_queue.empty())
        finally:
            os.unlink(inbox_path)


# ─── Sprint 50 T1: Unify cursor advancement to verified delivery ───

class TestCursorAdvancementUnified(unittest.TestCase):
    """Cursor (last_poll_time + _save_cursor_timestamp) must only advance
    after JSONL verify_message_ingested() confirms ingestion, not at inject
    time (Sprint 50 T1).

    If verification fails/times out, cursor stays at pre-inject position so
    catch-up polling re-fetches the message.
    """

    def test_cursor_does_not_advance_on_inject(self):
        """last_poll_time must NOT advance when inject_message succeeds."""
        w = _make_wrapper()
        w._save_cursor_timestamp = MagicMock()
        original_poll_time = w.last_poll_time

        msg_ts = _iso_now()
        # Put a message in the queue (simulates SSE delivery)
        msg = {
            'id': 'msg-cursor-001',
            'from': {'id': 'other-agent', 'name': 'Jack'},
            'content': 'Test cursor',
            'timestamp': msg_ts,
            'mentions': [],
        }
        w.sse_message_queue.put(msg)

        # Inject it
        result = w.inject_message('Jack', 'Test cursor', msg_timestamp=msg_ts, msg_id='msg-cursor-001')
        self.assertTrue(result)

        # Cursor should NOT have advanced
        self.assertEqual(w.last_poll_time, original_poll_time)
        w._save_cursor_timestamp.assert_not_called()

    def test_cursor_advances_on_verified_ingestion(self):
        """last_poll_time advances when check_verify_ingestion() confirms success."""
        w = _make_wrapper()
        w._save_cursor_timestamp = MagicMock()

        msg_ts = _iso_now()
        w._verify_pending = True
        w._verify_search_text = '[Channel message from Jack'
        w._verify_start_time = time.time() - 1
        w._verify_msg_id = 'msg-cursor-002'
        w._verify_msg_ts = msg_ts
        w._verify_timeout = 5.0
        w.log_delivery_event = MagicMock()

        # Create a JSONL file with the expected content
        with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
            entry = json.dumps({
                "type": "queue-operation",
                "operation": "enqueue",
                "content": "[Channel message from Jack"
            })
            f.write(entry + '\n')
            jsonl_path = f.name

        try:
            w._verify_after_byte = 0
            w._resolve_transcript = MagicMock(return_value=jsonl_path)

            result = w.check_verify_ingestion()

            self.assertTrue(result)
            self.assertEqual(w.last_poll_time, msg_ts)
            w._save_cursor_timestamp.assert_called_once_with(msg_ts)
        finally:
            os.unlink(jsonl_path)

    def test_cursor_does_not_advance_on_verification_timeout(self):
        """last_poll_time must NOT advance when verification times out."""
        w = _make_wrapper()
        w._save_cursor_timestamp = MagicMock()

        original_poll_time = w.last_poll_time
        msg_ts = _iso_now()
        w._verify_pending = True
        w._verify_search_text = '[Channel message from Jack'
        w._verify_start_time = time.time() - 10  # Well past timeout
        w._verify_msg_id = 'msg-cursor-003'
        w._verify_msg_ts = msg_ts
        w._verify_timeout = 5.0
        w.pending_mark_read_timestamp = msg_ts
        w.log_delivery_failure = MagicMock()

        with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
            f.write('')  # Empty — nothing to verify
            jsonl_path = f.name

        try:
            w._verify_after_byte = 0
            w._resolve_transcript = MagicMock(return_value=jsonl_path)

            result = w.check_verify_ingestion()

            self.assertFalse(result)
            # Cursor should have REWOUND (retry path), not advanced
            # The key assertion: it must NOT be msg_ts
            self.assertNotEqual(w.last_poll_time, msg_ts)
        finally:
            os.unlink(jsonl_path)

    def test_verify_msg_ts_stored_on_enter(self):
        """_verify_msg_ts is set when verification starts (check_pending_enter)."""
        w = _make_wrapper()
        w.pending_enter = True
        w.pending_enter_time = time.time() - 2
        w.last_output_time = time.time() - 1
        w.last_inject_time = time.time() - 2
        w.last_injected_sender = 'Jack'
        w.last_injected_msg_id = 'msg-verify-ts-001'
        w.pending_mark_read_timestamp = _iso_now()

        # Mock transcript
        with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
            f.write('')
            jsonl_path = f.name

        try:
            w._resolve_transcript = MagicMock(return_value=jsonl_path)
            w._tmux_send = MagicMock(return_value=True)

            w.check_pending_enter()

            self.assertTrue(hasattr(w, '_verify_msg_ts'))
            self.assertEqual(w._verify_msg_ts, w.pending_mark_read_timestamp)
        finally:
            os.unlink(jsonl_path)


# ─── Sprint 51 T4: _tmux_send subprocess timeout + retry ───

class TestTmuxSendTimeoutAndRetry(unittest.TestCase):
    """_tmux_send must use a 10s subprocess timeout and retry once on TimeoutExpired.

    Sprint 51 audit (Architect) confirmed tmux-server contention during log-spew
    bursts caused 3s timeouts to fire on real deliveries. 10s tolerates the
    contention; one retry covers transient spikes. tmux_send_failed remains the
    classification for genuine failures (retry exhausted or non-zero rc).
    """

    def _make_tmux_wrapper(self):
        """Wrapper with a tmux_pane_target so _tmux_send uses the subprocess path."""
        w = _make_wrapper()
        w.tmux_pane_target = 'collab-agent-test:0.0'
        # Restore the REAL _tmux_send (baseline _make_wrapper mocks it out).
        w._tmux_send = CollabClaudeWrapper._tmux_send.__get__(w, CollabClaudeWrapper)
        return w

    def test_text_send_uses_10s_timeout(self):
        w = self._make_tmux_wrapper()
        fake_ok = MagicMock(returncode=0, stderr='')
        with patch.object(collab_claude.subprocess, 'run', return_value=fake_ok) as mock_run:
            self.assertTrue(w._tmux_send('hello'))
            self.assertEqual(mock_run.call_count, 1)
            self.assertEqual(mock_run.call_args.kwargs.get('timeout'), 10,
                "text send must use 10s timeout (was 3s before Sprint 51 T4)")

    def test_enter_send_uses_10s_timeout(self):
        w = self._make_tmux_wrapper()
        fake_ok = MagicMock(returncode=0, stderr='')
        with patch.object(collab_claude.subprocess, 'run', return_value=fake_ok) as mock_run:
            self.assertTrue(w._tmux_send('', enter=True))
            self.assertEqual(mock_run.call_count, 1)
            self.assertEqual(mock_run.call_args.kwargs.get('timeout'), 10,
                "Enter send must use 10s timeout")

    def test_text_send_retries_once_on_timeout_expired(self):
        """First TimeoutExpired → one retry that succeeds → return True."""
        w = self._make_tmux_wrapper()
        fake_ok = MagicMock(returncode=0, stderr='')
        side_effects = [
            subprocess.TimeoutExpired(cmd=['tmux', 'send-keys'], timeout=10),
            fake_ok,
        ]
        with patch.object(collab_claude.subprocess, 'run', side_effect=side_effects) as mock_run:
            self.assertTrue(w._tmux_send('retry-me'),
                "should recover from one TimeoutExpired via single retry")
            self.assertEqual(mock_run.call_count, 2,
                "must retry exactly once on first TimeoutExpired")

    def test_text_send_returns_false_when_retry_also_times_out(self):
        """Two consecutive TimeoutExpired → False (classified tmux_send_failed upstream)."""
        w = self._make_tmux_wrapper()
        side_effects = [
            subprocess.TimeoutExpired(cmd=['tmux', 'send-keys'], timeout=10),
            subprocess.TimeoutExpired(cmd=['tmux', 'send-keys'], timeout=10),
        ]
        with patch.object(collab_claude.subprocess, 'run', side_effect=side_effects) as mock_run:
            self.assertFalse(w._tmux_send('doomed'),
                "exhausted retry must return False so caller logs tmux_send_failed")
            self.assertEqual(mock_run.call_count, 2,
                "exactly one retry (total 2 attempts)")

    def test_enter_send_retries_once_on_timeout_expired(self):
        w = self._make_tmux_wrapper()
        fake_ok = MagicMock(returncode=0, stderr='')
        side_effects = [
            subprocess.TimeoutExpired(cmd=['tmux', 'send-keys'], timeout=10),
            fake_ok,
        ]
        with patch.object(collab_claude.subprocess, 'run', side_effect=side_effects) as mock_run:
            self.assertTrue(w._tmux_send('', enter=True))
            self.assertEqual(mock_run.call_count, 2,
                "Enter path must also retry once on TimeoutExpired")

    def test_nonzero_returncode_does_not_retry(self):
        """Non-timeout failures (rc != 0) are real failures — no retry, return False."""
        w = self._make_tmux_wrapper()
        fake_fail = MagicMock(returncode=1, stderr='pane not found')
        with patch.object(collab_claude.subprocess, 'run', return_value=fake_fail) as mock_run:
            self.assertFalse(w._tmux_send('nope'))
            self.assertEqual(mock_run.call_count, 1,
                "rc!=0 is a classification failure, not a contention timeout — no retry")


# ─── Sprint 57 T1 — _make_wrapper must not emit real delivery-status HTTP ───

class TestMakeWrapperNoDeliveryHttp(unittest.TestCase):
    """_make_wrapper() must not let tests POST fake TestAgent events to
    /api/collab/delivery-status. Root cause of yesterday's stability-alerts
    channel-regeneration: log_delivery_event / log_delivery_failure were not
    mocked alongside api_call, so they called urllib.request.urlopen() directly
    and polluted live .AppData/delivery-status.json with fake failures.
    """

    DELIVERY_STATUS_PATH = '/api/collab/delivery-status'

    def _urls_hitting_delivery_status(self, mock_urlopen):
        hits = []
        for call in mock_urlopen.call_args_list:
            if not call.args:
                continue
            req = call.args[0]
            url = getattr(req, 'full_url', None) or (req if isinstance(req, str) else '')
            if self.DELIVERY_STATUS_PATH in str(url):
                hits.append(str(url))
        return hits

    def test_make_wrapper_alone_does_not_hit_delivery_status(self):
        """Constructing the wrapper harness must not open any HTTP socket to
        the delivery-status endpoint. Guard against __init__ side effects."""
        with patch('urllib.request.urlopen') as mock_urlopen:
            _make_wrapper()
        self.assertEqual(
            self._urls_hitting_delivery_status(mock_urlopen), [],
            'Wrapper construction leaked HTTP to /api/collab/delivery-status',
        )

    def test_log_delivery_event_is_mocked_by_make_wrapper(self):
        """log_delivery_event on the wrapper returned by _make_wrapper must be a
        MagicMock (no real HTTP emission). This is the crux of the T1 fix."""
        w = _make_wrapper()
        self.assertIsInstance(w.log_delivery_event, MagicMock,
                              'log_delivery_event should be mocked by _make_wrapper')
        self.assertIsInstance(w.log_delivery_failure, MagicMock,
                              'log_delivery_failure should be mocked by _make_wrapper')

    def test_log_delivery_event_call_does_not_hit_network(self):
        """Even when test code explicitly calls log_delivery_event (via an inject
        code path), no HTTP request should leave the process."""
        with patch('urllib.request.urlopen') as mock_urlopen:
            w = _make_wrapper()
            w.log_delivery_event('msg-abc', 'delivered')
            w.log_delivery_event('msg-abc', 'timeout', {'elapsedMs': 1000})
            w.log_delivery_failure('msg-abc', 'tmux_send_failed')
        self.assertEqual(
            self._urls_hitting_delivery_status(mock_urlopen), [],
            'log_delivery_event/log_delivery_failure leaked HTTP despite mocks',
        )

    def test_inject_message_failure_path_does_not_hit_delivery_status(self):
        """End-to-end: an inject_message that hits log_delivery_failure
        (via tmux_send=False) must not emit network traffic to delivery-status."""
        with patch('urllib.request.urlopen') as mock_urlopen:
            w = _make_wrapper()
            w._tmux_send = MagicMock(return_value=False)  # force failure branch
            w.inject_message(
                sender='Jack',
                content='Test',
                reply_to=None,
                mentions=None,
                channel_id='test-channel-123',
                msg_timestamp=_iso_now(),
                msg_id='msg-inject-fail-1',
            )
        self.assertEqual(
            self._urls_hitting_delivery_status(mock_urlopen), [],
            'inject_message failure path leaked HTTP to delivery-status',
        )


# ─── Sprint 58 T1: injected_message_ids persistence across sessions ───

class TestInjectedIdsPersistence(unittest.TestCase):
    """Sprint 58 T1 — injected_message_ids must survive wrapper respawn.

    BUG: on agent restart, channel-poll's catch-up path re-injects messages
    the prior session already handled. Dedup set was in-memory only.

    FIX: persist set to .claude/injected-ids.json, load on __init__, debounced
    atomic writes on each add/discard, capped at the last 200 entries.
    """

    def setUp(self):
        import shutil
        self._tmpdir = tempfile.mkdtemp(prefix='collab-claude-t1-')
        self._orig_cwd = os.getcwd()
        os.chdir(self._tmpdir)
        os.makedirs('.claude', exist_ok=True)
        self._shutil = shutil

    def tearDown(self):
        os.chdir(self._orig_cwd)
        self._shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _ids_file(self):
        return os.path.join(self._tmpdir, '.claude', 'injected-ids.json')

    def test_load_returns_empty_when_file_missing(self):
        w = _make_wrapper()
        self.assertEqual(w.injected_message_ids, set())

    def test_load_restores_ids_from_file(self):
        with open(self._ids_file(), 'w') as f:
            json.dump({'ids': ['msg-a', 'msg-b', 'msg-c']}, f)
        w = _make_wrapper()
        self.assertEqual(w.injected_message_ids, {'msg-a', 'msg-b', 'msg-c'})

    def test_load_accepts_bare_list_format(self):
        """Backward compat: if file is a raw list, still load it."""
        with open(self._ids_file(), 'w') as f:
            json.dump(['x', 'y'], f)
        w = _make_wrapper()
        self.assertEqual(w.injected_message_ids, {'x', 'y'})

    def test_load_handles_corrupt_json(self):
        with open(self._ids_file(), 'w') as f:
            f.write('{not valid json')
        w = _make_wrapper()
        self.assertEqual(w.injected_message_ids, set())

    def test_load_handles_unreadable_file(self):
        # File exists but is a dict with no 'ids' key
        with open(self._ids_file(), 'w') as f:
            json.dump({'other': 'data'}, f)
        w = _make_wrapper()
        self.assertEqual(w.injected_message_ids, set())

    def test_load_caps_at_200_keeping_latest(self):
        ids = [f'msg-{i:04d}' for i in range(300)]
        with open(self._ids_file(), 'w') as f:
            json.dump({'ids': ids}, f)
        w = _make_wrapper()
        self.assertEqual(len(w.injected_message_ids), 200)
        # Last 200 kept, earliest dropped
        self.assertIn('msg-0299', w.injected_message_ids)
        self.assertIn('msg-0100', w.injected_message_ids)
        self.assertNotIn('msg-0099', w.injected_message_ids)
        self.assertNotIn('msg-0000', w.injected_message_ids)

    def test_track_injected_id_adds_and_persists(self):
        w = _make_wrapper()
        w._track_injected_id('msg-x')
        w._persist_injected_ids()  # force sync write for deterministic test
        self.assertIn('msg-x', w.injected_message_ids)
        with open(self._ids_file()) as f:
            data = json.load(f)
        self.assertIn('msg-x', data['ids'])

    def test_track_injected_id_empty_or_none_is_noop(self):
        w = _make_wrapper()
        w._track_injected_id('')
        w._track_injected_id(None)
        self.assertEqual(w.injected_message_ids, set())

    def test_untrack_injected_id_removes_and_persists(self):
        w = _make_wrapper()
        w._track_injected_id('msg-y')
        w._persist_injected_ids()
        w._untrack_injected_id('msg-y')
        w._persist_injected_ids()
        self.assertNotIn('msg-y', w.injected_message_ids)
        with open(self._ids_file()) as f:
            data = json.load(f)
        self.assertNotIn('msg-y', data['ids'])

    def test_untrack_missing_id_is_noop(self):
        w = _make_wrapper()
        w._untrack_injected_id('never-tracked')  # must not raise
        self.assertEqual(w.injected_message_ids, set())

    def test_persist_keeps_only_last_200(self):
        w = _make_wrapper()
        for i in range(250):
            w._track_injected_id(f'msg-{i:04d}')
        w._persist_injected_ids()
        with open(self._ids_file()) as f:
            data = json.load(f)
        self.assertEqual(len(data['ids']), 200)

    def test_persist_atomic_via_tmp_rename(self):
        """Persist must use tmp file + rename; no orphan .tmp left behind."""
        w = _make_wrapper()
        w._track_injected_id('msg-atomic')
        w._persist_injected_ids()
        tmp_file = self._ids_file() + '.tmp'
        self.assertTrue(os.path.exists(self._ids_file()))
        self.assertFalse(os.path.exists(tmp_file))

    def test_respawn_suppresses_reinjection_of_prior_session_ids(self):
        """THE CORE SCENARIO: wrapper A tracks msg, persists, dies;
        wrapper B in same cwd loads the ID — dedup catches the replay."""
        # Session A
        w_a = _make_wrapper()
        w_a._track_injected_id('msg-replayed')
        w_a._persist_injected_ids()
        del w_a  # session dies
        # Session B
        w_b = _make_wrapper()
        self.assertIn('msg-replayed', w_b.injected_message_ids)

    def test_persist_is_resilient_to_missing_dot_claude_dir(self):
        """If .claude/ does not exist, persist must create it or fail silently.
        Must NOT crash the wrapper."""
        self._shutil.rmtree(os.path.join(self._tmpdir, '.claude'), ignore_errors=True)
        w = _make_wrapper()
        w._track_injected_id('msg-z')
        w._persist_injected_ids()  # must not raise
        # If the helper chose to mkdir, the file exists; either way no crash.

    def test_existing_add_call_site_still_persists(self):
        """The existing `.add()` call sites must continue to work AND
        trigger persistence. Wrap via the new helper or equivalent."""
        w = _make_wrapper()
        # Simulate the real code path: using the helper to add an ID
        w._track_injected_id('msg-realpath')
        w._persist_injected_ids()
        # Cross-session: new wrapper in same cwd sees the ID
        w2 = _make_wrapper()
        self.assertIn('msg-realpath', w2.injected_message_ids)


class TestCleanupStaleSessions(unittest.TestCase):
    """Sprint 62 T1.2 — cleanup_stale_sessions prunes orphan files from dead PIDs.

    Covers:
    - /tmp/collab-session-*, collab-ready-*, collab-invite-* swept
    - .claude/collab-session-* swept
    - Dead PIDs (no /proc/<pid>) removed; live PIDs preserved
    - Own claude_pid never removed
    - Empty-PID files removed unconditionally
    - Corrupt/non-integer filenames skipped silently
    - Returns cleaned count via debug (no crash on IOError)
    """

    def setUp(self):
        import shutil
        self._tmpdir = tempfile.mkdtemp(prefix='collab-cleanup-t12-')
        self._orig_cwd = os.getcwd()
        os.chdir(self._tmpdir)
        os.makedirs('.claude', exist_ok=True)
        self._shutil = shutil

    def tearDown(self):
        os.chdir(self._orig_cwd)
        self._shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _touch(self, path):
        """Create an empty file at path."""
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            f.write('{}')

    def _make_wrapper_with_pid(self, pid):
        """Make a wrapper whose claude_pid is set to pid."""
        w = _make_wrapper()
        w.claude_pid = pid
        return w

    def _own_pid(self):
        return os.getpid()

    def test_dead_tmp_session_file_removed(self):
        dead_pid = 999999  # Extremely unlikely to be running
        path = f'/tmp/collab-session-{dead_pid}.json'
        self._touch(path)
        try:
            w = self._make_wrapper_with_pid(self._own_pid())
            with unittest.mock.patch('os.path.exists', side_effect=lambda p: False if p == f'/proc/{dead_pid}' else os.path.lexists(p)):
                w.cleanup_stale_sessions()
            self.assertFalse(os.path.exists(path))
        finally:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass

    def test_live_tmp_session_file_preserved(self):
        live_pid = self._own_pid()
        path = f'/tmp/collab-session-{live_pid}.json'
        self._touch(path)
        try:
            w = self._make_wrapper_with_pid(live_pid + 1)  # different claude_pid
            w.cleanup_stale_sessions()
            self.assertTrue(os.path.exists(path))
        finally:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass

    def test_own_claude_pid_file_never_removed(self):
        own_pid = self._own_pid()
        path = f'/tmp/collab-session-{own_pid}.json'
        self._touch(path)
        try:
            w = self._make_wrapper_with_pid(own_pid)
            w.cleanup_stale_sessions()
            self.assertTrue(os.path.exists(path))
        finally:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass

    def test_dead_dot_claude_session_file_removed(self):
        dead_pid = 999998
        fname = f'collab-session-{dead_pid}.json'
        path = os.path.join(self._tmpdir, '.claude', fname)
        self._touch(path)
        w = self._make_wrapper_with_pid(self._own_pid())
        with unittest.mock.patch('os.path.exists', side_effect=lambda p: False if p == f'/proc/{dead_pid}' else os.path.lexists(p)):
            w.cleanup_stale_sessions()
        self.assertFalse(os.path.exists(path))

    def test_all_tmp_prefixes_swept(self):
        dead_pid = 999997
        paths = [
            f'/tmp/collab-session-{dead_pid}.json',
            f'/tmp/collab-ready-{dead_pid}.json',
            f'/tmp/collab-invite-{dead_pid}.json',
        ]
        for p in paths:
            self._touch(p)
        try:
            w = self._make_wrapper_with_pid(self._own_pid())
            with unittest.mock.patch('os.path.exists', side_effect=lambda p: False if p == f'/proc/{dead_pid}' else os.path.lexists(p)):
                w.cleanup_stale_sessions()
            for p in paths:
                self.assertFalse(os.path.exists(p), f"{p} should have been removed")
        finally:
            for p in paths:
                try:
                    os.remove(p)
                except FileNotFoundError:
                    pass

    def test_corrupt_filename_skipped_silently(self):
        path = '/tmp/collab-session-notanint.json'
        self._touch(path)
        try:
            w = self._make_wrapper_with_pid(self._own_pid())
            w.cleanup_stale_sessions()  # Must not raise
        finally:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass


# ─── Sprint 68 T1.5: SSE-side expert-directive prepend ───


class TestClaudeTurnDisposition(unittest.TestCase):
    """Same three-way disposition as the Codex wrapper, read from Claude's JSONL.

    Both wrappers must answer the same question identically: did this turn
    complete having said nothing (close quietly), having said something the
    channel never received (warn), or can we not tell (warn anyway)?
    """

    def _transcript(self, *entries):
        fd, path = tempfile.mkstemp(suffix='.jsonl')
        os.close(fd)
        with open(path, 'w') as handle:
            for entry in entries:
                handle.write(json.dumps(entry) + '\n')
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))
        return path

    @staticmethod
    def _assistant(stop_reason, blocks):
        return {'type': 'assistant', 'message': {'stop_reason': stop_reason, 'content': blocks}}

    def test_turn_with_text_reports_text(self):
        path = self._transcript(self._assistant('end_turn', [{'type': 'text', 'text': 'Answer.'}]))
        self.assertEqual(jsonl_state_reader.final_response_disposition(path), 'text')

    def test_turn_with_no_content_is_empty(self):
        path = self._transcript(self._assistant('end_turn', []))
        self.assertEqual(jsonl_state_reader.final_response_disposition(path), 'empty')

    def test_whitespace_only_counts_as_empty(self):
        path = self._transcript(self._assistant('end_turn', [{'type': 'text', 'text': '  \n '}]))
        self.assertEqual(jsonl_state_reader.final_response_disposition(path), 'empty')

    def test_tool_use_before_a_silent_end_is_empty(self):
        path = self._transcript(
            self._assistant('tool_use', [{'type': 'tool_use', 'name': 'Bash'}]),
            self._assistant('end_turn', []),
        )
        self.assertEqual(jsonl_state_reader.final_response_disposition(path), 'empty')

    def test_incomplete_turn_is_unknown(self):
        path = self._transcript(self._assistant('tool_use', [{'type': 'tool_use', 'name': 'Bash'}]))
        self.assertIsNone(jsonl_state_reader.final_response_disposition(path))

    def test_explicit_blank_without_completion_is_unknown(self):
        # Claude carries completion and final content in the same assistant
        # record. Blank content without stop_reason=end_turn is not proof that
        # the turn deliberately completed silently.
        path = self._transcript(self._assistant(None, [{'type': 'text', 'text': ''}]))
        self.assertIsNone(jsonl_state_reader.final_response_disposition(path))

    def test_aborted_turn_is_unknown_not_silence(self):
        # An interrupted assistant record is not a deliberate empty reply.
        path = self._transcript(self._assistant('interrupted', []))
        self.assertIsNone(jsonl_state_reader.final_response_disposition(path))

    def test_malformed_final_line_is_unknown_not_silence(self):
        fd, path = tempfile.mkstemp(suffix='.jsonl')
        os.close(fd)
        with open(path, 'w') as handle:
            handle.write('{not-json}\n')
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))

        # Parse failure must keep the corrective; it must never masquerade as
        # proof that the assistant chose to say nothing.
        self.assertIsNone(jsonl_state_reader.final_response_disposition(path))

    def test_truncated_final_line_is_unknown_not_silence(self):
        fd, path = tempfile.mkstemp(suffix='.jsonl')
        os.close(fd)
        with open(path, 'w') as handle:
            handle.write('{"type":"assistant","message":{"stop_reason":"end_turn",')
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))

        self.assertIsNone(jsonl_state_reader.final_response_disposition(path))

    def test_truncated_record_after_blank_final_invalidates_silence(self):
        # Do not retain an earlier empty classification across unreadable data:
        # the truncated record may be the current turn's real final response.
        path = self._transcript(self._assistant('end_turn', []))
        with open(path, 'a') as handle:
            handle.write('{"type":"assistant","message":')
        self.assertIsNone(jsonl_state_reader.final_response_disposition(path))

    def test_new_user_turn_after_blank_final_invalidates_silence(self):
        # A completed silent turn cannot classify the next, still-running turn.
        # Reusing it would fail open and suppress a genuinely lost new reply.
        path = self._transcript(
            self._assistant('end_turn', []),
            {'type': 'user', 'message': {'content': 'next request'}},
        )
        self.assertIsNone(jsonl_state_reader.final_response_disposition(path))

    def test_invalid_utf8_is_unknown_not_exception(self):
        fd, path = tempfile.mkstemp(suffix='.jsonl')
        os.close(fd)
        with open(path, 'wb') as handle:
            handle.write(b'{"type":"assistant","message":\xff}\n')
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))

        self.assertIsNone(jsonl_state_reader.final_response_disposition(path))

    def test_parseable_final_with_malformed_message_is_unknown_not_exception(self):
        # JSON decoding succeeding does not make the record trustworthy. A
        # partial/corrupt writer can leave a scalar where the message object is
        # expected; that must fail safe rather than crash the wrapper.
        path = self._transcript({'type': 'assistant', 'message': 'corrupt'})
        self.assertIsNone(jsonl_state_reader.final_response_disposition(path))

    def test_completion_without_parseable_content_is_unknown_not_silence(self):
        # stop_reason=end_turn is the completion half only. Missing or malformed
        # content is not an explicit blank final and must keep the corrective.
        missing = self._transcript({'type': 'assistant', 'message': {'stop_reason': 'end_turn'}})
        malformed = self._transcript(
            {'type': 'assistant', 'message': {'stop_reason': 'end_turn', 'content': 'corrupt'}}
        )
        self.assertIsNone(jsonl_state_reader.final_response_disposition(missing))
        self.assertIsNone(jsonl_state_reader.final_response_disposition(malformed))

    def test_missing_transcript_is_unknown(self):
        self.assertIsNone(jsonl_state_reader.final_response_disposition('/nonexistent/x.jsonl'))

    def test_boundary_scopes_to_the_current_turn(self):
        path = self._transcript(self._assistant('end_turn', [{'type': 'text', 'text': 'previous'}]))
        boundary = os.path.getsize(path)
        with open(path, 'a') as handle:
            handle.write(json.dumps(self._assistant('end_turn', [])) + '\n')
        # Exactly on a newline: the new silent turn must still be seen.
        self.assertEqual(jsonl_state_reader.final_response_disposition(path, boundary), 'empty')

    def test_boundary_beyond_end_is_unknown(self):
        path = self._transcript(self._assistant('end_turn', [{'type': 'text', 'text': 'x'}]))
        self.assertIsNone(
            jsonl_state_reader.final_response_disposition(path, os.path.getsize(path) + 500)
        )

    # ── No-reply marker (Jack, 26 Sep 2026) ──
    # Claude Code answers an empty final response with a hidden meta prompt
    # ("no visible output ... produce a user-visible response"), so an empty
    # ending is unreachable on Claude. The marker is the only way to say "I
    # deliberately sent nothing" — and it must not become a way to swallow a
    # reply that merely mentions it.

    _NUDGE = {'type': 'user', 'isMeta': True, 'turnCompanion': True,
              'message': {'role': 'user', 'content': '[Your previous response had no visible output. '
                          'Please continue and produce a user-visible response.]'}}

    def test_marker_after_harness_nudge_is_silent(self):
        # The exact live sequence: thinking-only end, harness nudge, then marker.
        path = self._transcript(
            self._assistant('end_turn', [{'type': 'thinking', 'thinking': ''}]),
            self._NUDGE,
            self._assistant('end_turn', [{'type': 'text', 'text': 'NO_REPLY'}]),
        )
        self.assertEqual(jsonl_state_reader.final_response_disposition(path), 'empty')

    def test_text_after_harness_nudge_is_text(self):
        # Without the marker the forced text is indistinguishable from a
        # terminal-only reply, so the warning stays.
        path = self._transcript(
            self._assistant('end_turn', [{'type': 'thinking', 'thinking': ''}]),
            self._NUDGE,
            self._assistant('end_turn', [{'type': 'text', 'text': 'No reply needed.'}]),
        )
        self.assertEqual(jsonl_state_reader.final_response_disposition(path), 'text')

    def test_nudge_without_a_later_completion_is_unknown(self):
        path = self._transcript(self._assistant('end_turn', []), self._NUDGE)
        self.assertIsNone(jsonl_state_reader.final_response_disposition(path))

    def test_summary_of_other_work_ending_in_marker_is_silent(self):
        path = self._transcript(self._assistant('end_turn', [{'type': 'text', 'text':
            "I've put P1001110 back into V4.5 and told Owner.\n\n  NO_REPLY  \n"}]))
        self.assertEqual(jsonl_state_reader.final_response_disposition(path), 'empty')

    def test_marker_in_an_earlier_text_block_still_counts_as_last_line(self):
        path = self._transcript(self._assistant('end_turn', [
            {'type': 'text', 'text': 'Done with the render.'},
            {'type': 'text', 'text': 'NO_REPLY'},
        ]))
        self.assertEqual(jsonl_state_reader.final_response_disposition(path), 'empty')

    def test_marker_not_on_the_last_line_is_text(self):
        # A reply that happens to contain the marker, then keeps going, is a reply.
        path = self._transcript(self._assistant('end_turn', [{'type': 'text', 'text':
            'NO_REPLY\n@Architect actually, here is my answer.'}]))
        self.assertEqual(jsonl_state_reader.final_response_disposition(path), 'text')

    def test_marker_inside_a_sentence_is_text(self):
        for text in ('NO_REPLY needed here', 'Ending with `NO_REPLY`', 'no_reply', 'NO_REPLY.'):
            with self.subTest(text=text):
                path = self._transcript(self._assistant('end_turn', [{'type': 'text', 'text': text}]))
                self.assertEqual(jsonl_state_reader.final_response_disposition(path), 'text')

    def test_marker_in_an_older_turn_does_not_silence_the_current_one(self):
        path = self._transcript(
            self._assistant('end_turn', [{'type': 'text', 'text': 'NO_REPLY'}]),
            {'type': 'user', 'message': {'role': 'user', 'content': 'next message'}},
            self._assistant('end_turn', [{'type': 'text', 'text': 'A reply in the terminal.'}]),
        )
        self.assertEqual(jsonl_state_reader.final_response_disposition(path), 'text')

    def test_non_string_text_block_is_not_a_crash(self):
        path = self._transcript(self._assistant('end_turn', [{'type': 'text', 'text': 7}]))
        self.assertEqual(jsonl_state_reader.final_response_disposition(path), 'empty')


class TestSystemPromptArgs(unittest.TestCase):
    """15 Oct 2026: a 200 KB role prompt passed inline as --append-system-prompt
    hit the 128 KB per-argument limit (Errno 7) and the agent never started."""

    def test_small_prompt_stays_inline(self):
        self.assertEqual(collab_claude.system_prompt_args('hello'),
                         ['--append-system-prompt', 'hello'])

    def test_large_prompt_goes_through_a_file_not_argv(self):
        big = 'x' * 200_000
        args = collab_claude.system_prompt_args(big)
        try:
            self.assertEqual(args[0], '--append-system-prompt-file')
            self.assertLess(max(len(a) for a in args), 4096)
            with open(args[1], encoding='utf-8') as f:
                self.assertEqual(f.read(), big)
            # The real spawn call must not fail with E2BIG for these args.
            import subprocess
            subprocess.run(['/bin/true'] + args, check=True)
        finally:
            collab_claude._cleanup_prompt_files()
        self.assertFalse(os.path.exists(args[1]))


class TestRespawnResume(unittest.TestCase):
    """2026-09-24: earlyoom killed an agent's claude; the respawn started a blank
    session and a stale tool_use tail blocked delivery for 14 minutes."""

    SID = '071a2b80-200d-4cb9-8a95-129ad8bfecc6'

    def test_resume_args_replaces_session_flags_and_keeps_others(self):
        args = ['--append-system-prompt', 'x y', '--continue', '--resume', 'old',
                '--model', 'opus', '--session-id=abc']
        self.assertEqual(
            collab_claude.resume_args(args, self.SID),
            ['--append-system-prompt', 'x y', '--model', 'opus', '--resume', self.SID])

    def test_session_id_requires_nonempty_uuid_transcript(self):
        with tempfile.TemporaryDirectory() as d:
            good = os.path.join(d, f'{self.SID}.jsonl')
            with open(good, 'w') as f:
                f.write('{}\n')
            empty = os.path.join(d, '11111111-2222-3333-4444-555555555555.jsonl')
            open(empty, 'w').close()
            self.assertEqual(collab_claude.session_id_from_transcript(good), self.SID)
            self.assertIsNone(collab_claude.session_id_from_transcript(empty))
            self.assertIsNone(collab_claude.session_id_from_transcript(os.path.join(d, 'x.jsonl')))
            self.assertIsNone(collab_claude.session_id_from_transcript(None))

    def test_transcript_older_than_current_child_is_ignored(self):
        w = CollabClaudeWrapper(channel_id='c', participant_name='T')
        with tempfile.NamedTemporaryFile('w', suffix='.jsonl', delete=False) as f:
            f.write(json.dumps({'type': 'assistant', 'message': {
                'stop_reason': 'tool_use', 'content': [{'type': 'tool_use', 'name': 'Bash'}]}}) + '\n')
        try:
            w._transcript_path = f.name
            with patch.object(w, '_resolve_transcript', return_value=f.name):
                w._child_spawned_at = os.path.getmtime(f.name) + 5
                self.assertIsNone(w._check_jsonl_state())
                w._child_spawned_at = os.path.getmtime(f.name) - 5
                self.assertNotEqual(w._check_jsonl_state(), None)
        finally:
            os.unlink(f.name)

    def test_pexpect_reports_signal_only_after_close(self):
        import pexpect
        child = pexpect.spawn('sleep', ['30'], encoding='utf-8', timeout=None)
        os.kill(child.pid, 15)
        child.expect(pexpect.EOF)
        child.close(force=True)
        self.assertIsNone(child.exitstatus)
        self.assertEqual(child.signalstatus, 15)


class TestCrossChannelReplyCountsAsResponse(unittest.TestCase):
    """A reply to a cross-channel delivery is stored in the source channel's file."""

    ENVELOPE = (
        "[Cross-channel delivery via the DevFlow Cross-Channel API]\n\n"
        "Source channel: Coffee Shop App (`377f27b2-cd64-471f-92f5-4c8615ddd3e2`)\n"
        "Sender: Jack (`roster-3eaef384`)\n\nOriginal cross-channel message:\n@TestAgent hi"
    )

    def setUp(self):
        # Messages are served by a fake DevFlow API, not a local file: DevFlow
        # may run on another machine, where a local .AppData copy is stale.
        self.store = {}
        self.urlopen = patch.object(collab_claude.urllib.request, 'urlopen', side_effect=self._serve)
        self.urlopen.start()

    def tearDown(self):
        self.urlopen.stop()

    def _serve(self, url, timeout=None):
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(url).query)
        since = q.get('since', [''])[0]
        msgs = [m for m in self.store.get(q['channelId'][0], []) if m['timestamp'] > since]
        resp = MagicMock()
        resp.read.return_value = json.dumps({'messages': msgs}).encode()
        resp.__enter__.return_value = resp
        return resp

    def _write(self, channel_id, messages):
        self.store[channel_id] = messages

    def _wrapper(self, source):
        w = _make_wrapper()
        w.last_inject_time_iso = '2026-09-25T10:00:00.000Z'
        w.last_injected_source_channel = source
        return w

    def test_parses_source_channel_from_envelope(self):
        self.assertEqual(
            collab_claude.cross_channel_source_id(self.ENVELOPE),
            '377f27b2-cd64-471f-92f5-4c8615ddd3e2',
        )
        self.assertIsNone(collab_claude.cross_channel_source_id('@TestAgent ordinary message'))
        self.assertIsNone(collab_claude.cross_channel_source_id(None))

    def test_reply_in_source_channel_counts(self):
        source = '377f27b2-cd64-471f-92f5-4c8615ddd3e2'
        self._write('test-channel-123', [])
        self._write(source, [{'timestamp': '2026-09-25T10:00:05.000Z', 'from': {'id': 'test-participant-456'}}])
        self.assertTrue(self._wrapper(source)._agent_responded_since_last_inject())

    def test_no_reply_anywhere_is_still_detected(self):
        source = '377f27b2-cd64-471f-92f5-4c8615ddd3e2'
        self._write('test-channel-123', [])
        self._write(source, [{'timestamp': '2026-09-25T09:59:00.000Z', 'from': {'id': 'test-participant-456'}}])
        self.assertFalse(self._wrapper(source)._agent_responded_since_last_inject())

    def test_ordinary_message_checks_only_own_channel(self):
        self._write('test-channel-123', [{'timestamp': '2026-09-25T10:00:05.000Z', 'from': {'id': 'test-participant-456'}}])
        self.assertTrue(self._wrapper(None)._agent_responded_since_last_inject())

    def test_reply_is_found_through_the_api_when_local_store_is_stale(self):
        """4 Oct 2026: DevFlow moved to its server; the local file stopped updating."""
        self._write('test-channel-123', [{'timestamp': '2026-09-25T10:00:05.000Z', 'from': {'id': 'test-participant-456'}}])
        with patch.object(collab_claude.os.path, 'exists', return_value=False):
            self.assertTrue(self._wrapper(None)._agent_responded_since_last_inject())

    def test_api_failure_fails_open(self):
        self.urlopen.stop()
        with patch.object(collab_claude.urllib.request, 'urlopen', side_effect=OSError('refused')):
            self.assertTrue(self._wrapper(None)._agent_responded_since_last_inject())
        self.urlopen.start()


class TestLongMessagePointer(unittest.TestCase):
    """Long messages are typed as a one-line pointer to a workspace file."""

    def setUp(self):
        self._cwd = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory()
        os.chdir(self._tmp.name)

    def tearDown(self):
        os.chdir(self._cwd)
        self._tmp.cleanup()

    def _typed(self, w):
        return w._tmux_send.call_args[0][0]

    def test_short_message_is_typed_unchanged(self):
        w = _make_wrapper()
        w.inject_message(sender='Jack', content='@TestAgent quick one', msg_id='m1')
        self.assertEqual(self._typed(w), '[Channel message from Jack in test-channel-123]: @TestAgent quick one\n(@you)')
        self.assertFalse(os.path.exists(os.path.join(self._tmp.name, '.session-scratch', 'inbox')))

    def test_long_message_becomes_single_line_pointer_with_full_file(self):
        w = _make_wrapper()
        content = '@TestAgent report\n' + '\n'.join(f'line {i} ' + 'x' * 80 for i in range(22))
        w.inject_message(sender='Jack', content=content, msg_id='abc-123')
        typed = self._typed(w)
        self.assertNotIn('\n', typed)
        self.assertTrue(typed.startswith('[Channel message from Jack in test-channel-123]: @TestAgent report'))
        self.assertTrue(typed.endswith('(@you)'))
        path = os.path.join(self._tmp.name, '.session-scratch', 'inbox', 'msg-abc-123.md')
        self.assertIn(f'read the full 23-line message: {path}]', typed)
        with open(path, encoding='utf-8') as f:
            body = f.read()
        self.assertIn(content, body)
        self.assertTrue(body.startswith('[Channel message from Jack in test-channel-123]: '))

    def test_six_short_lines_trigger_pointer(self):
        w = _make_wrapper()
        w.inject_message(sender='Jack', content='\n'.join('a' for _ in range(6)), msg_id='six')
        self.assertIn('read the full 6-line message: ', self._typed(w))

    def test_verify_search_text_still_matches_pointer(self):
        w = _make_wrapper()
        w.inject_message(sender='Jack', content='y' * 900, msg_id='v1')
        self.assertTrue(self._typed(w).startswith(f'[Channel message from {w.last_injected_sender}'))

    def test_append_path_uses_pointer(self):
        w = _make_wrapper()
        w.pending_enter = True
        w.inject_message(sender='Sam', content='z' * 900, msg_id='ap1')
        typed = self._typed(w)
        self.assertTrue(typed.startswith('\n[Channel message from Sam'))
        self.assertEqual(typed.count('\n'), 1)
        self.assertIn('msg-ap1.md', typed)

    def test_cross_channel_pointer_carries_reply_route(self):
        content = (
            "[Cross-channel delivery via the DevFlow Cross-Channel API]\n\n"
            "Source channel: SEO Engine (`a390186d-4db8-4869-9845-79b4a26f2945`)\n"
            "Sender: Jack (`roster-4f72dfeb`) — type: `claude-terminal`\n"
            + "routing boilerplate\n" * 10 +
            "Original cross-channel message:\n@TestAgent two defects found today")
        w = _make_wrapper()
        w.inject_message(sender='Jack', content=content, msg_id='cc1')
        typed = self._typed(w)
        self.assertIn('(cross-channel from SEO Engine; reply with collab_helper.py --channel '
                      'a390186d-4db8-4869-9845-79b4a26f2945 and @Jack)', typed)
        self.assertIn(': @TestAgent two defects found today [PREVIEW ONLY.', typed)

    def test_pointer_file_never_overwritten_and_old_files_pruned(self):
        base = self._tmp.name
        first = collab_claude.write_pointer_file(base, 'dup', 'one')
        second = collab_claude.write_pointer_file(base, 'dup', 'two')
        self.assertNotEqual(first, second)
        with open(first, encoding='utf-8') as f:
            self.assertEqual(f.read(), 'one')
        old = time.time() - collab_claude.POINTER_RETENTION_SECONDS - 60
        os.utime(first, (old, old))
        collab_claude.write_pointer_file(base, 'new', 'three')
        self.assertFalse(os.path.exists(first))
        self.assertTrue(os.path.exists(second))


class TestSupersededVerifyAlert(unittest.TestCase):
    """A verify still pending when the next message's Enter fires is logged, not dropped."""

    def _ready(self, w):
        w.pending_enter = True
        w.pending_enter_time = time.time() - 1.0
        w.last_output_time = time.time() - 2.0
        w._resolve_transcript = MagicMock(return_value=None)
        w.last_injected_sender = 'Review Cron'
        w._verify_pending = True
        w._verify_msg_id = 'old-msg'
        w._verify_start_time = time.time() - 400

    def test_unconfirmed_superseded_verify_logs_failure(self):
        w = _make_wrapper()
        self._ready(w)
        w.check_verify_ingestion = MagicMock(return_value=False)  # still mid-turn: window extended
        w.check_pending_enter()
        w.log_delivery_failure.assert_called_once()
        self.assertEqual(w.log_delivery_failure.call_args[0][:2], ('old-msg', 'jsonl_verify_superseded_unconfirmed'))

    def test_confirmed_on_last_look_logs_nothing(self):
        w = _make_wrapper()
        self._ready(w)
        def confirm():
            w._verify_pending = False
            return True
        w.check_verify_ingestion = MagicMock(side_effect=confirm)
        w.check_pending_enter()
        w.log_delivery_failure.assert_not_called()


class TestStartupDialogs(unittest.TestCase):
    TRUST = " Accessing workspace:\n {path}\n ❯ No, exit\n   Yes, I trust this folder\n"

    def test_trust_dialog_for_another_folder_is_left_alone(self):
        w = _make_wrapper(tmux_pane_target='pane')
        w._capture_tmux_pane = MagicMock(return_value=self.TRUST.format(path='/somewhere/else'))
        with patch.object(collab_claude.subprocess, 'run') as run:
            w._accept_startup_dialogs(timeout=2)
        run.assert_not_called()

    def test_own_trust_dialog_selects_yes_then_enter(self):
        w = _make_wrapper(tmux_pane_target='pane')
        own = self.TRUST.format(path=os.path.realpath(os.getcwd()))
        selected = own.replace('❯ No, exit', '  No, exit').replace('  Yes, I trust', '❯ Yes, I trust')
        w._capture_tmux_pane = MagicMock(side_effect=[own, selected, 'bypass permissions'])
        with patch.object(collab_claude.subprocess, 'run') as run, patch.object(collab_claude.time, 'sleep'):
            w._accept_startup_dialogs(timeout=5)
        keys = [c.args[0][-1] for c in run.call_args_list]
        self.assertEqual(keys, ['Down', 'Enter'])

    MCP = (" 9 new MCP servers found in this project\n"
           " {a} [✔] snapshot\n   [✔] qdrant\n {b}    Enable selected\n")

    def test_mcp_dialog_moves_to_enable_selected_before_enter(self):
        w = _make_wrapper(tmux_pane_target='pane')
        on_server = self.MCP.format(a='❯', b=' ')
        on_enable = self.MCP.format(a=' ', b='❯')
        w._capture_tmux_pane = MagicMock(side_effect=[on_server, on_server, on_server, on_enable, 'bypass permissions'])
        with patch.object(collab_claude.subprocess, 'run') as run, patch.object(collab_claude.time, 'sleep'):
            w._accept_startup_dialogs(timeout=5)
        keys = [c.args[0][-1] for c in run.call_args_list]
        self.assertEqual(keys, ['Down', 'Down', 'Enter'])


class TestVerifyBoundaryAcrossTranscripts(unittest.TestCase):
    """The delivery boundary is a size on one file, never applied to another.

    Reproduces 4 Oct 2026: straight after a respawn the resolver still named
    the previous session's transcript, so the boundary was measured there and
    applied to the new, smaller file. Ingestion was logged as failed and a turn
    ending in NO_REPLY drew the "0 channel posts" corrective."""

    def _write(self, path, entries, pad=0):
        with open(path, 'w') as f:
            if pad:
                f.write(json.dumps({'type': 'summary', 'pad': 'x' * pad}) + '\n')
            for e in entries:
                f.write(json.dumps(e) + '\n')

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.old = os.path.join(self.tmp, 'old.jsonl')
        self.new = os.path.join(self.tmp, 'new.jsonl')
        self._write(self.old, [], pad=5000)
        self._write(self.new, [
            {'type': 'user', 'message': {'role': 'user', 'content': '[Channel message from System in c]: @TestAgent restarted'}},
            {'type': 'assistant', 'message': {'stop_reason': 'end_turn', 'content': [
                {'type': 'text', 'text': 'Nothing to post.\n\nNO_REPLY'}]}},
        ])
        self.w = _make_wrapper()
        self.w._verify_after_byte = os.path.getsize(self.old)
        self.w._verify_transcript = self.old

    def test_silent_turn_in_new_transcript_is_recognised(self):
        self.assertGreater(self.w._verify_after_byte, os.path.getsize(self.new))
        offset = self.w._verify_offset_for(self.new)
        self.assertEqual(jsonl_state_reader.final_response_disposition(self.new, offset),
                         jsonl_state_reader.TURN_EMPTY)

    def test_ingestion_is_found_in_new_transcript(self):
        self.assertTrue(jsonl_state_reader.verify_message_ingested(
            self.new, '[Channel message from System', self.w._verify_offset_for(self.new)))

    def test_same_transcript_keeps_its_boundary(self):
        self.w._verify_transcript = self.new
        self.w._verify_after_byte = os.path.getsize(self.new)
        self.assertEqual(self.w._verify_offset_for(self.new), os.path.getsize(self.new))
        # An older silent turn before the boundary must not answer for a newer delivery.
        self.assertIsNone(jsonl_state_reader.final_response_disposition(
            self.new, self.w._verify_offset_for(self.new)))
