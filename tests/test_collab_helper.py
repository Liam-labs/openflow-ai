#!/usr/bin/env python3
"""
Test suite for collab_helper.py (the resilient API wrapper for collab chat operations).

Covers:
- Session file path resolution (PID-specific, /tmp/ vs .claude/)
- Cursor persistence (_load_last_poll, _save_last_poll)
- Post with auto-rejoin on 404
- Poll message formatting
- Channel override (save_on_rejoin=False)
"""

import io
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch, mock_open
import urllib.error

# Add scripts dir to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))

import collab_helper
from collab_helper import (
    CollabSession,
    generate_stable_id,
    get_session_file_path,
    _load_last_poll,
    _save_last_poll,
    _get_cursor_file,
    _format_messages,
    _resolve_message_content,
    validate_lead_args,
)


# ─── T4a: Session file path resolution ───

class TestSessionFilePath(unittest.TestCase):
    """PID-specific session file resolution: /tmp/ first, then .claude/."""

    def test_tmp_session_preferred_over_claude_dir(self):
        """When both /tmp/ and .claude/ session files exist, /tmp/ wins."""
        pid = 12345
        tmp_path = f'/tmp/collab-session-{pid}.json'
        claude_path = os.path.join(collab_helper.PROJECT_PATH, '.claude', f'collab-session-{pid}.json')

        with patch.dict(os.environ, {'CLAUDE_PID': str(pid)}):
            with patch('os.path.exists') as mock_exists:
                mock_exists.side_effect = lambda p: p in (tmp_path, claude_path)
                result = get_session_file_path(pid=pid)

        self.assertEqual(result, tmp_path)

    def test_falls_back_to_claude_dir(self):
        """When /tmp/ doesn't have the file, uses .claude/ directory."""
        pid = 12345
        tmp_path = f'/tmp/collab-session-{pid}.json'
        claude_path = os.path.join(collab_helper.PROJECT_PATH, '.claude', f'collab-session-{pid}.json')

        with patch('os.path.exists') as mock_exists:
            mock_exists.side_effect = lambda p: p == claude_path
            result = get_session_file_path(pid=pid)

        self.assertEqual(result, claude_path)

    def test_no_fallback_to_shared_symlink(self):
        """Never falls back to shared collab-session.json (bug #7 prevention)."""
        pid = 12345

        with patch('os.path.exists', return_value=False):
            result = get_session_file_path(pid=pid)

        # Should return the expected path, not a shared symlink
        self.assertIn(str(pid), result)
        self.assertNotEqual(result, os.path.join(collab_helper.PROJECT_PATH, '.claude', 'collab-session.json'))

    def test_uses_claude_pid_env_var(self):
        """Uses CLAUDE_PID env var when no pid argument given."""
        pid = 67890
        tmp_path = f'/tmp/collab-session-{pid}.json'

        with patch.dict(os.environ, {'CLAUDE_PID': str(pid)}):
            with patch('os.path.exists') as mock_exists:
                mock_exists.side_effect = lambda p: p == tmp_path
                result = get_session_file_path()

        self.assertEqual(result, tmp_path)

    def test_no_pid_uses_ppid(self):
        """When no PID available, falls back to os.getppid()."""
        with patch.dict(os.environ, {}, clear=True):
            # Remove CLAUDE_PID if present
            os.environ.pop('CLAUDE_PID', None)
            with patch('os.path.exists', return_value=False):
                result = get_session_file_path()

        self.assertIn(str(os.getppid()), result)


# ─── T4b: Cursor persistence ───

class TestCursorPersistence(unittest.TestCase):
    """_load_last_poll and _save_last_poll use a durable cursor file."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.cursor_file = os.path.join(self.tmpdir, 'collab-cursor.json')

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_save_and_load_roundtrip(self):
        """Saved timestamp can be loaded back."""
        test_ts = '2026-04-01T12:00:00.000Z'
        with patch('collab_helper._get_cursor_file', return_value=self.cursor_file):
            _save_last_poll(test_ts)
            loaded = _load_last_poll()

        self.assertEqual(loaded, test_ts)

    def test_load_returns_now_when_no_cursor(self):
        """Fresh agent (no cursor file) gets NOW, not epoch."""
        nonexistent = os.path.join(self.tmpdir, 'nope.json')
        with patch('collab_helper._get_cursor_file', return_value=nonexistent):
            with patch.dict(os.environ, {'CLAUDE_PID': '99999'}):
                # Also ensure no legacy file exists
                with patch('os.path.exists', return_value=False):
                    # Need to handle the cursor file check separately
                    result = _load_last_poll()

        # Should be a recent timestamp, not epoch
        self.assertNotEqual(result, '1970-01-01T00:00:00.000Z')
        self.assertIn('202', result)  # Year 202x

    def test_save_is_atomic(self):
        """_save_last_poll writes via tmp file + os.replace (atomic)."""
        test_ts = '2026-04-01T15:30:00.000Z'
        with patch('collab_helper._get_cursor_file', return_value=self.cursor_file):
            _save_last_poll(test_ts)

        # Verify the file is valid JSON
        with open(self.cursor_file) as f:
            data = json.load(f)
        self.assertEqual(data['lastPollTimestamp'], test_ts)
        self.assertIn('updatedAt', data)


# ─── T4c: Post with auto-rejoin on 404 ───

class TestPostAutoRejoin(unittest.TestCase):
    """Post retries with rejoin after 404, and signals the rejoin via prefix."""

    def _make_session(self):
        return CollabSession(
            channel_id='test-ch-123',
            participant_id='test-part-456',
            display_name='TestAgent',
            agent_type='claude-terminal',
            project_path='/tmp/test-project'
        )

    @patch('collab_helper._api_call')
    def test_successful_post(self, mock_api):
        """Normal post returns (True, message_id)."""
        mock_api.return_value = {'success': True, 'messageId': 'msg-001'}
        session = self._make_session()

        success, result = session.post('Hello world')

        self.assertTrue(success)
        self.assertEqual(result, 'msg-001')

    @patch('collab_helper._api_call')
    def test_active_voice_delivery_is_automatically_correlated(self, mock_api):
        mock_api.return_value = {'success': True, 'messageId': 'voice-response-1'}
        session = self._make_session()
        session.active_voice_delivery = {
            'recordId': 'delivery-1',
            'messageId': 'voice-turn-1',
            'conversationSessionId': 'conversation-1',
            'audioTurnId': 'audio-1',
            'revision': 3,
        }

        success, result = session.post('Correlated response')

        self.assertTrue(success)
        self.assertEqual(result, 'voice-response-1')
        payload = mock_api.call_args.args[2]
        self.assertEqual(payload['replyTo'], 'voice-turn-1')
        self.assertEqual(payload['voiceResponseContext'], session.active_voice_delivery)

    @patch('collab_helper._api_call')
    def test_text_only_followup_does_not_claim_or_clear_the_voice_reply(self, mock_api):
        mock_api.return_value = {'success': True, 'messageId': 'chat-detail'}
        session = self._make_session()
        context = {'recordId': 'delivery-one', 'messageId': 'voice-turn-one'}
        session.active_voice_delivery = context
        success, result = session.post('@Owner Detailed report.', voice_reply=False)
        self.assertTrue(success)
        self.assertEqual(result, 'chat-detail')
        payload = mock_api.call_args[0][2]
        self.assertNotIn('voiceResponseContext', payload)
        self.assertNotIn('replyTo', payload)
        self.assertEqual(payload['content'], '@Owner Detailed report.')
        self.assertEqual(session.active_voice_delivery, context)

    def test_text_only_is_a_recognized_flag(self):
        self.assertEqual(validate_lead_args(['--text-only', '--stdin']), ('continue', 0, ''))

    @patch('collab_helper.get_session_file_path')
    def test_loads_active_voice_delivery_from_session_file(self, mock_session_path):
        context = {
            'recordId': 'delivery-1',
            'messageId': 'voice-turn-1',
            'conversationSessionId': 'conversation-1',
            'audioTurnId': 'audio-1',
            'revision': 1,
        }
        handle = mock_open(read_data=json.dumps({
            'channelId': 'test-ch-123',
            'participantId': 'test-part-456',
            'displayName': 'TestAgent',
            'agentType': 'codex',
            'projectPath': '/tmp/test-project',
            'activeVoiceDelivery': context,
        }))
        mock_session_path.return_value = '/tmp/collab-session-test.json'

        with patch('builtins.open', handle):
            session = CollabSession.load()

        self.assertEqual(session.active_voice_delivery, context)

    @patch('collab_helper._api_call')
    def test_post_failure(self, mock_api):
        """Failed post returns (False, error message)."""
        mock_api.return_value = {'success': False, 'error': 'Rate limited'}
        session = self._make_session()

        success, result = session.post('Hello')

        self.assertFalse(success)
        self.assertIn('Rate limited', result)

    @patch('collab_helper._api_call')
    def test_post_404_triggers_rejoin(self, mock_api):
        """On 404, rejoin fires and retry succeeds with [rejoin] prefix."""
        # First call: 404 error. Second call (rejoin): success. Third call (retry post): success.
        call_count = [0]
        def side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                # First post — 404
                raise urllib.error.HTTPError(
                    'http://test', 404, 'Not Found', {}, None
                )
            elif call_count[0] == 2:
                # Rejoin
                return {'success': True, 'participantId': 'new-part-789'}
            else:
                # Retry post
                return {'success': True, 'messageId': 'msg-002'}

        mock_api.side_effect = side_effect
        session = self._make_session()
        session.save = MagicMock()  # Don't write real files

        success, result = session.post('Test after 404')

        self.assertTrue(success)
        self.assertTrue(result.startswith('[rejoin]'))

    @patch('collab_helper._api_call')
    def test_rejoin_failure_returns_error(self, mock_api):
        """When rejoin itself fails, returns error."""
        call_count = [0]
        def side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                raise urllib.error.HTTPError(
                    'http://test', 404, 'Not Found', {}, None
                )
            else:
                return {'success': False, 'error': 'Channel deleted'}

        mock_api.side_effect = side_effect
        session = self._make_session()

        success, result = session.post('Test failed rejoin')

        self.assertFalse(success)
        self.assertIn('auto-rejoin failed', result)


# ─── T4d: Poll message formatting ───

class TestPollMessageFormatting(unittest.TestCase):
    """_format_messages correctly filters own messages and formats output."""

    def test_filters_own_messages(self):
        """Messages from self are filtered out."""
        messages = [
            {'id': '1', 'from': {'id': 'my-id', 'name': 'Me'}, 'content': 'My msg', 'timestamp': '2026-04-01T12:00:00Z'},
            {'id': '2', 'from': {'id': 'other', 'name': 'Jack'}, 'content': 'Their msg', 'timestamp': '2026-04-01T12:00:01Z'},
        ]

        import io
        captured = io.StringIO()
        with patch('sys.stdout', captured):
            _format_messages(messages, 'my-id', 'Me')

        output = captured.getvalue()
        self.assertIn('Their msg', output)
        self.assertNotIn('My msg', output)

    def test_filters_system_messages(self):
        """System messages are hidden with count note."""
        messages = [
            {'id': '1', 'from': {'id': 'system', 'name': 'System'}, 'content': 'Bot joined', 'timestamp': '2026-04-01T12:00:00Z'},
            {'id': '2', 'from': {'id': 'other', 'name': 'Jack'}, 'content': 'Hello', 'timestamp': '2026-04-01T12:00:01Z'},
        ]

        import io
        captured = io.StringIO()
        with patch('sys.stdout', captured):
            _format_messages(messages, 'my-id', 'Me')

        output = captured.getvalue()
        self.assertIn('system message', output.lower())
        self.assertNotIn('Bot joined', output)

    def test_mention_prefix(self):
        """Messages that mention the agent get >>> prefix."""
        messages = [
            {
                'id': '1',
                'from': {'id': 'other', 'name': 'Jack'},
                'content': '@Me check this',
                'timestamp': '2026-04-01T12:00:00Z',
                'mentions': ['my-id']
            },
        ]

        import io
        captured = io.StringIO()
        with patch('sys.stdout', captured):
            _format_messages(messages, 'my-id', 'Me')

        output = captured.getvalue()
        self.assertIn('>>>', output)


# ─── T4e: Channel override (save_on_rejoin=False) ───

class TestChannelOverride(unittest.TestCase):
    """Legacy local overrides fail closed instead of joining a destination."""

    @patch('collab_helper._api_call')
    def test_override_channel_404_never_rejoins(self, mock_api):
        """The historical self-message bug started with this unsafe rejoin."""
        mock_api.side_effect = urllib.error.HTTPError(
            'http://test', 404, 'Not Found', {}, None
        )
        session = CollabSession(
            channel_id='original-channel',
            participant_id='part-123',
            display_name='TestAgent',
        )
        session.save = MagicMock()

        # Override channel and post with save_on_rejoin=False
        session.channel_id = 'override-channel'
        success, result = session.post('Override test', save_on_rejoin=False)

        self.assertFalse(success)
        self.assertIn('refusing to join', result)
        self.assertEqual(mock_api.call_count, 1)
        session.save.assert_not_called()


class TestCrossChannelPost(unittest.TestCase):
    """Foreign --channel sends use the authenticated cross-channel action."""

    def _make_session(self):
        return CollabSession(
            channel_id='source-channel',
            participant_id='source-participant',
            display_name='Jack',
            agent_type='codex',
            project_path='/projects/source/Team/Jack',
        )

    @patch('collab_helper._agent_api_call')
    def test_preserves_source_identity_and_target_channel(self, mock_agent_api):
        mock_agent_api.return_value = {
            'success': True,
            'data': {'messageId': 'cross-msg-1', 'sent': True},
        }
        session = self._make_session()

        success, result = session.post_cross_channel(
            'target-channel', '@Jack completed', mentions=['Jack'])

        self.assertTrue(success)
        self.assertEqual(result, 'cross-msg-1')
        self.assertEqual(session.channel_id, 'source-channel')
        payload = mock_agent_api.call_args[0][0]
        self.assertEqual(payload['action'], 'collab.cross_channel_message')
        self.assertEqual(payload['sourceChannelId'], 'source-channel')
        self.assertEqual(payload['sourceParticipantId'], 'source-participant')
        self.assertEqual(payload['targetChannelId'], 'target-channel')
        self.assertNotIn('participantId', payload)

    @patch('collab_helper._agent_api_call')
    def test_agent_api_failure_does_not_fall_back_to_local_post(self, mock_agent_api):
        mock_agent_api.return_value = {
            'success': False,
            'error': 'Target participant not found',
        }
        session = self._make_session()
        session.post = MagicMock()

        success, result = session.post_cross_channel(
            'target-channel', '@Jack hello', mentions=['Jack'])

        self.assertFalse(success)
        self.assertIn('Target participant not found', result)
        session.post.assert_not_called()


    @patch('collab_helper._agent_api_call')
    def test_allow_offline_flag_and_offline_warning(self, mock_agent_api):
        mock_agent_api.return_value = {
            'success': True,
            'data': {'messageId': 'cross-msg-2', 'sent': True, 'offlineRecipients': ['Heimdall']},
        }
        session = self._make_session()
        with patch('sys.stderr', new_callable=io.StringIO) as err:
            success, _ = session.post_cross_channel(
                'target-channel', '@Jack @Heimdall hi', allow_offline=True)
        self.assertTrue(success)
        self.assertTrue(mock_agent_api.call_args[0][0]['allowOffline'])
        self.assertIn('Heimdall', err.getvalue())
        self.assertIn('--online target-channel', err.getvalue())

    @patch('collab_helper._agent_api_call')
    def test_default_send_does_not_request_offline_delivery(self, mock_agent_api):
        mock_agent_api.return_value = {'success': True, 'data': {'messageId': 'm', 'sent': True}}
        self._make_session().post_cross_channel('target-channel', '@Jack hi')
        self.assertNotIn('allowOffline', mock_agent_api.call_args[0][0])


class TestCrossChannelAttachments(unittest.TestCase):
    """Local files travel as base64 ``images``; the server's shortfall is surfaced."""

    def _make_session(self):
        return CollabSession(
            channel_id='source-channel', participant_id='source-participant',
            display_name='Jack', agent_type='codex',
            project_path='/projects/source/Team/Jack')

    def _png(self):
        import tempfile
        d = tempfile.mkdtemp()
        self.addCleanup(__import__('shutil').rmtree, d, True)
        path = os.path.join(d, 'shot.png')
        with open(path, 'wb') as f:
            f.write(b'\x89PNG\r\n\x1a\n' + b'0' * 16)
        return path

    @patch('collab_helper._agent_api_call')
    def test_local_file_is_sent_as_base64_images_not_filepaths(self, mock_api):
        mock_api.return_value = {'success': True, 'data': {
            'messageId': 'm1', 'sent': True,
            'attachments': {'requested': 1, 'saved': 1, 'failed': []}}}
        session = self._make_session()
        ok, _ = session.post_cross_channel('target', '@Jack look', file_paths=[self._png()])
        self.assertTrue(ok)
        payload = mock_api.call_args[0][0]
        self.assertNotIn('filePaths', payload)
        self.assertEqual(len(payload['images']), 1)
        img = payload['images'][0]
        self.assertTrue(img['data'].startswith('data:image/png;base64,'))
        self.assertEqual((img['name'], img['type']), ('shot.png', 'image/png'))
        self.assertEqual(img['size'], 24)
        self.assertIsNone(session.attachment_shortfall)
        self.assertGreater(mock_api.call_args.kwargs['timeout'], 10)

    @patch('collab_helper._agent_api_call')
    def test_partial_save_is_reported(self, mock_api):
        mock_api.return_value = {'success': True, 'data': {
            'messageId': 'm1', 'sent': True,
            'attachments': {'requested': 1, 'saved': 0,
                            'failed': [{'name': 'shot.png', 'reason': 'invalid data URL'}]}}}
        session = self._make_session()
        with patch('sys.stderr', new_callable=io.StringIO) as err:
            ok, mid = session.post_cross_channel('target', '@Jack look', file_paths=[self._png()])
        self.assertTrue(ok)
        self.assertEqual(mid, 'm1')
        self.assertIn('server saved 0 of 1', session.attachment_shortfall)
        self.assertIn('shot.png', session.attachment_shortfall)
        self.assertIn('NOT all delivered', err.getvalue())

    @patch('collab_helper._agent_api_call')
    def test_old_server_without_report_counts_as_shortfall(self, mock_api):
        mock_api.return_value = {'success': True, 'data': {'messageId': 'm1', 'sent': True}}
        session = self._make_session()
        with patch('sys.stderr', new_callable=io.StringIO):
            session.post_cross_channel('target', '@Jack look', file_paths=[self._png()])
        self.assertIn('did not confirm', session.attachment_shortfall)

    @patch('collab_helper._agent_api_call')
    def test_text_only_send_has_no_shortfall_and_default_timeout(self, mock_api):
        mock_api.return_value = {'success': True, 'data': {'messageId': 'm1', 'sent': True}}
        session = self._make_session()
        session.post_cross_channel('target', '@Jack hi')
        self.assertIsNone(session.attachment_shortfall)
        self.assertNotIn('images', mock_api.call_args[0][0])
        self.assertEqual(mock_api.call_args.kwargs['timeout'], 10)

    def test_load_attachments_skips_missing_and_oversize(self):
        path = self._png()
        with patch('sys.stderr', new_callable=io.StringIO) as err:
            images, skipped = collab_helper.load_attachments(['/no/such/file.png', path])
        self.assertEqual(len(images), 1)
        self.assertEqual(skipped, 1)
        self.assertIn('File not found', err.getvalue())
        with patch('collab_helper.MAX_ATTACHMENT_BYTES', 4), \
                patch('sys.stderr', new_callable=io.StringIO) as err:
            images, skipped = collab_helper.load_attachments([path])
        self.assertEqual((images, skipped), ([], 1))
        self.assertIn('too large', err.getvalue())


class TestAgentApiCallErrors(unittest.TestCase):
    """Transport failures retain their real cause instead of raising logger bugs."""

    @patch('collab_helper._log')
    @patch('collab_helper.urllib.request.urlopen')
    def test_url_error_is_logged_and_reraised(self, mock_urlopen, mock_log):
        failure = urllib.error.URLError('connection refused')
        mock_urlopen.side_effect = failure

        with patch.dict(os.environ, {'DEVFLOW_API_TOKEN': 'test-token'}):
            with self.assertRaises(urllib.error.URLError) as raised:
                collab_helper._agent_api_call({
                    'action': 'collab.cross_channel_message',
                })

        self.assertIs(raised.exception, failure)
        mock_log.assert_called_once_with(
            'ERROR', 'api', 'Connection failed',
            method='POST', url=collab_helper.AGENT_API_URL,
            action='collab.cross_channel_message',
            error='connection refused',
        )


class TestAgentApiRefusalBody(unittest.TestCase):
    """A structured Agent API refusal (e.g. RECIPIENTS_OFFLINE) reaches the sender."""

    @patch('collab_helper._log')
    @patch('collab_helper.urllib.request.urlopen')
    def test_json_error_body_is_returned(self, mock_urlopen, _mock_log):
        body = json.dumps({'success': False, 'code': 'RECIPIENTS_OFFLINE',
                           'error': 'Not sent: no addressed agent is online. Online now: Vala.'})
        mock_urlopen.side_effect = urllib.error.HTTPError(
            'http://x', 409, 'Conflict', {}, io.BytesIO(body.encode()))
        with patch.dict(os.environ, {'DEVFLOW_API_TOKEN': 'test-token'}):
            result = collab_helper._agent_api_call({'action': 'collab.cross_channel_message'})
        self.assertFalse(result['success'])
        self.assertIn('Online now: Vala', result['error'])

    @patch('collab_helper._log')
    @patch('collab_helper.urllib.request.urlopen')
    def test_non_json_http_error_still_raises(self, mock_urlopen, _mock_log):
        mock_urlopen.side_effect = urllib.error.HTTPError(
            'http://x', 502, 'Bad Gateway', {}, io.BytesIO(b'<html>'))
        with patch.dict(os.environ, {'DEVFLOW_API_TOKEN': 'test-token'}):
            with self.assertRaises(urllib.error.HTTPError):
                collab_helper._agent_api_call({'action': 'collab.cross_channel_message'})


class TestChannelPresence(unittest.TestCase):
    """--online prints who can actually receive a cross-channel message."""

    @patch('collab_helper._agent_api_call')
    def test_lists_online_first_and_summary(self, mock_agent_api):
        mock_agent_api.return_value = {'success': True, 'data': {
            'channel': {'id': 'c1', 'name': 'AcmeMedia Web'},
            'participants': [
                {'name': 'Heimdall', 'type': 'claude-terminal', 'status': 'offline'},
                {'name': 'Jack', 'type': 'claude-terminal', 'status': 'online'},
                {'name': 'Owner', 'type': 'user', 'status': 'online'},
            ],
            'online': ['Jack'],
        }}
        with patch('sys.stdout', new_callable=io.StringIO) as out:
            code = collab_helper.show_channel_presence('c1')
        self.assertEqual(code, 0)
        text = out.getvalue()
        self.assertLess(text.index('Jack'), text.index('Heimdall'))
        self.assertIn('Owner [human]', text)
        self.assertIn('Online agents: Jack', text)
        self.assertEqual(mock_agent_api.call_args[0][0], {'action': 'collab.presence', 'channelId': 'c1'})

    def test_online_is_a_known_lead_flag(self):
        self.assertEqual(collab_helper.validate_lead_args(['--online', 'c1'])[0], 'continue')


# ─── T4f: Stable ID generation ───

class TestStableId(unittest.TestCase):
    """generate_stable_id produces consistent SHA256-based IDs."""

    def test_deterministic(self):
        """Same inputs produce the same ID every time."""
        id1 = generate_stable_id('Builder', 'claude-terminal', '/home/user/SG-1/Team/Builder')
        id2 = generate_stable_id('Builder', 'claude-terminal', '/home/user/SG-1/Team/Builder')
        self.assertEqual(id1, id2)

    def test_different_names_different_ids(self):
        """Different agent names produce different IDs."""
        id1 = generate_stable_id('Builder', 'claude-terminal', '/path')
        id2 = generate_stable_id('Jack', 'claude-terminal', '/path')
        self.assertNotEqual(id1, id2)

    def test_uuid_format(self):
        """ID has UUID-like format (8-4-4-4-12)."""
        result = generate_stable_id('Test', 'agent', '/path')
        parts = result.split('-')
        self.assertEqual(len(parts), 5)
        self.assertEqual(len(parts[0]), 8)
        self.assertEqual(len(parts[1]), 4)
        self.assertEqual(len(parts[2]), 4)
        self.assertEqual(len(parts[3]), 4)
        self.assertEqual(len(parts[4]), 12)


# ─── T4g: Session load/save ───

class TestSessionLoadSave(unittest.TestCase):
    """CollabSession.load() and .save() round-trip correctly."""

    def test_load_returns_none_for_missing_file(self):
        """Load returns None when session file doesn't exist."""
        with patch('collab_helper.get_session_file_path', return_value='/tmp/no-such-session.json'):
            result = CollabSession.load()
        self.assertIsNone(result)

    def test_load_returns_none_for_corrupted_json(self):
        """Load returns None for invalid JSON."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            f.write('not valid json{{{')
            path = f.name
        try:
            with patch('collab_helper.get_session_file_path', return_value=path):
                result = CollabSession.load()
            self.assertIsNone(result)
        finally:
            os.unlink(path)

    def test_save_creates_valid_json(self):
        """Save writes a well-formed session file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            session_path = os.path.join(tmpdir, 'session.json')
            with patch('collab_helper.get_session_file_path', return_value=session_path):
                session = CollabSession(
                    channel_id='ch-1',
                    participant_id='p-1',
                    display_name='Test',
                )
                session.save()

            with open(session_path) as f:
                data = json.load(f)
            self.assertEqual(data['channelId'], 'ch-1')
            self.assertEqual(data['participantId'], 'p-1')
            self.assertEqual(data['displayName'], 'Test')


# ─── BrowserDev persistent routing identity ───

class TestProcessBoundSession(unittest.TestCase):
    """Persistent BrowserDev processes must use their injected channel identity.

    Regression for the July 2026 Edge routing incident: Windows tool
    subprocesses could not resolve a PID session file, so Edge found or created
    stale files from another channel and posted there manually.
    """

    ENV = {
        'DEVFLOW_CHANNEL_ID': 'seo-channel',
        'DEVFLOW_PARTICIPANT_ID': 'seo-edge-participant',
        'DEVFLOW_PARTICIPANT_NAME': 'Edge',
        'DEVFLOW_PROJECT_PATH': '/home/user/SEO/Team/Edge',
        'DEVFLOW_AGENT_TYPE': 'claude-terminal',
        'DEVFLOW_RESPONSE_ROUTING': 'server-auto-post',
    }

    def _load(self):
        with patch.dict(os.environ, self.ENV, clear=True):
            return CollabSession.load()

    def test_complete_env_identity_wins_over_stale_pid_session_file(self):
        """A foreign PID file can never override process-bound identity."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump({
                'channelId': 'sg1-channel',
                'participantId': 'sg1-edge-participant',
                'displayName': 'Edge',
                'projectPath': '/home/user/SG-1/Team/Edge',
            }, f)
            stale_path = f.name
        try:
            with patch.dict(os.environ, self.ENV, clear=True):
                with patch('collab_helper.get_session_file_path',
                           return_value=stale_path) as mock_path:
                    session = CollabSession.load()
            self.assertEqual(session.channel_id, 'seo-channel')
            self.assertEqual(session.participant_id, 'seo-edge-participant')
            self.assertEqual(session.display_name, 'Edge')
            self.assertEqual(session.project_path,
                             '/home/user/SEO/Team/Edge')
            self.assertTrue(session.process_bound)
            mock_path.assert_not_called()
        finally:
            os.unlink(stale_path)

    def test_partial_env_identity_fails_closed_before_file_lookup(self):
        """Never combine one env identifier with a stale file identifier."""
        for partial in (
            {'DEVFLOW_CHANNEL_ID': 'seo-channel'},
            {'DEVFLOW_PARTICIPANT_ID': 'seo-edge-participant'},
        ):
            with self.subTest(partial=partial):
                with patch.dict(os.environ, partial, clear=True):
                    with patch(
                        'collab_helper.get_session_file_path',
                        return_value='/tmp/no-such-process-bound-session.json',
                    ) as mock_path:
                        self.assertIsNone(CollabSession.load())
                mock_path.assert_not_called()

    @patch('collab_helper._api_call')
    def test_server_auto_post_refuses_ordinary_manual_post(self, mock_api):
        """The persistent transport owns ordinary response delivery."""
        session = self._load()
        success, detail = session.post('manual duplicate')
        self.assertFalse(success)
        self.assertIn('automatically posts', detail)
        mock_api.assert_not_called()

    @patch('collab_helper._api_call')
    def test_server_auto_post_allows_ask_owner_in_bound_channel(self, mock_api):
        """Structured Ask-Owner is the sole helper-post exception."""
        mock_api.return_value = {'success': True, 'messageId': 'question-1'}
        session = self._load()
        metadata = {
            'client': {
                'kind': 'ask-owner.question',
                'payload': {'id': 'question-1'},
            },
        }
        success, result = session.post('Question for Owner', metadata=metadata)
        self.assertTrue(success)
        self.assertEqual(result, 'question-1')
        body = mock_api.call_args[0][2]
        self.assertEqual(body['channelId'], 'seo-channel')
        self.assertEqual(body['participantId'], 'seo-edge-participant')

    @patch('collab_helper._api_call')
    def test_process_bound_session_refuses_channel_override(self, mock_api):
        """Even Ask-Owner cannot override the process's originating channel."""
        session = self._load()
        session.channel_id = 'sg1-channel'
        metadata = {'client': {'kind': 'ask-owner.question', 'payload': {}}}
        success, detail = session.post('Question for Owner', metadata=metadata)
        self.assertFalse(success)
        self.assertIn('channel override', detail)
        mock_api.assert_not_called()


# ─── Sprint 43 P2-T1: lead-flag validation regression ───

class TestValidateLeadArgs(unittest.TestCase):
    """validate_lead_args refuses unknown CLI flags before any send.

    Regression for Sprint 43 P2-T1: literal '--join <uuid> --name Sam' and
    '--help' were broadcast as channel messages because the parsing loop
    treated unknown flags as message body.
    """

    def test_no_args_continues(self):
        action, code, _ = validate_lead_args([])
        self.assertEqual(action, 'continue')
        self.assertEqual(code, 0)

    def test_plain_message_continues(self):
        action, _, _ = validate_lead_args(['hello', 'world'])
        self.assertEqual(action, 'continue')

    def test_known_channel_flag_continues(self):
        action, _, _ = validate_lead_args(['--channel', 'abc', 'msg'])
        self.assertEqual(action, 'continue')

    def test_known_file_flag_continues(self):
        action, _, _ = validate_lead_args(['--file', '/tmp/x.png', 'msg'])
        self.assertEqual(action, 'continue')

    def test_poll_continues(self):
        action, _, _ = validate_lead_args(['--poll'])
        self.assertEqual(action, 'continue')

    def test_stdin_continues(self):
        action, _, _ = validate_lead_args(['--stdin'])
        self.assertEqual(action, 'continue')

    def test_join_flag_rejected(self):
        """The original Segway G3 leak: --join uuid --name Sam."""
        action, code, detail = validate_lead_args(['--join', 'abc-uuid', '--name', 'Sam'])
        self.assertEqual(action, 'exit')
        self.assertEqual(code, 2)
        self.assertIn("--join", detail)

    def test_name_flag_rejected(self):
        action, code, _ = validate_lead_args(['--name', 'Sam'])
        self.assertEqual(action, 'exit')
        self.assertEqual(code, 2)

    def test_help_long_returns_usage(self):
        action, code, detail = validate_lead_args(['--help'])
        self.assertEqual(action, 'exit')
        self.assertEqual(code, 0)
        self.assertEqual(detail, 'usage')

    def test_help_short_returns_usage(self):
        action, code, detail = validate_lead_args(['-h'])
        self.assertEqual(action, 'exit')
        self.assertEqual(code, 0)
        self.assertEqual(detail, 'usage')

    def test_arbitrary_unknown_flag_rejected(self):
        action, code, detail = validate_lead_args(['--foobar', 'value'])
        self.assertEqual(action, 'exit')
        self.assertEqual(code, 2)
        self.assertIn("--foobar", detail)

    def test_short_unknown_flag_rejected(self):
        """Single-dash options (e.g. -x) also rejected when unknown."""
        action, code, _ = validate_lead_args(['-x', 'value'])
        self.assertEqual(action, 'exit')
        self.assertEqual(code, 2)

    def test_message_starting_with_double_dash_word_rejected(self):
        """Defensive: literal '--something' as first word still hard-fails.

        If an agent really wants to send '--option' as message text,
        they can quote it differently or prefix with explanatory text.
        """
        action, code, _ = validate_lead_args(['--option'])
        self.assertEqual(action, 'exit')
        self.assertEqual(code, 2)


class TestStdinMessageInput(unittest.TestCase):
    """Raw stdin preserves shell-sensitive Markdown response content."""

    def test_preserves_code_fences_backticks_dollars_and_subshell_text(self):
        import io
        original = (
            "Run this:\n\n```bash\nwsl npm run build\n```\n\n"
            "Use `http://localhost:5173`, $PATH, and $(not-a-command).\n"
        )
        result = _resolve_message_content([], True, io.StringIO(original))
        self.assertEqual(
            result,
            original[:-1],
        )

    def test_rejects_positional_text_mixed_with_stdin(self):
        import io
        with self.assertRaisesRegex(ValueError, 'positional'):
            _resolve_message_content(
                ['unsafe', 'message'],
                True,
                io.StringIO('safe stdin'),
            )

    def test_legacy_positional_message_remains_supported(self):
        import io
        result = _resolve_message_content(
            ['plain', 'message'],
            False,
            io.StringIO('ignored'),
        )
        self.assertEqual(result, 'plain message')


class TestValidateLeadArgsCLI(unittest.TestCase):
    """Subprocess-level proof: CLI exits non-zero with no API call.

    These are the strongest regression — they prove the binary behaviour,
    not just the helper function.
    """

    SCRIPT = os.path.join(os.path.dirname(__file__), '..', 'scripts', 'collab_helper.py')

    def _run(self, *args):
        import subprocess
        return subprocess.run(
            ['python3', self.SCRIPT, *args],
            capture_output=True, text=True, timeout=5,
            env={**os.environ, 'CLAUDE_PID': '999999'},
        )

    def test_cli_rejects_join_flag_leak(self):
        """The exact bug: '--join uuid --name Sam' must not be sent."""
        result = self._run('--join', 'abc-uuid', '--name', 'Sam')
        self.assertEqual(result.returncode, 2)
        self.assertIn("Unknown flag", result.stderr)
        self.assertIn("--join", result.stderr)
        # No API output (Sent./WARNING etc.) on stdout
        self.assertNotIn("Sent.", result.stdout)

    def test_cli_help_prints_usage(self):
        result = self._run('--help')
        self.assertEqual(result.returncode, 0)
        self.assertIn("Usage:", result.stderr)


if __name__ == '__main__':
    unittest.main()


class TestRejoinHomeGuard(unittest.TestCase):
    """Edge cross-post incident (11 Jun 2026): after a recall splices an away
    agent out of a foreign channel, a stale session file 404s there and the
    old auto-rejoin silently re-created the participant in the WRONG channel,
    leaking messages/attachments. The guard resolves roster ground truth:
    single-home agents redirect home; ambiguous multi-channel agents (Edge)
    refuse the silent rejoin."""

    HOME = 'home-channel-1111'
    FOREIGN = 'foreign-channel-2222'

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.channels_file = os.path.join(self.tmpdir, 'collab-channels.json')
        self._orig_channels_file = collab_helper.CHANNELS_DATA_FILE
        collab_helper.CHANNELS_DATA_FILE = self.channels_file

    def tearDown(self):
        collab_helper.CHANNELS_DATA_FILE = self._orig_channels_file
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_channels(self, channels):
        with open(self.channels_file, 'w') as f:
            json.dump({'channels': channels}, f)

    def _session(self, channel_id):
        return collab_helper.CollabSession(
            channel_id=channel_id, participant_id='p-old',
            display_name='GuardAgent', agent_type='claude-terminal',
            project_path='/proj/agentdir')

    def _roster_channel(self, cid, agent_overrides=None):
        agent = {'name': 'GuardAgent', 'channelId': cid,
                 'workingDirectory': '/proj/agentdir', 'status': 'running'}
        agent.update(agent_overrides or {})
        return {'id': cid, 'name': f'ch-{cid}', 'participants': [],
                'roster': {'agents': [agent]}}

    @patch('collab_helper._api_call')
    def test_redirect_to_home_when_session_channel_stale(self, mock_api):
        self._write_channels([self._roster_channel(self.HOME)])
        mock_api.return_value = {'success': True, 'participantId': 'p-new'}
        session = self._session(self.FOREIGN)
        with patch.object(session, 'save'):
            self.assertTrue(session.rejoin())
        self.assertEqual(session.channel_id, self.HOME)
        self.assertEqual(mock_api.call_args[0][2]['channelId'], self.HOME)

    @patch('collab_helper._api_call')
    def test_proceed_when_session_channel_is_home(self, mock_api):
        self._write_channels([self._roster_channel(self.HOME)])
        mock_api.return_value = {'success': True, 'participantId': 'p-new'}
        session = self._session(self.HOME)
        with patch.object(session, 'save'):
            self.assertTrue(session.rejoin())
        self.assertEqual(session.channel_id, self.HOME)

    @patch('collab_helper._api_call')
    def test_proceed_when_legitimately_away(self, mock_api):
        self._write_channels([self._roster_channel(
            self.HOME, {'status': 'away', 'awayInChannelId': self.FOREIGN})])
        mock_api.return_value = {'success': True, 'participantId': 'p-new'}
        session = self._session(self.FOREIGN)
        with patch.object(session, 'save'):
            self.assertTrue(session.rejoin())
        self.assertEqual(session.channel_id, self.FOREIGN)

    @patch('collab_helper._api_call')
    def test_abort_when_multi_channel_ambiguous(self, mock_api):
        # Edge-shaped data: same name + same workingDirectory in many channels,
        # every roster entry claiming home = itself.
        self._write_channels([
            self._roster_channel('ch-a'), self._roster_channel('ch-b'),
            self._roster_channel('ch-c')])
        session = self._session(self.FOREIGN)
        self.assertFalse(session.rejoin())
        mock_api.assert_not_called()

    @patch('collab_helper._api_call')
    def test_disambiguates_same_name_by_working_directory(self, mock_api):
        # Two distinct agents share a name but live in different directories.
        other = self._roster_channel('ch-other',
                                     {'workingDirectory': '/proj/otherdir'})
        self._write_channels([other, self._roster_channel(self.HOME)])
        mock_api.return_value = {'success': True, 'participantId': 'p-new'}
        session = self._session(self.FOREIGN)
        with patch.object(session, 'save'):
            self.assertTrue(session.rejoin())
        self.assertEqual(session.channel_id, self.HOME)

    @patch('collab_helper._api_call')
    def test_proceed_when_no_roster_entry(self, mock_api):
        self._write_channels([{'id': 'x', 'participants': [],
                               'roster': {'agents': []}}])
        mock_api.return_value = {'success': True, 'participantId': 'p-new'}
        session = self._session(self.FOREIGN)
        with patch.object(session, 'save'):
            self.assertTrue(session.rejoin())
        self.assertEqual(session.channel_id, self.FOREIGN)

    @patch('collab_helper._api_call')
    def test_proceed_when_channels_file_missing(self, mock_api):
        # No ground truth available — keep old behavior.
        mock_api.return_value = {'success': True, 'participantId': 'p-new'}
        session = self._session(self.FOREIGN)
        with patch.object(session, 'save'):
            self.assertTrue(session.rejoin())
        self.assertEqual(session.channel_id, self.FOREIGN)

    @patch('collab_helper._api_call')
    def test_override_channel_skips_guard(self, mock_api):
        # --channel override posts rejoin their channel deliberately; the
        # ambiguity abort must NOT fire for save_session=False.
        self._write_channels([
            self._roster_channel('ch-a'), self._roster_channel('ch-b')])
        mock_api.return_value = {'success': True, 'participantId': 'p-new'}
        session = self._session(self.FOREIGN)
        self.assertTrue(session.rejoin(save_session=False))
        self.assertEqual(session.channel_id, self.FOREIGN)


class TestRequiredRecipient(unittest.TestCase):
    """A message with no recipient silently becomes a channel-wide broadcast.

    Routing is computed from the message text, so an omitted @mention is not an
    error the sender ever sees. These tests pin the enforcement that makes the
    omission impossible rather than merely discouraged.
    """

    def test_no_recipient_is_refused(self):
        message, error = collab_helper.resolve_recipients("Here is the answer", [], False)
        self.assertIsNotNone(error)
        self.assertIn("--to", error)
        self.assertIn("--broadcast", error)

    def test_empty_whitespace_and_lone_at_are_genuinely_unaddressed(self):
        for message in ("", "   \n", "@", "No one is addressed here"):
            with self.subTest(message=message):
                resolved, error = collab_helper.resolve_recipients(message, [], False)
                self.assertEqual(resolved, message)
                self.assertIsNotNone(error)

    def test_email_address_is_not_an_agent_mention(self):
        message = "Send the evidence to owner@example.com"
        resolved, error = collab_helper.resolve_recipients(message, [], False)
        self.assertEqual(resolved, message)
        self.assertIsNotNone(error, "an email address must not disable broadcast protection")

    def test_email_plus_local_part_is_not_an_agent_mention(self):
        message = "Send the evidence to owner+@example.com"
        resolved, error = collab_helper.resolve_recipients(message, [], False)
        self.assertEqual(resolved, message)
        self.assertIsNotNone(error, "a plus local-part must not disable broadcast protection")

    def test_email_hyphen_local_part_is_not_an_agent_mention(self):
        message = "Send the evidence to owner-@example.com"
        resolved, error = collab_helper.resolve_recipients(message, [], False)
        self.assertEqual(resolved, message)
        self.assertIsNotNone(error, "a hyphen local-part must not disable broadcast protection")

    def test_to_prepends_mention_so_routing_finds_it(self):
        message, error = collab_helper.resolve_recipients("Here is the answer", ["Owner"], False)
        self.assertIsNone(error)
        self.assertEqual(message, "@Owner Here is the answer")

    def test_to_does_not_duplicate_an_existing_mention(self):
        message, error = collab_helper.resolve_recipients("@Owner here it is", ["Owner"], False)
        self.assertIsNone(error)
        self.assertEqual(message, "@Owner here it is")

    def test_existing_mention_matches_case_insensitively(self):
        message, error = collab_helper.resolve_recipients("@owner hi", ["Owner"], False)
        self.assertIsNone(error)
        self.assertEqual(message, "@owner hi")

    def test_multiple_recipients_are_all_prepended(self):
        message, error = collab_helper.resolve_recipients("update", ["Owner", "Builder"], False)
        self.assertIsNone(error)
        self.assertEqual(message, "@Owner @Builder update")

    def test_to_adds_only_recipients_missing_from_the_body(self):
        message, error = collab_helper.resolve_recipients(
            "@Owner update",
            ["Owner", "Builder"],
            False,
        )
        self.assertIsNone(error)
        self.assertEqual(message, "@Builder @Owner update")

    def test_broadcast_allows_a_message_with_no_mention(self):
        message, error = collab_helper.resolve_recipients("Morning all", [], True)
        self.assertIsNone(error)
        self.assertEqual(message, "Morning all")

    def test_mention_in_text_needs_no_flag(self):
        message, error = collab_helper.resolve_recipients("@Owner here it is", [], False)
        self.assertIsNone(error)

    def test_mention_later_in_text_and_with_punctuation_needs_no_flag(self):
        message = "Decision for (@Owner): ship it"
        resolved, error = collab_helper.resolve_recipients(message, [], False)
        self.assertEqual(resolved, message)
        self.assertIsNone(error)

    def test_multiple_body_mentions_need_no_flag(self):
        message = "@Owner @Builder ship it"
        resolved, error = collab_helper.resolve_recipients(message, [], False)
        self.assertEqual(resolved, message)
        self.assertIsNone(error)

    def test_to_and_broadcast_together_are_refused(self):
        _, error = collab_helper.resolve_recipients("x", ["Owner"], True)
        self.assertIsNotNone(error)
        self.assertIn("contradictory", error)

    def test_to_and_broadcast_remain_refused_even_if_body_is_addressed(self):
        message = "@Owner x"
        resolved, error = collab_helper.resolve_recipients(message, ["Owner"], True)
        self.assertEqual(resolved, message)
        self.assertIsNotNone(error)
        self.assertIn("contradictory", error)

    def test_new_flags_are_accepted_as_lead_args(self):
        for flag in ('--to', '--broadcast'):
            action, code, _ = collab_helper.validate_lead_args([flag, 'Owner', 'hello'])
            self.assertEqual(action, 'continue', f"{flag} should be a known lead flag")
