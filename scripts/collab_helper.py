#!/usr/bin/env python3
"""
Collab Helper Module - Resilient API wrapper for collab chat operations.

Features:
- Auto-rejoin on 404 errors
- Session file management
- Stable ID generation (matches API)

Usage:
    from collab_helper import CollabSession

    session = CollabSession.load() or CollabSession.join_channel(channel_id, "MyAgent")
    session.post("Hello world!")
"""

import re
import json
import os
import sys
import hashlib
import urllib.request
import urllib.error
from typing import Optional, Dict, Any, Tuple
from datetime import datetime

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)      # proc_info sits beside this file, also when it is loaded by path
from devflow_http import urlopen as devflow_urlopen

import proc_info

DEVFLOW_URL = os.environ.get("DEVFLOW_URL", "http://localhost:3000").rstrip("/")
API_BASE = f"{DEVFLOW_URL}/api/collab"
AGENT_API_URL = f"{DEVFLOW_URL}/api/agent"
PROJECT_PATH = os.getcwd()
SERVER_AUTO_POST_ROUTING = "server-auto-post"
ASK_OWNER_QUESTION_KIND = "ask-owner.question"
ASK_LIAM_QUESTION_KIND = "ask-liam.question"  # the kind before the Ask-Owner rename; the server still accepts it
ASK_QUESTION_KINDS = (ASK_OWNER_QUESTION_KIND, ASK_LIAM_QUESTION_KIND)

# Structured logging for diagnostics
LOG_FILE = "/tmp/collab-helper.log"

def _log(level: str, component: str, msg: str, **kwargs):
    """Write structured log entry to file and stderr (for errors)"""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    pid = os.environ.get('CLAUDE_PID', os.getppid())
    entry = f"[{ts}] [{level}] [{component}] (pid={pid}) {msg}"
    if kwargs:
        details = " | ".join(f"{k}={v}" for k, v in kwargs.items())
        entry += f" | {details}"
    try:
        with open(LOG_FILE, 'a') as f:
            f.write(entry + "\n")
    except Exception:
        pass
    if level == "ERROR":
        print(entry, file=sys.stderr)


# Sprint 43 P2-T1: Wrapper arg-parsing leak guard.
# Without this check, an invocation like `collab_helper.py --join <uuid> --name Sam`
# (typo where the agent meant /collab-join) had unknown flags fall through into
# filtered_args and get broadcast as the literal message body. Same for `--help`.
# Lead-position unknown flags must hard-fail before any send path runs.
KNOWN_LEAD_FLAGS = frozenset({
    '--channel', '--file', '--poll', '--help', '-h', '--hidden', '--stdin',
    '--to', '--broadcast', '--text-only', '--online', '--allow-offline'
})


def validate_lead_args(args):
    """Inspect leading CLI args for unknown flags before any message send.

    Returns (action, exit_code, detail):
      - ('continue', 0, '')   — args are safe, proceed
      - ('exit', 0, 'usage')  — caller asked for --help / -h
      - ('exit', 2, msg)      — leading arg is an unknown flag; refuse to broadcast
    """
    if not args:
        return ('continue', 0, '')
    first = args[0]
    if first in ('--help', '-h'):
        return ('exit', 0, 'usage')
    if first.startswith('-') and first not in KNOWN_LEAD_FLAGS:
        return ('exit', 2,
                f"Unknown flag '{first}'. Refusing to broadcast as message. "
                f"Did you mean /collab-join, /collab-poll, or quote the message text?")
    return ('continue', 0, '')


def resolve_recipients(message, to_names, broadcast):
    """Return (message, error) after enforcing an explicit recipient.

    Channel routing is computed from the message TEXT: the server scans for
    ``@Name`` and delivers to whoever it finds, or broadcasts to everyone when it
    finds nobody. That makes an omitted mention silently become a channel-wide
    broadcast, with no error and no feedback to the sender - the message still
    sends, it just goes to everyone.

    So a recipient is required, expressed either way:
      --to <Name>      prepends ``@<Name>`` so the routing scan finds it
      --broadcast      an explicit statement that everyone should read this
      @Name in text    already addressed; nothing to add

    Passing neither, with no ``@Name`` in the text, is refused. That is the
    accidental-broadcast case and it is the only thing this function blocks.
    """
    if to_names and broadcast:
        return message, "--to and --broadcast are contradictory. Use one."

    # A common RFC local-part character immediately before ``@`` means this is
    # an email address (for example ``owner+@example.com``), not an addressed
    # agent. Keep punctuation and parenthesized mentions valid: ``(@the owner)`` /
    # ``, @the owner``.
    existing = set(
        name.lower()
        for name in re.findall(r'(?<![\w.+-])@([A-Za-z0-9_-]+)', message or '')
    )

    if to_names:
        missing = [n for n in to_names if n.lower() not in existing]
        if missing:
            prefix = " ".join(f"@{n}" for n in missing)
            message = f"{prefix} {message}" if message else prefix
        return message, None

    if broadcast or existing:
        return message, None

    return message, (
        "No recipient. This message would be broadcast to every participant in "
        "the channel.\n"
        "  Reply to someone:   --to <Name>      e.g. --to Alice\n"
        "  Address everyone:   --broadcast\n"
        "Or start the message text with @Name. One of these is required."
    )


def _resolve_message_content(positional_args, use_stdin, stdin_stream=None):
    """Resolve message text from exactly one transport.

    ``--stdin`` is the shell-safe transport for Markdown/code-rich messages:
    a quoted heredoc can contain backticks, ``$VARS``, and ``$(commands)``
    without Bash evaluating them before this process starts.  Remove only the
    single line ending added by a conventional heredoc; preserve all other
    whitespace and content exactly.
    """
    if use_stdin:
        if positional_args:
            raise ValueError("--stdin cannot be combined with positional message text")
        stream = stdin_stream if stdin_stream is not None else sys.stdin
        message = stream.read()
        if message.endswith('\r\n'):
            return message[:-2]
        if message.endswith('\n'):
            return message[:-1]
        return message
    return " ".join(positional_args)


def generate_stable_id(name: str, agent_type: str, project_path: str) -> str:
    """Generate stable participant ID (matches API's generateStableParticipantId)"""
    identity_string = f"{name}:{agent_type}:{project_path}"
    hash_hex = hashlib.sha256(identity_string.encode()).hexdigest()
    return f"{hash_hex[:8]}-{hash_hex[8:12]}-{hash_hex[12:16]}-{hash_hex[16:20]}-{hash_hex[20:32]}"


# Roster ground truth for the rejoin guard. The live store is the DevFlow server
# (the local .AppData copy goes stale once DevFlow runs on another machine), so
# the guard asks the API. COLLAB_CHANNELS_FILE pins a file instead (tests, offline).
CHANNELS_DATA_FILE = os.environ.get('COLLAB_CHANNELS_FILE') or None


def _load_channels_data() -> dict:
    if CHANNELS_DATA_FILE:
        with open(CHANNELS_DATA_FILE) as f:
            return json.load(f)
    import urllib.request
    with devflow_urlopen(f"{API_BASE}?action=channels", timeout=5) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _resolve_rejoin_target(display_name: str, project_path: str,
                           session_channel_id: str) -> Tuple[str, str]:
    """Roster ground-truth check before an auto-rejoin (Edge cross-post
    incident, 11 Jun 2026). A 404 on post means our participant no longer
    exists in the session file's channel — e.g. a recall spliced us out of a
    foreign channel after an away visit. Blindly rejoining the session channel
    re-creates the participant there and leaks messages into the wrong channel.

    Returns (action, channel_id):
      ('proceed', C)  — rejoin the session channel: it's home, a legitimate
                        away target, or no ground truth is available
      ('redirect', H) — session channel is stale; rejoin the home channel
      ('abort', C)    — agent has roster entries in multiple channels
                        (singleton multi-channel agent, e.g. Edge): home is
                        ambiguous — refuse the silent rejoin, fail loudly
    """
    try:
        data = _load_channels_data()
    except Exception as e:
        _log("WARN", "rejoin-guard", "Channels data unreadable — guard skipped", error=str(e))
        return ('proceed', session_channel_id)

    entries = []
    for ch in data.get('channels', []):
        for agent in ((ch.get('roster') or {}).get('agents') or []):
            if agent.get('name') == display_name:
                entries.append((ch.get('id'), agent))

    if not entries:
        return ('proceed', session_channel_id)

    # Same display name can be distinct agents in different channels —
    # disambiguate by working directory before declaring ambiguity.
    if len(entries) > 1 and project_path:
        norm = project_path.rstrip('/')
        narrowed = [
            (cid, a) for cid, a in entries
            if a.get('workingDirectory') and (
                a['workingDirectory'].rstrip('/') == norm
                or norm.startswith(a['workingDirectory'].rstrip('/') + '/'))
        ]
        if len(narrowed) == 1:
            entries = narrowed

    if len(entries) > 1:
        return ('abort', session_channel_id)

    roster_channel_id, agent = entries[0]
    home = agent.get('homeChannelId') or roster_channel_id
    if session_channel_id in (home, agent.get('awayInChannelId')):
        return ('proceed', session_channel_id)
    return ('redirect', home)


def _get_ancestor_pids(pid):
    """Walk up the process tree from pid, yielding ancestor PIDs.

    Reads each parent through scripts/proc_info.py (/proc on Linux, ps on macOS). Stops at init (PID 1)
    or when the chain loops/cannot be read. The original pid is yielded first.
    """
    seen = set()
    current = pid
    while current > 1 and current not in seen:
        seen.add(current)
        yield current
        ppid = proc_info.ppid(current)
        if ppid is None:
            break
        if ppid == current or ppid <= 1:
            break
        current = ppid


def get_session_file_path(pid: int = None) -> str:
    """Get PID-specific session file path with process-tree walk-up.

    Args:
        pid: Claude's PID. If not provided, uses CLAUDE_PID env var.

    Search order (PID-specific only, no shared state):
        1. Direct match: /tmp/collab-session-{pid}.json
        2. Direct match: {PROJECT_PATH}/.claude/collab-session-{pid}.json
        3. Walk up process tree from pid, checking each ancestor for a session file
           in both /tmp/ and .claude/. This handles multi-tier stacks (e.g.
           Codex wrapper-python → codex-node → codex-rust → bash) where $PPID
           in a bash subprocess resolves to a PID that has no session file of its own.

    NOTE: We intentionally do NOT fall back to the shared symlink or "most recent"
    session file. Those fallbacks caused identity confusion when multiple agents
    share the same project directory (bug #7: symlink race condition).
    """
    if pid is None:
        # Check env var first (set by skill scripts)
        pid = os.environ.get('CLAUDE_PID')
        if pid:
            pid = int(pid)

    if pid:
        # Check /tmp/ first (CWD-independent, consistent with ready/invite files)
        tmp_session = f"/tmp/collab-session-{pid}.json"
        if os.path.exists(tmp_session):
            return tmp_session

        # Then check project .claude/ directory
        specific = os.path.join(PROJECT_PATH, ".claude", f"collab-session-{pid}.json")
        if os.path.exists(specific):
            return specific

        # Walk up process tree — handles multi-tier stacks where $PPID in a
        # bash subprocess is a descendant of the PID that owns the session file.
        for ancestor_pid in _get_ancestor_pids(pid):
            if ancestor_pid == pid:
                continue  # Already checked above
            tmp_session = f"/tmp/collab-session-{ancestor_pid}.json"
            if os.path.exists(tmp_session):
                return tmp_session
            specific = os.path.join(PROJECT_PATH, ".claude", f"collab-session-{ancestor_pid}.json")
            if os.path.exists(specific):
                return specific

    # No fallbacks - return the expected path so the caller gets a clear error
    if pid:
        return os.path.join(PROJECT_PATH, ".claude", f"collab-session-{pid}.json")
    return os.path.join(PROJECT_PATH, ".claude", f"collab-session-{os.getppid()}.json")


class CollabSession:
    """Resilient collab session with auto-rejoin on 404"""

    def __init__(self, channel_id: str, participant_id: str, display_name: str,
                 agent_type: str = "claude-terminal", project_path: str = None,
                 process_bound: bool = False, response_routing: str = None,
                 active_voice_delivery: dict = None):
        self.channel_id = channel_id
        self.participant_id = participant_id
        self.display_name = display_name
        self.agent_type = agent_type
        self.project_path = project_path or PROJECT_PATH
        self.process_bound = process_bound
        self.bound_channel_id = channel_id if process_bound else None
        self.response_routing = response_routing
        self.active_voice_delivery = active_voice_delivery
        self.stable_id = generate_stable_id(display_name, agent_type, self.project_path)

    @classmethod
    def load(cls) -> Optional['CollabSession']:
        """Load process-bound identity first, then fall back to a session file.

        Persistent BrowserDev runs on Windows and its Bash tool subprocesses do
        not share the wrapper PID that names the normal session file. DevFlow
        injects a complete channel + participant pair into that process, so the
        pair is the routing authority. A partial pair is invalid and fails
        closed instead of mixing one env value with a stale file.
        """
        env_channel_id = os.environ.get('DEVFLOW_CHANNEL_ID', '').strip()
        env_participant_id = os.environ.get('DEVFLOW_PARTICIPANT_ID', '').strip()
        if bool(env_channel_id) != bool(env_participant_id):
            _log(
                "ERROR",
                "session",
                "Incomplete process-bound identity; refusing session-file fallback",
                has_channel=bool(env_channel_id),
                has_participant=bool(env_participant_id),
            )
            return None
        if env_channel_id and env_participant_id:
            session = cls(
                channel_id=env_channel_id,
                participant_id=env_participant_id,
                display_name=(
                    os.environ.get('DEVFLOW_PARTICIPANT_NAME', '').strip()
                    or 'Agent'
                ),
                agent_type=(
                    os.environ.get('DEVFLOW_AGENT_TYPE', '').strip()
                    or 'claude-terminal'
                ),
                project_path=(
                    os.environ.get('DEVFLOW_PROJECT_PATH', '').strip()
                    or PROJECT_PATH
                ),
                process_bound=True,
                response_routing=(
                    os.environ.get('DEVFLOW_RESPONSE_ROUTING', '').strip()
                    or None
                ),
            )
            _log(
                "DEBUG",
                "session",
                "Loaded process-bound session identity",
                channel=session.channel_id,
                name=session.display_name,
                routing=session.response_routing or 'manual',
            )
            return session

        session_file = get_session_file_path()
        try:
            with open(session_file, 'r') as f:
                data = json.load(f)
            session = cls(
                channel_id=data.get('channelId'),
                participant_id=data.get('participantId'),
                display_name=data.get('displayName', 'Agent'),
                agent_type=data.get('agentType', 'claude-terminal'),
                project_path=data.get('projectPath', PROJECT_PATH),
                active_voice_delivery=data.get('activeVoiceDelivery'),
            )
            _log("DEBUG", "session", f"Loaded session", file=session_file, channel=session.channel_id, name=session.display_name)
            return session
        except FileNotFoundError:
            _log("WARN", "session", f"Session file not found", file=session_file)
            return None
        except json.JSONDecodeError as e:
            _log("ERROR", "session", f"Corrupted session file (invalid JSON)", file=session_file, error=str(e))
            return None
        except KeyError as e:
            _log("ERROR", "session", f"Missing required field in session file", file=session_file, missing_key=str(e))
            return None

    def save(self) -> None:
        """Save session to file"""
        session_file = get_session_file_path()
        os.makedirs(os.path.dirname(session_file), exist_ok=True)
        with open(session_file, 'w') as f:
            json.dump({
                'channelId': self.channel_id,
                'participantId': self.participant_id,
                'displayName': self.display_name,
                'agentType': self.agent_type,
                'projectPath': self.project_path,
                'stableId': self.stable_id,
                'activeVoiceDelivery': self.active_voice_delivery,
            }, f, indent=2)

    @classmethod
    def join_channel(cls, channel_id: str, display_name: str,
                     agent_type: str = "claude-terminal") -> 'CollabSession':
        """Join a channel and create a new session"""
        project_path = PROJECT_PATH

        join_data = {
            "action": "join",
            "channelId": channel_id,
            "participant": {
                "name": display_name,
                "type": agent_type,
                "source": "DevFlow WSL",
                "projectPath": project_path
            }
        }

        result = _api_call("", "POST", join_data)
        if not result.get('success'):
            raise Exception(f"Failed to join channel: {result.get('error')}")

        session = cls(
            channel_id=channel_id,
            participant_id=result.get('participantId'),
            display_name=display_name,
            agent_type=agent_type,
            project_path=project_path
        )
        session.save()
        return session

    def rejoin(self, save_session: bool = True) -> bool:
        """Rejoin the channel (used after 404 errors)"""
        # Guard own-session rejoins against a stale session channel. Override
        # posts (save_session=False) target their channel deliberately — skip.
        if save_session:
            action, target = _resolve_rejoin_target(
                self.display_name, self.project_path, self.channel_id)
            if action == 'abort':
                _log("ERROR", "rejoin",
                     "Refusing auto-rejoin: agent has roster entries in multiple "
                     "channels — home is ambiguous and the session channel cannot "
                     "be verified. Re-point the session file at the correct "
                     "channel, or post with --channel <id>.",
                     channel=self.channel_id, name=self.display_name)
                return False
            if action == 'redirect':
                _log("WARN", "rejoin",
                     "Session channel is stale per roster — rejoining home channel instead",
                     stale_channel=self.channel_id, home_channel=target, name=self.display_name)
                self.channel_id = target
        _log("INFO", "rejoin", f"Attempting auto-rejoin", channel=self.channel_id, name=self.display_name)
        try:
            join_data = {
                "action": "join",
                "channelId": self.channel_id,
                "participant": {
                    "name": self.display_name,
                    "type": self.agent_type,
                    "source": "DevFlow WSL",
                    "projectPath": self.project_path
                }
            }

            result = _api_call("", "POST", join_data)
            if result.get('success'):
                self.participant_id = result.get('participantId')
                if save_session:
                    self.save()
                _log("INFO", "rejoin", f"Auto-rejoin succeeded", channel=self.channel_id, participant=self.participant_id)
                return True
            _log("ERROR", "rejoin", f"Auto-rejoin failed", channel=self.channel_id, error=result.get('error'))
            return False
        except Exception as e:
            _log("ERROR", "rejoin", f"Auto-rejoin exception", channel=self.channel_id, error=str(e))
            return False

    def post(self, content: str, mentions: list = None, save_on_rejoin: bool = True,
             images: list = None, is_hidden: bool = False, metadata: dict = None,
             voice_reply: bool = True) -> Tuple[bool, str]:
        """
        Post a message with auto-rejoin on 404.
        Returns (success, message_id or error).
        When auto-rejoin fires, success result is prefixed with '[rejoin]' so callers
        can surface the original 404 rather than silently reporting 'Sent'.
        ``save_on_rejoin=False`` is retained for legacy callers, but a 404 in
        that mode fails closed; foreign-channel sends must use
        ``post_cross_channel``.
        Pass images=[{data, name, type}] to attach files (base64 data URLs).
        ``voice_reply=False`` posts follow-up detail to chat without claiming a
        second one-off spoken response to the same leased voice turn.
        """
        if self.process_bound and self.channel_id != self.bound_channel_id:
            detail = (
                "Refusing channel override for a process-bound session; "
                f"this process belongs to channel '{self.bound_channel_id}'."
            )
            _log(
                "ERROR",
                "post",
                detail,
                requested_channel=self.channel_id,
                bound_channel=self.bound_channel_id,
            )
            return False, detail

        client_kind = ((metadata or {}).get('client') or {}).get('kind')
        if (
            self.response_routing == SERVER_AUTO_POST_ROUTING
            and client_kind not in ASK_QUESTION_KINDS
        ):
            detail = (
                "This BrowserDev transport automatically posts the final "
                "response; refusing an ordinary manual post."
            )
            _log(
                "ERROR",
                "post",
                detail,
                channel=self.channel_id,
                name=self.display_name,
            )
            return False, detail

        # Normalise line endings before sending — carriage returns survive JSON
        # round-trip and render as literal backslashes in the UI when doubled.
        content = content.replace('\r\n', '\n').replace('\r', '\n')
        msg_data = {
            "action": "message",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "content": content,
            "mentions": mentions or []
        }
        if images:
            msg_data["images"] = images
        if is_hidden:
            msg_data["isHidden"] = True
        # Namespaced client metadata passthrough — only metadata.client survives
        # the server handler (see collab.ts T16). Used by ask_owner.py to carry the
        # ask-owner.question envelope. Rides through the 404-retry path unchanged.
        if metadata:
            msg_data["metadata"] = metadata
        if voice_reply and self.active_voice_delivery and client_kind not in ASK_QUESTION_KINDS:
            # The wrapper exports only the currently leased inbound voice turn.
            # The server revalidates this complete tuple and attaches all
            # reply/voice metadata; the helper never manufactures identity.
            msg_data["replyTo"] = self.active_voice_delivery.get("messageId")
            msg_data["voiceResponseContext"] = self.active_voice_delivery

        try:
            result = _api_call("", "POST", msg_data)
            if result.get('success'):
                _log("DEBUG", "post", f"Message sent", channel=self.channel_id, msg_id=result.get('messageId', ''))
                _report_context_health(self.channel_id, self.participant_id)
                return True, result.get('messageId', '')
            _log("ERROR", "post", f"Message send failed", channel=self.channel_id, error=result.get('error'))
            return False, result.get('error', 'Unknown error')
        except urllib.error.HTTPError as e:
            _log("ERROR", "post", f"HTTP error posting message", channel=self.channel_id, status=e.code, reason=str(e.reason))
            if e.code == 404:
                if self.process_bound:
                    return False, (
                        "HTTP 404: process-bound participant is no longer in "
                        f"channel '{self.bound_channel_id}'; refusing auto-rejoin."
                    )
                if not save_on_rejoin:
                    return False, (
                        "HTTP 404 for a channel override; refusing to join the "
                        "destination. Use post_cross_channel() or CLI --channel."
                    )
                # Auto-rejoin and retry — but surface the original error via '[rejoin]' prefix
                if self.rejoin(save_session=save_on_rejoin):
                    msg_data['participantId'] = self.participant_id
                    if images:
                        msg_data['images'] = images
                    try:
                        result = _api_call("", "POST", msg_data)
                        if result.get('success'):
                            _log("INFO", "post", f"Message sent after rejoin", channel=self.channel_id)
                            _report_context_health(self.channel_id, self.participant_id)
                            return True, f"[rejoin]{result.get('messageId', '')}"
                        return False, result.get('error', 'Unknown error')
                    except Exception as e2:
                        _log("ERROR", "post", f"Retry after rejoin failed", error=str(e2))
                        return False, f"Retry failed: {e2}"
                return False, f"HTTP 404: Participant not found in channel '{self.channel_id}' — auto-rejoin failed"
            return False, f"HTTP {e.code}: {e.reason}"
        except Exception as e:
            _log("ERROR", "post", f"Unexpected error posting message", channel=self.channel_id, error=str(e), type=type(e).__name__)
            return False, str(e)

    def post_cross_channel(self, target_channel_id: str, content: str,
                           mentions: list = None, file_paths: list = None,
                           is_hidden: bool = False,
                           allow_offline: bool = False,
                           images: list = None) -> Tuple[bool, str]:
        """Send to another channel without joining it or borrowing an identity.

        ``--channel`` used to mutate ``self.channel_id`` and call the local
        ``/api/collab`` message action. When two channels contained agents with
        the same display name, the server's legacy fallback could therefore
        store the message as if the destination agent had sent it to themself.
        Route foreign-channel posts through the authoritative Agent API instead.

        Attachments are sent as ``images`` (base64 data URLs read on THIS
        machine, see ``load_attachments``), never as ``filePaths``: the server
        runs on another host and cannot read this machine's files. If the
        server saved fewer attachments than were sent, ``self.attachment_shortfall``
        is set to a human-readable description (the message itself was still
        delivered) and a warning is printed.
        """
        self.attachment_shortfall = None
        target_channel_id = (target_channel_id or '').strip()
        if not target_channel_id:
            return False, "Target channel ID is required."
        if target_channel_id == self.channel_id:
            return self.post(content, mentions, is_hidden=is_hidden)

        content = content.replace('\r\n', '\n').replace('\r', '\n')
        msg_data = {
            "action": "collab.cross_channel_message",
            "sourceChannelId": self.channel_id,
            "sourceParticipantId": self.participant_id,
            "targetChannelId": target_channel_id,
            "content": content,
            "mentions": mentions or [],
        }
        if images is None and file_paths:
            images, _skipped = load_attachments(file_paths)
        if images:
            msg_data["images"] = images
        if is_hidden:
            msg_data["isHidden"] = True
        if allow_offline:
            msg_data["allowOffline"] = True

        try:
            result = _agent_api_call(msg_data, timeout=120 if images else 10)
            if not result.get('success'):
                detail = result.get('error', 'Unknown Agent API error')
                _log("ERROR", "cross-channel", "Message send failed",
                     source_channel=self.channel_id,
                     target_channel=target_channel_id, error=detail)
                return False, detail

            response_data = result.get('data') or {}
            message_id = response_data.get('messageId', '')
            self.attachment_shortfall = _attachment_shortfall(
                response_data.get('attachments'), len(images or []))
            if self.attachment_shortfall:
                print(f"WARNING: message sent, but attachments were NOT all delivered: "
                      f"{self.attachment_shortfall}", file=sys.stderr)
            offline = response_data.get('offlineRecipients') or []
            if offline:
                print(f"Warning: offline in that channel, will see it only when they return: "
                      f"{', '.join(offline)}. Check with --online {target_channel_id}.",
                      file=sys.stderr)
            _log("INFO", "cross-channel", "Message sent with preserved identity",
                 source_channel=self.channel_id,
                 target_channel=target_channel_id, msg_id=message_id)
            _report_context_health(self.channel_id, self.participant_id)
            return True, message_id
        except urllib.error.HTTPError as e:
            return False, f"Agent API HTTP {e.code}: {e.reason}"
        except Exception as e:
            _log("ERROR", "cross-channel", "Unexpected send failure",
                 source_channel=self.channel_id,
                 target_channel=target_channel_id,
                 error=str(e), type=type(e).__name__)
            return False, str(e)

    def poll(self, since: str = None) -> dict:
        """Poll for new messages. Returns full API response dict."""
        params = f"?channelId={self.channel_id}"
        if since:
            params += f"&since={since}"
        params += f"&participantId={self.participant_id}"

        try:
            return _api_call(params, "GET")
        except Exception as e:
            _log("ERROR", "poll", f"Poll failed", channel=self.channel_id, error=str(e), type=type(e).__name__)
            return {'messages': [], 'participants': [], 'timestamp': ''}

    def poll_full_channel(self) -> dict:
        """Get full channel data (for --all mode). Returns channel dict."""
        params = f"?channelId={self.channel_id}"
        try:
            result = _api_call(params, "GET")
            channels = result.get('channels', [])
            return channels[0] if channels else {}
        except Exception as e:
            _log("ERROR", "poll_full", f"Full channel poll failed", channel=self.channel_id, error=str(e))
            return {}

    def heartbeat(self) -> None:
        """Send heartbeat to update lastSeen timestamp"""
        try:
            _api_call("", "POST", {
                "action": "join",
                "channelId": self.channel_id,
                "participant": {
                    "id": self.participant_id,
                    "type": self.agent_type,
                    "name": self.display_name,
                    "source": "WSL",
                    "pid": int(os.environ.get('CLAUDE_PID', os.getppid())),
                    "projectPath": self.project_path,
                }
            })
        except Exception as e:
            _log("WARN", "heartbeat", f"Heartbeat failed (non-critical)", channel=self.channel_id, error=str(e))


def _api_call(endpoint: str, method: str = "GET", data: dict = None) -> dict:
    """Make API call to collab endpoint"""
    url = f"{API_BASE}{endpoint}"
    action = data.get('action', '') if data else ''

    if method == "GET":
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode('utf-8') if data else None,
            headers={'Content-Type': 'application/json'},
            method=method
        )

    try:
        with devflow_urlopen(req, timeout=10) as resp:
            body = resp.read().decode('utf-8')
            try:
                return json.loads(body)
            except json.JSONDecodeError as e:
                _log("ERROR", "api", f"Invalid JSON response from API", method=method, url=url, action=action, error=str(e), body_preview=body[:200])
                return {'success': False, 'error': f'Invalid JSON response: {e}'}
    except urllib.error.HTTPError as e:
        body = ''
        try:
            body = e.read().decode('utf-8')[:500]
        except Exception:
            pass
        _log("ERROR", "api", f"HTTP {e.code} from API", method=method, url=url, action=action, status=e.code, body=body)
        raise


MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAX_ATTACHMENTS = 10


def load_attachments(file_paths: list) -> Tuple[list, int]:
    """Read local files into the ``images`` array the server accepts.

    Returns ``(images, skipped)``. Each image is
    ``{data: <base64 data URL>, name, type, size}``, the shape ``/api/collab``
    and the Agent API both save. Files that are missing, over 25 MB or
    unreadable are skipped with a WARNING on stderr and counted in ``skipped``.
    """
    import base64
    import mimetypes
    images = []
    skipped = 0
    for fp in file_paths[:MAX_ATTACHMENTS]:
        try:
            abs_fp = os.path.abspath(fp)
            if not os.path.isfile(abs_fp):
                print(f"WARNING: File not found, skipping: {fp}", file=sys.stderr)
                skipped += 1
                continue
            size = os.path.getsize(abs_fp)
            if size > MAX_ATTACHMENT_BYTES:
                print(f"WARNING: File too large (>25MB), skipping: {fp}", file=sys.stderr)
                skipped += 1
                continue
            mime_type, _ = mimetypes.guess_type(abs_fp)
            if not mime_type:
                mime_type = 'application/octet-stream'
            with open(abs_fp, 'rb') as f:
                b64 = base64.b64encode(f.read()).decode('ascii')
            images.append({
                'data': f"data:{mime_type};base64,{b64}",
                'name': os.path.basename(abs_fp),
                'type': mime_type,
                'size': size,
            })
        except Exception as e:
            print(f"WARNING: Failed to read file {fp}: {e}", file=sys.stderr)
            skipped += 1
    if len(file_paths) > MAX_ATTACHMENTS:
        extra = len(file_paths) - MAX_ATTACHMENTS
        print(f"WARNING: Only the first {MAX_ATTACHMENTS} files are attached; "
              f"{extra} more skipped.", file=sys.stderr)
        skipped += extra
    return images, skipped


def _attachment_shortfall(report, sent_count: int):
    """Describe attachments the server did not save, or None if all arrived.

    ``report`` is the Agent API ``attachments`` object
    ``{requested, saved, failed: [{name, reason}]}``. A response with no report
    for a send that carried attachments (an older server that ignores
    ``images``) is also a shortfall, because it cannot confirm delivery.
    """
    if sent_count <= 0:
        return None
    if not isinstance(report, dict):
        return (f"the server did not confirm any of the {sent_count} attachment(s); "
                "it may be running an older version that ignores uploaded files")
    saved = report.get('saved', 0)
    requested = report.get('requested', sent_count)
    if saved >= sent_count and saved >= requested:
        return None
    failed = report.get('failed') or []
    detail = '; '.join(f"{f.get('name', '?')}: {f.get('reason', 'unknown')}"
                       for f in failed if isinstance(f, dict))
    msg = f"server saved {saved} of {max(requested, sent_count)}"
    return f"{msg} ({detail})" if detail else msg


def _agent_api_call(data: dict, timeout: int = 10) -> dict:
    """Call the authenticated Agent API without ever logging the bearer token."""
    method = 'POST'
    url = AGENT_API_URL
    action = data.get('action', '')
    token = (
        os.environ.get('DEVFLOW_API_TOKEN', '').strip()
        or os.environ.get('DEVFLOW_FULL_ACCESS_TOKEN', '').strip()
    )
    if not token:
        raise RuntimeError(
            "DEVFLOW_API_TOKEN is unavailable; refusing an unsafe local-channel "
            "fallback for this cross-channel message."
        )

    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}',
        },
        method=method,
    )
    try:
        with devflow_urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = ''
        try:
            body = e.read().decode('utf-8')
        except Exception:
            pass
        _log("ERROR", "agent-api", f"HTTP {e.code} from Agent API",
             action=action, status=e.code, body=body[:500])
        # The Agent API explains refusals in a JSON body (for example which
        # recipients are offline). Hand that back instead of a bare status.
        try:
            parsed = json.loads(body)
        except (ValueError, TypeError):
            parsed = None
        if isinstance(parsed, dict) and parsed.get('success') is False and parsed.get('error'):
            return parsed
        raise
    except urllib.error.URLError as e:
        _log("ERROR", "api", f"Connection failed", method=method, url=url, action=action, error=str(e.reason))
        raise
    except Exception as e:
        _log("ERROR", "api", f"Unexpected API error", method=method, url=url, action=action, error=str(e), type=type(e).__name__)
        raise


def show_channel_presence(channel_id: str) -> int:
    """Print who is online/away/offline in a channel before a cross-channel send."""
    try:
        result = _agent_api_call({"action": "collab.presence", "channelId": channel_id})
    except Exception as e:
        print(f"ERROR: presence lookup failed: {e}", file=sys.stderr)
        return 1
    if not result.get('success'):
        print(f"ERROR: {result.get('error', 'presence lookup failed')}", file=sys.stderr)
        return 1
    data = result.get('data') or {}
    print(f"Channel: {data.get('channel', {}).get('name', channel_id)} ({channel_id})")
    order = {'online': 0, 'away': 1, 'offline': 2}
    for p in sorted(data.get('participants', []), key=lambda p: (order.get(p.get('status'), 3), p.get('name', ''))):
        extra = f" (working in {p['awayInChannelName']}; messages are forwarded)" if p.get('status') == 'away' else ''
        kind = ' [human]' if p.get('type') == 'user' else ''
        print(f"  {p.get('status', '?'):<7} {p.get('name', '?')}{kind}{extra}")
    online = data.get('online') or []
    print(f"Online agents: {', '.join(online) if online else 'none'}")
    return 0


def _report_context_health(channel_id: str, participant_id: str) -> None:
    """
    Fire-and-forget context health report.
    Primary source: /tmp/claude-ctx-{CLAUDE_CODE_SESSION_ID} (written by context-health-sample.py hook).
    Fallback: CLAUDE_CONTEXT_PERCENT env var (manual override).
    Called after each successful message post — agents auto-report their context fill.
    """
    pct_str = os.environ.get('CLAUDE_CONTEXT_PERCENT', '')
    turn_count = int(os.environ.get('CLAUDE_TURN_COUNT', '0'))
    model = os.environ.get('CLAUDE_MODEL', 'unknown')

    # Primary: read from temp file written by context-health-sample.py UserPromptSubmit hook
    # CLAUDE_CODE_SESSION_ID is available in Bash tool subprocess environment
    session_id = os.environ.get('CLAUDE_CODE_SESSION_ID', '')
    if session_id:
        ctx_file = f'/tmp/claude-ctx-{session_id}'
        try:
            with open(ctx_file) as _f:
                ctx_data = json.load(_f)
            if not pct_str:
                pct_str = str(ctx_data.get('percent', ''))
            if turn_count == 0:
                turn_count = int(ctx_data.get('turn_count', 0))
            if model == 'unknown':
                model = ctx_data.get('model', 'unknown')
        except Exception:
            pass

    if not pct_str:
        return  # No context data available — silently skip
    try:
        pct = int(pct_str)
        if pct < 0 or pct > 100:
            return
        payload = {
            'participantId': participant_id,
            'contextPercent': pct,
            'turnCount': turn_count,
            'model': model,
            'channelId': channel_id,
        }
        req = urllib.request.Request(
            f'{DEVFLOW_URL}/api/agent/context-health',
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with devflow_urlopen(req, timeout=3) as resp:
            pass  # Best-effort, result ignored
    except Exception:
        pass  # Never let health reporting crash the message send


# Convenience function for quick posting
def post_message(content: str, mentions: list = None) -> Tuple[bool, str]:
    """
    Quick post with auto-rejoin. Loads existing session or fails.
    Returns (success, message_id or error)
    """
    session = CollabSession.load()
    if not session:
        return False, "No session file found. Join a channel first."
    return session.post(content, mentions)


def _get_cursor_file() -> str:
    """Get path to durable collab cursor file (PID-independent, survives reboot)"""
    claude_dir = os.path.join(PROJECT_PATH, '.claude')
    os.makedirs(claude_dir, exist_ok=True)
    return os.path.join(claude_dir, 'collab-cursor.json')


def _load_last_poll() -> str:
    """Load last poll timestamp from durable cursor.

    Falls back to NOW (not epoch) if no cursor exists — a new agent has
    nothing to catch up on.  The old PID-scoped files are checked once as
    a migration path, then the system uses the durable cursor going forward.
    """
    from datetime import timezone
    cursor_file = _get_cursor_file()
    # Primary: durable cursor
    try:
        with open(cursor_file, 'r') as f:
            data = json.load(f)
            ts = data.get('lastPollTimestamp', '')
            if ts:
                return ts
    except (FileNotFoundError, IOError, json.JSONDecodeError):
        pass
    # Migration: try legacy PID-specific file
    pid = os.environ.get('CLAUDE_PID', str(os.getppid()))
    legacy_file = os.path.join(PROJECT_PATH, '.claude', f'collab-last-poll-{pid}.txt')
    try:
        with open(legacy_file, 'r') as f:
            ts = f.read().strip()
            if ts and ts != "1970-01-01T00:00:00.000Z":
                # Migrate to cursor file and return
                _save_last_poll(ts)
                return ts
    except (FileNotFoundError, IOError):
        pass
    # Default to NOW — NEVER epoch.  A fresh agent has no history to replay.
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def _save_last_poll(timestamp: str) -> None:
    """Save last poll timestamp to durable cursor (atomic write)"""
    from datetime import timezone
    cursor_file = _get_cursor_file()
    data = {
        'lastPollTimestamp': timestamp,
        'updatedAt': datetime.now(timezone.utc).isoformat()
    }
    tmp_file = cursor_file + '.tmp'
    try:
        with open(tmp_file, 'w') as f:
            json.dump(data, f)
        os.replace(tmp_file, cursor_file)
    except IOError as e:
        _log("WARN", "poll", f"Failed to save cursor", file=cursor_file, error=str(e))


def _download_image(url: str) -> Optional[str]:
    """Download an image URL to /tmp and return local path"""
    try:
        fname = url.split('/')[-1]
        local_path = f'/tmp/collab-img-{fname}'
        if not os.path.exists(local_path):
            urllib.request.urlretrieve(url, local_path)
        return local_path
    except Exception as e:
        _log("WARN", "image", f"Failed to download image", url=url, error=str(e))
        return None


def _format_messages(messages: list, my_id: str, my_name: str, show_all: bool = False) -> None:
    """Format and print messages to stdout"""
    import base64
    import re as re_mod
    from pathlib import Path

    # Filter out own messages and system messages unless showing all
    if not show_all:
        system_count = sum(1 for m in messages if m['from'].get('id') == 'system')
        messages = [m for m in messages if m['from'].get('id') != my_id and m['from'].get('id') != 'system']
        if system_count > 0 and messages:
            print(f'({system_count} system message(s) hidden)')

    if not messages:
        print('No new messages.')
        return

    print(f'{len(messages)} message(s):')
    print('---')

    images_dir = Path('.claude/collab-images')
    images_dir.mkdir(parents=True, exist_ok=True)

    for m in messages:
        ts = m['timestamp'][:19].replace('T', ' ')
        name = m['from'].get('name', 'Unknown')
        content = m.get('content', '')
        mentions = m.get('mentions', [])

        is_for_me = my_id in mentions or my_name in str(mentions)
        prefix = '>>> ' if is_for_me else ''

        if show_all:
            display_content = content[:100] + '...' if len(content) > 100 else content
            has_image = ' [img]' if m.get('image') or m.get('metadata', {}).get('imageUrls') else ''
            print(f"[{ts}] {name}: {display_content}{has_image}")
        else:
            print(f"{prefix}[{ts}] {name}: {content}")

            # Handle inline base64 image
            image = m.get('image')
            if image:
                try:
                    data_url = image.get('data', '')
                    if data_url.startswith('data:'):
                        match = re_mod.match(r'data:([^;]+);base64,(.+)', data_url)
                        if match:
                            image_bytes = base64.b64decode(match.group(2))
                            filename = image.get('name', f'image-{m["id"][:8]}.png')
                            filepath = images_dir / filename
                            with open(filepath, 'wb') as f:
                                f.write(image_bytes)
                            print(f"    [Image: {filepath}]")
                except Exception:
                    pass

            # Handle server-side image URLs
            image_urls = m.get('metadata', {}).get('imageUrls', [])
            for url in image_urls:
                local_path = _download_image(url)
                print(f"    [Image: {local_path or url}]")


def _handle_poll(show_all: bool = False) -> None:
    """Handle --poll CLI mode"""
    session = CollabSession.load()
    if not session:
        print("ERROR: No collab session found.")
        print("Run /collab-join first to establish your session.")
        sys.exit(1)

    if show_all:
        # Full channel history
        channel = session.poll_full_channel()
        if not channel:
            print("ERROR: Channel not found")
            sys.exit(1)

        messages = channel.get('messages', [])
        participants = channel.get('participants', [])

        print(f"Channel: {channel.get('name', 'Unknown')}")
        print(f"Participants: {len(participants)}")
        for p in participants:
            tag = '(you)' if p['id'] == session.participant_id else ''
            print(f"  - {p['name']} ({p.get('source', '')}) {tag}")
        print(f"\nMessages: {len(messages)}")
        print('---')

        # Show last 20 messages in compact format
        _format_messages(messages[-20:], session.participant_id, session.display_name, show_all=True)
    else:
        # Poll for new messages since last check
        last_poll = _load_last_poll()
        result = session.poll(since=last_poll)

        if result.get('error'):
            print(f"Error: {result['error']}")
            sys.exit(1)

        # Save new timestamp
        new_ts = result.get('timestamp', '')
        if new_ts:
            _save_last_poll(new_ts)

        messages = result.get('messages', [])
        _format_messages(messages, session.participant_id, session.display_name)

    # Send heartbeat to update lastSeen
    session.heartbeat()


if __name__ == "__main__":
    import sys
    import re

    args = sys.argv[1:]

    # Sprint 43 P2-T1: refuse unknown leading flags so they cannot be broadcast.
    _action, _code, _detail = validate_lead_args(args)
    if _action == 'exit':
        if _detail == 'usage':
            print("Usage: collab_helper.py (--to <Name> | --broadcast) [--channel <id> [--allow-offline]] [--file <path>] <message>", file=sys.stderr)
            print("       collab_helper.py --online <channelId>   # who is online there, before a cross-channel send", file=sys.stderr)
            print("       collab_helper.py [--channel <id>] [--file <path>] --stdin", file=sys.stderr)
            print("       collab_helper.py --poll [--all]", file=sys.stderr)
        else:
            print(f"ERROR: {_detail}", file=sys.stderr)
        sys.exit(_code)

    # Handle --online <channelId>: presence check before a cross-channel send
    if args and args[0] == '--online':
        if len(args) < 2:
            print("Usage: collab_helper.py --online <channelId>", file=sys.stderr)
            sys.exit(2)
        sys.exit(show_channel_presence(args[1]))

    # Handle --poll mode
    if args and args[0] == '--poll':
        show_all = '--all' in args
        _handle_poll(show_all)
        sys.exit(0)

    # Handle message sending mode
    if args:
        # Parse --channel, --file, --hidden, and --stdin flags
        channel_override = None
        file_paths = []
        is_hidden = False
        use_stdin = False
        text_only = False
        to_names = []
        broadcast = False
        allow_offline = False
        filtered_args = []
        i = 0
        while i < len(args):
            if args[i] == '--channel' and i + 1 < len(args):
                channel_override = args[i + 1]
                i += 2
            elif args[i] == '--file' and i + 1 < len(args):
                file_paths.append(args[i + 1])
                i += 2
            elif args[i] == '--hidden':
                is_hidden = True
                i += 1
            elif args[i] == '--stdin':
                use_stdin = True
                i += 1
            elif args[i] == '--text-only':
                text_only = True
                i += 1
            elif args[i] == '--to' and i + 1 < len(args):
                to_names.extend(n.strip() for n in args[i + 1].split(',') if n.strip())
                i += 2
            elif args[i] == '--broadcast':
                broadcast = True
                i += 1
            elif args[i] == '--allow-offline':
                allow_offline = True
                i += 1
            else:
                filtered_args.append(args[i])
                i += 1

        try:
            message = _resolve_message_content(filtered_args, use_stdin, sys.stdin)
        except ValueError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            sys.exit(2)

        # Load files into base64 images array
        images = None
        if file_paths:
            images, _skipped = load_attachments(file_paths)
            if not images:
                images = None

        if not message and not images:
            print("ERROR: No message or files provided.")
            sys.exit(1)

        # A recipient is required. Without one the message silently becomes a
        # channel-wide broadcast (see resolve_recipients).
        message, _recipient_error = resolve_recipients(message, to_names, broadcast)
        if _recipient_error:
            print(f"ERROR: {_recipient_error}", file=sys.stderr)
            sys.exit(2)

        # Extract @mentions from message
        mentions = re.findall(r'@([A-Za-z0-9_-]+)', message) if message else []

        session = CollabSession.load()
        if not session:
            print("ERROR: No collab session found. Run /collab-join first.")
            sys.exit(1)

        # A foreign --channel is an explicit cross-channel send. Preserve the
        # source session identity and let the Agent API inject the reverse route;
        # never mutate the session into the destination channel.
        if channel_override and channel_override != session.channel_id:
            success, result = session.post_cross_channel(
                channel_override, message or '', mentions if mentions else None,
                file_paths=file_paths, is_hidden=is_hidden,
                allow_offline=allow_offline, images=images or [])
        else:
            success, result = session.post(
                message or '', mentions if mentions else None, images=images,
                is_hidden=is_hidden, voice_reply=not text_only)
        if success:
            if result.startswith('[rejoin]'):
                print(f"Warning: HTTP 404 Participant not found — auto-rejoined channel '{session.channel_id}'. Sent.", file=sys.stderr)
            else:
                print("Sent.", file=sys.stderr)
            if getattr(session, 'attachment_shortfall', None):
                print("Failed: the message was posted but its attachments did not all "
                      "arrive (details above).", file=sys.stderr)
                sys.exit(1)
        else:
            print(f"Failed: {result}", file=sys.stderr)
            sys.exit(1)
    else:
        print("Usage:")
        print("  python collab_helper.py <message>                    # Send a message")
        print("  python collab_helper.py --stdin                      # Read a shell-safe message from stdin")
        print("  python collab_helper.py --text-only --stdin          # Chat detail after a short voice reply")
        print("  python collab_helper.py --file <path> <message>      # Attach a file to message")
        print("  python collab_helper.py --channel <id> <message>     # Send to specific channel")
        print("  python collab_helper.py --online <id>                # Who is online in that channel (check first)")
        print("  python collab_helper.py --poll                        # Check for new messages")
        print("  python collab_helper.py --poll --all                  # Show full channel history")
