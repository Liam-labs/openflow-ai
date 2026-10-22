#!/usr/bin/env python3
"""Focused lifecycle tests for the legacy Codex PTY wrapper."""

import importlib
import datetime
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch


sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'scripts'))
collab_codex = importlib.import_module('collab-codex')
CollabCodexWrapper = collab_codex.CollabCodexWrapper


class TestCollabResponseSignal(unittest.TestCase):
    def test_cross_channel_agent_api_call_counts_as_a_sent_response(self):
        self.assertTrue(collab_codex.contains_collab_response_signal(
            'curl /api/agent --data {"action": "collab.cross_channel_message"}'
        ))

    def test_ordinary_agent_api_message_still_counts(self):
        self.assertTrue(collab_codex.contains_collab_response_signal(
            '{"action":"collab.message"}'
        ))


class TestWslInteropRefresh(unittest.TestCase):
    def test_selection_skips_stale_socket(self):
        probe = MagicMock(side_effect=[subprocess.TimeoutExpired('cmd.exe', 3), None])

        selected = collab_codex.select_working_wsl_interop(
            ['/run/WSL/6909_interop', '/run/WSL/508912_interop'],
            probe,
        )

        self.assertEqual(selected, '/run/WSL/508912_interop')
        self.assertEqual(probe.call_count, 2)

    def test_selection_returns_none_when_every_socket_fails(self):
        probe = MagicMock(side_effect=FileNotFoundError)

        self.assertIsNone(collab_codex.select_working_wsl_interop(
            ['/run/WSL/6909_interop'],
            probe,
        ))


class TestVoiceTurnRuntimeControl(unittest.TestCase):
    def test_voice_reply_hint_is_bound_to_the_leased_message_only(self):
        wrapper = self._wrapper()
        self.assertIn('one brief sentence', wrapper._voice_reply_hint('voice-message-1'))
        self.assertIn('under 12 words', wrapper._voice_reply_hint('voice-message-1'))
        self.assertIn('--text-only', wrapper._voice_reply_hint('voice-message-1'))
        self.assertEqual(wrapper._voice_reply_hint('unrelated-message'), '')
        wrapper._active_delivery['message']['metadata']['voice']['kind'] = 'not-a-voice-turn'
        self.assertEqual(wrapper._voice_reply_hint('voice-message-1'), '')

    def test_active_voice_detection_is_exact_and_safe_without_a_delivery(self):
        wrapper = self._wrapper()
        self.assertTrue(wrapper._active_delivery_is_voice())
        wrapper._active_delivery['message']['metadata']['voice']['kind'] = 'ordinary'
        self.assertFalse(wrapper._active_delivery_is_voice())
        wrapper._active_delivery = None
        self.assertFalse(wrapper._active_delivery_is_voice())

    def test_durable_voice_sse_wakes_claim_cycle_without_queuing_or_bypassing_fifo(self):
        wrapper = self._wrapper()
        wrapper.delivery_protocol = 'ledger-v1'
        wrapper._voice_delivery_wakeup = threading.Event()
        wrapper._message_event = threading.Event()
        wrapper.sse_message_queue = queue.Queue()
        wrapper.is_processing = True
        wrapper.pending_enter = False
        message = {'id': 'next-voice', 'from': {'id': 'owner'}, 'recipients': ['riley'],
            'metadata': {'durableDelivery': 'ledger-v1', 'voice': {'kind': 'riley.voice.turn'}}}
        wrapper._handle_sse_event('collab:message', json.dumps({'message': message}), 'event-1')
        self.assertTrue(wrapper._voice_delivery_wakeup.is_set())
        self.assertTrue(wrapper.sse_message_queue.empty())
        self.assertFalse(wrapper._consume_voice_delivery_wakeup())
        wrapper.is_processing = False
        self.assertFalse(wrapper._consume_voice_delivery_wakeup())  # prior lease still owns FIFO
        wrapper._active_delivery = None
        self.assertTrue(wrapper._consume_voice_delivery_wakeup())
        self.assertEqual(wrapper._last_delivery_claim_mono, 0)
        self.assertFalse(wrapper._consume_voice_delivery_wakeup())

    def test_other_recipients_and_nonvoice_sse_do_not_activate_voice_fast_path(self):
        wrapper = self._wrapper()
        wrapper.delivery_protocol = 'ledger-v1'
        wrapper._voice_delivery_wakeup = threading.Event()
        wrapper._message_event = threading.Event()
        for kind, recipients in [('riley.voice.turn', ['someone-else']), ('ordinary', ['riley'])]:
            message = {'id': 'message', 'from': {'id': 'owner'}, 'recipients': recipients,
                'metadata': {'durableDelivery': 'ledger-v1', 'voice': {'kind': kind}}}
            wrapper._handle_sse_event('collab:message', json.dumps({'message': message}), 'event-1')
            self.assertFalse(wrapper._voice_delivery_wakeup.is_set())

    def _wrapper(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.channel_id = 'commander'
        wrapper.participant_id = 'riley'
        wrapper.wrapper_pid = 222
        wrapper._active_delivery = {
            'id': 'delivery-1',
            'messageId': 'voice-message-1',
            'state': 'ingested',
            'lease': {'id': 'lease-1'},
            'message': {'metadata': {'voice': {
                'kind': 'riley.voice.turn',
                'conversationSessionId': 'conversation-1',
                'audioTurnId': 'audio-1',
                'revision': 1,
            }}},
        }
        wrapper._send_child_input = MagicMock(return_value=True)
        wrapper._clear_active_delivery_state = MagicMock()
        return wrapper

    def _cancel_record(self, lease_id='lease-1'):
        return {
            'id': 'delivery-1',
            'messageId': 'voice-message-1',
            'state': 'cancel_requested',
            'lease': {'id': lease_id},
            'message': {'metadata': {'voice': {
                'kind': 'riley.voice.turn',
                'conversationSessionId': 'conversation-1',
                'audioTurnId': 'audio-1',
                'revision': 1,
            }}},
            'voiceControl': {
                'cancelId': 'cancel-1',
                'expectedRevision': 1,
            },
        }

    def _answered_records(self):
        active = json.loads(json.dumps(self._wrapper()._active_delivery))
        active['voiceControl'] = {'responseMessageId': 'reply-1'}
        followup = {
            'id': 'delivery-2',
            'messageId': 'voice-message-2',
            'state': 'pending',
            'message': {'metadata': {'voice': {'kind': 'riley.voice.turn'}}},
        }
        return [active, followup]

    def test_answered_voice_turn_yields_to_pending_spoken_followup(self):
        wrapper = self._wrapper()
        wrapper.is_processing = True
        wrapper.pending_enter = False
        wrapper._voice_delivery_wakeup = threading.Event()
        wrapper._voice_delivery_wakeup.set()
        wrapper._message_event = threading.Event()
        wrapper._voice_followup_interrupts = set()
        wrapper._fetch_delivery_records = MagicMock(return_value=self._answered_records())
        wrapper._transition_active_delivery = MagicMock(return_value=True)

        self.assertTrue(wrapper._interrupt_answered_voice_for_followup())

        wrapper._send_child_input.assert_called_once_with(key='C-c')
        wrapper._transition_active_delivery.assert_called_once_with('handled')
        wrapper._clear_active_delivery_state.assert_called_once_with('handled')
        self.assertTrue(wrapper._voice_delivery_wakeup.is_set())
        self.assertTrue(wrapper._message_event.is_set())

    def test_unanswered_voice_turn_is_not_interrupted_by_followup(self):
        wrapper = self._wrapper()
        wrapper.is_processing = True
        wrapper.pending_enter = False
        wrapper._voice_delivery_wakeup = threading.Event()
        wrapper._voice_delivery_wakeup.set()
        wrapper._voice_followup_interrupts = set()
        records = self._answered_records()
        records[0].pop('voiceControl')
        wrapper._fetch_delivery_records = MagicMock(return_value=records)

        self.assertFalse(wrapper._interrupt_answered_voice_for_followup())
        wrapper._send_child_input.assert_not_called()
        wrapper._clear_active_delivery_state.assert_not_called()

    def test_followup_handled_retry_does_not_send_duplicate_interrupt(self):
        wrapper = self._wrapper()
        wrapper.is_processing = True
        wrapper.pending_enter = False
        wrapper._voice_delivery_wakeup = threading.Event()
        wrapper._voice_delivery_wakeup.set()
        wrapper._message_event = threading.Event()
        wrapper._voice_followup_interrupts = set()
        wrapper._fetch_delivery_records = MagicMock(return_value=self._answered_records())
        wrapper._transition_active_delivery = MagicMock(side_effect=[False, True])

        self.assertFalse(wrapper._interrupt_answered_voice_for_followup())
        self.assertTrue(wrapper._interrupt_answered_voice_for_followup())

        wrapper._send_child_input.assert_called_once_with(key='C-c')
        self.assertEqual(wrapper._transition_active_delivery.call_count, 2)
        wrapper._fetch_delivery_records.assert_called_once_with()

    def test_sse_replay_without_a_distinct_pending_voice_does_not_interrupt(self):
        wrapper = self._wrapper()
        wrapper.is_processing = True
        wrapper.pending_enter = False
        wrapper._voice_delivery_wakeup = threading.Event()
        wrapper._voice_delivery_wakeup.set()
        wrapper._voice_followup_interrupts = set()
        wrapper._fetch_delivery_records = MagicMock(return_value=self._answered_records()[:1])

        self.assertFalse(wrapper._interrupt_answered_voice_for_followup())
        wrapper._send_child_input.assert_not_called()

    def test_matched_active_cancel_interrupts_and_acknowledges(self):
        wrapper = self._wrapper()
        wrapper._voice_cancel_api_call = MagicMock(side_effect=[
            {'record': self._cancel_record()},
            {'record': {'state': 'cancelled'}},
        ])

        self.assertTrue(wrapper._check_voice_cancel_request())

        wrapper._send_child_input.assert_called_once_with(key='C-c')
        ack_payload = wrapper._voice_cancel_api_call.call_args_list[1].args[0]
        self.assertEqual(ack_payload['expectedMessageId'], 'voice-message-1')
        self.assertEqual(ack_payload['expectedRevision'], 1)
        self.assertEqual(ack_payload['leaseId'], 'lease-1')
        wrapper._clear_active_delivery_state.assert_called_once_with('voice_cancelled')

    def test_mismatched_delivery_cancel_never_interrupts(self):
        wrapper = self._wrapper()
        wrapper._voice_cancel_api_call = MagicMock(return_value={
            'record': self._cancel_record(lease_id='different-lease'),
        })

        self.assertFalse(wrapper._check_voice_cancel_request())

        wrapper._send_child_input.assert_not_called()
        wrapper._clear_active_delivery_state.assert_not_called()

    def test_cancel_ack_retry_does_not_send_duplicate_interrupt(self):
        wrapper = self._wrapper()
        wrapper._voice_cancel_api_call = MagicMock(side_effect=[
            {'record': self._cancel_record()},
            {'error': 'temporary failure'},
            {'record': self._cancel_record()},
            {'record': {'state': 'cancelled'}},
        ])

        self.assertFalse(wrapper._check_voice_cancel_request())
        self.assertTrue(wrapper._check_voice_cancel_request())

        wrapper._send_child_input.assert_called_once_with(key='C-c')
        wrapper._clear_active_delivery_state.assert_called_once_with('voice_cancelled')

    def test_active_voice_context_contains_complete_server_identity(self):
        wrapper = self._wrapper()

        self.assertEqual(wrapper._active_voice_delivery_context(), {
            'recordId': 'delivery-1',
            'messageId': 'voice-message-1',
            'conversationSessionId': 'conversation-1',
            'audioTurnId': 'audio-1',
            'revision': 1,
        })

    def test_leased_cancel_clears_composer_without_sending_ctrl_c(self):
        wrapper = self._wrapper()
        wrapper._active_delivery['state'] = 'leased'
        cancelled = self._cancel_record()
        cancelled['state'] = 'cancelled'
        cancelled.pop('lease')
        cancelled['voiceControl'].update({
            'cancelDisposition': 'pending_cancelled',
            'cancelledLeaseId': 'lease-1',
            'cancelledOwnerId': 'codex:riley:222',
        })
        wrapper._voice_cancel_api_call = MagicMock(side_effect=[
            {'record': cancelled},
            {'record': cancelled},
        ])

        self.assertTrue(wrapper._check_voice_cancel_request())

        wrapper._send_child_input.assert_called_once_with(key='C-u')
        wrapper._clear_active_delivery_state.assert_called_once_with('voice_cancelled')


def _write_rollout(path, cwd, extra_events=None):
    with open(path, 'w') as f:
        f.write(json.dumps({'type': 'session_meta', 'payload': {'cwd': cwd}}) + '\n')
        for event in extra_events or []:
            f.write(json.dumps(event) + '\n')


def _lifecycle_wrapper():
    wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
    wrapper._child_startup_output = ''
    wrapper._child_startup_proven = False
    wrapper._child_ready_registered = False
    wrapper._fatal_startup_error = None
    wrapper.codex_pid = 111
    wrapper.wrapper_pid = 222
    wrapper.joined = True
    wrapper.channel_id = 'channel-1'
    wrapper.register_session = MagicMock()
    wrapper._write_session_file = MagicMock()
    return wrapper


class TestCodexStartupLifecycle(unittest.TestCase):
    def test_fatal_config_output_never_registers_ready(self):
        wrapper = _lifecycle_wrapper()

        self.assertFalse(wrapper._observe_child_startup_output('Error loading config.'))
        proven = wrapper._observe_child_startup_output('toml: legacy profile is not supported')

        self.assertFalse(proven)
        self.assertEqual(wrapper._fatal_startup_error, 'Error loading config.toml')
        wrapper.register_session.assert_not_called()
        wrapper._write_session_file.assert_not_called()
        self.assertTrue(wrapper._startup_exit_is_fatal(1))

    def test_fragmented_ready_banner_registers_once(self):
        wrapper = _lifecycle_wrapper()

        self.assertFalse(wrapper._observe_child_startup_output('>_ OpenAI Co'))
        self.assertTrue(wrapper._observe_child_startup_output('dex (v0.144.5)'))
        self.assertTrue(wrapper._observe_child_startup_output(' later TUI output'))

        wrapper.register_session.assert_called_once_with()
        wrapper._write_session_file.assert_called_once_with('channel-1')
        self.assertFalse(wrapper._startup_exit_is_fatal(1))

    def test_ansi_fragmented_ready_banner_registers_and_preserves_raw_buffer(self):
        wrapper = _lifecycle_wrapper()
        first = (
            '\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]0;Dave\x07'
            '\x1b[38;5;245m│ >_\x1b[0m OpenAI \x1b[1mCo'
        )
        second = 'dex\x1b[22m (v0.144.5)\x1b[0m\r'

        self.assertFalse(wrapper._observe_child_startup_output(first))
        self.assertTrue(wrapper._observe_child_startup_output(second))

        self.assertIn('\x1b[38;5;245m', wrapper._child_startup_output)
        wrapper.register_session.assert_called_once_with()
        wrapper._write_session_file.assert_called_once_with('channel-1')

    def test_nonzero_exit_before_ready_is_fatal(self):
        wrapper = _lifecycle_wrapper()
        self.assertTrue(wrapper._startup_exit_is_fatal(2))
        self.assertFalse(wrapper._startup_exit_is_fatal(0))
        self.assertFalse(wrapper._startup_exit_is_fatal(None))

    def test_reset_allows_normal_restart_to_prove_new_child(self):
        wrapper = _lifecycle_wrapper()
        wrapper._observe_child_startup_output('>_ OpenAI Codex (v0.144.5)')
        wrapper._reset_child_startup_state()
        wrapper.register_session.reset_mock()
        wrapper._write_session_file.reset_mock()

        self.assertFalse(wrapper._child_startup_proven)
        self.assertTrue(wrapper._observe_child_startup_output('>_ OpenAI Codex (v0.144.5)'))
        wrapper.register_session.assert_called_once_with()
        wrapper._write_session_file.assert_called_once_with('channel-1')

    def test_trust_prompt_is_answered_once(self):
        wrapper = _lifecycle_wrapper()
        wrapper._tmux_send = MagicMock(return_value=True)
        wrapper._send_child_input = MagicMock(return_value=True)

        wrapper._observe_child_startup_output('Do you trust the contents of this directory?')
        wrapper._observe_child_startup_output('Do you trust the contents of this directory?')

        wrapper._send_child_input.assert_called_once_with('1', key='Enter')
        wrapper._tmux_send.assert_not_called()

    def test_alive_child_blocked_before_ready_is_terminated_after_timeout(self):
        wrapper = _lifecycle_wrapper()
        wrapper.child = MagicMock()
        wrapper._child_spawn_mono = time.monotonic() - collab_codex.STARTUP_READY_TIMEOUT_SECONDS - 1

        self.assertTrue(wrapper._check_startup_timeout())
        wrapper.child.terminate.assert_called_once_with(force=True)
        self.assertEqual(wrapper._fatal_startup_error, 'startup readiness timeout')


class TestCodexMemoryScaffold(unittest.TestCase):
    def _wrapper(self, agent_dir):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.participant_name = 'Architect'
        wrapper.agent_dir = agent_dir
        return wrapper

    def test_scaffold_preloads_memory_expertise_and_current_continuity(self):
        # Regression guard for the 2026-07-17 incident: an earlier version of this
        # method inlined all mutable context directly into the CLI positional prompt
        # argument. That blob got rendered into Codex's PTY scrollback and destabilized
        # every subsequent real-time keystroke injection for the life of the session —
        # channel messages silently failed to reach Codex, triggering wrapper respawns
        # that recreated the same fragile state. Fix: write mutable context to a scratch
        # file and have Codex read it with its own tools; the launch prompt stays short.
        with tempfile.TemporaryDirectory() as home:
            agent_dir = os.path.join(home, 'SG-1', 'Team', 'Architect')
            memory_dir = os.path.join(
                home, '.claude', 'projects',
                agent_dir.replace('/', '-'), 'memory',
            )
            os.makedirs(agent_dir)
            os.makedirs(memory_dir)
            os.makedirs(os.path.join(agent_dir, 'logs'))
            with open(os.path.join(agent_dir, 'logs', 'today.md'), 'w') as f:
                f.write(f'# Today - {datetime.date.today().isoformat()}\nTODAY-CONTEXT')
            with open(os.path.join(agent_dir, 'logs', 'handoff.md'), 'w') as f:
                f.write('HANDOFF-CONTEXT')
            with open(os.path.join(agent_dir, 'Expertise.md'), 'w') as f:
                f.write('EXPERTISE-CONTEXT')
            with open(os.path.join(agent_dir, 'SystemOwnership.json'), 'w') as f:
                f.write('{"owner":"Architect"}')
            with open(os.path.join(memory_dir, 'MEMORY.md'), 'w') as f:
                f.write('PERSISTENT-MEMORY-CONTEXT')

            wrapper = self._wrapper(agent_dir)
            with patch.object(collab_codex.os.path, 'expanduser', side_effect=lambda p: home if p == '~' else p):
                prompt = wrapper._build_scaffolded_prompt()

            # The launch prompt itself must stay short — no inlined content.
            for marker in (
                'TODAY-CONTEXT',
                'HANDOFF-CONTEXT',
                'EXPERTISE-CONTEXT',
                '"owner":"Architect"',
                'PERSISTENT-MEMORY-CONTEXT',
            ):
                self.assertNotIn(marker, prompt)
            self.assertLess(len(prompt), 1500)

            # It must point Codex at a scratch file containing the durable
            # memory frameworks plus current continuity.
            scratch_path = os.path.join(agent_dir, '.session-scratch', 'codex-startup-context.md')
            self.assertIn(scratch_path, prompt)
            self.assertTrue(os.path.isfile(scratch_path))
            with open(scratch_path) as f:
                written = f.read()
            self.assertIn('# Context Use Contract', written)
            self.assertIn('required operational context', written)
            # Which machine this session runs on: stated per session, marked do-not-save.
            self.assertIn('## Session location (do not save)', written)
            for marker in (
                'TODAY-CONTEXT',
                'HANDOFF-CONTEXT',
                'EXPERTISE-CONTEXT',
                '"owner":"Architect"',
                'PERSISTENT-MEMORY-CONTEXT',
            ):
                self.assertIn(marker, written)

            self.assertIn('Execution: report only hard blockers to Architect', prompt)
            self.assertNotIn('Reply to direct mentions', prompt)
            self.assertIn('A mention requires attention, not an acknowledgement', prompt)
            self.assertIn('finalise Plan.md, assign sprint tasks, then execute quietly until completion or a hard blocker', prompt)
            self.assertIn('Answer human questions; discuss plans and hard blockers', prompt)
            self.assertIn('No handoff, confirmation, ready, correction, stage, freeze/hold, or progress chatter', prompt)
            self.assertIn('Send once', prompt)
            self.assertIn('real line breaks', prompt)
            self.assertIn('**bold**', prompt)
            self.assertIn('<u>underline</u>', prompt)
            self.assertIn('treat human broadcasts as addressed to every participant', prompt)
            self.assertNotIn('reply only when directly mentioned', prompt.lower())

    def test_scaffold_today_context_is_current_date_and_tail_bounded(self):
        with tempfile.TemporaryDirectory() as home:
            agent_dir = os.path.join(home, 'Team', 'Architect')
            os.makedirs(os.path.join(agent_dir, 'logs'))
            with open(os.path.join(agent_dir, 'logs', 'today.md'), 'w') as f:
                f.write(f'# Today - {datetime.date.today().isoformat()}\n')
                f.write(''.join(f'TODAY-LINE-{i}\n' for i in range(60)))

            wrapper = self._wrapper(agent_dir)
            with patch.object(collab_codex.os.path, 'expanduser', side_effect=lambda p: home if p == '~' else p):
                wrapper._build_scaffolded_prompt()

            scratch_path = os.path.join(agent_dir, '.session-scratch', 'codex-startup-context.md')
            with open(scratch_path) as f:
                written = f.read()
            self.assertIn('TODAY-LINE-20', written)
            self.assertIn('TODAY-LINE-59', written)
            self.assertNotIn('TODAY-LINE-19', written)

    def test_memory_and_expertise_preloads_are_bounded(self):
        with tempfile.TemporaryDirectory() as home:
            agent_dir = os.path.join(home, 'Team', 'Architect')
            memory_dir = os.path.join(
                home, '.claude', 'projects',
                agent_dir.replace('/', '-'), 'memory',
            )
            os.makedirs(agent_dir)
            os.makedirs(memory_dir)
            with open(os.path.join(agent_dir, 'Expertise.md'), 'w') as f:
                f.write(''.join(f'EXPERTISE-LINE-{i}\n' for i in range(205)))
            with open(os.path.join(memory_dir, 'MEMORY.md'), 'w') as f:
                f.write(''.join(f'MEMORY-LINE-{i}\n' for i in range(205)))

            wrapper = self._wrapper(agent_dir)
            with patch.object(collab_codex.os.path, 'expanduser', side_effect=lambda p: home if p == '~' else p):
                wrapper._build_scaffolded_prompt()

            scratch_path = os.path.join(agent_dir, '.session-scratch', 'codex-startup-context.md')
            with open(scratch_path) as f:
                written = f.read()
            self.assertIn('EXPERTISE-LINE-199', written)
            self.assertNotIn('EXPERTISE-LINE-200', written)
            self.assertIn('MEMORY-LINE-199', written)
            self.assertNotIn('MEMORY-LINE-200', written)

    def test_scaffold_ignores_stale_today_log(self):
        with tempfile.TemporaryDirectory() as home:
            agent_dir = os.path.join(home, 'Team', 'Architect')
            os.makedirs(os.path.join(agent_dir, 'logs'))
            with open(os.path.join(agent_dir, 'logs', 'today.md'), 'w') as f:
                f.write('# Today - 2020-01-01\nSTALE-TODAY-CONTEXT')

            wrapper = self._wrapper(agent_dir)
            wrapper._build_scaffolded_prompt()

            scratch_path = os.path.join(agent_dir, '.session-scratch', 'codex-startup-context.md')
            with open(scratch_path) as f:
                written = f.read()
            self.assertNotIn('STALE-TODAY-CONTEXT', written)

    def test_launch_args_reference_scaffold_file_not_inline_content(self):
        with tempfile.TemporaryDirectory() as home:
            agent_dir = os.path.join(home, 'Team', 'Architect')
            memory_dir = os.path.join(
                home, '.claude', 'projects',
                agent_dir.replace('/', '-'), 'memory',
            )
            os.makedirs(memory_dir)
            with open(os.path.join(memory_dir, 'MEMORY.md'), 'w') as f:
                f.write('LAUNCH-MEMORY-MARKER')

            wrapper = self._wrapper(agent_dir)
            wrapper.model = 'gpt-test'
            wrapper.effort = None  # Required by _build_codex_launch_args
            wrapper.codex_args = ['--profile', 'agentchat']
            with patch.object(collab_codex.os.path, 'expanduser', side_effect=lambda p: home if p == '~' else p):
                args = wrapper._build_codex_launch_args()

            self.assertEqual(args[:2], ['-s', 'danger-full-access'])
            self.assertIn('-a', args)
            self.assertEqual(args[args.index('-a') + 1], 'never')
            self.assertNotIn('--dangerously-bypass-approvals-and-sandbox', args)
            self.assertIn('-m', args)
            self.assertEqual(args[args.index('-m') + 1], 'gpt-test')
            self.assertIn('-c', args)
            self.assertIn('disable_paste_burst=true', args)
            self.assertEqual(args[-3:-1], ['-c', 'disable_paste_burst=true'])
            self.assertIn('--profile', args)
            # The launch-arg prompt must stay short (PTY-render-safe) and must not
            # carry the raw memory content inline — only a path reference to it.
            self.assertLess(len(args[-1]), 1500)
            self.assertNotIn('LAUNCH-MEMORY-MARKER', args[-1])
            self.assertIn('codex-startup-context.md', args[-1])

    def test_launch_args_pin_ultra_effort_and_fast_mode(self):
        with tempfile.TemporaryDirectory() as agent_dir:
            wrapper = self._wrapper(agent_dir)
            wrapper.model = 'gpt-5.6-sol'
            wrapper.effort = 'ultra'
            wrapper.fast_mode = True
            wrapper.codex_args = ['--profile', 'agentchat']

            args = wrapper._build_codex_launch_args()

            self.assertIn('model_reasoning_effort="ultra"', args)
            self.assertIn('service_tier="fast"', args)

    def test_launch_args_pin_fast_mode_off(self):
        with tempfile.TemporaryDirectory() as agent_dir:
            wrapper = self._wrapper(agent_dir)
            wrapper.model = 'gpt-5.6-sol'
            wrapper.effort = 'medium'
            wrapper.fast_mode = False
            wrapper.codex_args = ['--profile', 'agentchat']

            args = wrapper._build_codex_launch_args()

            self.assertIn('service_tier="default"', args)


class TestCodexTmuxSubmission(unittest.TestCase):
    def _inject_wrapper(self, is_processing):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.child = MagicMock()
        wrapper.child.isalive.return_value = True
        wrapper.is_processing = is_processing
        wrapper.pending_enter = False
        wrapper.pending_enter_time = 0
        wrapper.pending_submit_key = 'Enter'
        wrapper._enter_lock = threading.Lock()
        wrapper._run_hook_before_inject = MagicMock(return_value='')
        wrapper.participant_id = 'participant-margaret'
        wrapper.participant_name = 'Architect'
        wrapper.channel_id = 'channel-1'
        wrapper._tmux_send = MagicMock(return_value=True)
        wrapper.tmux_pane_target = None
        wrapper._resolve_transcript = MagicMock(return_value=None)
        wrapper.idle_since = 1
        wrapper.last_output_time = 0
        wrapper.output_seen_since_inject = False
        wrapper.collab_response_sent = True
        wrapper._collab_detect_buf = 'old'
        wrapper.last_inject_time_iso = None
        wrapper.last_inject_time_mono = 0
        wrapper.last_injected_sender = None
        wrapper.last_injected_was_mentioned = False
        wrapper.broadcast_activity = MagicMock()
        wrapper._send_child_input = MagicMock(return_value=True)
        return wrapper

    def test_child_input_writes_one_bracketed_paste_frame_despite_partial_writes(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.child = MagicMock()
        wrapper.child.isalive.return_value = True
        wrapper.child.child_fd = 91
        wrapper._child_write_lock = threading.Lock()
        captured = bytearray()

        def partial_write(fd, data):
            self.assertEqual(fd, 91)
            written = min(7, len(data))
            captured.extend(data[:written])
            return written

        content = 'notes £☕\n' * 1500
        with patch.object(collab_codex.os, 'write', side_effect=partial_write):
            self.assertTrue(wrapper._send_child_input(content, bracketed=True))

        self.assertEqual(
            bytes(captured),
            b'\x1b[200~' + content.encode('utf-8') + b'\x1b[201~',
        )

    def test_injection_bypasses_tmux_relay_with_bracketed_child_write(self):
        wrapper = self._inject_wrapper(is_processing=False)

        self.assertTrue(wrapper.inject_message(
            'Owner', '@Architect ' + ('long ' * 600),
            mentions=['participant-margaret'], msg_id='msg-direct'
        ))

        wrapper._send_child_input.assert_called_once()
        sent_prompt = wrapper._send_child_input.call_args.args[0]
        self.assertIn('[Channel message from Owner', sent_prompt)
        self.assertIn('(@you)', sent_prompt)
        self.assertNotIn('substantive replies only', sent_prompt)  # static etiquette lives in channel-communication.md, not the footer
        self.assertTrue(wrapper._send_child_input.call_args.kwargs['bracketed'])
        wrapper._tmux_send.assert_not_called()

    def test_long_message_preserves_body_tail_mentions_and_delivery_token(self):
        wrapper = self._inject_wrapper(is_processing=False)
        wrapper._active_delivery = {'messageId': 'long-message', 'token': 'delivery-long'}
        content = ('Meeting notes £☕\n' * 700) + '\n@Architect use Expo; END_OF_MESSAGE'

        self.assertTrue(wrapper.inject_message('Owner', content, msg_id='long-message'))

        prompt = wrapper._send_child_input.call_args.args[0]
        self.assertIn(content, prompt)
        self.assertTrue(prompt.startswith('delivery-long\n'))
        self.assertTrue(prompt.endswith('END_OF_MESSAGE\n(@you)'))
        self.assertNotIn('[truncated', prompt)
        self.assertTrue(wrapper.pending_enter)

    def test_long_message_appended_to_pending_composer_preserves_full_body(self):
        wrapper = self._inject_wrapper(is_processing=False)
        wrapper.pending_enter = True
        content = ('Meeting notes £☕\n' * 700) + '\n@Architect use Expo; END_OF_MESSAGE'

        self.assertTrue(wrapper.inject_message('Owner', content, msg_id='long-appended'))

        prompt = wrapper._send_child_input.call_args.args[0]
        self.assertIn(content, prompt)
        self.assertTrue(prompt.endswith('END_OF_MESSAGE\n(@you)'))
        self.assertTrue(wrapper._send_child_input.call_args.kwargs['bracketed'])
        self.assertNotIn('[truncated', prompt)

    def test_idle_injection_defers_enter_submission(self):
        wrapper = self._inject_wrapper(is_processing=False)

        self.assertTrue(wrapper.inject_message(
            'Owner', '@Architect hello', mentions=['participant-margaret'], msg_id='msg-1'
        ))

        self.assertTrue(wrapper.pending_enter)
        self.assertEqual(wrapper.pending_submit_key, 'Enter')

    def test_voice_injection_skips_non_authoritative_pane_wait(self):
        wrapper = self._inject_wrapper(is_processing=False)
        wrapper.tmux_pane_target = '%50'
        wrapper._capture_tmux_pane = MagicMock(return_value='')
        wrapper._active_delivery = {
            'messageId': 'voice-message',
            'message': {'metadata': {'voice': {'kind': 'riley.voice.turn'}}},
        }

        with patch.object(collab_codex.time, 'sleep') as sleep:
            self.assertTrue(wrapper.inject_message(
                'Owner', 'hello', mentions=['participant-margaret'], msg_id='voice-message'
            ))

        sleep.assert_not_called()
        wrapper._capture_tmux_pane.assert_not_called()

    def test_voice_submit_uses_minimum_paste_settle_window(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.pending_enter = True
        wrapper.pending_enter_time = time.time() - 0.21
        wrapper.pending_submit_key = 'Enter'
        wrapper._enter_lock = threading.Lock()
        wrapper.child = MagicMock()
        wrapper.child.isalive.return_value = True
        wrapper.last_output_time = time.time() - 0.21
        wrapper.enter_idle_threshold = 0.5
        wrapper._send_child_input = MagicMock(return_value=True)
        wrapper._record_submit_success = MagicMock(return_value=True)
        wrapper._active_delivery = {
            'message': {'metadata': {'voice': {'kind': 'riley.voice.turn'}}},
        }

        self.assertTrue(wrapper.check_pending_enter())
        wrapper._send_child_input.assert_called_once_with(key='Enter')
        wrapper._record_submit_success.assert_called_once_with('Enter')

    def test_active_turn_injection_defers_tab_queueing(self):
        wrapper = self._inject_wrapper(is_processing=True)

        self.assertTrue(wrapper.inject_message(
            'Owner', '@Architect follow-up', mentions=['participant-margaret'], msg_id='msg-2'
        ))

        self.assertTrue(wrapper.pending_enter)
        self.assertEqual(wrapper.pending_submit_key, 'Tab')

    def test_failed_submit_keeps_pending_state_for_retry(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.pending_enter = True
        wrapper.pending_enter_time = time.time() - 1
        wrapper.pending_submit_key = 'Enter'
        wrapper._enter_lock = threading.Lock()
        wrapper.child = MagicMock()
        wrapper.child.isalive.return_value = True
        wrapper.last_output_time = 0
        wrapper.enter_idle_threshold = 0.5
        wrapper._tmux_send = MagicMock(return_value=False)
        wrapper._send_child_input = MagicMock(return_value=False)
        wrapper._verify_pending = False
        wrapper.last_injected_msg_id = None

        self.assertFalse(wrapper.check_pending_enter())
        self.assertTrue(wrapper.pending_enter)
        self.assertFalse(wrapper._verify_pending)

    def test_successful_tab_queue_does_not_start_immediate_jsonl_verify(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.pending_enter = True
        wrapper.pending_enter_time = time.time() - 1
        wrapper.pending_submit_key = 'Tab'
        wrapper._enter_lock = threading.Lock()
        wrapper.child = MagicMock()
        wrapper.child.isalive.return_value = True
        wrapper.last_output_time = 0
        wrapper.enter_idle_threshold = 0.5
        wrapper._tmux_send = MagicMock(return_value=True)
        wrapper._send_child_input = MagicMock(return_value=True)
        wrapper._verify_pending = False

        self.assertTrue(wrapper.check_pending_enter())
        wrapper._send_child_input.assert_called_once_with(key='Tab')
        self.assertFalse(wrapper.pending_enter)
        self.assertFalse(wrapper._verify_pending)

    def test_durable_submit_without_transcript_retains_claim_for_late_rollover(self):
        """A transcript rollover must not turn one accepted submit into many."""
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.pending_enter = True
        wrapper.pending_enter_time = time.time() - 1
        wrapper.pending_submit_key = 'Enter'
        wrapper._enter_lock = threading.Lock()
        wrapper.child = MagicMock()
        wrapper.child.isalive.return_value = True
        wrapper.last_output_time = 0
        wrapper.enter_idle_threshold = 0.5
        wrapper._tmux_send = MagicMock(return_value=True)
        wrapper._send_child_input = MagicMock(return_value=True)
        wrapper._resolve_transcript = MagicMock(return_value=None)
        wrapper._inject_transcript_byte = 0
        wrapper._verify_pending = False
        wrapper._verify_timeout = 5
        wrapper._retry_attempts = {}
        wrapper._active_delivery = {
            'id': 'record-1',
            'messageId': 'message-1',
            'token': '[[collab-delivery:message-1]]',
            'state': 'leased',
            'lease': {'id': 'lease-1'},
        }
        wrapper._transition_active_delivery = MagicMock(return_value=True)
        wrapper._release_active_delivery = MagicMock(return_value=True)
        wrapper._clear_codex_composer = MagicMock()
        wrapper.log_delivery_failure = MagicMock()
        wrapper.is_processing = True
        wrapper.pending_mark_read = False
        wrapper.pending_mark_read_timestamp = '2026-07-28T10:05:54.000Z'
        wrapper.last_injected_msg_id = 'message-1'

        self.assertTrue(wrapper.check_pending_enter())
        self.assertTrue(wrapper._verify_pending)
        self.assertEqual(wrapper._verify_search_text, '[[collab-delivery:message-1]]')

        wrapper._verify_start_time = time.time() - 10
        self.assertFalse(wrapper.check_verify_ingestion())

        wrapper._release_active_delivery.assert_not_called()
        self.assertIsNotNone(wrapper._active_delivery)
        self.assertTrue(wrapper._verify_pending)

    def test_watchdog_submit_runs_the_same_delivery_lifecycle_as_poll_submit(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.running = True
        wrapper.pending_enter = True
        wrapper.pending_enter_time = time.time() - 20
        wrapper.pending_submit_key = 'Enter'
        wrapper._enter_lock = threading.Lock()
        wrapper.child = MagicMock()
        wrapper.child.isalive.return_value = True
        wrapper._tmux_send = MagicMock(return_value=True)
        wrapper._send_child_input = MagicMock(return_value=True)
        wrapper._record_submit_success = MagicMock()

        def stop_after_first_iteration(_seconds):
            wrapper.running = False

        with patch.object(collab_codex.time, 'sleep', side_effect=stop_after_first_iteration):
            wrapper.watchdog_loop()

        wrapper._record_submit_success.assert_called_once_with('Enter')

    def test_tmux_tab_submission_uses_named_tab_key(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.tmux_pane_target = '%50'

        completed = MagicMock(returncode=0, stderr='')
        with patch.object(collab_codex.subprocess, 'run', return_value=completed) as run:
            self.assertTrue(wrapper._tmux_send('', key='Tab'))

        run.assert_called_once_with(
            ['tmux', 'send-keys', '-t', '%50', 'Tab'],
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_tmux_ctrl_u_cleanup_uses_named_control_key(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.tmux_pane_target = '%50'

        completed = MagicMock(returncode=0, stderr='')
        with patch.object(collab_codex.subprocess, 'run', return_value=completed) as run:
            self.assertTrue(wrapper._tmux_send('', key='C-u'))

        run.assert_called_once_with(
            ['tmux', 'send-keys', '-t', '%50', 'C-u'],
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_same_logical_message_keeps_first_response_window(self):
        wrapper = self._inject_wrapper(is_processing=False)

        self.assertTrue(wrapper.inject_message(
            'Owner', '@Architect hello', mentions=['participant-margaret'], msg_id='msg-1'
        ))
        first_window = wrapper.last_inject_time_iso

        wrapper.pending_enter = False
        time.sleep(0.01)
        self.assertTrue(wrapper.inject_message(
            'Owner', '@Architect hello again', mentions=['participant-margaret'], msg_id='msg-1'
        ))

        self.assertEqual(wrapper.last_inject_time_iso, first_window)


class TestCodexSseUtf8(unittest.TestCase):
    def test_incremental_decoder_preserves_multibyte_characters_byte_by_byte(self):
        decoder = collab_codex.Utf8StreamDecoder()
        payload = 'Yes — 9 × 9 pt'.encode('utf-8')

        rendered = ''.join(decoder.decode(bytes([byte])) for byte in payload)

        self.assertEqual(rendered, 'Yes — 9 × 9 pt')


class TestCodexSelfReminderDelivery(unittest.TestCase):
    def _wrapper(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.participant_id = 'roster-weir'
        wrapper.delivery_protocol = None
        wrapper.sse_message_queue = queue.Queue()
        wrapper._message_event = threading.Event()
        return wrapper

    @staticmethod
    def _payload(metadata=None, mentions=None):
        return json.dumps({
            'message': {
                'id': 'reminder-1',
                'from': {'id': 'roster-weir', 'name': 'Weir'},
                'content': '@Weir run the scheduled status pass',
                'mentions': mentions if mentions is not None else ['roster-weir'],
                'metadata': metadata or {},
            }
        })

    def test_marked_self_reminder_is_queued_for_injection(self):
        wrapper = self._wrapper()

        wrapper._handle_sse_event(
            'collab:message',
            self._payload(metadata={'allowSelfDelivery': True}),
            'evt-reminder',
        )

        queued = wrapper.sse_message_queue.get_nowait()
        self.assertEqual(queued['id'], 'reminder-1')
        self.assertTrue(wrapper._message_event.is_set())

    def test_unmarked_own_message_is_still_dropped(self):
        wrapper = self._wrapper()

        wrapper._handle_sse_event(
            'collab:message',
            self._payload(),
            'evt-normal',
        )

        self.assertTrue(wrapper.sse_message_queue.empty())

    def test_marked_message_without_self_mention_is_dropped(self):
        wrapper = self._wrapper()

        wrapper._handle_sse_event(
            'collab:message',
            self._payload(
                metadata={'allowSelfDelivery': True},
                mentions=['someone-else'],
            ),
            'evt-not-targeted',
        )

        self.assertTrue(wrapper.sse_message_queue.empty())


class TestCodexChildCleanup(unittest.TestCase):
    def test_cleanup_removes_child_files_and_matching_wrapper_session(self):
        wrapper = _lifecycle_wrapper()
        with tempfile.TemporaryDirectory() as tmpdir:
            claude_dir = os.path.join(tmpdir, '.claude')
            os.makedirs(claude_dir)
            ready = os.path.join(tmpdir, 'ready.json')
            invite = os.path.join(tmpdir, 'invite.json')
            local_child = os.path.join(claude_dir, 'collab-session-111.json')
            local_wrapper = os.path.join(claude_dir, 'collab-session-222.json')
            tmp_child = os.path.join(tmpdir, 'tmp-child.json')
            tmp_wrapper = os.path.join(tmpdir, 'tmp-wrapper.json')
            for path in (ready, invite, local_child, tmp_child):
                with open(path, 'w') as f:
                    f.write('{}')
            for path in (local_wrapper, tmp_wrapper):
                with open(path, 'w') as f:
                    json.dump({'pid': 111}, f)

            real_remove = os.remove

            def translated_remove(path):
                translations = {
                    '/tmp/collab-session-111.json': tmp_child,
                    '/tmp/collab-session-222.json': tmp_wrapper,
                }
                return real_remove(translations.get(path, path))

            real_open = open

            def translated_open(path, *args, **kwargs):
                if path == '/tmp/collab-session-222.json':
                    path = tmp_wrapper
                return real_open(path, *args, **kwargs)

            with patch.object(collab_codex, 'get_ready_file', return_value=ready), \
                    patch.object(collab_codex, 'get_invite_file', return_value=invite), \
                    patch.object(collab_codex.os, 'getcwd', return_value=tmpdir), \
                    patch.object(collab_codex.os, 'remove', side_effect=translated_remove), \
                    patch.object(collab_codex, 'debug'), \
                    patch('builtins.open', side_effect=translated_open):
                wrapper._cleanup_child_files(111)

            for path in (ready, invite, local_child, local_wrapper, tmp_child, tmp_wrapper):
                self.assertFalse(os.path.exists(path), path)

    def test_cleanup_preserves_wrapper_session_for_a_newer_child(self):
        wrapper = _lifecycle_wrapper()
        with tempfile.TemporaryDirectory() as tmpdir:
            claude_dir = os.path.join(tmpdir, '.claude')
            os.makedirs(claude_dir)
            local_wrapper = os.path.join(claude_dir, 'collab-session-222.json')
            with open(local_wrapper, 'w') as f:
                json.dump({'pid': 333}, f)

            with patch.object(collab_codex, 'get_ready_file', return_value=os.path.join(tmpdir, 'missing-ready')), \
                    patch.object(collab_codex, 'get_invite_file', return_value=os.path.join(tmpdir, 'missing-invite')), \
                    patch.object(collab_codex.os, 'getcwd', return_value=tmpdir), \
                    patch.object(collab_codex, 'debug'):
                wrapper._cleanup_child_files(111)

            self.assertTrue(os.path.exists(local_wrapper))


class TestCodexTranscriptOwnership(unittest.TestCase):
    def _session_dir(self, home):
        today = datetime.date.today()
        path = os.path.join(
            home, '.codex', 'sessions', str(today.year),
            f'{today.month:02d}', f'{today.day:02d}',
        )
        os.makedirs(path)
        return path

    def _expanduser(self, home):
        real_expanduser = os.path.expanduser
        return lambda path: home if path == '~' else real_expanduser(path)

    def test_simultaneous_agents_choose_newest_rollout_for_their_own_cwd(self):
        with tempfile.TemporaryDirectory() as home:
            agent_a = os.path.join(home, 'Team', 'Architect')
            agent_b = os.path.join(home, 'Team', 'Dave')
            os.makedirs(agent_a)
            os.makedirs(agent_b)
            session_dir = self._session_dir(home)
            a_old = os.path.join(session_dir, 'rollout-a-old.jsonl')
            a_new = os.path.join(session_dir, 'rollout-a-new.jsonl')
            b_newest = os.path.join(session_dir, 'rollout-b-newest.jsonl')
            _write_rollout(a_old, agent_a)
            _write_rollout(a_new, agent_a)
            _write_rollout(b_newest, agent_b)
            os.utime(a_old, (100, 100))
            os.utime(a_new, (200, 200))
            os.utime(b_newest, (300, 300))

            with patch.object(collab_codex.os.path, 'expanduser', side_effect=self._expanduser(home)):
                self.assertEqual(collab_codex.resolve_codex_transcript_path(agent_a), a_new)
                self.assertEqual(collab_codex.resolve_codex_transcript_path(agent_b), b_newest)

    def test_expected_cwd_never_falls_back_to_another_agents_rollout(self):
        with tempfile.TemporaryDirectory() as home:
            expected = os.path.join(home, 'Team', 'Architect')
            other = os.path.join(home, 'Team', 'Dave')
            os.makedirs(expected)
            os.makedirs(other)
            session_dir = self._session_dir(home)
            other_rollout = os.path.join(session_dir, 'rollout-other.jsonl')
            malformed = os.path.join(session_dir, 'rollout-malformed.jsonl')
            _write_rollout(other_rollout, other)
            with open(malformed, 'w') as f:
                f.write('{not-json}\n')
            os.utime(other_rollout, (100, 100))
            os.utime(malformed, (200, 200))

            with patch.object(collab_codex.os.path, 'expanduser', side_effect=self._expanduser(home)):
                self.assertIsNone(collab_codex.resolve_codex_transcript_path(expected))

    def test_no_expected_cwd_preserves_legacy_newest_file_fallback(self):
        with tempfile.TemporaryDirectory() as home:
            session_dir = self._session_dir(home)
            older = os.path.join(session_dir, 'rollout-older.jsonl')
            newest = os.path.join(session_dir, 'rollout-newest.jsonl')
            with open(older, 'w') as f:
                f.write('{legacy-without-session-meta}\n')
            with open(newest, 'w') as f:
                f.write('{also-legacy}\n')
            os.utime(older, (100, 100))
            os.utime(newest, (200, 200))

            with patch.object(collab_codex.os.path, 'expanduser', side_effect=self._expanduser(home)):
                self.assertEqual(collab_codex.resolve_codex_transcript_path(), newest)

    def test_cached_owned_rollout_survives_daily_lookup_window(self):
        with tempfile.TemporaryDirectory() as home:
            agent_dir = os.path.join(home, 'Team', 'Architect')
            os.makedirs(agent_dir)
            old_dir = os.path.join(home, '.codex', 'sessions', '2026', '07', '20')
            os.makedirs(old_dir)
            rollout = os.path.join(old_dir, 'rollout-owned.jsonl')
            _write_rollout(rollout, agent_dir)

            wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
            wrapper.agent_dir = agent_dir
            wrapper._codex_transcript_path = rollout
            wrapper._codex_transcript_byte = 321
            wrapper._inject_transcript_byte = 123

            with patch.object(
                collab_codex,
                'resolve_codex_transcript_path',
                return_value=None,
            ) as resolver:
                self.assertEqual(wrapper._resolve_transcript(), rollout)

            resolver.assert_not_called()
            self.assertEqual(wrapper._codex_transcript_byte, 321)
            self.assertEqual(wrapper._inject_transcript_byte, 123)

    def test_retry_token_search_uses_recorded_transcript_without_global_scan(self):
        with tempfile.TemporaryDirectory() as home:
            agent_dir = os.path.join(home, 'Team', 'Architect')
            os.makedirs(agent_dir)
            old_day = datetime.date.today() - datetime.timedelta(days=8)
            old_dir = os.path.join(
                home,
                '.codex',
                'sessions',
                str(old_day.year),
                f'{old_day.month:02d}',
                f'{old_day.day:02d}',
            )
            os.makedirs(old_dir)
            rollout = os.path.join(old_dir, 'rollout-owned.jsonl')
            token = collab_codex.delivery_token('message-1', 'roster-margaret')
            _write_rollout(rollout, agent_dir, [{
                'type': 'response_item',
                'payload': {'role': 'user', 'content': [{'type': 'input_text', 'text': token}]},
            }])

            wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
            wrapper.agent_dir = agent_dir
            wrapper.participant_id = 'roster-margaret'
            wrapper._resolve_transcript = MagicMock(return_value=None)

            with patch.object(collab_codex.os.path, 'expanduser', side_effect=self._expanduser(home)):
                found = wrapper._find_existing_delivery_token(token, rollout)

            self.assertIsNotNone(found)
            self.assertEqual(found[0], rollout)


class TestCodexDurableDelivery(unittest.TestCase):
    def test_crash_recovery_rejects_a_ledger_claim_supported_only_by_tool_output(self):
        token = collab_codex.delivery_token('recover-message', 'riley')
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'rollout.jsonl')
            with open(path, 'w') as stream:
                stream.write(json.dumps({'type': 'response_item', 'payload': {
                    'type': 'custom_tool_call_output', 'output': token}}) + '\n')
                stream.write(json.dumps({'type': 'response_item', 'payload': {
                    'role': 'assistant', 'phase': 'final_answer'}}) + '\n')
            wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
            wrapper.delivery_protocol = 'ledger-v1'
            wrapper._active_delivery = None
            wrapper._child_startup_proven = wrapper.joined = True
            wrapper.channel_id, wrapper.participant_id = 'commander', 'riley'
            wrapper._last_delivery_recovery_mono = 0
            wrapper._delivery_api_call = MagicMock(return_value={'record': {
                'id': 'recovery-record', 'messageId': 'recover-message', 'token': token,
                'state': 'ingested', 'transcriptPath': path, 'transcriptByte': 5}})
            wrapper._dead_letter_active_delivery = MagicMock(return_value=True)
            wrapper._complete_active_delivery = MagicMock(return_value=True)
            self.assertFalse(wrapper._recover_ingested_delivery())
            wrapper._complete_active_delivery.assert_not_called()
            wrapper._dead_letter_active_delivery.assert_called_once_with('recovery_unverified_ingestion')

    def test_crash_recovery_can_complete_an_exact_typed_user_turn(self):
        token = collab_codex.delivery_token('recover-real', 'riley')
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'rollout.jsonl')
            with open(path, 'w') as stream:
                stream.write(json.dumps({'type': 'response_item', 'payload': {
                    'role': 'user', 'content': [{'type': 'input_text', 'text': token}]}}) + '\n')
                stream.write(json.dumps({'type': 'response_item', 'payload': {
                    'role': 'assistant', 'phase': 'final_answer'}}) + '\n')
            wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
            wrapper.delivery_protocol = 'ledger-v1'
            wrapper._active_delivery = None
            wrapper._child_startup_proven = wrapper.joined = True
            wrapper.channel_id, wrapper.participant_id = 'commander', 'riley'
            wrapper._last_delivery_recovery_mono = 0
            wrapper._delivery_api_call = MagicMock(return_value={'record': {
                'id': 'recovery-record', 'messageId': 'recover-real', 'token': token,
                'state': 'ingested', 'transcriptPath': path, 'transcriptByte': 5}})
            wrapper._dead_letter_active_delivery = MagicMock(return_value=True)
            wrapper._complete_active_delivery = MagicMock(return_value=True)
            self.assertTrue(wrapper._recover_ingested_delivery())
            wrapper._complete_active_delivery.assert_called_once()
            wrapper._dead_letter_active_delivery.assert_not_called()

    def test_context_usage_reads_latest_token_count(self):
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as rollout:
            rollout.write(json.dumps({
                'type': 'event_msg',
                'payload': {
                    'type': 'token_count',
                    'info': {
                        'last_token_usage': {'total_tokens': 100},
                        'model_context_window': 1000,
                    },
                },
            }) + '\n')
            rollout.write(json.dumps({
                'type': 'event_msg',
                'payload': {
                    'type': 'token_count',
                    'info': {
                        'last_token_usage': {'total_tokens': 700},
                        'model_context_window': 1000,
                    },
                },
            }) + '\n')
            path = rollout.name
        try:
            self.assertEqual(collab_codex.read_codex_context_usage(path), (700, 1000))
        finally:
            os.unlink(path)

    def test_auto_compact_starts_only_for_idle_unqueued_high_context(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.is_processing = False
        wrapper.pending_enter = False
        wrapper._verify_pending = False
        wrapper._active_delivery = None
        wrapper.sse_message_queue = queue.Queue()
        wrapper.child = MagicMock()
        wrapper.child.isalive.return_value = True
        wrapper._auto_compact_last_attempt_mono = 0.0
        wrapper._resolve_transcript = MagicMock(return_value='/tmp/rollout.jsonl')
        wrapper._send_child_input = MagicMock(return_value=True)
        wrapper.broadcast_activity = MagicMock()
        wrapper.last_output_time = 0
        wrapper.output_seen_since_inject = True
        wrapper.idle_since = time.time()

        with patch.object(collab_codex, 'read_codex_context_usage', return_value=(700, 1000)):
            self.assertTrue(wrapper._maybe_auto_compact_context())

        wrapper._send_child_input.assert_called_once_with('/compact', key='Enter')
        self.assertTrue(wrapper.is_processing)
        self.assertFalse(wrapper.output_seen_since_inject)
        wrapper.broadcast_activity.assert_called_once_with('working', force=True)

    def test_auto_compact_runs_before_queued_channel_message(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.is_processing = False
        wrapper.pending_enter = False
        wrapper._verify_pending = False
        wrapper._active_delivery = None
        wrapper.sse_message_queue = queue.Queue()
        wrapper.sse_message_queue.put({'id': 'message-1'})
        wrapper.child = MagicMock()
        wrapper.child.isalive.return_value = True
        wrapper._auto_compact_last_attempt_mono = 0.0
        wrapper._resolve_transcript = MagicMock(return_value='/tmp/rollout.jsonl')
        wrapper._send_child_input = MagicMock(return_value=True)
        wrapper.broadcast_activity = MagicMock()
        wrapper.last_output_time = 0
        wrapper.output_seen_since_inject = True
        wrapper.idle_since = time.time()

        with patch.object(collab_codex, 'read_codex_context_usage', return_value=(900, 1000)):
            self.assertTrue(wrapper._maybe_auto_compact_context())

        wrapper._send_child_input.assert_called_once_with('/compact', key='Enter')

    def test_turn_aborted_is_an_idle_boundary_after_reasoning(self):
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as rollout:
            rollout.write(json.dumps({
                'type': 'response_item',
                'payload': {'type': 'reasoning'},
            }) + '\n')
            rollout.write(json.dumps({
                'type': 'event_msg',
                'payload': {'type': 'turn_aborted'},
            }) + '\n')
            path = rollout.name
        try:
            self.assertEqual(collab_codex.check_codex_jsonl_state(path), 'idle')
        finally:
            os.unlink(path)

    def test_initializer_creates_jsonl_poll_counter(self):
        with patch.object(CollabCodexWrapper, '_detect_tmux_pane', return_value=None):
            wrapper = CollabCodexWrapper()

        self.assertEqual(wrapper._jsonl_check_count, 0)

    def test_stale_processing_marker_cannot_starve_an_idle_child(self):
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as rollout:
            rollout.write(json.dumps({
                'type': 'response_item',
                'payload': {'type': 'reasoning'},
            }) + '\n')
            path = rollout.name
        try:
            old = time.time() - collab_codex.STALE_JSONL_PROCESSING_SECONDS - 5
            os.utime(path, (old, old))
            wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
            wrapper._codex_transcript_path = path
            wrapper._codex_transcript_byte = 0
            wrapper._last_jsonl_state = None
            wrapper.is_process_tree_active = MagicMock(return_value=False)
            wrapper._resolve_transcript = MagicMock(return_value=path)

            self.assertIsNone(wrapper._check_jsonl_state())
        finally:
            os.unlink(path)

    def test_corrective_reminder_is_one_shot_per_inbound_message(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.child = MagicMock()
        wrapper.child.isalive.return_value = True
        wrapper.last_injected_was_mentioned = True
        wrapper.last_injected_sender = 'Owner'
        wrapper._response_window_msg_id = 'message-1'
        wrapper._corrective_sent_msg_id = None
        wrapper._enter_lock = threading.Lock()
        wrapper.pending_enter = False
        wrapper._tmux_send = MagicMock(return_value=True)
        wrapper._send_child_input = MagicMock(return_value=True)

        self.assertTrue(wrapper.send_corrective_reminder())
        self.assertFalse(wrapper.send_corrective_reminder())
        wrapper._send_child_input.assert_called_once_with(
            unittest.mock.ANY, key='Enter', bracketed=True
        )
        wrapper._tmux_send.assert_not_called()

    def test_join_advertises_wrapper_pid_used_by_delivery_owner_fence(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.channel_id = 'channel-1'
        wrapper.channel_name = ''
        wrapper.participant_name = 'Architect'
        wrapper.participant_id = None
        wrapper.codex_pid = 333
        wrapper.wrapper_pid = 222
        wrapper.delivery_protocol = 'ledger-v1'
        wrapper.api_call = MagicMock(return_value={'success': False, 'error': 'test stop'})

        self.assertFalse(wrapper.join_channel('channel-1'))

        payload = wrapper.api_call.call_args.args[2]
        self.assertEqual(payload['participant']['pid'], 222)

    def test_reasoning_and_tool_activity_after_an_older_final_is_processing(self):
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as rollout:
            rollout.write(json.dumps({
                'type': 'response_item',
                'payload': {'type': 'message', 'role': 'assistant', 'phase': 'final_answer'},
            }) + '\n')
            rollout.write(json.dumps({
                'type': 'response_item',
                'payload': {'type': 'reasoning'},
            }) + '\n')
            rollout.write(json.dumps({
                'type': 'response_item',
                'payload': {'type': 'custom_tool_call'},
            }) + '\n')
            path = rollout.name
        try:
            self.assertEqual(collab_codex.check_codex_jsonl_state(path), 'processing')
        finally:
            os.unlink(path)


    def test_exact_token_offset_excludes_stale_final_answer(self):
        with tempfile.NamedTemporaryFile(mode='wb', delete=False) as rollout:
            rollout.write(json.dumps({
                'type': 'response_item',
                'payload': {'role': 'assistant', 'phase': 'final_answer'},
            }).encode() + b'\n')
            token = collab_codex.delivery_token('message-1')
            rollout.write(json.dumps({
                'type': 'response_item',
                'payload': {'role': 'user', 'content': [{'type': 'input_text', 'text': token}]},
            }).encode() + b'\n')
            rollout.write(json.dumps({
                'type': 'response_item',
                'payload': {'role': 'assistant', 'phase': 'analysis'},
            }).encode() + b'\n')
            path = rollout.name
        try:
            token_end = collab_codex.find_codex_delivery_token_offset(path, token, 0)
            self.assertIsNotNone(token_end)
            self.assertEqual(collab_codex.check_codex_jsonl_state(path, token_end), 'processing')
        finally:
            os.unlink(path)

    def test_ingestion_requires_typed_user_input_not_tool_or_assistant_echo(self):
        token = collab_codex.delivery_token('typed-user-only')
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'rollout.jsonl')
            records = [
                {'type': 'response_item', 'payload': {'role': role,
                    'content': [{'type': 'input_text', 'text': token}]}}
                for role in ('assistant', 'tool', 'system')
            ] + [
                {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': token}},
                {'type': 'response_item', 'payload': {'type': 'custom_tool_call_output', 'output': token}},
                {'type': 'response_item', 'payload': {'role': 'user',
                    'content': [{'type': 'input_text', 'text': 'quoted inline ' + token}]}},
            ]
            with open(path, 'w') as stream:
                for record in records:
                    stream.write(json.dumps(record) + '\n')
            self.assertIsNone(collab_codex.find_codex_delivery_token_offset(path, token))
            boundary = os.path.getsize(path)
            user = json.dumps({'type': 'response_item', 'payload': {'role': 'user',
                'content': [{'type': 'input_text', 'text': token + '\nchannel message'}]}})
            with open(path, 'a') as stream:
                stream.write(user)
            self.assertIsNone(collab_codex.find_codex_delivery_token_offset(path, token, boundary))
            with open(path, 'a') as stream:
                stream.write('\n')
            verified = collab_codex.find_codex_delivery_token_offset(path, token, boundary)
            self.assertGreater(verified, boundary)
            self.assertIsNone(collab_codex.find_codex_delivery_token_offset(path, token, os.path.getsize(path)))

    def test_claim_is_gated_until_startup_is_proven(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.delivery_protocol = 'ledger-v1'
        wrapper._child_startup_proven = False
        wrapper._active_delivery = None
        wrapper.joined = True
        wrapper.channel_id = 'channel-1'
        wrapper.participant_id = 'roster-margaret'
        wrapper.child = MagicMock()
        wrapper.child.isalive.return_value = True
        wrapper._delivery_api_call = MagicMock()

        self.assertIsNone(wrapper._claim_durable_delivery())
        wrapper._delivery_api_call.assert_not_called()

    def test_claim_is_gated_while_transcript_shows_runtime_work(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.delivery_protocol = 'ledger-v1'
        wrapper._child_startup_proven = True
        wrapper._active_delivery = None
        wrapper.joined = True
        wrapper.channel_id = 'channel-1'
        wrapper.participant_id = 'roster-margaret'
        wrapper.is_processing = False
        wrapper.child = MagicMock()
        wrapper.child.isalive.return_value = True
        wrapper._check_jsonl_state = MagicMock(return_value='processing')
        wrapper._delivery_api_call = MagicMock()

        self.assertIsNone(wrapper._claim_durable_delivery())
        wrapper._delivery_api_call.assert_not_called()

    def test_expired_active_lease_is_cleared_without_changing_runtime_activity(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper._active_delivery = {
            'messageId': 'message-1',
            'state': 'submitted',
            'lease': {'expiresAt': '2026-07-28T10:06:24.000Z'},
        }
        wrapper._active_delivery_started_mono = time.monotonic()
        wrapper._verify_pending = True
        wrapper._verify_search_text = '[[collab-delivery:message-1]]'
        wrapper._verify_msg_id = 'message-1'
        wrapper._verify_msg_ts = '2026-07-28T10:05:54.000Z'
        wrapper._verify_start_time = time.time()
        wrapper._verify_after_byte = 100
        wrapper.pending_mark_read = False
        wrapper.pending_mark_read_timestamp = wrapper._verify_msg_ts
        wrapper.last_injected_msg_id = 'message-1'
        wrapper.is_processing = True

        self.assertTrue(wrapper._reconcile_active_delivery(
            now=datetime.datetime(2026, 7, 28, 10, 6, 25, tzinfo=datetime.timezone.utc)
        ))

        self.assertIsNone(wrapper._active_delivery)
        self.assertFalse(wrapper._verify_pending)
        self.assertTrue(wrapper.is_processing)

    def test_unexpired_active_lease_is_not_cleared(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        active = {
            'messageId': 'message-1',
            'state': 'submitted',
            'lease': {'expiresAt': '2026-07-28T10:06:24.000Z'},
        }
        wrapper._active_delivery = active
        wrapper._active_delivery_started_mono = time.monotonic()
        wrapper._verify_pending = True
        wrapper.pending_enter = False
        wrapper.is_processing = True

        self.assertFalse(wrapper._reconcile_active_delivery(
            now=datetime.datetime(2026, 7, 28, 10, 6, 23, tzinfo=datetime.timezone.utc)
        ))
        self.assertIs(wrapper._active_delivery, active)

    def test_orphaned_submitted_state_is_cleared_before_lease_expiry(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper._active_delivery = {
            'messageId': 'message-1',
            'state': 'submitted',
            'lease': {'expiresAt': '2026-07-28T10:10:00.000Z'},
        }
        wrapper._active_delivery_started_mono = time.monotonic()
        wrapper._verify_pending = False
        wrapper.pending_enter = False
        wrapper.pending_mark_read = False
        wrapper.pending_mark_read_timestamp = None
        wrapper.last_injected_msg_id = 'message-1'
        wrapper.is_processing = False

        self.assertTrue(wrapper._reconcile_active_delivery(
            now=datetime.datetime(2026, 7, 28, 10, 6, 23, tzinfo=datetime.timezone.utc)
        ))
        self.assertIsNone(wrapper._active_delivery)

    def test_active_delivery_without_valid_lease_has_bounded_local_lifetime(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper._active_delivery = {
            'messageId': 'message-1',
            'state': 'submitted',
            'lease': {},
        }
        wrapper._active_delivery_started_mono = time.monotonic() - 121
        wrapper._verify_pending = False
        wrapper.pending_mark_read = False
        wrapper.pending_mark_read_timestamp = None
        wrapper.last_injected_msg_id = 'message-1'
        wrapper.is_processing = False

        self.assertTrue(wrapper._reconcile_active_delivery())
        self.assertIsNone(wrapper._active_delivery)

    def test_lease_renewal_does_not_reset_local_lifetime_ceiling(self):
        started_mono = time.monotonic() - 100
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper._active_delivery = {
            'id': 'record-1',
            'messageId': 'message-1',
            'state': 'submitted',
            'lease': {
                'id': 'lease-1',
                'expiresAt': '2026-07-28T10:06:24.000Z',
            },
        }
        wrapper._active_delivery_started_mono = started_mono
        wrapper.channel_id = 'channel-1'
        wrapper.participant_id = 'roster-margaret'
        wrapper.wrapper_pid = 222
        wrapper._delivery_api_call = MagicMock(return_value={'record': {
            **wrapper._active_delivery,
            'lease': {
                'id': 'lease-1',
                'expiresAt': '2026-07-28T10:07:00.000Z',
            },
        }})

        self.assertTrue(wrapper._renew_active_delivery())
        self.assertEqual(wrapper._active_delivery_started_mono, started_mono)

    def test_unsupported_renew_is_attempted_once_not_every_poll(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper._active_delivery = {
            'id': 'record-1',
            'messageId': 'message-1',
            'state': 'submitted',
            'lease': {
                'id': 'lease-1',
                'expiresAt': '2026-07-28T10:06:24.000Z',
            },
        }
        wrapper.channel_id = 'channel-1'
        wrapper.participant_id = 'roster-margaret'
        wrapper.wrapper_pid = 222
        wrapper._renew_delivery_supported = True
        wrapper._delivery_api_call = MagicMock(return_value={
            'status': 400,
            'error': 'Unknown delivery action',
        })

        self.assertFalse(wrapper._renew_active_delivery())
        self.assertFalse(wrapper._renew_active_delivery())
        wrapper._delivery_api_call.assert_called_once()

    def test_local_lifetime_ceiling_quarantines_accepted_submit_without_replay(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper._active_delivery = {
            'id': 'record-1',
            'messageId': 'message-1',
            'state': 'submitted',
            'lease': {
                'id': 'lease-1',
                'expiresAt': '2099-07-28T10:06:24.000Z',
            },
        }
        wrapper._active_delivery_started_mono = time.monotonic() - 121
        wrapper._verify_pending = True
        wrapper.pending_enter = False
        wrapper.is_processing = True
        wrapper._dead_letter_active_delivery = MagicMock(return_value=True)
        wrapper._clear_active_delivery_state = MagicMock()
        wrapper._clear_codex_composer = MagicMock()

        self.assertTrue(wrapper._reconcile_active_delivery())

        wrapper._dead_letter_active_delivery.assert_called_once_with('jsonl_ingestion_timeout')
        wrapper._clear_codex_composer.assert_called_once_with()
        wrapper._clear_active_delivery_state.assert_called_once_with(
            'local_lifetime_exceeded'
        )

    def test_ingested_delivery_is_not_dead_lettered_by_pre_ingestion_ceiling(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper._active_delivery = {
            'id': 'record-1',
            'messageId': 'message-1',
            'state': 'ingested',
            'lease': {
                'id': 'lease-1',
                'expiresAt': '2099-07-28T10:06:24.000Z',
            },
        }
        wrapper._active_delivery_started_mono = time.monotonic() - 121
        wrapper._verify_pending = False
        wrapper.pending_enter = False
        wrapper.is_processing = True
        wrapper._dead_letter_active_delivery = MagicMock(return_value=True)
        wrapper._clear_active_delivery_state = MagicMock()

        self.assertFalse(wrapper._reconcile_active_delivery())
        wrapper._dead_letter_active_delivery.assert_not_called()
        wrapper._clear_active_delivery_state.assert_not_called()

    def test_ingested_delivery_renews_after_pre_ingestion_ceiling(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper._active_delivery = {
            'id': 'record-1',
            'messageId': 'message-1',
            'state': 'ingested',
            'lease': {
                'id': 'lease-1',
                'expiresAt': '2020-01-01T00:00:00.000Z',
            },
        }
        wrapper._active_delivery_started_mono = time.monotonic() - 121
        wrapper.channel_id = 'channel-1'
        wrapper.participant_id = 'roster-margaret'
        wrapper.wrapper_pid = 222
        wrapper._delivery_api_call = MagicMock(return_value={'record': {
            **wrapper._active_delivery,
            'lease': {
                'id': 'lease-1',
                'expiresAt': '2099-01-01T00:00:00.000Z',
            },
        }})

        self.assertTrue(wrapper._renew_active_delivery())
        wrapper._delivery_api_call.assert_called_once()

    def test_release_api_failure_cannot_leave_an_expired_local_queue_blocker(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper._verify_pending = True
        wrapper._verify_start_time = time.time() - 10
        wrapper._verify_after_byte = 0
        wrapper._verify_search_text = '[[collab-delivery:message-1]]'
        wrapper._verify_msg_id = 'message-1'
        wrapper._verify_msg_ts = '2026-07-28T10:05:54.000Z'
        wrapper._verify_timeout = 5
        wrapper._active_delivery = {
            'id': 'record-1',
            'messageId': 'message-1',
            'token': wrapper._verify_search_text,
            'state': 'submitted',
            'lease': {
                'id': 'lease-1',
                'expiresAt': '2026-07-28T10:06:24.000Z',
            },
        }
        wrapper._active_delivery_started_mono = time.monotonic()
        wrapper._resolve_transcript = MagicMock(return_value=None)
        wrapper._dead_letter_active_delivery = MagicMock(side_effect=[False, True])
        wrapper.log_delivery_failure = MagicMock()
        wrapper._verify_timeout_logged = False
        wrapper.is_processing = True
        wrapper.pending_mark_read = False
        wrapper.pending_mark_read_timestamp = wrapper._verify_msg_ts
        wrapper.last_injected_msg_id = 'message-1'

        self.assertFalse(wrapper.check_verify_ingestion())
        self.assertIsNotNone(wrapper._active_delivery)

        self.assertTrue(wrapper._reconcile_active_delivery(
            now=datetime.datetime(2026, 7, 28, 10, 6, 25, tzinfo=datetime.timezone.utc)
        ))
        self.assertIsNone(wrapper._active_delivery)
        self.assertTrue(wrapper.is_processing)

    def test_noninject_transcript_work_marks_wrapper_processing(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.is_processing = False
        wrapper.joined = True
        wrapper._check_jsonl_state = MagicMock(return_value='processing')
        wrapper.broadcast_activity = MagicMock()
        wrapper.last_output_time = 0
        wrapper.output_seen_since_inject = True
        wrapper.idle_since = 123

        wrapper.check_jsonl_processing_start()

        self.assertTrue(wrapper.is_processing)
        self.assertFalse(wrapper.output_seen_since_inject)
        self.assertEqual(wrapper.idle_since, 0)
        wrapper.broadcast_activity.assert_called_once_with('working', force=True)

    def test_durable_injection_contains_stable_token(self):
        wrapper = TestCodexTmuxSubmission()._inject_wrapper(is_processing=False)
        wrapper._active_delivery = {
            'id': 'record-1',
            'messageId': 'message-1',
            'token': '[[collab-delivery:message-1]]',
            'state': 'leased',
            'lease': {'id': 'lease-1'},
        }

        self.assertTrue(wrapper.inject_message(
            'Owner', '@Architect hello', mentions=['participant-margaret'], msg_id='message-1'
        ))

        sent_prompt = wrapper._send_child_input.call_args.args[0]
        self.assertIn('[[collab-delivery:message-1]]', sent_prompt)

    def test_ingestion_ack_is_first_durable_dedup_point(self):
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as rollout:
            token = '[[collab-delivery:message-1]]'
            rollout.write(json.dumps({'type': 'response_item', 'payload': {'role': 'user',
                'content': [{'type': 'input_text', 'text': token}]}}) + '\n')
            path = rollout.name
        try:
            wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
            wrapper._verify_pending = True
            wrapper._verify_start_time = time.time()
            wrapper._verify_after_byte = 0
            wrapper._verify_search_text = token
            wrapper._verify_msg_id = 'message-1'
            wrapper._verify_msg_ts = '2026-07-19T00:00:01.000Z'
            wrapper._verify_timeout = 5
            wrapper._active_delivery = {
                'id': 'record-1',
                'messageId': 'message-1',
                'token': token,
                'state': 'submitted',
                'lease': {'id': 'lease-1'},
            }
            wrapper._resolve_transcript = MagicMock(return_value=path)
            wrapper._transition_active_delivery = MagicMock(return_value=True)
            wrapper._track_injected_id = MagicMock()
            wrapper._retry_attempts = {}
            wrapper._save_cursor_timestamp = MagicMock()
            wrapper.log_delivery_event = MagicMock()
            wrapper.last_poll_time = ''
            wrapper._codex_transcript_byte = 0

            self.assertTrue(wrapper.check_verify_ingestion())

            wrapper._transition_active_delivery.assert_called_once()
            self.assertEqual(wrapper._transition_active_delivery.call_args.args[0], 'ingested')
            wrapper._track_injected_id.assert_called_once_with('message-1')
            self.assertGreater(wrapper._codex_transcript_byte, 0)
            self.assertFalse(wrapper._verify_pending)
        finally:
            os.unlink(path)

    def test_missing_token_timeout_keeps_claim_for_late_ingestion(self):
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as rollout:
            rollout.write('{}\n')
            path = rollout.name
        try:
            wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
            wrapper._verify_pending = True
            wrapper._verify_start_time = time.time() - 10
            wrapper._verify_after_byte = 0
            wrapper._verify_search_text = '[[collab-delivery:message-1]]'
            wrapper._verify_msg_id = 'message-1'
            wrapper._verify_msg_ts = '2026-07-19T00:00:01.000Z'
            wrapper._verify_timeout = 5
            wrapper._active_delivery = {
                'id': 'record-1',
                'messageId': 'message-1',
                'token': '[[collab-delivery:message-1]]',
                'state': 'submitted',
                'lease': {'id': 'lease-1'},
            }
            wrapper._resolve_transcript = MagicMock(return_value=path)
            wrapper._release_active_delivery = MagicMock(return_value=True)
            wrapper._clear_codex_composer = MagicMock()
            wrapper.log_delivery_failure = MagicMock()
            wrapper.is_processing = True
            wrapper.pending_mark_read = True
            wrapper.pending_mark_read_timestamp = wrapper._verify_msg_ts
            wrapper.last_injected_msg_id = 'message-1'
            wrapper._verify_timeout_logged = False

            self.assertFalse(wrapper.check_verify_ingestion())

            wrapper._release_active_delivery.assert_not_called()
            wrapper._clear_codex_composer.assert_not_called()
            self.assertIsNotNone(wrapper._active_delivery)
            self.assertTrue(wrapper._verify_pending)
            self.assertTrue(wrapper._verify_timeout_logged)
            self.assertTrue(wrapper.is_processing)
            self.assertTrue(wrapper.pending_mark_read)
            wrapper.log_delivery_failure.assert_called_once_with(
                'message-1', 'jsonl_ingestion_timeout', elapsed_ms=unittest.mock.ANY
            )
        finally:
            os.unlink(path)

    def test_retry_claim_with_existing_transcript_token_is_not_reinjected(self):
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as rollout:
            token = '[[collab-delivery:message-1]]'
            rollout.write(json.dumps({
                'type': 'response_item',
                'payload': {'type': 'message', 'role': 'user', 'content': token},
            }) + '\n')
            rollout.write(json.dumps({
                'type': 'response_item',
                'payload': {'type': 'message', 'role': 'assistant', 'phase': 'final_answer'},
            }) + '\n')
            path = rollout.name
        try:
            wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
            wrapper.delivery_protocol = 'ledger-v1'
            wrapper._child_startup_proven = True
            wrapper._active_delivery = None
            wrapper._active_delivery_started_mono = 0
            wrapper.joined = True
            wrapper.channel_id = 'channel-1'
            wrapper.participant_id = 'roster-margaret'
            wrapper.wrapper_pid = 222
            wrapper.is_processing = False
            wrapper.child = MagicMock()
            wrapper.child.isalive.return_value = True
            wrapper._check_jsonl_state = MagicMock(return_value='idle')
            wrapper._last_delivery_claim_mono = 0
            wrapper._delivery_claim_interval = 0
            wrapper._delivery_api_call = MagicMock(return_value={'record': {
                'id': 'record-1',
                'messageId': 'message-1',
                'token': token,
                'state': 'leased',
                'attempts': 2,
                'recoveryReason': 'jsonl_ingestion_timeout',
                'transcriptPath': path,
                'message': {'id': 'message-1', 'timestamp': '2026-08-04T08:50:00.000Z'},
                'lease': {'id': 'lease-2'},
            }})
            wrapper._find_existing_delivery_token = MagicMock(return_value=(path, len(token)))
            wrapper._transition_active_delivery = MagicMock(return_value=True)
            wrapper._complete_active_delivery = MagicMock(return_value=True)

            self.assertIsNone(wrapper._claim_durable_delivery())

            wrapper._find_existing_delivery_token.assert_called_once_with(token, path)
            wrapper._transition_active_delivery.assert_called_once_with(
                'ingested', transcript_path=path, transcript_byte=len(token)
            )
            wrapper._complete_active_delivery.assert_called_once_with()
        finally:
            os.unlink(path)

    def test_wrapper_never_injects_an_attempt_beyond_its_retry_ceiling(self):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.delivery_protocol = 'ledger-v1'
        wrapper.MAX_DELIVERY_RETRIES = 3
        wrapper._child_startup_proven = True
        wrapper._active_delivery = None
        wrapper._active_delivery_started_mono = 0
        wrapper.joined = True
        wrapper.channel_id = 'channel-1'
        wrapper.participant_id = 'roster-margaret'
        wrapper.wrapper_pid = 222
        wrapper.is_processing = False
        wrapper.child = MagicMock()
        wrapper.child.isalive.return_value = True
        wrapper._check_jsonl_state = MagicMock(return_value='idle')
        wrapper._last_delivery_claim_mono = 0
        wrapper._delivery_claim_interval = 0
        wrapper._delivery_api_call = MagicMock(return_value={'record': {
            'id': 'record-1',
            'messageId': 'message-1',
            'token': '[[collab-delivery:message-1]]',
            'state': 'leased',
            'attempts': 4,
            'recoveryReason': 'jsonl_ingestion_timeout',
            'message': {'id': 'message-1', 'content': '@Architect do not replay'},
            'lease': {'id': 'lease-4'},
        }})
        wrapper._find_existing_delivery_token = MagicMock(return_value=None)
        wrapper._dead_letter_active_delivery = MagicMock(return_value=True)

        self.assertIsNone(wrapper._claim_durable_delivery())
        self.assertIsNotNone(wrapper._active_delivery)
        wrapper._dead_letter_active_delivery.assert_called_once_with('wrapper_attempt_ceiling')


class TestCodexInboxReadAfterConfirm(unittest.TestCase):
    def _wrapper(self, inbox_path):
        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper._get_inbox_path = MagicMock(return_value=inbox_path)
        wrapper.injected_message_ids = set()
        wrapper._dedup_lock = threading.Lock()
        wrapper.sse_message_queue = queue.Queue()
        wrapper.log_delivery_event = MagicMock()
        wrapper.participant_name = 'Daniel'
        return wrapper

    def test_fresh_inbox_message_stays_unread_until_injection_is_confirmed(self):
        inbox = {
            'messages': [{
                'id': 'message-1',
                'from': 'Owner (Signal)',
                'content': '@Daniel respond',
                'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'read': False,
            }],
            'lastUpdated': '2026-07-28T10:11:31.000Z',
        }
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as handle:
            json.dump(inbox, handle)
            path = handle.name
        try:
            wrapper = self._wrapper(path)

            self.assertEqual(wrapper.check_inbox(), 1)

            with open(path) as handle:
                stored = json.load(handle)
            self.assertFalse(stored['messages'][0]['read'])
        finally:
            os.unlink(path)

    def test_confirmed_inbox_message_is_marked_read_on_next_pass(self):
        inbox = {
            'messages': [{
                'id': 'message-1',
                'from': 'Owner (Signal)',
                'content': '@Daniel respond',
                'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'read': False,
            }],
            'lastUpdated': '2026-07-28T10:11:31.000Z',
        }
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as handle:
            json.dump(inbox, handle)
            path = handle.name
        try:
            wrapper = self._wrapper(path)
            wrapper.injected_message_ids.add('message-1')

            self.assertEqual(wrapper.check_inbox(), 0)

            with open(path) as handle:
                stored = json.load(handle)
            self.assertTrue(stored['messages'][0]['read'])
        finally:
            os.unlink(path)

    def test_inbox_reconstructs_routing_metadata(self):
        inbox = {
            'messages': [{
                'id': 'message-1',
                'from': 'Owner (Signal)',
                'senderId': 'user-owner',
                'content': 'targeted payload',
                'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'read': False,
                'mentions': ['roster-daniel'],
                'recipients': ['roster-daniel'],
                'metadata': {'deliveryMode': 'targeted'},
            }],
            'lastUpdated': '2026-07-28T10:11:31.000Z',
        }
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as handle:
            json.dump(inbox, handle)
            path = handle.name
        try:
            wrapper = self._wrapper(path)
            self.assertEqual(wrapper.check_inbox(), 1)
            queued = wrapper.sse_message_queue.get_nowait()
            self.assertEqual(queued['from']['id'], 'user-owner')
            self.assertEqual(queued['mentions'], ['roster-daniel'])
            self.assertEqual(queued['recipients'], ['roster-daniel'])
        finally:
            os.unlink(path)


if __name__ == '__main__':
    unittest.main()


class TestCodexTurnDisposition(unittest.TestCase):
    """A turn with no channel post is two opposite situations, not one.

    The corrective assumes the reply went to the terminal. It may instead be that
    the agent deliberately said nothing. Only the transcript separates them, and
    treating "unknown" as silence would swallow a genuinely lost reply — so
    anything short of proven emptiness must keep the warning.
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
    def _final(text):
        content = [{'type': 'output_text', 'text': text}] if text is not None else []
        return {'type': 'response_item',
                'payload': {'role': 'assistant', 'phase': 'final_answer', 'content': content}}

    @staticmethod
    def _event(kind):
        return {'type': 'event_msg', 'payload': {'type': kind}}

    def test_turn_with_text_reports_text(self):
        path = self._transcript(self._final('Here is the answer.'), self._event('task_complete'))
        self.assertEqual(collab_codex.codex_final_response_disposition(path), 'text')

    def test_completed_turn_with_no_final_answer_is_unknown(self):
        # A skipped or truncated final-response line leaves no parseable final
        # answer. Calling that silence would suppress a genuinely lost reply.
        path = self._transcript(self._event('task_complete'))
        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_blank_final_answer_with_completion_is_empty(self):
        # The live shape of a deliberate silence: an explicit blank final answer
        # followed by task_complete. Both halves required.
        path = self._transcript(self._final('   '), self._event('task_complete'))
        self.assertEqual(collab_codex.codex_final_response_disposition(path), 'empty')

    def test_blank_final_answer_without_completion_is_unknown(self):
        path = self._transcript(self._final(''))
        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_final_answer_ending_in_marker_with_completion_is_empty(self):
        path = self._transcript(self._final('Render done.\nNO_REPLY\n'), self._event('task_complete'))
        self.assertEqual(collab_codex.codex_final_response_disposition(path), 'empty')

    def test_marker_without_completion_is_unknown(self):
        path = self._transcript(self._final('NO_REPLY'))
        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_marker_not_on_last_line_is_text(self):
        for text in ('NO_REPLY\n@Dave here is my answer', 'NO_REPLY needed', 'NO_REPLY.'):
            with self.subTest(text=text):
                path = self._transcript(self._final(text), self._event('task_complete'))
                self.assertEqual(collab_codex.codex_final_response_disposition(path), 'text')

    def test_completion_before_blank_final_does_not_pair_across_order(self):
        # The two required halves must describe the same turn in transcript
        # order; an older completion cannot prove a later blank final complete.
        path = self._transcript(self._event('task_complete'), self._final(''))
        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_later_completion_without_final_overrides_earlier_silence(self):
        # Keep scanning to the current (last) completed turn. Reusing the prior
        # turn's blank final would fail open on a lost/malformed later answer.
        path = self._transcript(
            self._final(''),
            self._event('task_complete'),
            self._event('task_complete'),
        )
        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_malformed_final_then_completion_is_unknown(self):
        # The malformed line is skipped by the parser; without an explicit
        # parseable final answer the turn must not be classified as silent.
        fd, path = tempfile.mkstemp(suffix='.jsonl')
        os.close(fd)
        with open(path, 'w') as handle:
            handle.write('{"type": "response_item", "payload": {"phase": "final_ans\n')
            handle.write(json.dumps(self._event('task_complete')) + '\n')
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))
        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_truncated_final_then_completion_is_unknown(self):
        # A distinct truncation fixture pins the fail-safe independently of a
        # generic malformed line: task_complete alone cannot turn this into a
        # proven silent response.
        fd, path = tempfile.mkstemp(suffix='.jsonl')
        os.close(fd)
        with open(path, 'w') as handle:
            handle.write('{"type":"response_item","payload":{"phase":"final_answer",')
            handle.write('\n' + json.dumps(self._event('task_complete')) + '\n')
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))

        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_truncated_record_after_blank_completion_invalidates_silence(self):
        # Once unreadable data appears after the candidate silent turn, the
        # reader can no longer prove that silence belongs to the current turn.
        path = self._transcript(self._final(''), self._event('task_complete'))
        with open(path, 'a') as handle:
            handle.write('{"type":"response_item","payload":')
        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_new_started_turn_after_blank_completion_invalidates_silence(self):
        # An older deliberately silent turn cannot suppress the warning for a
        # newer turn that has started but has no trustworthy final response.
        path = self._transcript(
            self._final(''),
            self._event('task_complete'),
            self._event('task_started'),
            {'type': 'response_item',
             'payload': {'type': 'message', 'role': 'user', 'content': []}},
        )
        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_new_user_record_without_started_event_invalidates_silence(self):
        path = self._transcript(
            self._final(''),
            self._event('task_complete'),
            {'type': 'response_item',
             'payload': {'type': 'message', 'role': 'user', 'content': []}},
        )
        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_parseable_event_with_malformed_payload_is_unknown_not_exception(self):
        path = self._transcript({'type': 'event_msg', 'payload': 'corrupt'})
        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_completion_with_malformed_final_content_is_unknown_not_silence(self):
        # A parseable final_answer envelope with an invalid content field is no
        # more evidence of silence than a malformed JSON line.
        malformed_final = {
            'type': 'response_item',
            'payload': {'phase': 'final_answer', 'content': 'corrupt'},
        }
        path = self._transcript(malformed_final, self._event('task_complete'))
        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_unfinished_turn_is_unknown(self):
        path = self._transcript({'type': 'response_item', 'payload': {'phase': 'reasoning'}})
        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_aborted_turn_is_unknown_not_silence(self):
        # An interruption is not a decision to stay quiet; keep the warning.
        path = self._transcript(self._event('turn_aborted'))
        self.assertIsNone(collab_codex.codex_final_response_disposition(path))

    def test_missing_transcript_is_unknown(self):
        self.assertIsNone(collab_codex.codex_final_response_disposition('/nonexistent/x.jsonl'))

    def test_boundary_scopes_to_the_current_turn(self):
        path = self._transcript(self._final('previous answer'), self._event('task_complete'))
        boundary = os.path.getsize(path)
        with open(path, 'a') as handle:
            handle.write(json.dumps(self._final('')) + '\n')
            handle.write(json.dumps(self._event('task_complete')) + '\n')
        # The earlier spoken turn must not classify this silent one.
        self.assertEqual(collab_codex.codex_final_response_disposition(path, boundary), 'empty')

    def test_boundary_beyond_end_is_unknown(self):
        path = self._transcript(self._final('answer'), self._event('task_complete'))
        oversized = os.path.getsize(path) + 500
        self.assertIsNone(collab_codex.codex_final_response_disposition(path, oversized))


class TestCodexReplayMatrix(unittest.TestCase):
    def test_transcript_older_than_48h_stays_owned_by_live_child(self):
        with tempfile.TemporaryDirectory() as home:
            agent_dir = os.path.join(home, 'Team', 'Rodney')
            os.makedirs(agent_dir)
            old_dir = os.path.join(home, '.codex', 'sessions', '2026', '01', '02')
            os.makedirs(old_dir)
            rollout = os.path.join(old_dir, 'rollout-old.jsonl')
            _write_rollout(rollout, agent_dir)
            ancient = time.time() - 72 * 3600
            os.utime(rollout, (ancient, ancient))

            wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
            wrapper.agent_dir = agent_dir
            wrapper.codex_pid = 4242
            wrapper._codex_transcript_path = None
            wrapper._codex_transcript_byte = 0
            wrapper._inject_transcript_byte = 0
            wrapper._child_spawn_wall = ancient - 3600

            with patch.object(collab_codex, 'resolve_codex_transcript_for_pid',
                              return_value=rollout), \
                 patch.object(collab_codex, 'resolve_codex_transcript_path',
                              return_value=None):
                self.assertEqual(wrapper._resolve_transcript(), rollout)
                wrapper._codex_transcript_byte = 99
                self.assertEqual(wrapper._resolve_transcript(), rollout)
            self.assertEqual(wrapper._codex_transcript_byte, 99)

    def test_prior_channel_response_before_first_inject_does_not_count(self):
        import io
        import urllib.parse
        stored = [{'timestamp': '2026-10-01T10:00:00.000Z', 'from': {'id': 'p-1'}}]

        def fake_urlopen(url, timeout=None):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            since = q['since'][0]
            body = {'messages': [m for m in stored if m['timestamp'] >= since]}
            return io.BytesIO(json.dumps(body).encode())

        class _Ctx(io.BytesIO):
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False

        wrapper = CollabCodexWrapper.__new__(CollabCodexWrapper)
        wrapper.channel_id = 'chan-1'
        wrapper.participant_id = 'p-1'
        wrapper.last_inject_time_iso = '2026-10-01T11:00:00.000Z'
        with patch.object(collab_codex.urllib.request, 'urlopen',
                          side_effect=lambda u, timeout=None: _Ctx(fake_urlopen(u).getvalue())):
            self.assertFalse(wrapper._agent_responded_since_last_inject())
            wrapper.last_inject_time_iso = '2026-10-01T09:00:00.000Z'
            self.assertTrue(wrapper._agent_responded_since_last_inject())
        # API unreachable -> fail open
        with patch.object(collab_codex.urllib.request, 'urlopen', side_effect=OSError('down')):
            self.assertTrue(wrapper._agent_responded_since_last_inject())
