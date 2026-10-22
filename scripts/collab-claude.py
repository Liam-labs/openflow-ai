#!/usr/bin/env python3
"""
Collab Claude Wrapper (pexpect version)

Wraps the Claude CLI using pexpect for proper PTY handling.
All Claude sessions started with this wrapper can be dynamically
pulled into collab channels via the DevFlow UI.

Usage:
  collab-claude [claude args...]              # Start without channel (can join later)
  collab-claude --channel <id> [claude args...] # Start in a channel
"""

import os

DEVFLOW_HOME = os.environ.get("DEVFLOW_HOME") or os.path.join(os.path.expanduser("~"), "DevFlow")
# Who the people are is configuration, not code. Unset: neutral wording (our own agents set these in their environment).
OWNER_PROSE = os.environ.get("DEVFLOW_OWNER_NAME", "").strip() or "the owner"
import socket
os.environ["COLLAB_AGENT_WRAPPER"] = "1"
import sys
import json
import time
import signal
import argparse
import threading
import queue
import urllib.parse
import urllib.request
import urllib.error
import subprocess
import re
import uuid
import proc_info
from jsonl_state_reader import check_jsonl_state, resolve_transcript_path, JsonlState, tool_to_label, verify_message_ingested, final_response_disposition, TURN_EMPTY, NO_REPLY_MARKER


TRANSPORT_PROMPT = (
    "## AgentChat transport (DevFlow collab wrapper)\n"
    "Your terminal output is invisible to the channel. Reply to every "
    "[Channel message from ...] by sending the complete reply through the helper, "
    "addressed to whoever asked:\n"
    "CLAUDE_PID=${COLLAB_WRAPPER_PID:-$PPID} python3 " + DEVFLOW_HOME + "/scripts/collab_helper.py "
    "--to <Name> --stdin <<'DEVFLOW_MESSAGE'\n<complete reply>\nDEVFLOW_MESSAGE\n"
    "Send each reply once. Details: .claude/rules/channel-communication.md."
)
RESUME_MIN_RUNTIME_SECONDS = 60
_SESSION_ID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def session_id_from_transcript(path):
    """Session UUID of a non-empty <uuid>.jsonl transcript, else None."""
    if not path:
        return None
    sid = os.path.basename(path)[:-len('.jsonl')] if path.endswith('.jsonl') else ''
    try:
        if _SESSION_ID_RE.match(sid) and os.path.getsize(path) > 0:
            return sid
    except OSError:
        pass
    return None


def resume_args(claude_args, session_id):
    """claude_args with any session-selection flags replaced by --resume <id>."""
    out, skip = [], False
    for arg in claude_args:
        if skip:
            skip = False
            continue
        if arg in ('--resume', '-r', '--session-id'):
            skip = True
            continue
        if arg in ('--continue', '-c') or arg.startswith(('--resume=', '--session-id=')):
            continue
        out.append(arg)
    return out + ['--resume', session_id]

# Linux caps a single argv string at 128 KB (MAX_ARG_STRLEN). A large role prompt
# passed inline as --append-system-prompt made pexpect.spawn die with
# "OSError: [Errno 7] Argument list too long" and the agent never started
# (an agent, 15 Oct 2026, 200 KB role file). Prompts above this size are handed to
# the CLI through --append-system-prompt-file, which has no length limit.
MAX_INLINE_PROMPT_BYTES = 64 * 1024
_prompt_files = []


def _cleanup_prompt_files():
    for path in _prompt_files:
        try:
            os.unlink(path)
        except OSError:
            pass
    _prompt_files.clear()


def system_prompt_args(prompt_content):
    """CLI args that append prompt_content to the system prompt, without ever
    putting an oversized string in argv."""
    if len(prompt_content.encode('utf-8')) <= MAX_INLINE_PROMPT_BYTES:
        return ['--append-system-prompt', prompt_content]
    import atexit
    import tempfile
    fd, path = tempfile.mkstemp(prefix='collab-claude-sysprompt-', suffix='.md')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(prompt_content)
    if not _prompt_files:
        atexit.register(_cleanup_prompt_files)
    _prompt_files.append(path)
    print(f"\033[33m[Collab] System prompt is {len(prompt_content.encode('utf-8'))} bytes; "
          f"passing it via --append-system-prompt-file {path} to stay under the argv limit\033[0m",
          file=sys.stderr)
    return ['--append-system-prompt-file', path]


try:
    import pexpect
except ImportError:
    print("\033[31mError: pexpect not installed. Run: pip install pexpect\033[0m", file=sys.stderr)
    sys.exit(1)

try:
    from reply_context import format_reply_context
except ImportError:  # ships next to this script; a stray copy without it only loses the reply line
    def format_reply_context(reply_to):
        return ""

# Configuration
DEVFLOW_URL = __import__("os").environ.get("DEVFLOW_URL", "http://localhost:3000").rstrip("/")
API_BASE = f"{DEVFLOW_URL}/api/collab"
POLL_INTERVAL = 2  # seconds
IDLE_THRESHOLD = 1.5  # seconds since last keystroke before injecting
MAX_CATCHUP_AGE_SECONDS = 480  # Max age (8 min) for inbox file catch-up only (the owner's directive: older messages dropped)
MAX_VERIFY_RETRIES = 3  # Max re-delivery attempts when JSONL ingestion verify times out (confirmed-unconfirmed → retry, not drop)
MAX_CATCHUP_MESSAGES = 50  # Max messages to fetch on reconnect catch-up (replaces time-based cap for SSE/poll paths)

# Sprint 56 T2 — Plan Mode auto-accept thresholds.
# Debounce: real user has this long to pick option 2 or 3 before we press 1.
# Accept timeout: after we press 1, tool_result should arrive within this window.
PLAN_MODE_DEBOUNCE_SECONDS = 3.0
PLAN_MODE_ACCEPT_TIMEOUT_SECONDS = 10.0

# Real Claude binary path
CLAUDE_BINARY = os.path.expanduser("~/.local/bin/claude")
if not os.path.exists(CLAUDE_BINARY):
    # Installed some other way (npm -g, a package manager): use whatever is on PATH.
    CLAUDE_BINARY = __import__("shutil").which("claude") or CLAUDE_BINARY


def _stored_secret(name):
    """One value from DevFlow's private secret store (.AppData/secrets.json), or ''. Never raises."""
    try:
        path = os.environ.get("DEVFLOW_SECRETS_FILE") or os.path.join(
            os.environ.get("DEVFLOW_HOME") or os.path.join(os.path.expanduser("~"), "DevFlow"), ".AppData", "secrets.json")
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle).get(name, "")
        return value if isinstance(value, str) else ""
    except (OSError, ValueError, AttributeError):
        return ""


def _use_stored_api_key():
    """API-key mode (DEVFLOW_CLAUDE_AUTH=api-key, set by the setup wizard): hand the stored key to Claude.

    Without that setting the key stays out of the agent, as before. An agent started from a shell that already
    removed the key (the tmux launch does) gets it back here, straight from the private file, so it never
    appears on a command line.
    """
    mode = (os.environ.get("DEVFLOW_CLAUDE_AUTH") or _stored_secret("DEVFLOW_CLAUDE_AUTH")).strip().lower()
    if mode != "api-key" or os.environ.get("ANTHROPIC_API_KEY"):
        return
    key = _stored_secret("ANTHROPIC_API_KEY")
    if key:
        os.environ["ANTHROPIC_API_KEY"] = key

# Debug log
DEBUG_LOG = "/tmp/collab-claude-debug.log"

COLLAB_RESPONSE_ACTION_RE = re.compile(
    r'["\']action["\']\s*:\s*["\']collab\.(?:message|cross_channel_message)["\']'
)


def contains_collab_response_signal(buffer):
    """Detect a real local or cross-channel collab send in recent TUI output."""
    return (
        ('Bash(' in buffer and 'collab_helper' in buffer)
        or COLLAB_RESPONSE_ACTION_RE.search(buffer) is not None
    )


def debug(msg):
    """Write debug message to log file (with PID for multi-wrapper tracing)"""
    try:
        with open(DEBUG_LOG, "a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} [{os.getpid()}] {msg}\n")
    except:
        pass


def download_collab_image(url):
    """Download a collab image/file URL to /tmp/ and return the local path.
    Returns None if download fails."""
    try:
        # Fix relative URLs — prepend DevFlow base URL
        if url.startswith("/"):
            url = f"{DEVFLOW_URL}{url}"
        filename = url.split("/")[-1]
        local_path = f"/tmp/collab-img-{filename}"
        if os.path.exists(local_path):
            return local_path
        urllib.request.urlretrieve(url, local_path)
        return local_path
    except Exception as e:
        debug(f"Failed to download image {url}: {e}")
        return None


def get_invite_file(pid=None):
    return f"/tmp/collab-invite-{pid or os.getpid()}.json"


def get_ready_file(pid=None):
    return f"/tmp/collab-ready-{pid or os.getpid()}.json"


def get_project_name():
    """Extract project name from package.json or directory name"""
    cwd = os.getcwd()
    try:
        # Check package.json
        pkg_path = os.path.join(cwd, 'package.json')
        if os.path.exists(pkg_path):
            with open(pkg_path) as f:
                data = json.load(f)
                if data.get('name'):
                    return data['name']
    except:
        pass
    
    # Fallback to directory name
    return os.path.basename(cwd)



_CROSS_CHANNEL_SOURCE = re.compile(
    r"\A\[Cross-channel delivery via the DevFlow Cross-Channel API\]\s*\n"
    r"\s*\nSource channel: [^\n]*\(`([0-9a-fA-F-]{8,64})`\)"
)


def cross_channel_source_id(content):
    """Source channel ID of a cross-channel delivery envelope, else None.

    The agent answers such a message with `collab_helper.py --channel <source>`,
    so its reply is stored in the source channel's file, not its own.
    """
    if not isinstance(content, str):
        return None
    match = _CROSS_CHANNEL_SOURCE.match(content)
    return match.group(1) if match else None


# Long messages are delivered as a one-line pointer to a file instead of being
# typed. Claude Code turns fast-typed long text into a paste block, which the
# model treats as untrusted pasted content and which can be lost under load
# (Jack/SEO Engine 2026-09-28: 2 KB report arrived as its last line only).
POINTER_MIN_CHARS = 800         # more than this -> pointer
POINTER_MAX_LINES = 5           # more lines than this -> pointer
POINTER_PREVIEW_CHARS = 200
POINTER_RETENTION_SECONDS = 7 * 24 * 3600
POINTER_DIR = os.path.join('.session-scratch', 'inbox')

_CC_SOURCE_NAME = re.compile(r"^Source channel: (.+?) \(`([0-9a-fA-F-]{8,64})`\)", re.M)
_CC_SENDER = re.compile(r"^Sender: (.+?) \(`", re.M)
_CC_BODY_MARKER = "Original cross-channel message:\n"


def needs_pointer(content):
    return len(content) > POINTER_MIN_CHARS or content.count('\n') + 1 > POINTER_MAX_LINES


def pointer_routing(content):
    """(routing hint, message body) — the hint lets the agent route a
    cross-channel reply without opening the file."""
    source_id = cross_channel_source_id(content)
    if not source_id:
        return '', content
    name = _CC_SOURCE_NAME.search(content)
    sender = _CC_SENDER.search(content)
    idx = content.find(_CC_BODY_MARKER)
    body = content[idx + len(_CC_BODY_MARKER):] if idx >= 0 else content
    hint = (f" (cross-channel from {name.group(1) if name else source_id}; reply with "
            f"collab_helper.py --channel {source_id} and @{sender.group(1).strip() if sender else 'sender'})")
    return hint, body


def write_pointer_file(base_dir, msg_id, text, now=None):
    """Write the full message under <base_dir>/.session-scratch/inbox and
    return its absolute path. Prunes files past retention; never overwrites."""
    now = time.time() if now is None else now
    inbox = os.path.join(base_dir, POINTER_DIR)
    os.makedirs(inbox, exist_ok=True)
    for name in os.listdir(inbox):
        path = os.path.join(inbox, name)
        try:
            if name.startswith('msg-') and now - os.path.getmtime(path) > POINTER_RETENTION_SECONDS:
                os.remove(path)
        except OSError:
            pass
    safe_id = re.sub(r'[^A-Za-z0-9_-]', '', str(msg_id or '')) or uuid.uuid4().hex
    for n in range(1, 1000):
        path = os.path.join(inbox, f"msg-{safe_id}.md" if n == 1 else f"msg-{safe_id}-{n}.md")
        try:
            with open(path, 'x', encoding='utf-8') as f:
                f.write(text)
            return os.path.abspath(path)
        except FileExistsError:
            continue
    raise OSError(f"no free pointer file name for {safe_id}")


def build_pointer_line(header, content, marker, path):
    hint, body = pointer_routing(content)
    flat = ' '.join(body.split())
    preview = flat[:POINTER_PREVIEW_CHARS] + ('…' if len(flat) > POINTER_PREVIEW_CHARS else '')
    lines = content.count('\n') + 1
    return (f"{header}{hint}: {preview} [PREVIEW ONLY. Before acting or replying, "
            f"read the full {lines}-line message: {path}] {marker}")


class CollabClaudeWrapper:
    def __init__(self, channel_id=None, participant_name=None, claude_args=None):
        self.channel_id = channel_id
        self.channel_name = ""  # Resolved channel display name (set in join_channel)
        self.participant_name = participant_name
        self.participant_id = None
        self.claude_args = claude_args or []
        self.child = None  # pexpect child process
        self._child_spawned_at = 0.0  # JSONL state older than this belongs to a dead child
        self.last_keystroke = time.time()
        self.last_poll_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.running = True
        self.joined = False
        self.claude_pid = None  # Claude's PID (child), used for registration
        self.wrapper_pid = os.getpid()  # Wrapper's PID (parent)
        # Sprint 58 T1 — cross-session dedup persistence.
        # Reentrant lock allows helpers like _track_injected_id to be called
        # from inside an existing `with self._dedup_lock:` block without deadlock.
        self._dedup_lock = threading.RLock()
        self._dedup_max_ids = 200
        self._dedup_persist_interval = 1.0  # seconds; debounce window
        self._dedup_last_persist_mono = 0.0
        self._dedup_dirty = False
        self._dedup_file = os.path.join(os.getcwd(), '.claude', 'injected-ids.json')
        # Insertion order tracker (oldest first); used to cap at _dedup_max_ids.
        self._dedup_order: list = []
        # Load persisted IDs from prior session (silently empty set on any error).
        self.injected_message_ids = self._load_injected_ids()  # set[str]
        self.role_name = None  # Agent's assigned role (fetched from roster after join)
        # Activity status tracking
        self.current_activity = 'idle'  # idle, typing, working
        self.last_output_time = 0  # Track when Claude last produced output
        self.activity_idle_threshold = 5.0  # Min silence (seconds) before checking CPU for idle (raised from 3.0 — Opus has 3-5s inter-tool-call pauses that false-triggered idle)
        self.initial_idle_threshold = 15.0  # Extended threshold before first output after injection (API wait)
        self.output_seen_since_inject = False  # True once Claude produces any output after injection
        # NOTE: This is NOT a hard timeout. After 5s of silence, we CHECK CPU activity.
        # If CPU is active (Claude thinking), status stays 'working' indefinitely.
        # Only silence + CPU idle = truly idle. Agents can work for hours.
        self.last_heartbeat_time = 0  # When we last sent a heartbeat
        self.heartbeat_interval = 5.0  # Send heartbeat every 5s during active processing
        self.idle_heartbeat_interval = 30.0  # Send heartbeat every 30s when idle (keeps lastSeen fresh)
        self.is_processing = False  # True when Claude is working on an injected message
        self.idle_since = 0  # Timestamp when we last transitioned to idle (for cooldown)
        self.collab_response_sent = False  # True if collab_helper.py was called during processing (legacy TUI signal, kept as a hint only)
        self.last_inject_time_iso = None  # ISO 8601 UTC timestamp of the most recent inject — used for deterministic response detection against the channel JSON file
        self.last_inject_time_mono = 0  # monotonic clock at last inject — used for minimum processing time guard
        self.last_injected_sender = None  # Who sent the message we're processing
        self.last_injected_was_mentioned = False  # True if the message we're processing was a direct @mention
        self.last_injected_msg_id = None  # Message ID currently being processed
        self.last_injected_source_channel = None  # Cross-channel delivery: channel the reply goes to
        self.delivery_timeout_logged = False  # True if 60s timeout already logged for current msg
        self.last_cpu_times = {}  # Track CPU times for process tree to detect thinking
        # Deferred Enter mechanism - send text first, Enter later when idle
        self.pending_enter = False  # True if text was sent but Enter not yet
        self.pending_mark_read = False  # True if mark_read should fire after Claude finishes processing
        self.pending_mark_read_timestamp = None  # Timestamp of the message being processed
        self.pending_enter_time = 0  # When text was sent
        self._enter_lock = threading.Lock()  # Protects pending_enter read-check-act across threads
        self.enter_idle_threshold = 0.5  # Seconds of no output before sending Enter
        self._prepared_submitted = []  # Prepared hearing requests in the input buffer, stamped ingested at Enter
        self._prepared_enter = False  # A prepared hearing paste into an idle agent: Enter goes at once, not after the idle wait
        self._connection_acks = None  # Hearing connection checks the wrapper answers itself (switched on per participant or for all)
        # SSE push: real-time message delivery (replaces polling for messages)
        self.sse_connected = False  # True when SSE stream is active
        self.sse_message_queue = queue.Queue()  # Messages received via SSE
        self.sse_last_event_id = None  # For reconnection with Last-Event-ID
        self.sse_reconnect_failures = 0  # Count consecutive SSE failures
        self.sse_max_failures = 5  # Fall back to polling after this many failures
        self.sse_last_data_time = 0  # When we last received any byte from the stream (for zombie detection)
        self._sse_resp = None  # Current SSE response object — allows external close() to break blocking read
        self.sse_zombie_kicked = False  # True if last disconnect was zombie-triggered (wider catch-up on reconnect)
        # Failed-inject retry: a tmux_send failure (e.g. 10s tmux-server hang at
        # fresh-spawn) previously dropped the message until the 120s inbox backstop
        # — the owner saw this as 1-2 min dead air on fresh agents. Failed injects now
        # re-queue with backoff instead of waiting for the backstop.
        self._inject_retry_counts = {}   # msg_id -> failed inject attempts
        self._inject_retry_pending = []  # [(retry_at_monotonic, msg_dict)]
        # Home channel tracking — immutable once set on first join.
        # Survives restarts because _write_session_file() persists it.
        self.home_channel_id = None
        self.home_channel_name = None
        # Visit tracking — set when agent hops to a non-home channel
        self.visiting = False
        self.visit_start_time = 0
        self.visit_timeout = 300  # 5 minutes idle before auto-return
        # tmux-based injection (Task 2 — thread-safe replacement for pexpect.send)
        self.tmux_pane_target = self._detect_tmux_pane()  # e.g. "%3" or None
        # MCP/background PID isolation (Task 4 — exclude persistent daemon PIDs from CPU check)
        self.background_pids: set = set()
        # Threading lock for any remaining direct child_fd writes (Task 6)
        self._child_write_lock = threading.Lock()
        # Push-wake: SSE thread signals poll thread to wake immediately on new message
        self._message_event = threading.Event()
        # JSONL transcript state reader (Sprint 38 — idle override)
        self._transcript_path: str | None = None  # Cached path to JSONL transcript
        self._jsonl_check_count = 0  # Counter for sampling debug logs
        self._last_jsonl_state: str | None = None  # Previous state for change-based logging
        self._last_jsonl_detail: JsonlState | None = None  # Full state incl. last_tool_name
        # JSONL ingestion verification (Sprint 45 T2.1)
        self._verify_pending = False  # True while waiting for JSONL confirmation
        self._verify_search_text: str | None = None  # Snippet to find in enqueue entry
        self._verify_after_byte: int = 0  # JSONL size before Enter — scan only new entries
        self._verify_transcript: str | None = None  # the file _verify_after_byte was measured on
        self._verify_start_time: float = 0  # When verification started (monotonic)
        self._verify_deferred_while_busy: bool = False  # True if this verify was deferred >=1x for a busy agent (=> msg processed in a real turn; idle-timeout must NOT re-inject)
        self._verify_msg_id: str | None = None  # Message ID being verified
        self._verify_msg_ts: str | None = None  # Message timestamp for cursor advancement on verify
        self._verify_timeout: float = 30.0  # Seconds before declaring ingestion failure (raised 5→30: 5s false-timed-out legit-but-slow deliveries, causing premature give-up. 30s lets real deliveries confirm before any retry decision, minimizing duplicate re-injects.)
        self._base_verify_timeout: float = 5.0  # Base timeout for exponential backoff
        # Delivery retry tracking (Sprint 45 T3.4)
        self._retry_attempts: dict = {}  # msg_id → retry count
        self.MAX_DELIVERY_RETRIES: int = 3
        # Sprint 56 T1 — Plan Mode pending-gate tracker.
        # Key: ExitPlanMode tool_use_id. Value: monotonic first-seen timestamp.
        # Populated by _observe_jsonl_record_for_plan_mode() when an ExitPlanMode
        # tool_use record is seen; cleared when the matching tool_result arrives.
        self._pending_plan_mode: dict = {}
        # Sprint 56 T2 — Plan Mode accepted-gate tracker.
        # Key: ExitPlanMode tool_use_id. Value: monotonic accept-keystroke timestamp.
        # An id moves pending → accepted when _accept_plan_mode_gate() fires the
        # '1' keystroke. Cleared by the observer on tool_result, or failed by
        # _check_plan_mode_accept_timeout() after PLAN_MODE_ACCEPT_TIMEOUT_SECONDS.
        self._accepted_plan_mode: dict = {}
        # Sprint 56 T3 — JSONL tail state for plan-mode observer wiring.
        # Path is cached to detect transcript rotation (new claude session → new file).
        # Byte offset starts as None (= "skip historical records on first encounter").
        self._plan_mode_tail_path: str | None = None
        self._plan_mode_tail_byte: int | None = None

    # ─── Sprint 58 T1 — injected_message_ids persistence ───
    def _load_injected_ids(self):
        """Load previously-persisted message IDs from .claude/injected-ids.json.
        Returns a set. Populates self._dedup_order as a side effect so insertion
        order survives restart. Any I/O or parse error returns an empty set.
        """
        try:
            with open(self._dedup_file, 'r') as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            self._dedup_order = []
            return set()
        # Accept either {"ids": [...]} or a bare list for forward-compat.
        if isinstance(data, dict):
            ids = data.get('ids', [])
        elif isinstance(data, list):
            ids = data
        else:
            ids = []
        # Keep only string entries, cap at max_ids (drop oldest).
        ids = [i for i in ids if isinstance(i, str) and i]
        if len(ids) > self._dedup_max_ids:
            ids = ids[-self._dedup_max_ids:]
        self._dedup_order = list(ids)
        return set(ids)

    def _persist_injected_ids(self):
        """Atomically write current injected_message_ids (in insertion order, last
        _dedup_max_ids entries) to disk. Silent on I/O failure — this is a
        best-effort cache, not load-bearing state.
        """
        try:
            with self._dedup_lock:
                ids = list(self._dedup_order)
                if len(ids) > self._dedup_max_ids:
                    ids = ids[-self._dedup_max_ids:]
                    self._dedup_order = ids
            parent = os.path.dirname(self._dedup_file)
            try:
                os.makedirs(parent, exist_ok=True)
            except OSError:
                pass  # mkdir may fail on read-only fs; fall through to write attempt
            tmp = self._dedup_file + '.tmp'
            with open(tmp, 'w') as f:
                json.dump({'ids': ids}, f)
            os.replace(tmp, self._dedup_file)
            self._dedup_dirty = False
            self._dedup_last_persist_mono = time.monotonic()
        except Exception as e:
            debug(f"_persist_injected_ids failed: {e}")

    def _maybe_persist_dedup(self):
        """Debounced persist: writes only if dirty AND interval has elapsed."""
        if not self._dedup_dirty:
            return
        if time.monotonic() - self._dedup_last_persist_mono < self._dedup_persist_interval:
            return
        self._persist_injected_ids()

    def _track_injected_id(self, msg_id):
        """Mark msg_id as injected. Adds to the in-memory set, appends to the
        insertion-order list (trimming to _dedup_max_ids), and schedules a
        debounced persist. No-op on empty/None.
        """
        if not msg_id:
            return
        with self._dedup_lock:
            if msg_id in self.injected_message_ids:
                return
            self.injected_message_ids.add(msg_id)
            self._dedup_order.append(msg_id)
            while len(self._dedup_order) > self._dedup_max_ids:
                old = self._dedup_order.pop(0)
                self.injected_message_ids.discard(old)
            self._dedup_dirty = True
        self._maybe_persist_dedup()

    def _untrack_injected_id(self, msg_id):
        """Remove msg_id from the in-memory set and insertion-order list, then
        schedule a debounced persist. Used by rollback paths (child died before
        Enter, Enter failed, watchdog reset). No-op if ID not present.
        """
        if not msg_id:
            return
        with self._dedup_lock:
            if msg_id not in self.injected_message_ids:
                return
            self.injected_message_ids.discard(msg_id)
            try:
                self._dedup_order.remove(msg_id)
            except ValueError:
                pass
            self._dedup_dirty = True
        self._maybe_persist_dedup()

    def _requeue_failed_inject(self, msg):
        """Schedule a failed inject for retry with linear backoff (5s, 10s).

        Called when inject_message() returns False (tmux send failed / child
        gone / append failed). The message is NOT in injected_message_ids at
        this point, so re-queueing cannot duplicate. After 3 failed attempts
        the message is abandoned to the inbox/catch-up backstop and logged as
        a genuine delivery failure.
        """
        msg_id = msg.get("id")
        if not msg_id:
            return
        attempts = self._inject_retry_counts.get(msg_id, 0) + 1
        self._inject_retry_counts[msg_id] = attempts
        if attempts >= 3:
            debug(f"Inject retry exhausted for {msg_id[:8]} after {attempts} attempts — leaving to inbox backstop")
            self.log_delivery_failure(msg_id, "inject_retry_exhausted")
            self._inject_retry_counts.pop(msg_id, None)
            return
        delay = 5 * attempts
        self._inject_retry_pending.append((time.monotonic() + delay, msg))
        debug(f"Inject failed for {msg_id[:8]} (attempt {attempts}) — retrying in {delay}s")

    def _drain_inject_retries(self):
        """Move due retry messages back into sse_message_queue. Runs from the
        main loop slow check (every POLL_INTERVAL). The dedup check at the
        queue consumer protects against a race where the inbox backstop
        delivered the message first.
        """
        if not self._inject_retry_pending:
            return
        now_mono = time.monotonic()
        due = [m for t, m in self._inject_retry_pending if t <= now_mono]
        if not due:
            return
        self._inject_retry_pending = [(t, m) for t, m in self._inject_retry_pending if t > now_mono]
        for m in due:
            mid = m.get("id") or "?"
            self.sse_message_queue.put(m)
            debug(f"Re-queued failed inject {mid[:8]} for retry")

    def _detect_plan_mode(self, record):
        """Pure classifier. If `record` is an assistant message that emits an
        ExitPlanMode tool_use block, return the block's tool_use_id; else None.

        Side-effect-free — does NOT mutate self._pending_plan_mode, call tmux,
        sleep, or touch I/O. Safe to call on every JSONL line read.
        """
        if not isinstance(record, dict):
            return None
        if record.get('type') != 'assistant':
            return None
        message = record.get('message')
        if not isinstance(message, dict):
            return None
        content = message.get('content')
        if not isinstance(content, list):
            return None
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get('type') != 'tool_use':
                continue
            if block.get('name') != 'ExitPlanMode':
                continue
            tu_id = block.get('id')
            if isinstance(tu_id, str) and tu_id:
                return tu_id
        return None

    def _observe_jsonl_record_for_plan_mode(self, record, now):
        """State tracker for Plan Mode pending gates.

        - If `record` carries an ExitPlanMode tool_use, add the tool_use_id to
          self._pending_plan_mode keyed on `now` (first-seen wins — duplicate
          observations do not re-stamp).
        - If `record` is a user tool_result whose tool_use_id is already pending,
          clear that entry.
        - Otherwise: no-op.

        Deterministic and hermetic: never calls tmux/subprocess/sleep and only
        mutates self._pending_plan_mode. `now` is accepted as an argument (not
        read from the clock) so callers and tests control the timestamp.
        """
        # Plan-mode side: add pending entry if this is an ExitPlanMode tool_use.
        tu_id = self._detect_plan_mode(record)
        if tu_id is not None:
            # T2 guard: tail scan may re-read the same record after we've already
            # accepted it. Never push an already-accepted id back to pending, or
            # the next debounce tick would double-keystroke.
            if tu_id in self._accepted_plan_mode:
                return
            if tu_id not in self._pending_plan_mode:
                self._pending_plan_mode[tu_id] = now
            return
        # Resolution side: clear any matching tool_result id from pending or accepted.
        if not isinstance(record, dict):
            return
        if record.get('type') != 'user':
            return
        message = record.get('message')
        if not isinstance(message, dict):
            return
        content = message.get('content')
        if not isinstance(content, list):
            return
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get('type') != 'tool_result':
                continue
            resolved_id = block.get('tool_use_id')
            if not isinstance(resolved_id, str):
                continue
            if resolved_id in self._pending_plan_mode:
                del self._pending_plan_mode[resolved_id]
            if resolved_id in self._accepted_plan_mode:
                del self._accepted_plan_mode[resolved_id]

    def _log_plan_mode_event(self, event_type, tool_use_id, extra=None):
        """Structured telemetry hook for Plan Mode auto-accept lifecycle.

        Event types:
          plan_auto_accepted     — '1' keystroke fired successfully
          plan_auto_accept_failed — _tmux_send returned False, OR no tool_result
                                    arrived within PLAN_MODE_ACCEPT_TIMEOUT_SECONDS
                                    (reason recorded in extra['reason'])

        Tests monkeypatch this method to capture events without touching I/O.
        Production emits a structured debug line — delivery-monitor wiring is
        intentionally deferred until the /api/collab/delivery-status status
        whitelist is extended to cover plan_mode events.
        """
        timestamp_ms = int(time.time() * 1000)
        extra_str = f" extra={extra}" if extra else ""
        debug(
            f"plan_mode event={event_type} agent={self.participant_name} "
            f"tool_use_id={tool_use_id} ts_ms={timestamp_ms}{extra_str}"
        )

    def _accept_plan_mode_gate(self, tool_use_id, now):
        """Fire the '1' + Enter keystroke to accept a pending ExitPlanMode plan.

        Single-attempt — no retry. Returns True if _tmux_send succeeded.

        - Unknown id (not in pending): safe no-op. No tmux send, no telemetry.
        - Success: pending → accepted, emit plan_auto_accepted.
        - _tmux_send failure: remove from pending, DO NOT add to accepted
          (menu never rendered, observing for a 10s timeout is pointless),
          emit plan_auto_accept_failed with reason 'tmux_send_failed'.
        """
        if tool_use_id not in self._pending_plan_mode:
            return False
        ok = self._tmux_send('1', enter=True)
        del self._pending_plan_mode[tool_use_id]
        if ok:
            self._accepted_plan_mode[tool_use_id] = now
            self._log_plan_mode_event('plan_auto_accepted', tool_use_id)
            return True
        self._log_plan_mode_event(
            'plan_auto_accept_failed',
            tool_use_id,
            extra={'reason': 'tmux_send_failed'},
        )
        return False

    def _check_plan_mode_debounce(self, now):
        """Sweep pending entries; accept any whose age >= PLAN_MODE_DEBOUNCE_SECONDS.

        Iterates over a snapshot of keys so _accept_plan_mode_gate() can mutate
        _pending_plan_mode mid-loop without RuntimeError.
        """
        for tu_id in list(self._pending_plan_mode.keys()):
            t0 = self._pending_plan_mode.get(tu_id)
            if t0 is None:
                continue
            if (now - t0) >= PLAN_MODE_DEBOUNCE_SECONDS:
                self._accept_plan_mode_gate(tu_id, now)

    def _check_plan_mode_accept_timeout(self, now):
        """Sweep accepted entries; fail any whose age >= PLAN_MODE_ACCEPT_TIMEOUT_SECONDS.

        An accept that never saw a tool_result within the window is logged as
        plan_auto_accept_failed (reason='no_tool_result') and evicted — no retry,
        per spec. Iterates over a snapshot of keys for safe mid-loop mutation.
        """
        for tu_id in list(self._accepted_plan_mode.keys()):
            t0 = self._accepted_plan_mode.get(tu_id)
            if t0 is None:
                continue
            if (now - t0) >= PLAN_MODE_ACCEPT_TIMEOUT_SECONDS:
                del self._accepted_plan_mode[tu_id]
                self._log_plan_mode_event(
                    'plan_auto_accept_failed',
                    tu_id,
                    extra={'reason': 'no_tool_result'},
                )

    def _tail_jsonl_for_plan_mode(self):
        """Sprint 56 T3 wiring — tail new JSONL records and feed the plan-mode observer.

        Starts reading from end-of-file on first encounter so we never fire a
        keystroke on a stale ExitPlanMode from before this wrapper started.
        Resets offset on transcript path change (claude restart → new session file)
        or on file shrink (rotation/truncation).

        Best-effort and non-blocking — swallows I/O errors. Called on every fast poll.
        """
        path = self._resolve_transcript()
        if not path:
            return
        if path != self._plan_mode_tail_path:
            self._plan_mode_tail_path = path
            self._plan_mode_tail_byte = None
        try:
            file_size = os.path.getsize(path)
        except (FileNotFoundError, PermissionError, OSError):
            return
        if self._plan_mode_tail_byte is None:
            # First encounter — skip history, start at EOF.
            self._plan_mode_tail_byte = file_size
            return
        if file_size < self._plan_mode_tail_byte:
            self._plan_mode_tail_byte = 0
        if file_size == self._plan_mode_tail_byte:
            return
        now = time.monotonic()
        try:
            with open(path, 'r') as f:
                if self._plan_mode_tail_byte > 0:
                    f.seek(self._plan_mode_tail_byte - 1)
                    if f.read(1) != '\n':
                        f.seek(self._plan_mode_tail_byte)
                        f.readline()  # discard partial line
                    else:
                        f.seek(self._plan_mode_tail_byte)
                for line in f:
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        record = json.loads(stripped)
                    except (json.JSONDecodeError, ValueError):
                        continue
                    self._observe_jsonl_record_for_plan_mode(record, now)
                self._plan_mode_tail_byte = f.tell()
        except (FileNotFoundError, PermissionError, OSError) as e:
            debug(f"_tail_jsonl_for_plan_mode error: {e}")

    def _detect_tmux_pane(self):
        """Return the tmux pane target string for this process, or None if not in tmux.

        Uses $TMUX_PANE (e.g. "%3") as the most precise target — avoids ambiguity when
        a session has multiple panes. Falls back to session name from display-message.
        """
        pane_id = os.environ.get('TMUX_PANE')
        if pane_id:
            debug(f"Detected tmux pane target: {pane_id}")
            return pane_id
        if os.environ.get('TMUX'):
            try:
                result = subprocess.run(
                    ['tmux', 'display-message', '-p', '#S'],
                    capture_output=True, text=True, timeout=2
                )
                if result.returncode == 0 and result.stdout.strip():
                    name = result.stdout.strip()
                    debug(f"Detected tmux session (fallback): {name}")
                    return name
            except Exception as e:
                debug(f"tmux session detection failed: {e}")
        return None

    def _tmux_send(self, text, enter=False):
        """Send text/Enter to Claude via tmux send-keys (thread-safe).

        Routes through tmux → pane stdin → interact() select loop → child_fd.
        This avoids concurrent os.write(child_fd) races between poll/watchdog threads.
        Falls back to pexpect.send() (with lock) if not running inside tmux.

        Args:
            text: Literal text to send (empty string OK when enter=True).
            enter: If True, also send an Enter key after the text.
        Returns:
            True on success, False on failure.
        """
        if not self.tmux_pane_target:
            # Fallback path — pexpect.send() guarded by write lock
            with self._child_write_lock:
                if not (self.child and self.child.isalive()):
                    return False
                if text:
                    n = self.child.send(text)
                    expected = len(text.encode('utf-8'))
                    if n < expected:
                        debug(f"_tmux_send fallback: partial write {n}/{expected} bytes")
                if enter:
                    self.child.send('\r')
            return True

        # Sprint 51 T4: 10s timeout tolerates tmux-server contention during
        # log-spew bursts (3s was firing on real deliveries per Sam's audit).
        # Retry once on TimeoutExpired only — rc!=0 is a real classification
        # failure and stays as tmux_send_failed.
        def _run_with_retry(cmd):
            for attempt in (1, 2):
                try:
                    return subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                except subprocess.TimeoutExpired as e:
                    if attempt == 1:
                        debug(f"_tmux_send timeout on attempt 1, retrying: {e}")
                        continue
                    raise

        try:
            if text:
                # -l sends text literally — no special key interpretation by tmux
                result = _run_with_retry(
                    ['tmux', 'send-keys', '-t', self.tmux_pane_target, '-l', text]
                )
                if result.returncode != 0:
                    debug(f"_tmux_send text failed (rc={result.returncode}): {result.stderr.strip()}")
                    return False
            if enter:
                result = _run_with_retry(
                    ['tmux', 'send-keys', '-t', self.tmux_pane_target, 'Enter']
                )
                if result.returncode != 0:
                    debug(f"_tmux_send Enter failed (rc={result.returncode}): {result.stderr.strip()}")
                    return False
            return True
        except Exception as e:
            debug(f"_tmux_send error: {e}")
            return False

    def _tmux_paste(self, text):
        """Paste text as one bracketed paste, not typed keys, so a long block arrives whole. Enter stays deferred."""
        if not self.tmux_pane_target:
            with self._child_write_lock:
                if not (self.child and self.child.isalive()):
                    return False
                self.child.send('\x1b[200~' + text + '\x1b[201~')
            return True
        buffer = 'devflow-hearing-' + uuid.uuid4().hex[:12]
        try:
            loaded = subprocess.run(['tmux', 'load-buffer', '-b', buffer, '-'], input=text, text=True, capture_output=True, timeout=10)
            if loaded.returncode != 0:
                debug(f"_tmux_paste load failed (rc={loaded.returncode})")
                return False
            # -p brackets the paste for Claude's input; -r keeps line feeds as typed newlines, never Enter.
            pasted = subprocess.run(['tmux', 'paste-buffer', '-p', '-r', '-d', '-b', buffer, '-t', self.tmux_pane_target],
                                    capture_output=True, text=True, timeout=10)
            if pasted.returncode != 0:
                subprocess.run(['tmux', 'delete-buffer', '-b', buffer], capture_output=True, timeout=5)
                debug(f"_tmux_paste paste failed (rc={pasted.returncode})")
                return False
            return True
        except Exception as e:
            debug(f"_tmux_paste error: {type(e).__name__}")
            return False

    def _prepared_flag(self):
        """Whether this participant's prepared-hearing flag file exists, re-checked at most every 5 s."""
        now = time.monotonic()
        if now - getattr(self, '_prepared_flag_checked', -10.0) >= 5:
            self._prepared_flag_checked = now
            try:
                import hearing_prepared_inject
                self._prepared_flag_on = hearing_prepared_inject.enabled(self.participant_id)
            except Exception:
                self._prepared_flag_on = False
        return self._prepared_flag_on

    def _prepared_hearing(self, sender, content):
        """The prepared instruction and data block to deliver in place of a request notice, or None for today's notice.

        Flag OFF by default: without the participant's private flag file nothing runs. Any refusal, timeout or
        error also returns None (contract: Meeting-Note-Taker docs/contracts/prepared-context.md).
        """
        try:
            import hearing_prepared_inject as prepared
            request = prepared.notice_request(sender, content)
            if not request or not prepared.enabled(self.participant_id):
                return None
            started = time.time()
            out = prepared.context(request, self.channel_id, self.participant_id, self.participant_name)
            parts = prepared.split(out['text']) if out else None
            prepared.record(request, 'context', mode='prepared_context' if parts else 'notice', call_ms=int((time.time() - started) * 1000))
            return {'request': request, 'instruction': parts[0], 'data': parts[1]} if parts else None
        except Exception as e:
            debug(f"Prepared hearing context unavailable ({type(e).__name__}); using the notice")
            return None

    @staticmethod
    def _prepared_prompt(sender, ch, marker, prepared):
        """The typed part: today's header with the preparation's instruction; the data block is pasted after it."""
        return f"[Channel message from {sender} in {ch}]: {prepared['instruction']} {marker}"

    def _send_injection(self, text, prepared=None, prompt_enter=False):
        """Type today's injection text, or the prepared instruction followed by its pasted data block.

        A failed paste types today's notice after the instruction; the model then reads the packet the preparation saved.
        prompt_enter: the input was empty, so a prepared paste into an idle agent is submitted at once. The usual
        output-idle wait before Enter only waited for Claude to redraw this input (about 1 s in the 17 October proof).
        """
        if prepared:
            import hearing_prepared_inject
            if not self._tmux_send(prepared['prompt']):
                hearing_prepared_inject.record(prepared['request'], 'type_failed')
                return self._tmux_send(text)
            if self._tmux_paste(prepared['data']):
                self._prepared_submitted.append(prepared['request'])
                self._prepared_enter = prompt_enter and not self.is_processing
                hearing_prepared_inject.record(prepared['request'], 'pasted', chars=len(prepared['data']))
                return True
            hearing_prepared_inject.record(prepared['request'], 'paste_failed')
            debug("Prepared hearing paste failed; typing the notice after the instruction")
            return self._tmux_send("\n" + text.lstrip("\n"))
        return self._tmux_send(text)

    def _stamp_prepared(self):
        """After Enter submits the input, stamp agent-side ingestion of each prepared hearing context in it."""
        submitted, self._prepared_submitted = self._prepared_submitted, []
        if not submitted:
            return
        import hearing_prepared_inject
        for request in submitted:
            hearing_prepared_inject.record(request, 'submitted')
            hearing_prepared_inject.stamp_ingested(request, self.channel_id, self.participant_id, self.participant_name)

    def _connection_check(self, sender, content):
        """True when the message is this participant's hearing connection check and the wrapper has taken it.

        Off unless hearing_connection_ack's switch is on; then the notice never reaches Claude. The wrapper acknowledges
        the check while Claude is idle at its prompt, or withholds it after 30 s busy (Jack, 17 October 2026). Any error
        delivers the notice as today.
        """
        try:
            import hearing_connection_ack as connection
            check = connection.connection_check(sender, content, self.participant_id)
            if check is None or not connection.enabled(self.participant_id):
                return False
            if self._connection_acks is None:
                self._connection_acks = connection.ConnectionAcks()
            self._connection_acks.take(check, self.channel_id, self.participant_id, self.participant_name)
        except Exception as e:
            debug(f"Hearing connection check not taken ({type(e).__name__}); delivering the notice")
            return False
        debug("Hearing connection check taken by the wrapper; not injected")
        self._service_connection_acks()
        return True

    def _service_connection_acks(self):
        """Acknowledge waiting hearing connection checks while Claude is idle at its prompt, by the same test as idle
        delivery: alive, not processing, nothing typed and pending, and no tool call open in its transcript."""
        acks = self._connection_acks
        if not acks or not acks.pending:
            return
        try:
            idle = bool(self.child and self.child.isalive() and not self.is_processing and not self.pending_enter
                        and self._check_jsonl_state() in ('end_turn', 'max_tokens', None))
            acks.service(idle)
        except Exception as e:
            debug(f"Hearing connection acknowledgement check failed ({type(e).__name__})")

    def _capture_tmux_pane(self, lines=80):
        """Capture recent pane output for delivery verification.

        Returns the rendered pane content as a string, or empty string on failure.
        """
        if not self.tmux_pane_target:
            return ""
        try:
            result = subprocess.run(
                ['tmux', 'capture-pane', '-p', '-t', self.tmux_pane_target, '-S', f'-{lines}'],
                capture_output=True, text=True, timeout=3
            )
            if result.returncode == 0:
                return result.stdout
        except Exception as e:
            debug(f"_capture_tmux_pane error: {e}")
        return ""

    # Startup dialogs a DevFlow-provisioned workspace must get past unattended.
    # Each entry: (text that identifies the dialog, option that must be highlighted
    # before Enter). LedgerOS an agent sat at the trust dialog from 04:53 to 14:10
    # on 2026-09-28, shown as "running" but never started.
    # The MCP list appears when the folder was never marked trusted, so Claude
    # ignores the provisioned enableAllProjectMcpServers and asks instead. Its
    # servers are all ticked by default; Enter on a server would untick it, so
    # only "Enable selected" may receive Enter (LaptopProbe, 2026-10-02).
    STARTUP_DIALOGS = (
        ('Yes, I trust this folder', 'Yes, I trust this folder'),
        ('Yes, allow external imports', 'Yes, allow external imports'),
        ('new MCP servers found in this project', 'Enable selected'),
    )

    @staticmethod
    def _option_highlighted(pane, option):
        return any('❯' in line and option in line for line in pane.splitlines())

    def _accept_startup_dialogs(self, timeout=90.0):
        """Accept the folder-trust and CLAUDE.md external-imports dialogs for this
        agent's own workspace. Moves the selection to Yes and presses Enter only
        once Yes is highlighted; stops when the prompt is ready or on timeout."""
        if not self.tmux_pane_target:
            return
        workspace = os.path.realpath(os.getcwd())
        deadline = time.time() + timeout
        while time.time() < deadline and self.running:
            pane = self._capture_tmux_pane(lines=60)
            if 'bypass permissions' in pane or '? for shortcuts' in pane:
                return
            for marker, highlighted in self.STARTUP_DIALOGS:
                if marker not in pane:
                    continue
                if marker.startswith('Yes, I trust') and workspace not in ''.join(l.strip() for l in pane.splitlines()):
                    debug(f"Startup: trust dialog is not for {workspace} — leaving it for a human")
                    return
                if not self._option_highlighted(pane, highlighted):
                    subprocess.run(['tmux', 'send-keys', '-t', self.tmux_pane_target, 'Down'],
                                   capture_output=True, timeout=5)
                    time.sleep(0.5)
                    pane = self._capture_tmux_pane(lines=60)
                if self._option_highlighted(pane, highlighted):
                    subprocess.run(['tmux', 'send-keys', '-t', self.tmux_pane_target, 'Enter'],
                                   capture_output=True, timeout=5)
                    debug(f"Startup: accepted dialog '{marker}' for {workspace}")
                    time.sleep(2)
                break
            else:
                time.sleep(1)

    def _capture_background_pids(self):
        """Snapshot Claude's child PIDs shortly after spawn to identify background daemons.

        MCP servers and other persistent helpers are spawned at startup and run
        indefinitely. Their background CPU (event loops, heartbeats) would otherwise
        keep is_process_tree_active() returning True even when Claude is idle.
        Called once via a daemon thread ~3s after Claude spawns.
        """
        if not self.claude_pid:
            return
        try:
            result = subprocess.run(
                ['pgrep', '-P', str(self.claude_pid)],
                capture_output=True, text=True, timeout=1
            )
            if result.stdout.strip():
                pids = {int(p) for p in result.stdout.strip().split('\n') if p.strip()}
                self.background_pids = pids
                debug(f"Baseline background PIDs (MCP/daemons): {pids}")
        except Exception as e:
            debug(f"_capture_background_pids error: {e}")

    def api_call(self, endpoint, method="GET", data=None):
        url = f"{API_BASE}{endpoint}"
        try:
            if method == "GET":
                req = urllib.request.Request(url)
            else:
                req = urllib.request.Request(
                    url,
                    data=json.dumps(data).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    method=method
                )
            with urllib.request.urlopen(req, timeout=5) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except Exception as e:
            debug(f"API error: {e}")
            return {"error": str(e)}

    def _resolve_transcript(self) -> str | None:
        """Resolve the JSONL transcript path, re-resolving on rotation.

        Claude Code rotates the transcript to a new <uuid>.jsonl on
        compaction/resume, and .session-scratch/transcript-path is updated to
        match (resolve_transcript_path reads it as authoritative). The previous
        version cached the spawn-time path indefinitely, so after the first
        rotation the wrapper kept reading a frozen, DEAD transcript — every
        ingestion-verify searched a file that stopped growing and timed out
        (100% verify failure + retry storm, proven 2026-06-03: an agent stuck on a
        1312902-byte file last written at spawn while the live transcript grew
        elsewhere). Re-resolve every call (a small scratch-file read, cheap at
        the ~2s poll cadence); keep the last-known path as fallback if a fresh
        resolve transiently returns None."""
        path = resolve_transcript_path(os.getcwd())
        if path and path != self._transcript_path:
            debug(f"JSONL transcript resolved: {path}")
            self._transcript_path = path
        return path or self._transcript_path

    def _verify_offset_for(self, transcript: str | None) -> int:
        """Byte boundary for the delivery being verified, valid for `transcript`.

        The boundary is a size measured on one specific file. Straight after a
        respawn the resolver still names the previous session's transcript (the
        new one has not been written yet), so the size is captured there and
        then applied to the new file, which is usually smaller. Every scan then
        reads nothing: ingestion is logged as a failure and a deliberate
        NO_REPLY is treated as a lost reply (an agent, 4 Oct 2026). A different
        file than the one measured began after the boundary, so scan it whole."""
        if transcript and transcript != self._verify_transcript:
            return 0
        return self._verify_after_byte

    def _check_jsonl_state(self) -> str | None:
        """Check the JSONL transcript for the agent's actual processing state.
        Returns stop_reason string ('tool_use', 'end_turn', 'max_tokens') or None.
        Also stores full JsonlState (with last_tool_name) on self._last_jsonl_detail."""
        path = self._resolve_transcript()
        if not path:
            return None
        try:
            if os.path.getmtime(path) < self._child_spawned_at:
                # Nothing written since this child spawned: the tail belongs to
                # a dead predecessor (e.g. a tool_use cut off by earlyoom) and
                # would pin is_processing=True, blocking all delivery.
                self._last_jsonl_detail = None
                return None
        except OSError:
            pass
        detail = check_jsonl_state(path)
        if detail is None:
            # Only clear cache if the file itself is genuinely gone (agent
            # restarted / transcript rotated — new file will have different
            # UUID). If the file EXISTS but is empty or has no assistant
            # entries yet (early bootstrap), the path is valid and re-resolving
            # it every 200ms just spins the log (841MB debug log, 2026-06-06).
            if not os.path.exists(path):
                self._transcript_path = None
            self._last_jsonl_detail = None
            return None
        self._last_jsonl_detail = detail
        result = detail.stop_reason
        # Log on state change only (not every 200ms cycle)
        if result != self._last_jsonl_state:
            debug(f"JSONL state change: {self._last_jsonl_state} -> {result}" +
                  (f" (tool: {detail.last_tool_name})" if detail.last_tool_name else ""))
            self._last_jsonl_state = result
        return result

    def is_process_tree_active(self):
        """Check if Claude's process tree has significant CPU activity.

        Returns True only if the process tree consumed meaningful CPU since last check.
        Filters out idle overhead (event loop, GC, TUI rendering) which produces
        small tick increments even when Claude is sitting at a prompt doing nothing.
        """
        if not self.claude_pid:
            return False
        try:
            # Get all PIDs in Claude's process tree
            pids = [self.claude_pid]
            try:
                result = subprocess.run(
                    ['pgrep', '-P', str(self.claude_pid)],
                    capture_output=True, text=True, timeout=1
                )
                if result.stdout.strip():
                    pids.extend(int(p) for p in result.stdout.strip().split('\n') if p.strip())
            except Exception:
                pass

            # Read CPU times for each PID (proc_info: /proc on Linux, ps on macOS)
            # Values are in clock ticks (typically 100 Hz = 10ms per tick)
            current_times = {}
            for pid in pids:
                ticks = proc_info.cpu_ticks(pid)
                if ticks is not None:
                    current_times[pid] = ticks

            if not current_times:
                return False

            # Exclude persistent background daemons (MCP servers etc.) from delta.
            # Their event-loop/heartbeat CPU would otherwise falsely sustain 'working' state.
            active_times = {pid: t for pid, t in current_times.items()
                            if pid not in self.background_pids or pid == self.claude_pid}

            # Compare with last snapshot
            total_current = sum(active_times.values())
            total_last = sum(self.last_cpu_times.get(pid, 0) for pid in active_times)
            self.last_cpu_times = current_times  # Always update full snapshot for next cycle

            # Require significant CPU usage to count as "active".
            # At 100 Hz, 10 ticks = 100ms of CPU. Idle Node.js processes typically
            # use 0-3 ticks per 2s poll (event loop, GC, TUI). Active Claude
            # (thinking, API calls, tool execution) uses 50+ ticks per 2s.
            # Threshold of 10 ticks filters idle overhead while catching real work.
            cpu_delta = total_current - total_last
            is_active = cpu_delta >= 10
            if cpu_delta > 0:
                debug(f"CPU delta: {cpu_delta} ticks ({'active' if is_active else 'idle overhead'})")
            return is_active
        except Exception:
            return False

    def _derive_activity_detail(self, status: str) -> str | None:
        """Derive human-readable activity detail from current state.

        Returns:
            Label string (e.g. 'Reading file...', 'Thinking...') or None for idle.
        """
        if status == 'idle':
            return None
        # Check JSONL state for tool name
        detail = self._last_jsonl_detail
        if detail and detail.last_tool_name:
            label = tool_to_label(detail.last_tool_name)
            if label:
                return label
        # Working but no known tool → agent is thinking
        if status == 'working':
            return 'Thinking...'
        return None

    def broadcast_activity(self, status, force=False):
        """Broadcast activity status (typing/working/idle) to the channel

        Args:
            status: 'idle', 'typing', or 'working'
            force: If True, send even if status hasn't changed (for periodic heartbeat)
        """
        if not self.joined or not self.channel_id or not self.participant_id:
            return
        if status == self.current_activity and not force:
            return  # No change

        self.current_activity = status
        self.last_heartbeat_time = time.time()
        activity_detail = self._derive_activity_detail(status)
        debug(f"Broadcasting activity: {status}{' (heartbeat)' if force else ''}"
              f"{f' [{activity_detail}]' if activity_detail else ''}")
        payload = {
            "action": "heartbeat",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "activityStatus": status,
        }
        if activity_detail is not None:
            payload["activityDetail"] = activity_detail
        payload["host"] = self._host_report()
        self.api_call("", "POST", payload)

    def _host_report(self):
        """Self-reported host facts so the server need not inspect this machine."""
        if getattr(self, "_host_tmux_session", None) is None:
            name = ""
            if os.environ.get('TMUX'):
                try:
                    r = subprocess.run(['tmux', 'display-message', '-p', '#S'],
                                       capture_output=True, text=True, timeout=2)
                    name = r.stdout.strip() if r.returncode == 0 else ""
                except Exception:
                    name = ""
            self._host_tmux_session = name
        return {
            "hostId": os.environ.get("DEVFLOW_HOST_ID") or socket.gethostname(),
            "pid": self.claude_pid,
            "wrapperPid": self.wrapper_pid,
            "tmuxSession": self._host_tmux_session or None,
            "cwd": os.getcwd(),
            "model": os.environ.get("ANTHROPIC_MODEL") or None,
        }

    def register_session(self):
        """Register session using Claude's PID so UI can find it"""
        if not self.claude_pid:
            debug("Cannot register - Claude PID not yet known")
            return

        # Set name if not provided
        if not self.participant_name:
            self.participant_name = get_project_name()

        try:
            with open(get_ready_file(self.claude_pid), 'w') as f:
                json.dump({
                    "pid": self.claude_pid,
                    "name": self.participant_name,
                    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "cwd": os.getcwd(),
                    "wrapperPid": self.wrapper_pid
                }, f)
            print(f"\033[32m[Collab] Session ready (PID {self.claude_pid}) - can be added to channels via DevFlow UI\033[0m", file=sys.stderr)
            debug(f"Session registered: {self.participant_name} (Claude PID: {self.claude_pid})")
        except Exception as e:
            print(f"\033[33m[Collab] Warning: {e}\033[0m", file=sys.stderr)

    def cleanup_stale_sessions(self):
        """Remove stale session/ready/invite files for PIDs that no longer exist.

        Sweeps both .claude/ (project-local) and /tmp/ (CWD-independent) directories.
        Called on startup and periodically from the poll loop.
        """
        cleaned = 0
        # Sweep .claude/ directory
        try:
            session_dir = os.path.join(os.getcwd(), '.claude')
            if os.path.isdir(session_dir):
                for filename in os.listdir(session_dir):
                    if not filename.startswith('collab-session-') or not filename.endswith('.json'):
                        continue
                    if filename == 'collab-session.json':
                        # Remove stale shared symlink (no longer used, causes identity confusion)
                        filepath = os.path.join(session_dir, filename)
                        try:
                            os.remove(filepath)
                            debug(f"Removed stale shared symlink: {filepath}")
                            cleaned += 1
                        except Exception:
                            pass
                        continue
                    try:
                        pid_str = filename.replace('collab-session-', '').replace('.json', '')
                        pid = int(pid_str)
                    except ValueError:
                        continue
                    if pid == self.claude_pid:
                        continue  # Don't delete our own
                    if not proc_info.pid_alive(pid):
                        try:
                            os.remove(os.path.join(session_dir, filename))
                            debug(f"Cleaned up stale .claude/ session: {filename} (PID {pid} dead)")
                            cleaned += 1
                        except OSError as e:
                            debug(f"Could not remove {filename}: {e}")
        except Exception as e:
            debug(f"Stale cleanup error (.claude/): {e}")

        # Sweep /tmp/ for stale collab files (session, ready, invite)
        try:
            for prefix in ('collab-session-', 'collab-ready-', 'collab-invite-'):
                for filename in os.listdir('/tmp'):
                    if not filename.startswith(prefix) or not filename.endswith('.json'):
                        continue
                    try:
                        pid_str = filename.replace(prefix, '').replace('.json', '')
                        if not pid_str:
                            # Empty PID file (e.g., collab-session-.json) — always remove
                            os.remove(f'/tmp/{filename}')
                            debug(f"Removed empty-PID file: /tmp/{filename}")
                            cleaned += 1
                            continue
                        pid = int(pid_str)
                    except ValueError:
                        continue
                    if pid == self.claude_pid:
                        continue  # Don't delete our own
                    if not proc_info.pid_alive(pid):
                        try:
                            os.remove(f'/tmp/{filename}')
                            cleaned += 1
                        except OSError:
                            pass
        except Exception as e:
            debug(f"Stale cleanup error (/tmp/): {e}")

        if cleaned > 0:
            debug(f"Stale file cleanup: removed {cleaned} files")

    def unregister_session(self):
        """Clean up all registration and session files for this agent"""
        if self.claude_pid:
            files_to_remove = [
                get_ready_file(self.claude_pid),
                get_invite_file(self.claude_pid),
                f'/tmp/collab-session-{self.claude_pid}.json',
                os.path.join(os.getcwd(), '.claude', f'collab-session-{self.claude_pid}.json'),
            ]
            for f in files_to_remove:
                try:
                    os.remove(f)
                    debug(f"Cleaned up: {f}")
                except FileNotFoundError:
                    pass
                except Exception as e:
                    debug(f"Failed to clean up {f}: {e}")

    def join_channel(self, channel_id, channel_name=None, force=False):
        self.channel_id = channel_id
        if channel_name:
            self.channel_name = channel_name  # Store for OTEL and Pulse reporting
        payload = {
            "action": "join",
            "channelId": channel_id,
            "participant": {
                "name": self.participant_name,
                "type": "claude-terminal",
                "source": "collab-claude wrapper",
                "pid": self.claude_pid,  # Include PID for stable ID matching
                "projectPath": os.getcwd()  # Include projectPath for stable ID generation
            }
        }
        if force:
            payload["force"] = True
        result = self.api_call("", "POST", payload)
        if result.get("success"):
            self.participant_id = result.get("participantId")
            self.joined = True
            team_lead_id = result.get("teamLeadId")
            # Set poll time based on lastRead, capped to max 5 minutes ago.
            # Without the cap, a stale lastRead (days old) causes the wrapper to
            # fetch and inject every message since then on respawn — a flood.
            channel_data = result.get("channel", {})
            my_participant = None
            for p in channel_data.get("participants", []):
                if p.get("id") == self.participant_id:
                    my_participant = p
                    break
            # Determine catch-up poll time from best available source.
            # Priority: durable cursor > lastRead > joinedAt > NOW
            cursor_ts = self._load_cursor_timestamp()
            if cursor_ts:
                self.last_poll_time = cursor_ts
                debug(f"Catch-up poll time from durable cursor: {self.last_poll_time}")
            elif my_participant and my_participant.get("lastRead"):
                self.last_poll_time = my_participant["lastRead"]
                debug(f"Catch-up poll time from lastRead: {self.last_poll_time}")
            elif my_participant and my_participant.get("joinedAt"):
                self.last_poll_time = my_participant["joinedAt"]
                debug(f"Catch-up poll time from joinedAt: {self.last_poll_time}")
            else:
                self.last_poll_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                debug("No lastRead/joinedAt/cursor found — using NOW as poll time")
            # No time cap on join — use lastRead from server as-is.
            # Count-based cap (limit=50 on poll URL) prevents message floods.
            if self.last_poll_time:
                debug(f"Join catch-up: using lastRead {self.last_poll_time} (no time cap)")
            channel_display = channel_name or channel_id[:8]
            # Set home channel on first-ever join (immutable after that)
            if self.home_channel_id is None:
                self.home_channel_id = channel_id
                self.home_channel_name = channel_display
                debug(f"Home channel set: {channel_display} ({channel_id[:8]})")
            elif channel_id != self.home_channel_id:
                # Visiting a different channel
                self.visiting = True
                self.visit_start_time = time.time()
                debug(f"Visiting channel: {channel_display} (home: {self.home_channel_name})")
            else:
                # Returned to home channel
                self.visiting = False
                self.visit_start_time = 0
                debug(f"Returned to home channel: {channel_display}")
            print(f"\033[32m[Collab] Joined '{channel_display}' as {self.participant_name}\033[0m", file=sys.stderr)
            debug(f"Joined channel: {channel_display}")

            # Write session file for /collab-post skill to use.
            # Skip if claude_pid not yet known (pre-spawn join) — the restart loop
            # calls _write_session_file() again after Claude spawns with the real PID.
            if self.claude_pid:
                self._write_session_file(channel_id, channel_name)

            # Fetch agent's role from roster
            self._fetch_role_from_roster(result.get("channel"))

            # Inject role context with sprint task board guidance
            if self.child and self.child.isalive():
                time.sleep(1.5)  # Wait for TUI to settle
                if team_lead_id == self.participant_id:
                    self.inject_message("System", "You are the Team Lead for this channel. Set a clear outcome and owner, use the sprint board when multi-person coordination benefits from it, trust agents to choose implementation details, and apply review/testing in proportion to real risk. Distil decisions and outcomes for " + OWNER_PROSE + "; keep detailed evidence in DevFlow records. This channel uses targeted delivery, so you receive direct mentions and broadcasts, not messages targeted to other agents.")
                elif team_lead_id:
                    self.inject_message("System", "You are a specialist on this channel. Work autonomously toward the assigned outcome, choose proportionate verification, and record nonessential discoveries as follow-ups rather than blockers. Use the sprint board when a board task exists. Keep channel communication focused on decisions, outcomes, and genuine blockers. This channel uses targeted delivery, so you receive direct mentions and broadcasts, not messages targeted to other agents.")

            return True
        debug(f"Failed to join channel: {result}")
        return False

    def _get_cursor_path(self):
        """Path to the durable collab cursor (PID-independent, survives reboot)"""
        return os.path.join(os.getcwd(), '.claude', 'collab-cursor.json')

    def _load_cursor_timestamp(self):
        """Load last-processed message timestamp from durable cursor.
        Returns ISO timestamp string or None.
        """
        try:
            with open(self._get_cursor_path(), 'r') as f:
                data = json.load(f)
                return data.get('lastPollTimestamp')
        except (FileNotFoundError, IOError, json.JSONDecodeError):
            return None

    def _save_cursor_timestamp(self, timestamp):
        """Persist last-processed message timestamp to disk (atomic write)."""
        native = getattr(self, '_native_pump', None)
        if native and native.active() and not getattr(self, '_native_ack_allowed', False):
            return
        cursor_path = self._get_cursor_path()
        data = {
            'lastPollTimestamp': timestamp,
            'updatedAt': time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        }
        tmp_path = cursor_path + '.tmp'
        try:
            os.makedirs(os.path.dirname(cursor_path), exist_ok=True)
            with open(tmp_path, 'w') as f:
                json.dump(data, f)
            os.replace(tmp_path, cursor_path)
        except IOError as e:
            debug(f"Failed to save cursor: {e}")

    def _write_session_file(self, channel_id, channel_name=None):
        """Write PID-specific session file for /collab-post skill compatibility"""
        try:
            session_dir = os.path.join(os.getcwd(), '.claude')
            os.makedirs(session_dir, exist_ok=True)

            # Use PID-specific filename to allow multiple agents in same project
            pid_session_file = os.path.join(session_dir, f'collab-session-{self.claude_pid}.json')

            session_data = {
                "channelId": channel_id,
                "participantId": self.participant_id,
                "displayName": self.participant_name,
                "channelName": channel_name or "Unknown",
                "pid": self.claude_pid,
                "agentType": "claude",
                "projectPath": os.getcwd(),
                "homeChannelId": self.home_channel_id,
                "homeChannelName": self.home_channel_name
            }

            # Write PID-specific file
            with open(pid_session_file, 'w') as f:
                json.dump(session_data, f)

            # Also write to /tmp/ as CWD-independent location (consistent with ready/invite files)
            # This prevents CWD mismatch when the helper runs from a different directory
            tmp_session_file = f'/tmp/collab-session-{self.claude_pid}.json'
            with open(tmp_session_file, 'w') as f:
                json.dump(session_data, f)

            # NOTE: Do NOT create shared symlink (.claude/collab-session.json).
            # When multiple agents share the same project directory, the symlink
            # gets overwritten by the last agent to join, causing identity confusion.
            # Each agent is identified exclusively by their PID-specific session file.

            debug(f"Wrote session file: {pid_session_file} + {tmp_session_file}")
        except Exception as e:
            debug(f"Failed to write session file: {e}")

    def _fetch_role_from_roster(self, channel_data=None):
        """Fetch agent's role from roster entry. Called after joining."""
        try:
            # Try from join response first
            if not channel_data:
                # Fetch channel data separately
                result = self.api_call(f"?channelId={self.channel_id}", "GET")
                channels = result.get("channels", [])
                channel_data = next((c for c in channels if c.get("id") == self.channel_id), None)

            if not channel_data:
                return

            roster = channel_data.get("roster", {})
            agents = roster.get("agents", [])

            # Find our roster entry by name or participantId
            my_entry = None
            for agent in agents:
                if agent.get("participantId") == self.participant_id:
                    my_entry = agent
                    break
                if agent.get("name") == self.participant_name:
                    my_entry = agent
                    break

            if not my_entry or not my_entry.get("roleId"):
                debug("No role assigned to this agent")
                return

            # Fetch role name from roles API
            role_id = my_entry["roleId"]
            try:
                req = urllib.request.Request(f"{DEVFLOW_URL}/api/roles")
                with urllib.request.urlopen(req, timeout=5) as resp:
                    roles_result = json.loads(resp.read().decode('utf-8'))
                if roles_result.get("success"):
                    for role in roles_result.get("roles", []):
                        if role.get("id") == role_id:
                            self.role_name = role.get("name")
                            debug(f"Agent role: {self.role_name} (id: {role_id})")
                            return
            except Exception:
                pass

            # Fallback: just store the role ID
            debug(f"Could not resolve role name for id: {role_id}")
        except Exception as e:
            debug(f"Failed to fetch role: {e}")

    def log_delivery_event(self, msg_id, status, extra=None):
        """Log a message delivery event to /api/collab/delivery-status (best-effort, non-blocking)."""
        if not msg_id:
            return
        try:
            import urllib.request as urllib_req
            payload = {
                "messageId": msg_id,
                "status": status,  # "delivered" | "timeout" | "delivery_failure"
                "participantId": self.participant_id,
                "agentName": self.participant_name,
                "channelId": self.channel_id,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            if extra:
                payload.update(extra)
            data = json.dumps(payload).encode()
            req = urllib_req.Request(
                f"{DEVFLOW_URL}/api/collab/delivery-status",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            urllib_req.urlopen(req, timeout=3)
            debug(f"Delivery event logged: {status} for msg {msg_id[:8]}")
        except Exception as e:
            debug(f"Delivery event log failed (non-fatal): {e}")

    def log_delivery_failure(self, msg_id, failure_reason, elapsed_ms=None):
        """Log a structured delivery_failure event with richer telemetry fields."""
        now = time.time()
        last_output_delta = int((now - self.last_output_time) * 1000) if self.last_output_time > 0 else None
        extra = {
            "failureReason": failure_reason,
            "wrapperPid": self.wrapper_pid,
            "isProcessingAtInject": self.is_processing,
        }
        if elapsed_ms is not None:
            extra["elapsedMs"] = elapsed_ms
        if last_output_delta is not None:
            extra["lastOutputTimeDeltaMs"] = last_output_delta
        self.log_delivery_event(msg_id, "delivery_failure", extra)

    def leave_channel(self):
        if self.joined and self.participant_id:
            self.api_call("", "POST", {
                "action": "leave",
                "channelId": self.channel_id,
                "participantId": self.participant_id
            })
            print(f"\033[33m[Collab] Left channel\033[0m", file=sys.stderr)

    def return_to_home_channel(self):
        """Return from a visited channel back to the home channel."""
        if not self.visiting or not self.home_channel_id:
            return
        visited = self.channel_name or self.channel_id[:8]
        home = self.home_channel_name or self.home_channel_id[:8]
        debug(f"Returning to home channel: {home} (was visiting {visited})")
        # Leave the visited channel
        self.leave_channel()
        self.joined = False
        # Rejoin home channel — join_channel() will clear visiting state
        self.join_channel(self.home_channel_id, self.home_channel_name)
        if self.child and self.child.isalive():
            self.inject_message("System", f"You have returned to your home channel '{home}' after visiting '{visited}'. Resume your normal work here.")

    def check_forward_queue(self):
        """Check for cross-channel forwarded messages and inject them."""
        if not self.participant_id:
            return
        safe_id = ''.join(c if c.isalnum() or c in ('_', '-') else '_' for c in self.participant_id)[:50]
        queue_file = f'/tmp/collab-forward-{safe_id}.json'
        if not os.path.exists(queue_file):
            return
        try:
            with open(queue_file, 'r') as f:
                queue = json.load(f)
            messages = queue.get("messages", [])
            if not messages:
                return
            # Clear queue immediately to prevent re-processing
            with open(queue_file, 'w') as f:
                json.dump({"participantId": self.participant_id, "messages": [], "lastUpdated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, f)
            debug(f"Draining {len(messages)} forwarded message(s)")
            for msg in messages:
                msg_id = msg.get("id", "")
                with self._dedup_lock:
                    if msg_id and msg_id in self.injected_message_ids:
                        continue
                sender = msg.get("from", "Unknown")
                content = msg.get("content", "")
                source_channel = msg.get("sourceChannelName", "unknown")
                # Prefix with forwarding context so the agent knows it's from another channel
                forwarded_content = f"[Forwarded from #{source_channel}] {content}"
                if self.child and self.child.isalive() and not self.pending_enter:
                    idle_time = time.time() - self.last_keystroke
                    if idle_time >= IDLE_THRESHOLD:
                        if self.inject_message(sender, forwarded_content):
                            if msg_id:
                                self._track_injected_id(msg_id)
                            debug(f"Injected forwarded message from {sender} (#{source_channel})")
                            break  # One message at a time
        except Exception as e:
            debug(f"Forward queue check error: {e}")

    def cleanup_stale_invite(self):
        """Remove invite file for current PID if it is stale (>5 min old) or for a different agent.

        Called once at startup before the main loop to prevent stale invite files left
        from a previous session (or PID reuse) from triggering an involuntary channel hop.
        """
        if not self.claude_pid:
            return
        try:
            import datetime
            invite_file = get_invite_file(self.claude_pid)
            if not os.path.exists(invite_file):
                return
            with open(invite_file, 'r') as f:
                invite = json.load(f)
            # Stale if older than 5 minutes
            invited_at = invite.get('invitedAt')
            if invited_at:
                try:
                    age_s = (datetime.datetime.now(datetime.timezone.utc)
                             - datetime.datetime.fromisoformat(invited_at.replace('Z', '+00:00'))
                             ).total_seconds()
                    if age_s > 300:
                        debug(f"Startup sweep: removing stale invite ({age_s:.0f}s old) for PID {self.claude_pid}")
                        os.remove(invite_file)
                        return
                except Exception as e:
                    debug(f"Startup sweep timestamp parse error: {e}")
            # Wrong agent — only check when both names are known
            display_name = invite.get('displayName')
            if display_name and self.participant_name:
                if display_name.lower() != self.participant_name.lower():
                    debug(f"Startup sweep: removing mismatched invite (for '{display_name}', we are '{self.participant_name}')")
                    os.remove(invite_file)
        except Exception as e:
            debug(f"Startup invite sweep error: {e}")

    def check_for_invite(self):
        """Check for channel invite file using Claude's PID"""
        if not self.claude_pid:
            return None
        try:
            invite_file = get_invite_file(self.claude_pid)
            if os.path.exists(invite_file):
                with open(invite_file, 'r') as f:
                    invite = json.load(f)

                # Guard against PID reuse: if displayName is set and does not match our
                # registered name, this invite was meant for a different agent.
                display_name = invite.get('displayName')
                if display_name and self.participant_name:
                    if display_name.lower() != self.participant_name.lower():
                        debug(f"Invite rejected: displayName='{display_name}' but we are '{self.participant_name}' — likely PID reuse")
                        os.remove(invite_file)
                        return None

                # Guard against stale invite files (> 5 minutes old).
                invited_at = invite.get('invitedAt')
                if invited_at:
                    try:
                        import datetime
                        age_s = (datetime.datetime.now(datetime.timezone.utc)
                                 - datetime.datetime.fromisoformat(invited_at.replace('Z', '+00:00'))
                                 ).total_seconds()
                        if age_s > 300:
                            debug(f"Invite rejected: stale ({age_s:.0f}s old, limit 300s)")
                            os.remove(invite_file)
                            return None
                    except Exception as e:
                        debug(f"Invite timestamp check error: {e}")

                os.remove(invite_file)
                debug(f"Found invite: {invite}")

                # Re-read ready file to get latest display name
                # (user may have run /register-session after wrapper started)
                ready_file = get_ready_file(self.claude_pid)
                if os.path.exists(ready_file):
                    try:
                        with open(ready_file, 'r') as f:
                            ready_data = json.load(f)
                        if ready_data.get('name') and ready_data['name'] != self.participant_name:
                            old_name = self.participant_name
                            self.participant_name = ready_data['name']
                            debug(f"Updated participant_name from ready file: {old_name} -> {self.participant_name}")
                    except Exception as e:
                        debug(f"Could not read ready file for name update: {e}")

                return invite
        except Exception as e:
            debug(f"Invite check error: {e}")
        return None

    def check_messages(self):
        if not self.joined or not self.channel_id:
            return []
        # IMPORTANT: Pass participantId for targeted message delivery filtering
        result = self.api_call(f"?channelId={self.channel_id}&since={self.last_poll_time}&participantId={self.participant_id}")
        messages = result.get("messages", [])
        # Do NOT advance last_poll_time here — only advance per-message after injection
        # (advancing to the last message's timestamp would permanently skip uninjected messages)
        return messages

    def _get_inbox_path(self):
        """Get the inbox file path for this participant.

        Mirrors the server-side getInboxFilename() in collab-delivery.ts:
        participantId is sanitized (non-alphanumeric/underscore/hyphen → _) and
        truncated to 50 chars, then used as inbox-{safeId}.json under .claude/.
        """
        if not self.participant_id:
            return None
        import re as _re_inbox
        safe_id = _re_inbox.sub(r'[^a-zA-Z0-9_-]', '_', self.participant_id)[:50]
        return os.path.join(os.getcwd(), '.claude', f'inbox-{safe_id}.json')

    def _reopen_inbox_read(self, msg_id):
        """Re-open the inbox 'read' flag after a failed ingestion verify.

        check_inbox sets read=True at ENQUEUE, before verify confirms the inject
        landed. On verify-timeout the recovery un-dedups injected_message_ids but the
        inbox read=True persists, so the safety net ('if read: continue') skips the
        message forever and it is silently dropped (root cause of the broadcast loss,
        confirmed 2026-06-03). Flipping read back to False lets the safety net
        re-deliver it — same dup-over-drop contract as _untrack_injected_id. No-op if
        the inbox file or message id is absent.
        """
        if not msg_id:
            return
        inbox_path = self._get_inbox_path()
        if not inbox_path or not os.path.exists(inbox_path):
            return
        try:
            import fcntl
            with open(inbox_path, 'r+') as f:
                fcntl.flock(f, fcntl.LOCK_EX)
                try:
                    raw = f.read()
                    if not raw.strip():
                        return
                    data = json.loads(raw)
                    changed = False
                    for m in data.get('messages', []):
                        if m.get('id') == msg_id and m.get('read'):
                            m['read'] = False
                            changed = True
                    if changed:
                        data['lastUpdated'] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
                        f.seek(0)
                        f.truncate()
                        f.write(json.dumps(data, indent=2))
                        debug(f"Re-opened inbox read flag for {str(msg_id)[:8]} (verify timeout — safety net will re-deliver)")
                finally:
                    fcntl.flock(f, fcntl.LOCK_UN)
        except FileNotFoundError:
            pass
        except Exception as e:
            debug(f"_reopen_inbox_read failed (non-fatal) for {str(msg_id)[:8]}: {e}")

    def check_inbox(self):
        """Check inbox file for unread messages missed by SSE/polling.

        The server writes every delivered message to a persistent inbox file
        ({projectPath}/.claude/inbox-{participantId}.json). This method reads
        unread messages, queues them into the SSE message queue for the normal
        processing pipeline, and marks them read in the file.

        Returns the number of messages queued.
        """
        inbox_path = self._get_inbox_path()
        if not inbox_path:
            return 0
        if not os.path.exists(inbox_path):
            return 0

        queued = 0
        stale_skipped = 0
        try:
            import fcntl
            with open(inbox_path, 'r+') as f:
                fcntl.flock(f, fcntl.LOCK_EX)
                try:
                    raw = f.read()
                    if not raw.strip():
                        fcntl.flock(f, fcntl.LOCK_UN)
                        return 0
                    data = json.loads(raw)
                except (json.JSONDecodeError, ValueError) as parse_err:
                    debug(f"Inbox parse error (non-fatal): {parse_err}")
                    fcntl.flock(f, fcntl.LOCK_UN)
                    return 0

                messages = data.get('messages', [])
                modified = False

                for msg in messages:
                    if msg.get('read', False):
                        continue
                    msg_id = msg.get('id', '')
                    if not msg_id:
                        continue

                    # Skip stale messages (older than MAX_CATCHUP_AGE_SECONDS)
                    if msg.get('timestamp'):
                        try:
                            from datetime import datetime, timezone as _tz_inbox
                            msg_dt = datetime.fromisoformat(msg['timestamp'].replace('Z', '+00:00'))
                            age_s = (datetime.now(_tz_inbox.utc) - msg_dt).total_seconds()
                            if age_s > MAX_CATCHUP_AGE_SECONDS:
                                msg['read'] = True
                                modified = True
                                stale_skipped += 1
                                continue
                        except Exception:
                            pass

                    with self._dedup_lock:
                        if msg_id in self.injected_message_ids:
                            # Already injected via SSE/polling — just mark read in file
                            msg['read'] = True
                            modified = True
                            continue

                    # Convert inbox format → API format for the processing pipeline.
                    # Inbox from: "Jack (BnG CRM System)" → API from: {id, name}
                    from_str = msg.get('from', 'Unknown')
                    sender_name = from_str.split(' (')[0] if ' (' in from_str else from_str

                    # Rebuild replyTo to match API shape (inbox stores from as string)
                    reply_to = msg.get('replyTo')
                    if reply_to and isinstance(reply_to.get('from'), str):
                        reply_to = {
                            'id': reply_to.get('id', ''),
                            'from': {'name': reply_to['from']},
                            'content': reply_to.get('content', ''),
                        }

                    api_msg = {
                        'id': msg_id,
                        'from': {'id': 'inbox', 'name': sender_name},
                        'content': msg.get('content', ''),
                        'timestamp': msg.get('timestamp', ''),
                        'replyTo': reply_to,
                        'mentions': [],
                    }

                    self.sse_message_queue.put(api_msg)
                    # READ-AFTER-CONFIRM (2026-06-04, Reynolds diagnosed + CJack). Do NOT mark
                    # read at ENQUEUE. If this queued item never injects (drop / crash / drain
                    # race), a read=True here persists and the L1449 skip drops it FOREVER — the
                    # read-before-confirm root of the fleet silent-drop (mirror image of the
                    # verify re-inject dup). The inbox read flag is now set only AFTER a confirmed
                    # inject: the dedup branch above (msg_id in injected_message_ids → read=True)
                    # marks it on the next pass once delivery is confirmed. A re-queue before
                    # inject is harmless — the queue consumer dedups against injected_message_ids
                    # BEFORE injecting, so it never double-delivers; and a never-injected message
                    # stays unread and gets re-delivered instead of silently dropped.
                    queued += 1

                if modified:
                    data['lastUpdated'] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
                    f.seek(0)
                    f.truncate()
                    f.write(json.dumps(data, indent=2))

                fcntl.flock(f, fcntl.LOCK_UN)
        except FileNotFoundError:
            pass
        except Exception as e:
            debug(f"Inbox check failed (non-fatal): {e}")

        if stale_skipped:
            debug(f"Inbox catch-up: discarded {stale_skipped} stale message(s) older than {MAX_CATCHUP_AGE_SECONDS}s")
        if queued:
            debug(f"Inbox catch-up: queued {queued} unread message(s)")
            # Log to DevFlow event system for ongoing visibility into safety-net usage.
            # One entry per catch-up run (not per message) to keep volume low.
            try:
                now_ts = time.time()
                # Calculate max age: how long the oldest recovered message sat unread
                oldest_ts = None
                recovered_ids = []
                for msg in data.get('messages', []):
                    with self._dedup_lock:
                        already_injected = msg.get('id') and msg['id'] in self.injected_message_ids
                    if msg.get('read') and msg.get('id') and not already_injected:
                        recovered_ids.append(msg['id'][:8])
                        msg_time = msg.get('timestamp', '')
                        if msg_time and (oldest_ts is None or msg_time < oldest_ts):
                            oldest_ts = msg_time
                max_age_s = 0
                if oldest_ts:
                    from datetime import datetime, timezone as _tz_age
                    try:
                        ot = datetime.fromisoformat(oldest_ts.replace('Z', '+00:00'))
                        max_age_s = int(now_ts - ot.timestamp())
                    except Exception:
                        pass
                log_payload = json.dumps({
                    "source": "agent",
                    "severity": "info",
                    "title": f"Inbox safety net: {queued} message(s) recovered by {self.participant_name}",
                    "metadata": {
                        "agent": self.participant_name,
                        "channelId": self.channel_id,
                        "recoveredCount": queued,
                        "maxAgeSecs": max_age_s,
                        "messageIds": recovered_ids[:10],
                    }
                }).encode()
                api_token = os.environ.get('DEVFLOW_API_TOKEN', '')
                req = urllib.request.Request(
                    f"{DEVFLOW_URL}/api/logs",
                    data=log_payload,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_token}",
                    },
                    method="POST"
                )
                urllib.request.urlopen(req, timeout=3)
            except Exception:
                pass  # Best-effort — never block message recovery
        return queued


    def _agent_responded_since_last_inject(self):
        """Deterministic check: did this agent post any message to its channel
        since the most recent inject?

        Asks DevFlow for the channel's messages since the inject and looks for
        one whose from.id matches our participant_id. It used to read
        ~/DevFlow/.AppData directly, which is only the live store when DevFlow
        runs on this machine; once DevFlow moved to its server that copy went
        stale and every reply looked missing, so every turn drew the corrective
        (an agent, 4 Oct 2026).

        This replaces the old TUI string-parsing detection in output_filter,
        which was unreliable because Claude Code's Ink TUI doesn't emit tool
        invocation strings as contiguous text in the pty output stream.

        Returns True if a matching message is found, False otherwise.
        Returns True (fail-open) on any read/parse error so a transient API
        failure never triggers a spurious corrective re-injection.
        """
        try:
            if not self.channel_id or not self.participant_id or not self.last_inject_time_iso:
                return True  # Insufficient info — fail open, do not nag
            # A reply to a cross-channel delivery is posted to the source channel
            # (collab_helper.py --channel <source>) under our participant ID, so
            # look there too, otherwise a correct reply triggers a false nag.
            channel_ids = [self.channel_id]
            source = getattr(self, 'last_injected_source_channel', None)
            if source and source != self.channel_id:
                channel_ids.append(source)
            inject_iso = self.last_inject_time_iso
            for channel_id in channel_ids:
                query = urllib.parse.urlencode({'channelId': channel_id, 'since': inject_iso, 'limit': 200})
                with urllib.request.urlopen(f"{API_BASE}?{query}", timeout=5) as resp:
                    data = json.loads(resp.read().decode('utf-8'))
                messages = data.get('messages') if isinstance(data, dict) else None
                if not isinstance(messages, list):
                    return True  # Unexpected shape — fail open
                for m in messages:
                    # ISO 8601 timestamps with the same format and trailing Z
                    # compare correctly as plain strings.
                    ts = m.get('timestamp', '')
                    if ts and ts < inject_iso:
                        continue
                    from_obj = m.get('from') or {}
                    sender_id = from_obj.get('id') if isinstance(from_obj, dict) else None
                    if sender_id and sender_id == self.participant_id:
                        return True
            return False
        except Exception as e:
            debug(f"_agent_responded_since_last_inject error (failing open): {e}")
            return True  # Any error → fail open, no false positive corrective

    def mark_read(self, message_timestamp=None):
        native = getattr(self, '_native_pump', None)
        if native and native.active():
            return  # Native completion performs its independently verified ack.
        if self.joined and self.participant_id:
            payload = {
                "action": "mark_read",
                "channelId": self.channel_id,
                "participantId": self.participant_id
            }
            if message_timestamp:
                payload["messageTimestamp"] = message_timestamp
            self.api_call("", "POST", payload)

    def sync_name_from_ready_file(self):
        """Sync participant_name from ready file (in case /register-session was called)"""
        if not self.claude_pid:
            return False
        try:
            ready_file = get_ready_file(self.claude_pid)
            if os.path.exists(ready_file):
                with open(ready_file, 'r') as f:
                    ready_data = json.load(f)
                new_name = ready_data.get('name')
                if new_name and new_name != self.participant_name:
                    old_name = self.participant_name
                    self.participant_name = new_name
                    debug(f"Synced name from ready file: {old_name} -> {new_name}")

                    # Update name in channel via rejoin (collab API merges updates)
                    if self.joined and self.channel_id:
                        self.api_call("", "POST", {
                            "action": "join",
                            "channelId": self.channel_id,
                            "participant": {
                                "id": self.participant_id,
                                "name": new_name,
                                "type": "claude-terminal",
                                "source": "collab-claude wrapper",
                                "pid": self.claude_pid,
                                "projectPath": os.getcwd()
                            }
                        })
                        debug(f"Updated name in channel to: {new_name}")
                    return True
        except Exception as e:
            debug(f"Name sync error: {e}")
        return False

    def _format_injection(self, sender, content, reply_to, ch, marker, msg_id):
        """Text to type for one channel message: the full message when short,
        otherwise a single-line pointer to a file holding the full message."""
        header = f"[Channel message from {sender} in {ch}]"
        reply_line = format_reply_context(reply_to)  # names the full id of the message being answered
        if reply_line:
            header += f" {reply_line}"
        full = f"{header}: {content}\n{marker}"
        if not needs_pointer(content):
            return full
        try:
            path = write_pointer_file(os.getcwd(), msg_id, full + "\n")
        except OSError as e:
            debug(f"Pointer file write failed ({e}) — typing full message")
            return full
        debug(f"Long message ({len(content)} chars) delivered as pointer: {path}")
        return build_pointer_line(header, content, marker, path)

    def inject_message(self, sender, content, reply_to=None, mentions=None, channel_id=None, msg_timestamp=None, msg_id=None):
        """Inject a message into Claude's input using pexpect (deferred Enter)

        This method only sends the text to the input buffer. The Enter key
        is sent later by check_pending_enter() once Claude is idle.
        This prevents the message from being lost if Claude is mid-output.

        Args:
            sender: Name of message sender
            content: Message content
            reply_to: Optional reply context dict
            mentions: List of mentioned participant IDs/names
            msg_timestamp: ISO timestamp of original message (for age markers)
            msg_id: Message ID for delivery telemetry (optional)
        """
        native = getattr(self, '_native_pump', None)
        if native and native.active():
            # All channel submissions go through the exclusive native pump.
            return False
        if not self.child or not self.child.isalive():
            debug("Cannot inject - child not alive")
            return False

        # A hearing connection check is answered by the wrapper itself when switched on; Claude never sees it.
        if sender == 'Hearing companion' and self._connection_check(sender, content):
            return True

        # Prepared hearing context (flag OFF by default), fetched before the Enter lock; None keeps today's path.
        prepared = self._prepared_hearing(sender, content) if sender == 'Hearing companion' else None

        # If there's already text pending in the input buffer (Enter not yet sent),
        # APPEND this message to the buffer instead of blocking. When Enter fires,
        # all accumulated messages submit together as one batch. This matches the
        # original behavior where messages stacked in the tmux input field.
        with self._enter_lock:
            if self.pending_enter:
                # Format the message the same way as a normal inject
                ch = channel_id or self.channel_id or "unknown"
                # Prefer the readable channel name over the raw UUID in the injected header.
                if getattr(self, "channel_name", "") and ch == (self.channel_id or ch):
                    ch = self.channel_name
                # Add mention annotation
                is_mentioned_append = False
                if mentions:
                    for m in (mentions or []):
                        if isinstance(m, str) and m == self.participant_id:
                            is_mentioned_append = True
                            break
                if not is_mentioned_append and self.participant_name:
                    import re as _re_append
                    if _re_append.search(r'@' + _re_append.escape(self.participant_name) + r'(?:[^a-zA-Z0-9_-]|$)', content, _re_append.IGNORECASE):
                        is_mentioned_append = True
                if is_mentioned_append:
                    marker = "(@you)"
                elif mentions:
                    marker = "(not addressed to you)"
                else:
                    marker = "(broadcast)"
                append_prompt = "\n" + self._format_injection(sender, content, reply_to, ch, marker, msg_id)
                if prepared:
                    prepared['prompt'] = "\n" + self._prepared_prompt(sender, ch, marker, prepared)
                # Append to tmux input buffer (text accumulates, Enter sends all at once)
                if self._send_injection(append_prompt, prepared):
                    debug(f"APPENDED to pending input buffer (mentioned={is_mentioned_append}): {append_prompt[:80]}...")
                    return True
                else:
                    debug("Failed to append to input buffer")
                    return False

        try:
            # Determine if this agent is mentioned
            mentions = mentions or []
            is_mentioned = False
            if mentions:
                # Primary: check participant ID match (mentions[] contains participant IDs)
                for m in mentions:
                    if isinstance(m, str) and m == self.participant_id:
                        is_mentioned = True
                        break

            # Fallback: scan message content for @Name (handles ID mismatch edge cases
            # and multi-mention messages where ID-based check might miss this agent)
            if not is_mentioned and self.participant_name:
                import re as _re
                name_pattern = _re.compile(
                    r'@' + _re.escape(self.participant_name) + r'(?:[^a-zA-Z0-9_-]|$)',
                    _re.IGNORECASE
                )
                if name_pattern.search(content):
                    is_mentioned = True
                    debug(f"is_mentioned set via @name fallback scan (participant_id check missed)")

            # Format message — behavioral rules are in .claude/rules/Directives.md
            # NOTE: No age-based HISTORICAL prefix or hard-drop. The 5-min catch-up
            # cap in join_channel() prevents fetching ancient messages. Messages that
            # make it into the queue are legitimate and should be injected normally.
            # The old age check here caused messages to be dropped while waiting in
            # the internal queue (age checked at injection time, not queue time).
            ch = channel_id or self.channel_id or "unknown"
            # Prefer the readable channel name over the raw UUID in the injected header.
            if getattr(self, "channel_name", "") and ch == (self.channel_id or ch):
                ch = self.channel_name
            if is_mentioned:
                marker = "(@you)"
            elif mentions:
                marker = "(not addressed to you)"
            else:
                marker = "(broadcast)"
            prompt = self._format_injection(sender, content, reply_to, ch, marker, msg_id)
            if prepared:
                prepared['prompt'] = self._prepared_prompt(sender, ch, marker, prepared)

            debug(f"Injecting text (Enter deferred, mentioned={is_mentioned}): {prompt}")

            # Serialize text send + pending_enter under _enter_lock to prevent
            # hook-triggered commands from interleaving with the injected message.
            with self._enter_lock:
                if not self._send_injection(prompt, prepared, prompt_enter=True):
                    debug("inject_message: _tmux_send returned False, aborting")
                    if msg_id:
                        self.log_delivery_failure(msg_id, "tmux_send_failed")
                    return False
                self.pending_enter = True
                self.pending_enter_time = time.time()

            # Optional verification — log-only, never retry the send (skipped for a prepared paste submitted at once)
            if self.tmux_pane_target and not self._prepared_enter:
                time.sleep(0.3)  # Give Ink time to render the input
                verify_snippet = prompt[:40]
                pane_content = self._capture_tmux_pane()
                if verify_snippet in pane_content:
                    debug("Inject: delivery verified via pane capture")
                else:
                    debug("Inject: text not found in pane capture (Ink render delay) — proceeding anyway")

            debug("Text sent, Enter deferred (always-defer — prevents race on turn-transition)")

            # Mark as processing and broadcast 'working' immediately.
            # IMPORTANT: also reset last_output_time to NOW so the CPU check loop doesn't
            # see a stale (e.g. 177s old) silence_time and immediately declare idle before
            # Claude has had a chance to start generating output (Task 1 root-cause fix).
            self.idle_since = 0
            self.is_processing = True
            self.last_output_time = time.time()  # Reset stale timestamp — prevents premature CPU-idle
            self.output_seen_since_inject = False  # No output yet — use extended idle threshold
            self.collab_response_sent = False  # Reset — track if agent responds via collab
            self._collab_detect_buf = ''  # Reset detection buffer for new message
            from datetime import datetime, timezone
            # Channel file timestamps use 3-decimal millisecond ISO 8601 (e.g.
            # 2026-04-10T15:02:53.052Z). Match that format exactly so plain
            # string comparison stays chronological in _agent_responded_since_last_inject.
            _now_utc = datetime.now(timezone.utc)
            self.last_inject_time_iso = _now_utc.strftime('%Y-%m-%dT%H:%M:%S.') + f'{_now_utc.microsecond // 1000:03d}Z'
            self.last_inject_time_mono = time.monotonic()
            self.last_injected_sender = sender
            self.last_injected_was_mentioned = is_mentioned
            self.last_injected_source_channel = cross_channel_source_id(content)
            self.broadcast_activity('working', force=True)  # Always broadcast on inject — dedup skip hides state changes
            if self._prepared_enter:
                self._message_event.set()  # the poll thread sends its Enter on the next pass

            return True
        except Exception as e:
            debug(f"Inject error: {e}")
            self.is_processing = False
            return False

    def _process_idle_messages(self, messages):
        """Inject idle-delivery messages — shared by the slow-poll drain and the
        fast idle-drain so the two paths can never diverge. Downloads images,
        filters own/system messages, dedups under _dedup_lock, injects ONE
        message then batch-appends the rest into the input buffer.

        MUST be called only from the poll thread (CJack guardrail:
        poll-thread-only injection keeps the check->inject->track window safe)."""
        for msg in messages:
            msg_id = msg.get("id")
            sender = msg.get("from", {}).get("name", "Unknown")
            content = msg.get("content", "")
            sender_id = msg.get("from", {}).get("id", "")
            reply_to = msg.get("replyTo")  # Reply context if present
            mentions = msg.get("mentions", [])  # List of mentioned IDs/names

            # Download images to /tmp/ so agents can view them with Read tool
            image_urls = msg.get("metadata", {}).get("imageUrls", [])
            if image_urls:
                img_lines = []
                for url in image_urls:
                    local_path = download_collab_image(url)
                    if local_path:
                        # Detect file type for appropriate label
                        ext = local_path.rsplit(".", 1)[-1].lower() if "." in local_path else ""
                        if ext in ("md", "txt", "json", "ts", "tsx", "js", "css", "py", "sh"):
                            img_lines.append(f"[Attached file: {local_path}]")
                        else:
                            img_lines.append(f"[Image: {local_path}]")
                    else:
                        img_lines.append(f"[ATTACHMENT FAILED TO DOWNLOAD: {url}]")
                url_text = "\n".join(img_lines)
                content = f"{content}\n{url_text}" if content else url_text

            # Skip already-injected messages (prevents duplicates)
            with self._dedup_lock:
                if msg_id and msg_id in self.injected_message_ids:
                    debug(f"Skipping already-injected message: {msg_id[:8]}...")
                    continue

            # Skip own messages
            if sender_id == self.participant_id:
                continue
            # Allow system messages only if they mention us (e.g. keep-alive pings)
            if sender_id == "system" and self.participant_id not in mentions:
                continue

            # Only inject ONE message per cycle, wait for it to be submitted
            msg_ts = msg.get("timestamp")
            if self.inject_message(sender, content, reply_to, mentions, channel_id=self.channel_id, msg_timestamp=msg_ts, msg_id=msg_id):
                if msg_id:
                    self._inject_retry_counts.pop(msg_id, None)  # Clear retry state on success
                    self._track_injected_id(msg_id)
                    # Track for delivery timeout detection
                    self.last_injected_msg_id = msg_id
                    self.delivery_timeout_logged = False
                    # Log delivered event (non-blocking)
                    self.log_delivery_event(msg_id, "delivered")
                # Cursor advancement deferred to JSONL verification
                # success (Sprint 50 T1). Do NOT advance here.
                # mark_read deferred to after Claude finishes processing
                # (see is_processing=False block). This prevents phantom reads
                # where lastRead advances past messages Claude never handled.
                self.pending_mark_read = True
                self.pending_mark_read_timestamp = msg_ts
                # Drain remaining queued messages into the input buffer.
                # inject_message() will APPEND them (pending_enter is now True).
                # This batches multiple messages into one submission.
                batch_count = 0
                while not self.sse_message_queue.empty() and batch_count < 20:
                    try:
                        next_msg = self.sse_message_queue.get_nowait()
                    except queue.Empty:
                        break
                    next_id = next_msg.get("id")
                    next_sender_id = next_msg.get("from", {}).get("id", "")
                    if next_sender_id == self.participant_id:
                        continue
                    with self._dedup_lock:
                        if next_id and next_id in self.injected_message_ids:
                            continue
                    next_sender = next_msg.get("from", {}).get("name", "Unknown")
                    next_content = next_msg.get("content", "")
                    next_reply = next_msg.get("replyTo")
                    next_mentions = next_msg.get("mentions", [])
                    next_ts = next_msg.get("timestamp")
                    if self.inject_message(next_sender, next_content, next_reply, next_mentions, channel_id=self.channel_id, msg_timestamp=next_ts, msg_id=next_id):
                        if next_id:
                            self._inject_retry_counts.pop(next_id, None)
                            self._track_injected_id(next_id)
                            self.log_delivery_event(next_id, "delivered")
                        self.pending_mark_read_timestamp = next_ts
                        batch_count += 1
                        debug(f"Batch append {batch_count}: {next_sender}")
                    else:
                        self._requeue_failed_inject(next_msg)
                if batch_count > 0:
                    debug(f"Batched {batch_count} additional message(s) into input buffer")
                break  # All queued messages processed
            else:
                # tmux send failed — schedule retry instead of waiting for the
                # 120s inbox backstop (fresh-session dead-air fix)
                self._requeue_failed_inject(msg)

    def check_pending_enter(self):
        """Check if we should send the deferred Enter key

        Only sends Enter if:
        1. There's a pending Enter from inject_message()
        2. Claude has been idle (no output) for enter_idle_threshold seconds
        3. At least 0.2s has passed since text was sent (minimum delay)
        """
        with self._enter_lock:
            if not self.pending_enter:
                return False

            if not self.child or not self.child.isalive():
                # Child died before Enter was sent — message text is lost from the buffer.
                # Remove from dedup set so it can be re-delivered after Claude respawns.
                if self.last_injected_msg_id and self.last_injected_msg_id in self.injected_message_ids:
                    self._untrack_injected_id(self.last_injected_msg_id)
                    debug(f"Removed {self.last_injected_msg_id[:8]} from injected_message_ids (child died before Enter)")
                    self.log_delivery_failure(self.last_injected_msg_id, "child_died")
                # Rewind poll cursor so catch-up polling returns the lost message
                if self.pending_mark_read_timestamp:
                    from datetime import datetime, timezone as _tz_recovery
                    try:
                        ts = datetime.fromisoformat(self.pending_mark_read_timestamp.replace('Z', '+00:00'))
                        rewound = datetime.fromtimestamp(ts.timestamp() - 1, tz=_tz_recovery.utc)
                        self.last_poll_time = rewound.strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
                        debug(f"Rewound last_poll_time to {self.last_poll_time} for message recovery")
                    except Exception:
                        pass  # Fallback: existing last_poll_time is close enough
                self.pending_enter = False
                self.pending_mark_read = False
                self.pending_mark_read_timestamp = None
                self._prepared_submitted = []  # lost with the buffer; a re-delivery reads the saved packet
                self._prepared_enter = False
                return False

            time_since_inject = time.time() - self.pending_enter_time
            time_since_output = time.time() - self.last_output_time if self.last_output_time > 0 else float('inf')
            prompt = self._prepared_enter  # a prepared hearing paste into an idle agent

            # Minimum delay after sending text
            if time_since_inject < 0.2 and not prompt:
                return False

            # Check if Claude is idle (no output for threshold)
            # Also send if we've waited too long (5s max) to prevent stuck messages
            max_wait = 5.0
            if prompt or time_since_output >= self.enter_idle_threshold or time_since_inject >= max_wait:
                try:
                    debug(f"Sending deferred Enter (idle: {time_since_output:.2f}s, waited: {time_since_inject:.2f}s, prepared at once: {prompt})")
                    if self._tmux_send('', enter=True):  # Thread-safe Enter via tmux (Task 2)
                        self._stamp_prepared()
                    self.pending_enter = False
                    self._prepared_enter = False
                    # Start JSONL ingestion verification (Sprint 45 T2.1)
                    transcript = self._resolve_transcript()
                    # A verify still pending here was extended through a long busy
                    # turn and is about to be replaced. Last look, then record it as
                    # a delivery failure instead of dropping it silently (Jack/SEO
                    # Engine 2026-09-28). No re-inject: that caused fleet duplicates.
                    if self._verify_pending and not self.check_verify_ingestion() and self._verify_pending:
                        old_id = self._verify_msg_id
                        self._verify_pending = False
                        debug(f"JSONL VERIFY: superseded unconfirmed on msg {str(old_id)[:8]} — logging failure")
                        self.log_delivery_failure(old_id, 'jsonl_verify_superseded_unconfirmed',
                                                  elapsed_ms=int((time.time() - self._verify_start_time) * 1000))
                    if transcript:
                        try:
                            self._verify_after_byte = os.path.getsize(transcript)
                        except OSError:
                            self._verify_after_byte = 0
                        self._verify_transcript = transcript
                        self._verify_search_text = f'[Channel message from {self.last_injected_sender}' if self.last_injected_sender else None
                        self._verify_start_time = time.time()
                        self._verify_msg_id = self.last_injected_msg_id
                        self._verify_deferred_while_busy = False  # reset per new verify
                        self._verify_msg_ts = self.pending_mark_read_timestamp
                        self._verify_pending = bool(self._verify_search_text)
                        if self._verify_pending:
                            debug(f"JSONL verify: started (searching for {self._verify_search_text!r} after byte {self._verify_after_byte})")
                    return True
                except Exception as e:
                    debug(f"Error sending deferred Enter: {e}")
                    # Enter failed — remove from dedup for re-delivery
                    if self.last_injected_msg_id and self.last_injected_msg_id in self.injected_message_ids:
                        self._untrack_injected_id(self.last_injected_msg_id)
                        debug(f"Removed {self.last_injected_msg_id[:8]} from injected_message_ids (Enter failed)")
                    self.pending_enter = False
                    self._prepared_submitted = []  # ingestion uncertain: never stamped
                    self._prepared_enter = False
                    return False

            return False

    def check_jsonl_processing_start(self):
        """Detect processing that started outside inject_message() via JSONL ground truth.

        If is_processing=False but JSONL shows tool_use, Claude is actively working
        on something (compaction, skill, direct input). Transition to processing state.
        """
        if self.is_processing or not self.joined:
            return

        jsonl_state = self._check_jsonl_state()
        if jsonl_state == 'tool_use':
            debug("JSONL processing detected (non-inject source) — setting is_processing=True")
            self.is_processing = True
            self.last_output_time = time.time()
            self.output_seen_since_inject = False
            self.idle_since = 0
            self.broadcast_activity('working', force=True)

    def send_corrective_reminder(self):
        """Send a corrective re-injection reminder when agent responded in terminal only.

        Serialized under _enter_lock to prevent clobbering pending inject text.
        Skipped entirely if pending_enter is True (message still being delivered).
        """
        if not self.child or not self.child.isalive():
            return
        if not self.last_injected_was_mentioned or not self.last_injected_sender:
            return
        # One corrective per delivery. Every later idle transition re-checks the
        # same delivery, so without this an agent that answers the corrective in
        # the terminal is nagged again after every turn (Jack, 26 Sep 2026).
        if self._corrective_sent_for_current_delivery():
            debug("Corrective reminder suppressed — already sent once for this delivery")
            return

        with self._enter_lock:
            if self.pending_enter:
                debug("Corrective reminder skipped — pending_enter is True (inject in progress)")
                return
            reminder = (
                f"[SYSTEM: The wrapper detected 0 channel posts from you this turn. If you meant to reply to "
                f"@{self.last_injected_sender}, it was NOT sent — terminal output is invisible to the channel "
                f"and to {self.last_injected_sender}. Re-send via: collab_helper.py --to <Name> --stdin with a "
                f"single-quoted heredoc. Never put response text in a quoted shell argument. If no reply is "
                f"needed, send nothing and end your response with a line containing only {NO_REPLY_MARKER}.]"
            )
            self._tmux_send(reminder)
            self._tmux_send('', enter=True)
            self._corrective_sent_inject_mono = self.last_inject_time_mono
        debug("Corrective re-injection sent for terminal-only @mention response")

    def _corrective_sent_for_current_delivery(self):
        sent_for = getattr(self, '_corrective_sent_inject_mono', None)
        return sent_for is not None and sent_for == self.last_inject_time_mono

    def check_verify_ingestion(self):
        """Poll the JSONL transcript to confirm message ingestion.

        Returns True if ingestion confirmed, False otherwise.

        Sprint 51 T2: jsonl verifier timeouts are false-positives — Jack's audit
        2026-04-18 found 22/22 timeout-flagged messages actually delivered. On
        timeout we now log once for telemetry and move on. We do NOT remove the
        message from injected_message_ids (would cause duplicate injection) and
        do NOT rewind last_poll_time (same). Real-loss reasons (tmux_send_failed,
        child_died) are logged elsewhere with their own retry semantics.
        """
        if not self._verify_pending:
            return False

        elapsed = time.time() - self._verify_start_time
        transcript = self._resolve_transcript()

        if transcript and self._verify_search_text:
            if verify_message_ingested(transcript, self._verify_search_text, self._verify_offset_for(transcript)):
                debug(f"JSONL VERIFY: SUCCESS — message confirmed in transcript ({elapsed:.1f}s after Enter)")
                self._verify_pending = False
                self._retry_attempts.pop(self._verify_msg_id, None)
                # Advance cursor only after verified ingestion (Sprint 50 T1)
                if self._verify_msg_ts:
                    self.last_poll_time = self._verify_msg_ts
                    self._save_cursor_timestamp(self._verify_msg_ts)
                    debug(f"Cursor advanced to {self._verify_msg_ts} (verified)")
                self.log_delivery_event(self._verify_msg_id, 'delivered', {
                    'verifiedVia': 'jsonl_ingestion',
                    'verifyElapsedMs': int(elapsed * 1000),
                })
                return True

        if elapsed >= self._verify_timeout:
            msg_id = self._verify_msg_id
            # Still mid-turn: extend the window so verify can still SUCCEED (and advance the
            # cursor) once the agent finishes processing. No re-inject either way.
            if self.is_processing:
                self._verify_start_time = time.time()  # extend window; re-check next cycle
                return False
            # PANE-CAPTURE IS THE DELIVERY AUTHORITY (2026-06-04, CJack + Reynolds).
            # On a verify timeout we do NOT un-dedup, rewind, or re-inject. The message text was
            # placed in the terminal at inject — _tmux_send succeeded, and a failed send is caught
            # right there (log_delivery_failure 'tmux_send_failed') and never reaches verify — so
            # the message IS delivered; the agent processes it when it is ready. JSONL verify is
            # TELEMETRY ONLY: it false-negatives delivered messages three ways —
            #   (a) after_byte is snapshotted at Enter, the same instant Claude writes the user
            #       turn, so the search window can start PAST the message;
            #   (b) the transcript rotates (compaction/resume) and the old byte offset is meaningless;
            #   (c) slow / startup processing writes the user turn after the 30s window.
            # Re-injecting on those false-negatives re-delivered already-processed messages — the
            # fleet-wide duplicates the owner hit (busy 3x AND idle, the common case; idle proven on
            # 2722573 — IDLEVERIFY1 re-injected though the agent replied 'ack'). Genuine loss is
            # handled at the source (tmux_send-failure + child-died recovery); read-flag
            # correctness for a never-injected message is owned by the inbox/hook layer.
            self._verify_pending = False
            if msg_id:
                self._retry_attempts.pop(msg_id, None)
            debug(f"JSONL VERIFY: timeout {elapsed:.1f}s on msg {str(msg_id)[:8]} — NOT re-injecting (pane-delivered; verify is telemetry-only)")
            self.log_delivery_failure(msg_id, 'jsonl_verify_timeout_noreinject', elapsed_ms=int(elapsed * 1000))
            return False

        return False

    def watchdog_loop(self):
        """Independent watchdog thread — catches stuck Enter states.

        Runs independently of the poll thread. If pending_enter has been
        True for over 15 seconds, force-sends Enter. This handles edge cases
        where the poll thread's check_pending_enter() fails silently.
        """
        debug("Watchdog thread started")
        while self.running:
            try:
                with self._enter_lock:
                    if self.pending_enter and self.child and self.child.isalive():
                        elapsed = time.time() - self.pending_enter_time
                        if elapsed > 15:
                            debug(f"WATCHDOG: Pending Enter stuck for {elapsed:.1f}s — force-sending Enter")
                            try:
                                if self._tmux_send('', enter=True):  # Thread-safe via tmux (Task 2)
                                    self._stamp_prepared()
                                self.pending_enter = False
                                self._prepared_enter = False
                            except Exception as e:
                                debug(f"WATCHDOG: Failed to send Enter: {e}")
                                # Same recovery as check_pending_enter — remove from dedup for re-delivery
                                if self.last_injected_msg_id and self.last_injected_msg_id in self.injected_message_ids:
                                    self._untrack_injected_id(self.last_injected_msg_id)
                                    debug(f"WATCHDOG: Removed {self.last_injected_msg_id[:8]} from injected_message_ids")
                                self.pending_enter = False
            except Exception as e:
                debug(f"WATCHDOG error: {e}")
            time.sleep(5)
        debug("Watchdog thread stopped")

    def sse_listener(self):
        """Background thread: subscribe to SSE for real-time message push.

        Connects to /api/events?types=collab&channelId={id}&participantId={pid} and receives
        collab:message events in real-time (<50ms latency vs 2s polling).
        Falls back to polling after sse_max_failures consecutive failures.
        """
        debug("SSE listener thread started")
        EVENTS_URL = f"{DEVFLOW_URL}/api/events"
        backoff = 1  # seconds, doubles on failure up to 30s

        while self.running:
            if not self.joined or not self.channel_id:
                time.sleep(1)
                continue

            # participantId is REQUIRED: since the 2026-05-18 cross-channel-leak
            # fix, /api/events gates collab events behind canReceiveCollab, which is
            # False unless participantId is present AND channel membership verifies.
            # Omitting it kept the stream open (heartbeats) but silently dropped
            # EVERY real-time collab:message — SSE push was dead fleet-wide, masked
            # by the 120s inbox backstop. (CJack, 2026-06-05)
            url = f"{EVENTS_URL}?types=collab,system&channelId={self.channel_id}&participantId={self.participant_id}"
            headers = {}
            if self.sse_last_event_id:
                headers["Last-Event-ID"] = str(self.sse_last_event_id)

            try:
                req = urllib.request.Request(url, headers=headers)
                resp = urllib.request.urlopen(req, timeout=90)
                self._sse_resp = resp
                self.sse_connected = True
                self.sse_last_data_time = time.time()  # Connection itself counts as data
                was_disconnected = self.sse_reconnect_failures > 0
                was_zombie = self.sse_zombie_kicked
                self.sse_zombie_kicked = False
                self.sse_reconnect_failures = 0
                backoff = 1
                debug(f"SSE connected to {url}{' (after zombie)' if was_zombie else ''}")

                # Catch-up poll on connect/reconnect: fetch any messages missed
                # Runs on BOTH initial connect and reconnect to cover the respawn gap
                if True:  # Always catch up — was_disconnected only covered reconnects
                    debug(f"SSE {'reconnected' if was_disconnected else 'connected'} — running catch-up poll for missed messages")
                    try:
                        if was_zombie:
                            # Zombie reconnect: widen window to last 2 minutes to catch messages
                            # that arrived during the silent period when SSE appeared alive but wasn't.
                            from datetime import datetime, timezone as _tz
                            since_ts = time.time() - 120
                            since_iso = datetime.fromtimestamp(since_ts, tz=_tz.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
                            poll_url = f"{DEVFLOW_URL}/api/collab?channelId={self.channel_id}&participantId={self.participant_id}&since={since_iso}"
                            debug(f"SSE zombie catch-up: using 2-min window since {since_iso}")
                        else:
                            poll_url = f"{DEVFLOW_URL}/api/collab?channelId={self.channel_id}&participantId={self.participant_id}&limit={MAX_CATCHUP_MESSAGES}"
                            # Use lastRead-based since (no time cap) — count cap prevents floods
                            from datetime import datetime, timezone as _tz2
                            try:
                                if self.last_poll_time:
                                    lpt = datetime.fromisoformat(self.last_poll_time.replace('Z', '+00:00'))
                                    since_ts = lpt.timestamp() - 30  # Widen by 30s for boundary
                                    since_iso = datetime.fromtimestamp(since_ts, tz=_tz2.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
                                    poll_url += f"&since={since_iso}"
                                # No last_poll_time: omit since — server returns latest N messages
                            except Exception:
                                if self.last_poll_time:
                                    poll_url += f"&since={self.last_poll_time}"
                        poll_req = urllib.request.Request(poll_url)
                        poll_resp = urllib.request.urlopen(poll_req, timeout=5)
                        poll_data = json.loads(poll_resp.read().decode('utf-8'))
                        catchup_msgs = poll_data.get('messages', [])
                        queued_count = 0
                        # Strict greater-than cutoff against the last_poll_time BEFORE
                        # the 30s boundary widen was applied. The widen is there to
                        # protect against clock precision loss; it must not bring back
                        # messages we've already processed. Without this filter, a
                        # restart with a frozen cursor re-fetches the last handled
                        # message (empty in-memory dedup set can't catch it).
                        cutoff_ts = self.last_poll_time or ''
                        for msg in catchup_msgs:
                            sender_id = msg.get('from', {}).get('id', '')
                            msg_id = msg.get('id')
                            msg_ts = msg.get('timestamp', '') or ''
                            if sender_id == self.participant_id:
                                continue
                            # Strict cursor filter: skip anything at or before the cursor.
                            # ISO 8601 UTC timestamps are lex-comparable.
                            if cutoff_ts and msg_ts and msg_ts <= cutoff_ts:
                                debug(f"SSE catch-up: skipping {msg_id[:8] if msg_id else '?'} (ts {msg_ts} <= cursor {cutoff_ts})")
                                continue
                            # Dedup: skip messages already injected (prevents duplicates on SSE reconnect)
                            with self._dedup_lock:
                                already_seen = msg_id and msg_id in self.injected_message_ids
                            if already_seen:
                                debug(f"SSE catch-up: skipping already-injected {msg_id[:8]}...")
                                continue
                            self.sse_message_queue.put(msg)
                            queued_count += 1
                        if queued_count:
                            debug(f"SSE catch-up: queued {queued_count} missed message(s) (of {len(catchup_msgs)} fetched)")
                    except Exception as ce:
                        debug(f"SSE catch-up poll failed (non-fatal): {ce}")

                # Read SSE stream line-by-line
                event_type = None
                event_data = None
                event_id = None
                buffer = ""

                while self.running:
                    chunk = resp.read(1)
                    if not chunk:
                        debug("SSE stream ended (empty read)")
                        break

                    # Any received byte resets the zombie detection timer
                    self.sse_last_data_time = time.time()

                    char = chunk.decode('utf-8', errors='replace')
                    buffer += char

                    if buffer.endswith('\n'):
                        line = buffer.rstrip('\n')
                        buffer = ""

                        if line == "":
                            # Empty line = end of event
                            if event_type and event_data is not None:
                                self._handle_sse_event(event_type, event_data, event_id)
                            event_type = None
                            event_data = None
                            event_id = None
                        elif line.startswith("event: "):
                            event_type = line[7:]
                        elif line.startswith("data: "):
                            event_data = line[6:]
                        elif line.startswith("id: "):
                            event_id = line[4:]
                            self.sse_last_event_id = event_id
                        elif line.startswith(":"):
                            pass  # SSE comment (server heartbeat ping) — sse_last_data_time already updated above

            except Exception as e:
                debug(f"SSE connection error: {e}")
                was_connected = self.sse_connected
                self.sse_connected = False
                self._sse_resp = None  # Clear so zombie check doesn't try to close a dead socket

                # If we were gracefully notified of restart, use short backoff (server will be back in ~5s)
                if not was_connected and self.sse_reconnect_failures == 0:
                    debug("SSE disconnect after restart notification — reconnecting in 3s")
                    time.sleep(3)
                    continue

                self.sse_reconnect_failures += 1

                if self.sse_reconnect_failures >= self.sse_max_failures:
                    debug(f"SSE failed {self.sse_reconnect_failures} times, falling back to polling")
                    # Stay in fallback mode but keep trying periodically
                    time.sleep(30)
                    self.sse_reconnect_failures = 0  # Reset to try SSE again
                else:
                    time.sleep(min(backoff, 30))
                    backoff = min(backoff * 2, 30)

        self.sse_connected = False
        debug("SSE listener thread stopped")

    def _handle_sse_event(self, event_type, event_data, event_id):
        """Process a received SSE event and queue the message for injection."""
        # Handle graceful server restart — don't count as a failure
        if event_type == "system:restarting":
            debug("SSE received system:restarting — server is rebuilding, will reconnect gracefully")
            self.sse_connected = False
            # Don't increment sse_reconnect_failures — this is expected
            return

        if event_type != "collab:message":
            return
        try:
            data = json.loads(event_data)
            message = data.get("message", {})
            if not message:
                return

            sender_id = message.get("from", {}).get("id", "")

            # Skip own messages
            if sender_id == self.participant_id:
                return

            # Allow system messages only if they mention us (e.g. keep-alive pings)
            if sender_id == "system":
                msg_mentions = message.get("mentions", [])
                if self.participant_id not in msg_mentions:
                    return

            # Check targeted delivery: if message has recipients, only process if we're included
            recipients = message.get("recipients")
            if recipients and self.participant_id not in recipients:
                return  # Message not targeted at us

            # Queue for the poll loop to inject (thread-safe)
            self.sse_message_queue.put(message)
            self._message_event.set()  # Wake poll thread immediately
            debug(f"SSE queued message from {message.get('from', {}).get('name', '?')}: {message.get('content', '')[:50]}")
        except json.JSONDecodeError as e:
            debug(f"SSE JSON parse error: {e}")
        except Exception as e:
            debug(f"SSE event handling error: {e}")

    def poll_channel(self):
        """Background thread: poll for invites and messages

        Uses two timing loops:
        - Fast loop (0.2s): Check for deferred Enter to send
        - Slow loop (POLL_INTERVAL): Check for new messages from API

        When SSE is connected, skips API polling for messages and uses
        the SSE message queue instead (real-time push).
        """
        debug("Poll thread started")
        poll_count = 0
        fast_poll_interval = 0.2  # Check for deferred Enter every 200ms
        slow_poll_counter = 0  # Count fast polls to trigger slow poll
        slow_poll_threshold = int(POLL_INTERVAL / fast_poll_interval)  # ~10 fast polls = 1 slow poll

        while self.running:
            try:
                native = getattr(self, '_native_pump', None)
                if native and native.active():
                    try:
                        native.tick()
                    except Exception as exc:
                        # Remain owned by native transport on every failure.
                        # Log only the class, never prompts, credentials or payloads.
                        native.error = type(exc).__name__
                    self._message_event.wait(0.2)
                    self._message_event.clear()
                    continue
                slow_poll_counter += 1

                # Opt-in advisory wake, also on while this participant has prepared hearing context: a hearing request is
                # then read when the host commits it, not at the next 2-second inbox check (0.3-2.2 s in the 17 October
                # proof). The poll thread alone reads and injects.
                if os.environ.get('DEVFLOW_HEARING_INBOX_WAKEUP') == '1' or self._prepared_flag():
                    from hearing_inbox_wakeup import InboxWakeup
                    inbox_path = self._get_inbox_path() if self.joined and self.participant_id else None
                    watcher = getattr(self, '_inbox_wakeup', None)
                    if watcher and watcher.path != inbox_path:
                        watcher.close()
                        self._inbox_wakeup = watcher = None
                    if inbox_path and not watcher:
                        watcher = InboxWakeup(inbox_path, self._message_event)
                        if watcher.start():
                            self._inbox_wakeup = watcher
                    if watcher and watcher.take():
                        self.check_inbox()
                elif getattr(self, '_inbox_wakeup', None):
                    self._inbox_wakeup.close()  # the prepared flag was removed
                    self._inbox_wakeup = None

                # Fast check: deferred Enter (runs every 200ms)
                self.check_pending_enter()

                # Fast check: hearing connection checks waiting for Claude to be idle (runs every 200ms)
                self._service_connection_acks()

                # Fast check: JSONL ingestion verification (runs every 200ms)
                self.check_verify_ingestion()

                # Fast check: detect processing from non-inject sources via JSONL (runs every 200ms)
                self.check_jsonl_processing_start()

                # Sprint 56 T3: Plan Mode auto-accept (runs every 200ms).
                # Tail JSONL for new ExitPlanMode tool_use / tool_result records,
                # then sweep pending (≥3s → fire '1'+Enter) and accepted
                # (≥10s without tool_result → log failure).
                self._tail_jsonl_for_plan_mode()
                _pm_now = time.monotonic()
                self._check_plan_mode_debounce(_pm_now)
                self._check_plan_mode_accept_timeout(_pm_now)

                # Fast check: drain SSE queue while processing (runs every 200ms)
                # Without this, messages sit in sse_message_queue until idle
                # transition — causing 10-20s delays. Draining here lets
                # inject_message() batch them into the input buffer immediately.
                if (self.is_processing and self.joined and self.child
                        and self.child.isalive() and self.sse_connected):
                    _drained = 0
                    while not self.sse_message_queue.empty() and _drained < 20:
                        try:
                            _qm = self.sse_message_queue.get_nowait()
                        except queue.Empty:
                            break
                        _qm_id = _qm.get("id")
                        _qm_sid = _qm.get("from", {}).get("id", "")
                        if _qm_sid == self.participant_id:
                            continue
                        with self._dedup_lock:
                            if _qm_id and _qm_id in self.injected_message_ids:
                                continue
                        _qm_sender = _qm.get("from", {}).get("name", "Unknown")
                        _qm_content = _qm.get("content", "")
                        _qm_reply = _qm.get("replyTo")
                        _qm_mentions = _qm.get("mentions", [])
                        _qm_ts = _qm.get("timestamp")
                        if self.inject_message(_qm_sender, _qm_content, _qm_reply, _qm_mentions, channel_id=self.channel_id, msg_timestamp=_qm_ts, msg_id=_qm_id):
                            if _qm_id:
                                self._track_injected_id(_qm_id)
                                self.log_delivery_event(_qm_id, "delivered")
                            self.pending_mark_read = True
                            self.pending_mark_read_timestamp = _qm_ts
                            _drained += 1
                    if _drained > 0:
                        debug(f"Fast drain: injected {_drained} message(s) while processing")

                # Fast check: drain SSE queue while ALREADY idle (runs every 200ms /
                # on SSE wake via _message_event). The idle drain in the slow-poll
                # block only fires every POLL_INTERVAL, so a message landing at an
                # already-idle agent sat up to ~2s before injection even though the
                # loop had already woken on arrival. Busy agents got a fast-drain
                # above; this is the missing idle counterpart. Same gates as the
                # slow path (not pending_enter, not is_processing, IDLE_THRESHOLD,
                # dedup, fresh JSONL end_turn) — only the cadence changes. Runs in
                # the poll thread and shares _process_idle_messages with the slow
                # path, so exactly-once + ordering are unchanged (CJack guardrails:
                # poll-thread-only; not-pending_enter is the interleave guard).
                if (self.sse_connected and self.joined and self.child
                        and self.child.isalive() and not self.pending_enter
                        and not self.is_processing
                        and not self.sse_message_queue.empty()):
                    if (time.time() - self.last_keystroke) >= IDLE_THRESHOLD:
                        _fast_idle_state = self._check_jsonl_state()  # FRESH read
                        if _fast_idle_state in ('end_turn', 'max_tokens', None):
                            try:
                                _fast_msgs = [self.sse_message_queue.get_nowait()]
                            except queue.Empty:
                                _fast_msgs = []
                            if _fast_msgs:
                                debug("Fast idle-drain: injecting on arrival (no slow-poll wait)")
                                self._process_idle_messages(_fast_msgs)

                # Deferred terminal-only check for replies that went idle <30s
                # after delivery. Runs once, only if still idle and no newer
                # message was injected in between.
                _dci = getattr(self, '_deferred_corrective_inject', None)
                if _dci and not self.is_processing and time.monotonic() - _dci >= 30:
                    self._deferred_corrective_inject = None
                    if self.last_inject_time_mono == _dci and self.last_injected_sender:
                        if self._agent_responded_since_last_inject():
                            debug("Deferred corrective check: agent replied in channel — nothing to do")
                        else:
                            _t = self._resolve_transcript()
                            if _t and final_response_disposition(_t, self._verify_offset_for(_t)) == TURN_EMPTY:
                                debug("Deferred corrective check: deliberate silence — no corrective")
                            else:
                                debug(f"WARNING: Terminal-only response (deferred check) — no collab reply to {self.last_injected_sender}")
                                self.send_corrective_reminder()

                # Fast check: idle transition detection (runs every 200ms)
                # Detects when agent finishes processing and immediately drains
                # the SSE queue — eliminates the 2s slow-poll lag.
                if self.is_processing and self.last_output_time > 0:
                    _now = time.time()
                    _silence = _now - self.last_output_time
                    _threshold = self.activity_idle_threshold if self.output_seen_since_inject else self.initial_idle_threshold
                    if _silence >= _threshold and not self.is_process_tree_active():
                        # Check JSONL ground truth before declaring idle
                        _jsonl_state = self._check_jsonl_state()
                        if _jsonl_state == 'tool_use':
                            # Agent is in a tool call — NOT idle despite silence+CPU
                            self._jsonl_check_count += 1
                            if self._jsonl_check_count % 25 == 1:  # Log every 25th check (~5s at 200ms)
                                debug(f"JSONL override: stop_reason=tool_use, suppressing idle transition ({_silence:.1f}s silence)")
                            continue
                        # jsonl_state is 'end_turn', 'max_tokens', or None — proceed with idle transition
                        if _jsonl_state:
                            debug(f"JSONL confirms idle: stop_reason={_jsonl_state} ({_silence:.1f}s silence)")
                        self._jsonl_check_count = 0
                        # Silent AND CPU idle — truly done
                        self.is_processing = False
                        self.idle_since = _now
                        self.broadcast_activity('idle')
                        debug(f"Fast idle transition: {_silence:.1f}s silence, CPU idle")
                        # Deferred mark_read
                        if self.pending_mark_read:
                            if self.pending_mark_read_timestamp:
                                self.mark_read(message_timestamp=self.pending_mark_read_timestamp)
                                debug("Deferred mark_read executed (processing complete)")
                                # Advance durable cursor to mark_read timestamp so a
                                # restart after idle does not re-fetch the already-handled
                                # message. Cursor was previously only advanced on inject,
                                # which left it frozen on the last inbound message when no
                                # newer traffic arrived before the session died.
                                self._save_cursor_timestamp(self.pending_mark_read_timestamp)
                            else:
                                debug("Skipped mark_read — no message timestamp (prevents mark-all-as-read fallback)")
                            self.pending_mark_read = False
                            self.pending_mark_read_timestamp = None
                        # Terminal-only response detection + corrective re-injection.
                        # DETERMINISTIC CHECK: Read the channel JSON file and look for any
                        # message from this agent's participant_id with timestamp >= the
                        # most recent inject. This replaces the old TUI string-parsing
                        # detection (looking for "Bash(" + "collab_helper" in the pty
                        # stream), which produced false positives because Claude Code's
                        # Ink TUI never emits the literal tool-call name as contiguous
                        # text in the output stream — it redraws the screen with ANSI
                        # escapes and partial line updates.
                        agent_responded = self._agent_responded_since_last_inject()
                        # Minimum processing time guard: don't fire corrective if agent
                        # has been processing for less than 30s. Opus (and complex messages
                        # with file attachments) have natural 3-5s pauses between tool calls
                        # that look like idle to the CPU/silence detectors. Firing the
                        # corrective during these pauses interrupts real work and causes
                        # the agent to re-send its PREVIOUS answer instead of finishing
                        # the current one. 30s gives enough time for the agent to actually
                        # process and respond — premature correctives are worse than delayed
                        # correctives because they cause duplicate messages.
                        _time_since_inject = time.monotonic() - self.last_inject_time_mono if self.last_inject_time_mono else 999
                        if not agent_responded and self.last_injected_sender and _time_since_inject < 30:
                            debug(f"Suppressed premature corrective: only {_time_since_inject:.1f}s since inject (need 30s). Re-checking at 30s.")
                            # A fast terminal-only reply went idle before 30s and was
                            # never re-checked (Woolsey, 25 Sep 2026: replied in the
                            # terminal only, forever). Defer instead of dropping.
                            self._deferred_corrective_inject = self.last_inject_time_mono
                        # No channel post is two different situations, not one:
                        # the reply went to the terminal (recoverable — warn), or
                        # the agent deliberately said nothing (correct — close
                        # quietly). Only the transcript can tell them apart, and
                        # only for the turn that started at this delivery.
                        _silent_turn = False
                        if not agent_responded and self.last_injected_sender and _time_since_inject >= 30:
                            _t = self._resolve_transcript()
                            _disposition = (
                                final_response_disposition(_t, self._verify_offset_for(_t)) if _t else None
                            )
                            # Unknown is not silence. Anything other than proven
                            # emptiness keeps the warning, so a real lost reply is
                            # never swallowed by a missing or stale transcript.
                            _silent_turn = _disposition == TURN_EMPTY
                            if _silent_turn:
                                debug(
                                    "Deliberate silence: turn completed with an empty final "
                                    f"response after byte {self._verify_after_byte} — closing without a corrective"
                                )
                        if (not agent_responded and not _silent_turn and self.last_injected_sender
                                and _time_since_inject >= 30
                                and not self._corrective_sent_for_current_delivery()):
                            debug(f"WARNING: Terminal-only response — processed message from {self.last_injected_sender} but no collab post detected in channel file")
                            # If the message was a direct @mention, re-inject a reminder
                            # so the agent knows its response didn't reach the channel
                            self.send_corrective_reminder()
                            try:
                                import urllib.request as urllib_req
                                warn_data = json.dumps({
                                    "source": "agent",
                                    "severity": "medium",
                                    "title": f"{self.participant_name or 'Agent'} responded in terminal only (no collab reply to {self.last_injected_sender})",
                                    "metadata": {
                                        "event": "terminal-only-response",
                                        "agentName": self.participant_name,
                                        "channelId": self.channel_id,
                                        "triggeredBy": self.last_injected_sender
                                    }
                                }).encode('utf-8')
                                warn_req = urllib_req.Request(
                                    f"{DEVFLOW_URL}/api/logs",
                                    data=warn_data,
                                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ.get('DEVFLOW_API_TOKEN', '')}"},
                                    method="POST"
                                )
                                urllib_req.urlopen(warn_req, timeout=3)
                            except Exception:
                                pass  # Non-fatal — best-effort warning
                        # Immediate SSE queue drain — inject waiting messages NOW
                        if (self.joined and self.child and self.child.isalive()
                                and not self.pending_enter):
                            idle_time = _now - self.last_keystroke
                            if idle_time >= IDLE_THRESHOLD and self.sse_connected:
                                try:
                                    _msg = self.sse_message_queue.get_nowait()
                                    _msg_id = _msg.get("id")
                                    _sender_id = _msg.get("from", {}).get("id", "")
                                    _sender = _msg.get("from", {}).get("name", "Unknown")
                                    _content = _msg.get("content", "")
                                    _reply = _msg.get("replyTo")
                                    _mentions = _msg.get("mentions", [])
                                    _skip = False
                                    if _sender_id == self.participant_id:
                                        _skip = True
                                    if not _skip:
                                        with self._dedup_lock:
                                            if _msg_id and _msg_id in self.injected_message_ids:
                                                _skip = True
                                    if not _skip:
                                        _ts = _msg.get("timestamp")
                                        if self.inject_message(_sender, _content, _reply, _mentions, channel_id=self.channel_id, msg_timestamp=_ts, msg_id=_msg_id):
                                            if _msg_id:
                                                self._inject_retry_counts.pop(_msg_id, None)
                                                self._track_injected_id(_msg_id)
                                                self.last_injected_msg_id = _msg_id
                                                self.delivery_timeout_logged = False
                                                self.log_delivery_event(_msg_id, "delivered")
                                            self.pending_mark_read = True
                                            self.pending_mark_read_timestamp = _ts
                                            debug("Immediate inject after idle transition")
                                            # Batch remaining
                                            _bc = 0
                                            while not self.sse_message_queue.empty() and _bc < 20:
                                                try:
                                                    _nm = self.sse_message_queue.get_nowait()
                                                except queue.Empty:
                                                    break
                                                _nid = _nm.get("id")
                                                _nsid = _nm.get("from", {}).get("id", "")
                                                if _nsid == self.participant_id:
                                                    continue
                                                with self._dedup_lock:
                                                    if _nid and _nid in self.injected_message_ids:
                                                        continue
                                                _ns = _nm.get("from", {}).get("name", "Unknown")
                                                _nc = _nm.get("content", "")
                                                _nr = _nm.get("replyTo")
                                                _nme = _nm.get("mentions", [])
                                                _nts = _nm.get("timestamp")
                                                if self.inject_message(_ns, _nc, _nr, _nme, channel_id=self.channel_id, msg_timestamp=_nts, msg_id=_nid):
                                                    if _nid:
                                                        self._inject_retry_counts.pop(_nid, None)
                                                        self._track_injected_id(_nid)
                                                        self.log_delivery_event(_nid, "delivered")
                                                    self.pending_mark_read_timestamp = _nts
                                                    _bc += 1
                                                else:
                                                    self._requeue_failed_inject(_nm)
                                            if _bc > 0:
                                                debug(f"Batched {_bc} additional message(s) after idle transition")
                                        else:
                                            self._requeue_failed_inject(_msg)
                                except queue.Empty:
                                    pass  # No messages waiting

                # Slow check: API operations (runs every POLL_INTERVAL)
                if slow_poll_counter >= slow_poll_threshold:
                    slow_poll_counter = 0
                    poll_count += 1

                    # Re-queue failed injects whose backoff has elapsed
                    self._drain_inject_retries()

                    # Always check for invites - handles both initial join and rejoin after kick
                    invite = self.check_for_invite()
                    if invite:
                        invite_channel = invite.get("channelId")
                        invite_name = invite.get("channelName")
                        # If already joined same channel, this is a rejoin after kick
                        if self.joined and invite_channel == self.channel_id:
                            debug("Rejoin invite detected - was likely kicked")
                            self.joined = False  # Reset so join_channel works properly
                        # If visiting and invited back to home, treat as return
                        elif self.visiting and invite_channel == self.home_channel_id:
                            debug("Invited back to home channel — returning")
                            self.return_to_home_channel()
                            continue
                        # If already in a channel, leave before visiting the new one
                        elif self.joined and invite_channel != self.channel_id:
                            debug(f"Leaving {self.channel_id[:8]} to visit {invite_channel[:8]}")
                            self.leave_channel()
                            self.joined = False
                        self.join_channel(invite_channel, invite_name, force=invite.get("force", False))

                    # Periodically sync name from ready file (every ~10 seconds / 5 polls)
                    # This handles the case where /register-session is called after joining
                    if poll_count % 5 == 0:
                        self.sync_name_from_ready_file()

                    # Periodic stale file cleanup (every ~60 seconds / 30 polls)
                    # Prevents accumulation of dead session files from crashed agents
                    if poll_count % 30 == 0:
                        self.cleanup_stale_sessions()

                    # Periodic SSE catch-up poll (every ~120 seconds / 60 polls)
                    # Only runs when SSE is NOT connected — SSE catch-up on reconnect
                    # handles the healthy case. This is a fallback for when SSE has failed
                    # completely. Dedup via injected_message_ids.
                    if poll_count % 60 == 0 and self.joined and self.channel_id and not self.sse_connected:
                        try:
                            catchup_since = self.last_poll_time
                            from datetime import datetime as _dt, timedelta as _td
                            if catchup_since:
                                # Widen window by 30s to catch boundary messages (no time cap)
                                try:
                                    lpt = _dt.fromisoformat(catchup_since.replace('Z', '+00:00'))
                                    lpt_adjusted = lpt - _td(seconds=30)
                                    catchup_since = lpt_adjusted.strftime('%Y-%m-%dT%H:%M:%SZ')
                                except Exception:
                                    pass  # Use raw value on parse failure
                            catchup_url = (
                                f"{DEVFLOW_URL}/api/collab"
                                f"?channelId={self.channel_id}"
                                f"&participantId={self.participant_id}"
                                f"&limit={MAX_CATCHUP_MESSAGES}"
                            )
                            if catchup_since:
                                catchup_url += f"&since={catchup_since}"
                            cu_resp = urllib.request.urlopen(
                                urllib.request.Request(catchup_url), timeout=5
                            )
                            cu_data = json.loads(cu_resp.read().decode('utf-8'))
                            queued = 0
                            latest_ts = None
                            for cu_msg in cu_data.get('messages', []):
                                cu_id = cu_msg.get('id')
                                with self._dedup_lock:
                                    cu_already_seen = cu_id and cu_id in self.injected_message_ids
                                if cu_already_seen:
                                    continue
                                cu_sender_id = cu_msg.get('from', {}).get('id', '')
                                if cu_sender_id == self.participant_id:
                                    continue
                                # Respect targeted delivery
                                cu_recipients = cu_msg.get('recipients')
                                if cu_recipients and self.participant_id not in cu_recipients:
                                    continue
                                self.sse_message_queue.put(cu_msg)
                                queued += 1
                                # Track latest message timestamp for poll cursor advancement
                                cu_ts = cu_msg.get('timestamp')
                                if cu_ts and (latest_ts is None or cu_ts > latest_ts):
                                    latest_ts = cu_ts
                            if queued:
                                debug(f"Periodic catch-up queued {queued} missed message(s)")
                            # Advance poll cursor to latest message seen — prevents
                            # re-fetching the same window every 60s. Without this,
                            # last_poll_time only advances on idle (deferred mark_read),
                            # causing infinite re-queue during message floods.
                            all_msgs = cu_data.get('messages', [])
                            if all_msgs:
                                newest_ts = max((m.get('timestamp', '') for m in all_msgs), default=None)
                                if newest_ts and (not self.last_poll_time or newest_ts > self.last_poll_time):
                                    self.last_poll_time = newest_ts
                                    debug(f"Periodic catch-up advanced poll cursor to {newest_ts}")
                        except Exception as cu_e:
                            debug(f"Periodic catch-up poll failed (non-fatal): {cu_e}")

                    # Inbox catch-up — runs EVERY slow-poll (~2s), same rhythm as
                    # check_for_invite above (which already hits the API here, so an
                    # extra small local-file read is negligible). Was gated at
                    # poll_count % 60 (~120s), but the inbox is the safety net that
                    # catches messages SSE silently drops — and measurement showed SSE
                    # drops ~75% of deliveries, so the inbox is the DOMINANT path, not a
                    # rare backstop. A 120s recovery on the common path was the real
                    # source of felt delivery lag. check_inbox dedups via
                    # injected_message_ids, so racing the SSE leg cannot double-inject.
                    if self.joined and self.participant_id:
                        try:
                            self.check_inbox()
                        except Exception as inbox_e:
                            debug(f"Periodic inbox check failed (non-fatal): {inbox_e}")


                    # Visit timeout: auto-return to home channel after idle period
                    if self.visiting and self.visit_start_time > 0 and not self.is_processing:
                        visit_elapsed = time.time() - self.visit_start_time
                        idle_time = time.time() - max(self.last_output_time, self.last_keystroke)
                        if visit_elapsed >= self.visit_timeout and idle_time >= 30:
                            debug(f"Visit timeout ({self.visit_timeout}s elapsed, {idle_time:.0f}s idle) — returning home")
                            self.return_to_home_channel()

                    # Activity status management
                    now = time.time()
                    time_since_heartbeat = now - self.last_heartbeat_time if self.last_heartbeat_time > 0 else float('inf')

                    # Delivery timeout: if 60s since inject and no output at all, log warning
                    if (self.last_injected_msg_id and not self.delivery_timeout_logged
                            and self.pending_enter_time > 0
                            and (now - self.pending_enter_time) >= 60
                            and self.last_output_time <= self.pending_enter_time):
                        self.delivery_timeout_logged = True
                        elapsed = int((now - self.pending_enter_time) * 1000)
                        self.log_delivery_failure(
                            self.last_injected_msg_id,
                            "injection_timeout",
                            elapsed_ms=elapsed,
                        )

                    # Idle transition is handled in the fast poll (200ms) above.
                    # Slow poll only handles heartbeats for activity status.
                    if self.is_processing and self.last_output_time > 0:
                        if time_since_heartbeat >= self.heartbeat_interval:
                            self.broadcast_activity(self.current_activity, force=True)
                    elif self.joined and time_since_heartbeat >= self.idle_heartbeat_interval:
                        # Periodic idle heartbeat — keeps lastSeen fresh so agent doesn't appear offline
                        self.broadcast_activity('idle', force=True)

                    # SSE zombie detection — server sends `: heartbeat` every 10s.
                    # If we believe we're connected but haven't received any bytes in
                    # SSE_ZOMBIE_THRESHOLD_S seconds, force-close the socket so the SSE
                    # thread breaks out of its blocking read and reconnects.
                    SSE_ZOMBIE_THRESHOLD_S = 30  # 3x the server heartbeat interval (10s)
                    if (self.sse_connected and
                            self.sse_last_data_time > 0 and
                            time.time() - self.sse_last_data_time > SSE_ZOMBIE_THRESHOLD_S and
                            self._sse_resp is not None):
                        silent_secs = time.time() - self.sse_last_data_time
                        debug(f"SSE zombie detected: no data for {silent_secs:.0f}s — force-closing socket for reconnect")
                        self.sse_zombie_kicked = True
                        self.sse_connected = False
                        self.sse_last_data_time = 0
                        resp_to_close = self._sse_resp
                        self._sse_resp = None
                        try:
                            resp_to_close.close()
                        except Exception:
                            pass

                    # Check for messages (only if idle — no pending Enter AND not actively generating)
                    # Bug fix: pending_enter goes False after Enter is sent, but is_processing stays
                    # True while Claude generates a response. Injecting text during active generation
                    # sends it to the PTY buffer where Ink's output rendering swallows it silently.
                    if self.joined and self.child and self.child.isalive() and not self.pending_enter and not self.is_processing:
                        idle_time = time.time() - self.last_keystroke
                        if idle_time >= IDLE_THRESHOLD:
                            # Get messages from SSE queue (real-time) or fall back to polling
                            messages = []
                            if self.sse_connected:
                                # Pop ONE message per poll cycle — remaining stay queued for next cycle.
                                # Drain-all-process-one would lose queued messages silently.
                                try:
                                    messages = [self.sse_message_queue.get_nowait()]
                                except queue.Empty:
                                    messages = []
                            else:
                                # SSE not connected — fall back to API polling
                                messages = self.check_messages()

                            self._process_idle_messages(messages)

                    # Check forwarding queue for cross-channel messages (every slow poll)
                    if self.joined and self.child and self.child.isalive() and not self.pending_enter and not self.is_processing:
                        self.check_forward_queue()

            except Exception as e:
                debug(f"Poll error: {e}\n{__import__('traceback').format_exc()}")

            # Wait for next cycle — wakes early if SSE pushes a new message
            self._message_event.wait(timeout=fast_poll_interval)
            self._message_event.clear()
        watcher = getattr(self, '_inbox_wakeup', None)
        if watcher:
            watcher.close()
        debug("Poll thread stopped")

    def run(self):
        # Load ownership before any poll/inbox thread can inject, even on opt-out.
        from claude_mod_delivery import make_pump
        self._native_pump = make_pump(self, os.environ)
        # Find Claude binary
        if not os.path.exists(CLAUDE_BINARY):
            print(f"\033[31mError: Claude not found at {CLAUDE_BINARY}\033[0m", file=sys.stderr)
            return 1

        _use_stored_api_key()
        debug(f"Starting Claude: {CLAUDE_BINARY} {self.claude_args}")

        # Disable auto-updater: agents spawning simultaneously all trigger update
        # checks, causing a thundering herd on the network + CPU. Updates should
        # be done manually via `claude update` when no agents are running.
        os.environ.setdefault('DISABLE_AUTOUPDATER', '1')

        # Inject OTEL telemetry env vars so Claude Code reports to TokenPulse.
        # pexpect.spawn inherits os.environ, so setting here is sufficient.
        # Use setdefault so we don't override vars already exported by the shell.
        os.environ.setdefault('CLAUDE_CODE_ENABLE_TELEMETRY', '1')
        os.environ.setdefault('OTEL_METRICS_EXPORTER', 'otlp')
        os.environ.setdefault('OTEL_LOGS_EXPORTER', 'otlp')
        os.environ.setdefault('OTEL_EXPORTER_OTLP_PROTOCOL', 'grpc')
        os.environ.setdefault('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4317')
        os.environ.setdefault('OTEL_LOG_TOOL_DETAILS', '1')
        os.environ.setdefault('OTEL_METRICS_INCLUDE_SESSION_ID', 'true')
        # Always set OTEL_RESOURCE_ATTRIBUTES from current CWD + channel name.
        # Do not rely on any pre-existing env value — it may have a stale project name.
        if self.participant_name:
            # Derive project: handle Team/{agent} directory structure
            # e.g. /home/user/Pulse/Team/an agent -> project=Pulse
            _cwd_parts = os.getcwd().replace('\\', '/').split('/')
            _project = get_project_name()  # fallback (basename or package.json name)
            if 'Team' in _cwd_parts:
                _team_idx = len(_cwd_parts) - 1 - _cwd_parts[::-1].index('Team')
                if _team_idx > 0:
                    _project = _cwd_parts[_team_idx - 1]
            # Prefer resolved channel name over raw UUID
            _channel = self.channel_name or self.channel_id or ''
            os.environ['OTEL_RESOURCE_ATTRIBUTES'] = (
                f"agent.name={self.participant_name},"
                f"project={_project},"
                f"collab.channel={_channel}"
            )
            debug(f"Set OTEL_RESOURCE_ATTRIBUTES: {os.environ['OTEL_RESOURCE_ATTRIBUTES']}")

        try:
            MAX_RESTARTS = 50
            restart_count = 0

            # Handle window resize — defined once; uses self.child via closure so picks up
            # the latest spawned child on each restart iteration.
            def handle_resize(signum, frame):
                try:
                    rows, cols = os.popen('stty size', 'r').read().split()
                    if self.child:
                        self.child.setwinsize(int(rows), int(cols))
                except:
                    pass

            signal.signal(signal.SIGWINCH, handle_resize)

            # Start threads once — daemon threads survive across Claude restarts.
            poll_thread = threading.Thread(target=self.poll_channel, daemon=True)
            poll_thread.start()

            # Start watchdog thread — catches stuck Enter states even if poll thread dies
            watchdog_thread = threading.Thread(target=self.watchdog_loop, daemon=True)
            watchdog_thread.start()

            # Start SSE listener thread — real-time message push (replaces polling for messages)
            sse_thread = threading.Thread(target=self.sse_listener, daemon=True)
            sse_thread.start()

            # Join channel once — persists across Claude restarts.
            if self.channel_id:
                self.join_channel(self.channel_id)
                # Inbox catch-up: read any messages the server wrote to disk that
                # SSE/polling missed (e.g. crash recovery, API saturation).
                # Queues into sse_message_queue for the normal processing pipeline.
                if not self._native_pump or not self._native_pump.active():
                    self.check_inbox()

            # I/O filters — defined once, shared across all restart iterations.
            # Custom input filter to track keystrokes
            def input_filter(data):
                self.last_keystroke = time.time()
                return data

            # Custom output filter to detect activity (Claude generating response)
            def output_filter(data):
                self.last_output_time = time.time()
                if len(data) > 0 and self.is_processing:
                    self.output_seen_since_inject = True
                if len(data) > 0 and self.joined and self.is_processing:
                    # Only re-broadcast 'working' if we're already in processing state.
                    # NEVER transition from idle → working based on output alone.
                    # Only inject_message() should set is_processing = True.
                    # This prevents TUI noise (cursor updates, escape sequences, prompt
                    # redraws) from falsely showing "Working..." when agent is idle.
                    self.idle_since = 0
                    self.broadcast_activity('working')
                    # Detect collab response — agent replied via collab channel
                    # data can be str or bytes depending on pexpect internals
                    # IMPORTANT: Only match actual tool CALLS, not references in rules/docs.
                    # Old check ('collab_helper.py' in check) false-positived when Claude
                    # loaded rule files that mention collab_helper as instructional text,
                    # causing terminal-only response detection to silently skip.
                    # Uses a rolling buffer because tool invocation and output arrive
                    # in separate chunks (e.g. "Bash(collab_helper...)" in one chunk,
                    # "Sent." in another).
                    if not self.collab_response_sent:
                        try:
                            check = data if isinstance(data, str) else data.decode('utf-8', errors='replace')
                            self._collab_detect_buf = getattr(self, '_collab_detect_buf', '') + check
                            # Keep buffer bounded (last 1000 chars)
                            if len(self._collab_detect_buf) > 1000:
                                self._collab_detect_buf = self._collab_detect_buf[-1000:]
                            buf = self._collab_detect_buf
                            # Match actual execution patterns across chunks:
                            # - Tool invocation: "Bash(" appears near "collab_helper"
                            # - Success output: "Sent." after a collab_helper invocation
                            # - Direct Agent API call: collab.message or
                            #   collab.cross_channel_message (whitespace tolerant)
                            if contains_collab_response_signal(buf):
                                self.collab_response_sent = True
                                self._collab_detect_buf = ''
                        except Exception:
                            pass
                return data

            # Restart loop — Claude is respawned after each clean exit (e.g. context compaction).
            # Max MAX_RESTARTS to prevent infinite loops on persistent failures.
            resume_session_id = None
            while restart_count <= MAX_RESTARTS:
                # Spawn Claude in a real PTY using pexpect
                # Use list form to preserve multi-word arguments (e.g. --append-system-prompt with spaces)
                spawn_args = self.claude_args
                if resume_session_id:
                    spawn_args = resume_args(self.claude_args, resume_session_id)
                    debug(f"Respawning with --resume {resume_session_id} (abnormal exit; keeping conversation)")
                self._child_spawned_at = time.time()
                # Observer-only mod integration. No plugin/listener/default changes
                # unless this individual wrapper launch explicitly opts in.
                self._mod_bridge = None
                spawn_env = None
                if os.environ.get('DEVFLOW_CLAUDE_MOD_OBSERVE') == '1' or self._native_pump:
                    try:
                        from claude_mod_bridge import prepare_observer
                        spawn_args, spawn_env, self._mod_bridge = prepare_observer(spawn_args, os.environ, self._native_pump.transport if self._native_pump else None)
                    except Exception:
                        debug('Claude mod observer unavailable; continuing legacy launch')
                spawn_kwargs = {'encoding': 'utf-8', 'timeout': None}
                if spawn_env is not None:
                    spawn_kwargs['env'] = spawn_env
                self.child = pexpect.spawn(CLAUDE_BINARY, spawn_args, **spawn_kwargs)
                # Disable pexpect's 50ms sleep-before-send (Task 3 — delaybeforesend=0)
                self.child.delaybeforesend = 0

                # Get Claude's PID - this is crucial for registration
                self.claude_pid = self.child.pid
                if restart_count == 0:
                    debug(f"Claude spawned with PID: {self.claude_pid}")
                else:
                    debug(f"Claude respawned with PID: {self.claude_pid} (restart {restart_count}/{MAX_RESTARTS})")

                # Register with Claude's PID so UI can find us
                self.register_session()

                # Update session file with new PID so collab_helper.py finds the correct
                # participant ID. Without this, a restarted Claude gets a new PID but no
                # session file, causing it to join as a new participant ("Setup Wizard" bug).
                if self.joined and self.channel_id:
                    self._write_session_file(self.channel_id)

                # Schedule one-time background PID snapshot ~3s after spawn (Task 4).
                # After 3s, MCP servers and persistent helpers are running; we snapshot
                # their PIDs so is_process_tree_active() can exclude them from CPU delta.
                def _schedule_bg_pid_capture():
                    time.sleep(3)
                    self._capture_background_pids()
                threading.Thread(target=_schedule_bg_pid_capture, daemon=True).start()
                threading.Thread(target=self._accept_startup_dialogs, daemon=True).start()

                # Clean up stale session files from dead processes (first spawn only)
                if restart_count == 0:
                    self.cleanup_stale_sessions()
                    # Remove any stale/mismatched invite file before entering the poll loop.
                    # Prevents PID-reuse bug: a recycled PID inheriting a stale invite
                    # for a different agent would otherwise trigger an involuntary channel hop.
                    self.cleanup_stale_invite()

                # Set window size to match terminal
                try:
                    rows, cols = os.popen('stty size', 'r').read().split()
                    self.child.setwinsize(int(rows), int(cols))
                except:
                    self.child.setwinsize(24, 80)

                # Give control to the user - this handles all I/O
                # The interact() method connects the terminal to the child process
                debug("Starting interact()")
                self.child.interact(input_filter=input_filter, output_filter=output_filter)

                # interact() returned — Claude exited (e.g. after context compaction)
                # Release resources from the dead child before next spawn;
                # exitstatus/signalstatus are only populated after close().
                try:
                    self.child.close(force=True)
                except Exception:
                    pass
                if self._mod_bridge is not None:
                    self._mod_bridge.close()
                    self._mod_bridge = None
                exit_status = self.child.exitstatus
                signal_status = self.child.signalstatus
                ran_for = time.time() - self._child_spawned_at
                debug(f"Claude exited (status={exit_status}, signal={signal_status}, ran={ran_for:.0f}s, "
                      f"restarts={restart_count}/{MAX_RESTARTS})")

                # A killed/crashed child (earlyoom SIGTERM/SIGKILL, abort) resumes
                # its conversation; a clean exit keeps the fresh-session behaviour.
                # Skip resume for a child that died quickly so a session that
                # crashes on load cannot loop forever.
                resume_session_id = None
                abnormal = signal_status is not None or exit_status not in (0, None)
                if abnormal and ran_for >= RESUME_MIN_RUNTIME_SECONDS:
                    resume_session_id = session_id_from_transcript(self._resolve_transcript())
                    if not resume_session_id:
                        debug("Abnormal exit but no resumable transcript — fresh session")

                if restart_count >= MAX_RESTARTS:
                    debug(f"Max restarts ({MAX_RESTARTS}) reached, wrapper exiting")
                    break

                # Reset state before respawn — prevents stale flags from previous session
                self.is_processing = False
                with self._enter_lock:
                    self.pending_enter = False
                    self.pending_enter_time = 0
                self.collab_response_sent = False
                self.pending_mark_read = False
                self.pending_mark_read_timestamp = None
                self._child_spawned_at = time.time()  # dead child's JSONL tail is stale from here
                debug("State reset before respawn")

                restart_count += 1
                debug(f"Restarting Claude (attempt {restart_count}/{MAX_RESTARTS})...")
                time.sleep(2)

        except pexpect.exceptions.ExceptionPexpect as e:
            print(f"\033[31mError: {e}\033[0m", file=sys.stderr)
            debug(f"Pexpect error: {e}")
            return 1
        except KeyboardInterrupt:
            pass
        finally:
            self.running = False
            if getattr(self, '_mod_bridge', None) is not None:
                self._mod_bridge.close()
                self._mod_bridge = None
            # Sprint 58 T1 — flush any in-flight dedup state before exit so the
            # next session loads the full set of handled message IDs.
            try:
                if self._dedup_dirty:
                    self._persist_injected_ids()
            except Exception as e:
                debug(f"Final dedup persist failed: {e}")
            self.leave_channel()
            self.unregister_session()
            if self.child and self.child.isalive():
                self.child.close()
            debug("Wrapper exiting")

        return 0


def list_channels():
    try:
        req = urllib.request.Request(f"{API_BASE}?action=list")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            channels = data.get("channels", [])
            if not channels:
                print("No channels found.")
                return
            print("\nAvailable channels:")
            for ch in channels:
                print(f"  {ch['id'][:8]}...  {ch['name']}")
            print()
    except Exception as e:
        print(f"Error: {e}")


def main():
    parser = argparse.ArgumentParser(description="Claude with collab support")
    parser.add_argument("--channel", "-c", help="Channel ID to join")
    parser.add_argument("--name", "-n", help="Display name")
    parser.add_argument("--list", "-l", action="store_true", help="List channels")
    parser.add_argument("--system-prompt-file", help="Read system prompt from file (shell-safe alternative to --append-system-prompt)")

    parser.add_argument("--devflow-mod-observe", action="store_true", help="Enable the isolated observer mod for this launch only")
    parser.add_argument("--devflow-mod-delivery", action="store_true", help="Enable native delivery on the disposable canary only")
    parser.add_argument("--devflow-mod-recovery", action="store_true", help="Enable verified recovery on the disposable canary only")
    args, claude_args = parser.parse_known_args()
    if args.devflow_mod_delivery:
        os.environ['DEVFLOW_CLAUDE_MOD_DELIVERY'] = '1'
    if args.devflow_mod_recovery:
        os.environ['DEVFLOW_CLAUDE_MOD_RECOVERY'] = '1'

    if args.devflow_mod_observe:
        os.environ['DEVFLOW_CLAUDE_MOD_OBSERVE'] = '1'


    # If --system-prompt-file given, read file and inject as --append-system-prompt
    # This avoids shell interpretation of backticks/$ in role content
    prompt_content = ""
    if args.system_prompt_file:
        try:
            with open(args.system_prompt_file, 'r') as f:
                prompt_content = f.read().strip()
        except Exception as e:
            print(f"\033[33m[Collab] Warning: Could not read system prompt file: {e}\033[0m", file=sys.stderr)
    # channel-communication.md defers transport to "the current system or wrapper
    # prompt"; this wrapper never stated it, so agents without an SG-1 startup
    # rule answered in the terminal (Woolsey, 25 Sep 2026). State it for every
    # channel session.
    if args.channel:
        prompt_content = (TRANSPORT_PROMPT + "\n\n" + prompt_content).strip()
    if prompt_content:
        claude_args = system_prompt_args(prompt_content) + claude_args

    if args.list:
        list_channels()
        return 0

    wrapper = CollabClaudeWrapper(
        channel_id=args.channel,
        participant_name=args.name,
        claude_args=claude_args
    )
    return wrapper.run()


if __name__ == "__main__":
    sys.exit(main())
