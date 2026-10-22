#!/usr/bin/env python
"""
Collab Claude Wrapper for Windows (pywinpty / ConPTY).

Derived from /mnt/c/Users/<windows-user>/devflow-bridge/collab-claude-win.py (Jan 2026),
modernised on 2026-04-22 to match the current WSL wrapper's submit protocol
and cross-platform session-discovery requirements (Sprint 60 Phase A1).

Usage (Windows PowerShell 7, real console, NOT -NoNewWindow):
    python collab-claude-win.py [claude args...]
    python collab-claude-win.py --channel <id> [claude args...]

Runtime requirements:
  * Python 3 on Windows
  * pywinpty (pip install pywinpty)
  * PYTHONIOENCODING=utf-8 is set automatically below — without it, Windows
    cp1252 console crashes on Ink's Unicode box-drawing/status glyphs.

A1 changes vs Jan version:
  1. MAX_INJECT_LENGTH 500 -> 8000 chars, with overflow-to-tempfile pattern.
  2. Submit protocol: literal text + sleep(0.5s) + bare '\\r'. NO '\\x1b'
     prefix (verified PASS on claude.exe 2.1.117 by an agent 2026-04-22).
  3. Bootstrap wait: flat 5s min + sentinel scan on prompt glyphs and
     'accept edits on' before the first inject. Without this, writes hit
     the ConPTY before Ink's input field is live and vanish.
  4. Input thread: chunked 4096-byte reads instead of byte-at-a-time
     os.read(stdin,1) — v1 was UTF-8 unsafe under multi-byte keystrokes.
  5. Generic `.claude/collab-session.json` last-writer-wins symlink
     dropped — PID-specific files only, plus a `\\wsl$\\Ubuntu\\tmp\\` mirror.
  6. Invite/ready files move to `\\wsl$\\Ubuntu\\tmp\\collab-{invite,ready}-{pid}.json`
     so the DevFlow sessions monitor (which scans /tmp only) can discover
     Windows-launched agents without a server change.
  7. Binary path: `.local\\bin\\claude.exe` is primary (verified live path on
     claude.exe 2.1.117); old `%LOCALAPPDATA%\\Programs\\claude-code` demoted
     to fallback.
  8. Env block: DISABLE_AUTOUPDATER + PYTHONIOENCODING + OTEL telemetry
     vars ported from WSL wrapper L2590-2620.
"""

import os
import sys
import json
import time
import queue
import argparse
import threading
import urllib.request
import urllib.error
import ctypes
from datetime import datetime, timezone
from ctypes import wintypes

# Windows console API for raw input
kernel32 = ctypes.windll.kernel32
STD_INPUT_HANDLE = -10
ENABLE_PROCESSED_INPUT = 0x0001
ENABLE_LINE_INPUT = 0x0002
ENABLE_ECHO_INPUT = 0x0004
ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200

try:
    from winpty import PtyProcess
except ImportError:
    print("Error: pywinpty not installed. Run: pip install pywinpty", file=sys.stderr)
    sys.exit(1)

# Sprint 62 T1.1.d: pywin32 ReadDirectoryChangesW for event-driven JSONL
# change notification. Polling with os.path.getsize / fresh-handle / os.listdir /
# persistent-fd ALL fail on Windows because the NTFS metadata cache doesn't
# invalidate while the writing process is quiesced (Sam Runs 3/4/5 FAIL).
# ReadDirectoryChangesW is kernel-level — it fires FILE_ACTION_MODIFIED on
# every write regardless of caching. Degrades gracefully on Linux / missing
# pywin32 — _HAS_WIN32 gate switches tail logic back to polling (which works
# correctly on Linux because ext4 has no equivalent cache lag).
try:
    import win32file  # type: ignore
    import win32con  # type: ignore
    _HAS_WIN32 = True
except ImportError:
    win32file = None  # type: ignore
    win32con = None  # type: ignore
    _HAS_WIN32 = False

# Phase E: JSONL transcript state + Plan Mode auto-accept.
# Shared module with the WSL wrapper — lives alongside this file under
# ~/DevFlow/scripts/. When this script runs from Windows Python via
# \\wsl$\Ubuntu\home\<user>\DevFlow\scripts\collab-claude-win.py, Python's
# default sys.path includes the script directory, so the import resolves.
try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from jsonl_state_reader import (
        JsonlState,
        check_jsonl_state,
        resolve_transcript_path,
        tool_to_label,
    )
except Exception as _jsonl_import_err:
    # Non-fatal: Plan Mode + JSONL state features degrade to no-op.
    # Wrapper's Phase A-D functionality is not affected.
    JsonlState = None  # type: ignore
    check_jsonl_state = None  # type: ignore
    resolve_transcript_path = None  # type: ignore
    tool_to_label = None  # type: ignore
    # Can't call debug() yet — logger defined below; the first _tail_jsonl
    # call will log the degradation path.

# The reply line (names the full id of the message being answered) is worded in one place, next to this file.
try:
    from reply_context import format_reply_context
except Exception:  # a stray copy without it only loses the reply line
    def format_reply_context(reply_to):
        return ""

# ---- Runtime env (set before any spawn) ----------------------------------
os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
os.environ.setdefault('DISABLE_AUTOUPDATER', '1')
os.environ.setdefault('CLAUDE_CODE_ENABLE_TELEMETRY', '1')
os.environ.setdefault('OTEL_METRICS_EXPORTER', 'otlp')
os.environ.setdefault('OTEL_LOGS_EXPORTER', 'otlp')
os.environ.setdefault('OTEL_EXPORTER_OTLP_PROTOCOL', 'grpc')
os.environ.setdefault('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4317')
os.environ.setdefault('OTEL_LOG_TOOL_DETAILS', '1')
os.environ.setdefault('OTEL_METRICS_INCLUDE_SESSION_ID', 'true')

# Configuration
DEVFLOW_URL = os.environ.get("DEVFLOW_URL", "http://localhost:3000").rstrip("/")
API_BASE = f"{DEVFLOW_URL}/api/collab"
POLL_INTERVAL = 2  # seconds
IDLE_THRESHOLD = 1.5  # seconds since last keystroke before injecting
MAX_INJECT_LENGTH = 8000  # Long messages spill to a temp file with a pointer in the inject.
MAX_CATCHUP_MESSAGES = 50  # Catch-up poll count cap on SSE connect/reconnect.
SSE_ZOMBIE_THRESHOLD = 60.0  # Seconds since last data before declaring SSE dead.
SSE_MAX_FAILURES = 5  # Consecutive connect failures before falling back to polling.
# Phase E: Plan Mode auto-accept thresholds (WSL L44-45 parity, Sprint 56).
# Debounce: real user has this long to pick option 2 or 3 before we press 1.
# Accept timeout: after we press 1, tool_result should arrive within this window.
PLAN_MODE_DEBOUNCE_SECONDS = 3.0
PLAN_MODE_ACCEPT_TIMEOUT_SECONDS = 10.0
BOOTSTRAP_MIN_SECONDS = 5.0  # Flat minimum wait before scanning for input-field sentinels.
BOOTSTRAP_MAX_SECONDS = 20.0  # Upper bound on bootstrap wait; proceed anyway after this.
# Sentinels that indicate Ink's input field is live (confirmed against claude.exe 2.1.117).
BOOTSTRAP_SENTINELS = ("accept edits on", "How can I help", "│", ">")

# Claude binary discovery order — primary is the live 2.1.117 install path
# verified by an agent's Run-3 (2026-04-22). The old %LOCALAPPDATA% path is
# retained as fallback in case a future installer reverts.
CLAUDE_BINARY = os.path.expandvars(r"%USERPROFILE%\.local\bin\claude.exe")
CLAUDE_FALLBACK_PATHS = [
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\claude-code\claude.exe"),
    os.path.expandvars(r"%APPDATA%\npm\claude.cmd"),
    r"C:\Program Files\Claude\claude.exe",
]

# Session-file coordination with the DevFlow server.
# The server's sessions monitor scans /tmp ONLY (lib/monitors/sessions-monitor.ts:23-26).
# From Windows, the WSL UNC path maps over SMB to the WSL /tmp filesystem. Modern WSL
# exposes both `\\wsl.localhost\<distro>\` (preferred, WSL >= 0.67.6) and `\\wsl$\<distro>\`
# (legacy, being phased out). Sam's Run-4 2026-04-22 observed `\\wsl$\` silently failing
# on her box — probe both at startup and pick the first writable form.
WSL_TMP_CANDIDATES = [
    r"\\wsl.localhost\Ubuntu\tmp",
    r"\\wsl$\Ubuntu\tmp",
]
WSL_TMP = None  # Populated by _resolve_wsl_tmp() on startup; None disables /tmp mirror.

# Per-run debug log — stays in Windows %TEMP% (it's local debug, not server-visible).
TEMP_DIR = os.environ.get("TEMP") or __import__("tempfile").gettempdir()
DEBUG_LOG = os.path.join(TEMP_DIR, "collab-claude-win-debug.log")


def debug(msg):
    """Write debug message to log file."""
    try:
        with open(DEBUG_LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    except Exception:
        pass


def _linux_tmp_path(pid, kind):
    """Return the Linux-side /tmp path (ext4-native) for session discovery files.

    Used as the target of wsl.exe tee writes so the DevFlow sessions monitor
    can discover Windows-launched agents without hitting 9P coherence issues.
    """
    return f"/tmp/collab-{kind}-{pid}.json"


def _write_via_wsl_tee(linux_path, text):
    """Write `text` to a Linux-side path by piping through `wsl.exe tee`.

    Bypasses the Windows \\wsl$ 9P bridge entirely. Sam's Sprint 60
    smoke #2 (2026-04-22) revealed that manual `wsl.exe -- tee` from fresh
    pwsh works, but wrapper-context `subprocess.run(['wsl.exe', '--', 'tee'])`
    returns rc=0 with no stderr yet produces no visible file in /tmp.
    Likely cause: default-distro ambiguity when invoked through
    wt.exe → pwsh → python → subprocess — wsl.exe may route to a
    different WSL service instance without explicit `-d Ubuntu`.

    This version pins the distro explicitly, captures+logs stderr even
    on rc=0, and verifies post-write via `wsl.exe ls` so silent failures
    are visible in the debug log.

    Args:
        linux_path: /tmp/... path (Linux-style)
        text: content to write

    Returns:
        True if write verified by post-stat, False otherwise.
    """
    import subprocess
    try:
        result = subprocess.run(
            ['wsl.exe', '-d', 'Ubuntu', '--', 'tee', linux_path],
            input=text.encode('utf-8'),
            capture_output=True,
            timeout=5,
        )
        stderr_preview = result.stderr[:200] if result.stderr else b''
        # Log stderr even on rc=0 (Sprint 60 smoke #2 — silent failure mode).
        debug(f"wsl.exe tee ({linux_path}): rc={result.returncode} stderr={stderr_preview!r}")
        if result.returncode != 0:
            return False
    except Exception as e:
        debug(f"wsl.exe tee write error ({linux_path}): {e}")
        return False

    # Post-write verify via separate wsl.exe invocation. If this ls fails,
    # the tee's rc=0 was a lie (likely routing to a different WSL instance).
    try:
        verify = subprocess.run(
            ['wsl.exe', '-d', 'Ubuntu', '--', 'ls', '-la', linux_path],
            capture_output=True,
            timeout=5,
        )
        if verify.returncode == 0 and verify.stdout:
            debug(f"wsl.exe tee VERIFIED ({linux_path}): {verify.stdout.strip()[:200]!r}")
            return True
        else:
            debug(
                f"wsl.exe tee WRITE LIED ({linux_path}): tee rc=0 but post-ls "
                f"rc={verify.returncode} stdout={verify.stdout[:200]!r} "
                f"stderr={verify.stderr[:200]!r}"
            )
            return False
    except Exception as e:
        debug(f"wsl.exe tee post-verify error ({linux_path}): {e}")
        return False


def _wsl_rm(linux_path):
    """Delete a Linux-side file via `wsl.exe rm`. Best-effort, no raise."""
    import subprocess
    try:
        subprocess.run(
            ['wsl.exe', '-d', 'Ubuntu', '--', 'rm', '-f', linux_path],
            capture_output=True,
            timeout=5,
        )
    except Exception:
        pass


def _reject_unc_cwd():
    r"""If invoked with a WSL UNC path as CWD, refuse to start.

    Claude Code generates its JSONL project directory from the CWD; a CWD
    like \\wsl.localhost\Ubuntu\home\... produces a slug prefix that
    Claude can't create, silently aborting every assistant turn.
    Sam's Run-5 hit exactly this — Start-Process inheriting pwsh's WSL CWD.
    """
    cwd = os.getcwd()
    if cwd.startswith(r"\\wsl$") or cwd.startswith(r"\\wsl.localhost"):
        print(
            "[Collab] FATAL: current working directory is a WSL UNC path (" + cwd + ").\n"
            "  Claude Code cannot create JSONL project dirs under UNC CWDs and will\n"
            "  silently drop every injected message. Re-launch with a Windows-local\n"
            "  CWD, e.g.:\n"
            r"    Start-Process -WorkingDirectory C:\Users\<you>\devflow-bridge ..." + "\n",
            file=sys.stderr,
        )
        sys.exit(3)


def _resolve_wsl_tmp():
    """Probe each WSL UNC candidate and return the first one that accepts a
    write. Populates the module-level WSL_TMP for subsequent file-path helpers.
    Returns None if none are writable — in that case the wrapper runs, but
    server-side discovery won't work until the path is fixed manually.
    """
    global WSL_TMP
    if WSL_TMP:
        return WSL_TMP  # Already resolved this run.
    for candidate in WSL_TMP_CANDIDATES:
        try:
            os.makedirs(candidate, exist_ok=True)
            probe_path = os.path.join(candidate, f"collab-probe-{os.getpid()}.txt")
            with open(probe_path, 'w', encoding='utf-8') as f:
                f.write(f"probe {time.time()}\n")
            os.remove(probe_path)
            WSL_TMP = candidate
            debug(f"WSL_TMP resolved to {candidate}")
            return candidate
        except Exception as e:
            debug(f"WSL_TMP probe failed for {candidate}: {e}")
    debug("WARN: no writable WSL_TMP candidate found; server discovery disabled.")
    return None


def get_invite_file(pid=None):
    if not WSL_TMP:
        return None
    return os.path.join(WSL_TMP, f"collab-invite-{pid or os.getpid()}.json")


def get_ready_file(pid=None):
    if not WSL_TMP:
        return None
    return os.path.join(WSL_TMP, f"collab-ready-{pid or os.getpid()}.json")


def get_tmp_session_file(pid):
    if not WSL_TMP:
        return None
    return os.path.join(WSL_TMP, f"collab-session-{pid}.json")


def get_project_name():
    """Extract project name from package.json or directory name."""
    cwd = os.getcwd()
    try:
        pkg_path = os.path.join(cwd, 'package.json')
        if os.path.exists(pkg_path):
            with open(pkg_path, encoding='utf-8') as f:
                data = json.load(f)
                if data.get('name'):
                    return data['name']
    except Exception:
        pass
    return os.path.basename(cwd)


def find_claude_binary():
    """Find Claude binary, checking primary then fallback locations."""
    if os.path.exists(CLAUDE_BINARY):
        return CLAUDE_BINARY
    for path in CLAUDE_FALLBACK_PATHS:
        if os.path.exists(path):
            return path
    import shutil
    claude_in_path = shutil.which("claude")
    if claude_in_path:
        return claude_in_path
    return None


def get_console_size():
    """Get console window size on Windows."""
    try:
        from ctypes import windll, create_string_buffer
        h = windll.kernel32.GetStdHandle(-12)  # STD_OUTPUT_HANDLE
        csbi = create_string_buffer(22)
        res = windll.kernel32.GetConsoleScreenBufferInfo(h, csbi)
        if res:
            import struct
            (_, _, _, _, _, left, top, right, bottom, _, _) = struct.unpack("hhhhHhhhhhh", csbi.raw)
            cols = right - left + 1
            rows = bottom - top + 1
            return rows, cols
    except Exception:
        pass
    return 24, 80


class CollabClaudeWrapper:
    def __init__(self, channel_id=None, participant_name=None, claude_args=None):
        self.channel_id = channel_id
        self.participant_name = participant_name
        self.participant_id = None
        self.claude_args = claude_args or []
        self.proc = None  # PtyProcess
        self.last_keystroke = time.time()
        self.last_poll_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.running = True
        self.joined = False
        self.claude_pid = None
        self.wrapper_pid = os.getpid()
        self.injected_message_ids = set()
        self._dedup_lock = threading.Lock()  # Guards injected_message_ids across SSE + poll threads (risk-note #1)
        # Activity status
        self.current_activity = 'idle'
        self.last_output_time = 0
        self.activity_idle_threshold = 2.0
        # PTY thread safety — guards all proc.read/write access
        self.pty_lock = threading.Lock()
        # Shared output buffer for bootstrap sentinel detection + reader thread
        self.output_buffer = []
        self._buffer_lock = threading.Lock()
        self.input_field_ready = False
        # ---- Phase B: SSE transport ------------------------------------
        # Real-time message delivery — SSE is primary, polling is fallback.
        self.sse_message_queue = queue.Queue()
        self.sse_connected = False
        self.sse_last_event_id = None
        self.sse_reconnect_failures = 0
        self.sse_last_data_time = 0.0  # Any received byte updates this — zombie detection key
        self._sse_resp = None  # Current SSE response — closed externally to break blocking read
        self.sse_zombie_kicked = False  # True if last disconnect was zombie-triggered
        self._message_event = threading.Event()  # SSE signals poll thread to drain queue
        # ---- Phase C: deferred Enter + @mention annotation -----------
        # Text is written to the PTY immediately; Enter is deferred and fired
        # by enter_watchdog() only once Claude has been quiet for
        # enter_idle_threshold seconds. Prevents Enter from racing a TUI
        # redraw while Claude is mid-streaming.
        self.pending_enter = False
        self.pending_enter_time = 0.0  # Set by inject_message after text write
        self.enter_idle_threshold = 0.5  # Seconds of no output before firing Enter
        self._enter_lock = threading.Lock()  # Guards pending_enter read/write
        # ---- Phase E: JSONL tail + Plan Mode auto-accept --------------
        # Parity with WSL collab-claude.py Sprint 56 T1+T2+T3 state.
        self._transcript_path = None  # Cached JSONL path; re-resolves on None
        self._plan_mode_tail_path = None  # Transcript path for tail offset tracking
        self._plan_mode_tail_byte = None  # Byte offset; None = skip history on first read
        # Sprint 62 T1.1.c → T1.1.d: persistent read handle kept for the tail-read
        # path (not for size polling — T1.1.c proved the NTFS cache survives even
        # persistent-fd seek+tell). T1.1.d shifted size-change detection to
        # event-driven via ReadDirectoryChangesW (see _plan_mode_watcher). This fd
        # is now only used to read content after the watcher signals a change.
        self._plan_mode_tail_fd = None
        # T1.1.d event: set by _plan_mode_watcher thread when the NTFS kernel fires
        # FILE_ACTION_MODIFIED on the transcript dir. Tail loop consumes + clears.
        # Linux / missing-pywin32: watcher thread is a noop and tail falls back to
        # the original persistent-fd polling path (which works on ext4).
        self._plan_mode_change_event = threading.Event()
        # Key: ExitPlanMode tool_use_id. Value: monotonic first-seen timestamp.
        self._pending_plan_mode = {}
        # Key: ExitPlanMode tool_use_id. Value: monotonic accept-keystroke timestamp.
        self._accepted_plan_mode = {}

    # ------------------------------------------------------------------
    # API helpers
    # ------------------------------------------------------------------

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

    def broadcast_activity(self, status, force=False):
        if not self.joined or not self.channel_id or not self.participant_id:
            return
        if not force and status == self.current_activity:
            return
        self.current_activity = status
        debug(f"Broadcasting activity: {status}")
        self.api_call("", "POST", {
            "action": "heartbeat",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "activityStatus": status
        })

    def idle_heartbeat_thread(self):
        """Periodic heartbeat while idle — keeps lastSeen fresh so agent doesn't appear offline."""
        IDLE_HEARTBEAT_INTERVAL = 30.0  # seconds
        while self.running:
            time.sleep(IDLE_HEARTBEAT_INTERVAL)
            if self.joined and self.current_activity == 'idle':
                self.broadcast_activity('idle', force=True)

    # ------------------------------------------------------------------
    # Session registration — writes to WSL /tmp via \\wsl$\Ubuntu\tmp
    # so the DevFlow sessions monitor (which globs /tmp) can discover us.
    # ------------------------------------------------------------------

    def register_session(self):
        if not self.claude_pid:
            debug("Cannot register - Claude PID not yet known")
            return
        if not self.participant_name:
            self.participant_name = get_project_name()
        try:
            ready_payload = json.dumps({
                "pid": self.claude_pid,
                "name": self.participant_name,
                "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "cwd": os.getcwd(),
                "wrapperPid": self.wrapper_pid,
                "platform": "windows"
            })
            linux_ready = _linux_tmp_path(self.claude_pid, 'ready')
            if _write_via_wsl_tee(linux_ready, ready_payload):
                print(f"[Collab] Session ready (PID {self.claude_pid}) — discoverable at {linux_ready}", file=sys.stderr)
                debug(f"Session registered via wsl.exe tee: {linux_ready}")
            else:
                print(f"[Collab] Warning: ready-file write via wsl.exe tee failed", file=sys.stderr)
                debug("Ready-file write failed — sessions monitor will not discover this agent")
        except Exception as e:
            print(f"[Collab] Warning: ready-file write failed: {e}", file=sys.stderr)

    def unregister_session(self):
        if self.claude_pid:
            # WSL /tmp files — delete via wsl.exe rm to match the tee-write path.
            for kind in ('ready', 'invite', 'session'):
                _wsl_rm(_linux_tmp_path(self.claude_pid, kind))
            # Windows-local project-dir session file — plain os.remove.
            try:
                session_dir = os.path.join(os.getcwd(), '.claude')
                project_local = os.path.join(session_dir, f'collab-session-{self.claude_pid}.json')
                os.remove(project_local)
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Channel membership
    # ------------------------------------------------------------------

    def join_channel(self, channel_id, channel_name=None):
        self.channel_id = channel_id
        if channel_name:
            self.channel_name = channel_name  # Used for the readable injected header label
        result = self.api_call("", "POST", {
            "action": "join",
            "channelId": channel_id,
            "participant": {
                "name": self.participant_name,
                "type": "claude-terminal",
                "source": "collab-claude-win wrapper"
            }
        })
        if result.get("success"):
            self.participant_id = result.get("participantId")
            self.joined = True
            self.last_poll_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            channel_display = channel_name or channel_id[:8]
            print(f"[Collab] Joined '{channel_display}' as {self.participant_name}", file=sys.stderr)
            debug(f"Joined channel: {channel_display}")
            self._write_session_file(channel_id, channel_name)
            return True
        debug(f"Failed to join channel: {result}")
        return False

    def _write_session_file(self, channel_id, channel_name=None):
        """Write PID-specific session file. NO generic collab-session.json fallback.

        The WSL wrapper removed that fallback because it's last-writer-wins when
        multiple agents share a project directory, causing identity confusion.
        Each agent is identified exclusively by PID.
        """
        try:
            session_data = {
                "channelId": channel_id,
                "participantId": self.participant_id,
                "displayName": self.participant_name,
                "channelName": channel_name or "Unknown",
                "pid": self.claude_pid,
                "agentType": "claude",
                "platform": "windows",
                "projectPath": os.getcwd(),
            }

            # Project-local file for /collab-post skill compatibility (when run inside project).
            session_dir = os.path.join(os.getcwd(), '.claude')
            os.makedirs(session_dir, exist_ok=True)
            pid_session_file = os.path.join(session_dir, f'collab-session-{self.claude_pid}.json')
            with open(pid_session_file, 'w', encoding='utf-8') as f:
                json.dump(session_data, f)

            # Mirror to WSL /tmp via wsl.exe tee — Linux-native write, bypasses
            # the 9P bridge's Windows-side cache that silently swallowed earlier
            # SMB+fsync attempts (Sam Sprint 60 smoke #1).
            linux_session = _linux_tmp_path(self.claude_pid, 'session')
            if _write_via_wsl_tee(linux_session, json.dumps(session_data)):
                debug(f"Wrote session files: {pid_session_file} (Windows-local) + {linux_session} (wsl.exe tee)")
            else:
                debug(f"Wrote session file: {pid_session_file}; WSL /tmp mirror FAILED — server discovery likely broken")
        except Exception as e:
            debug(f"Failed to write session file: {e}")

    def leave_channel(self):
        if self.joined and self.participant_id:
            self.api_call("", "POST", {
                "action": "leave",
                "channelId": self.channel_id,
                "participantId": self.participant_id
            })
            print("[Collab] Left channel", file=sys.stderr)

    def check_for_invite(self):
        if not self.claude_pid:
            return None
        invite_file = get_invite_file(self.claude_pid)
        if not invite_file:
            return None
        try:
            if os.path.exists(invite_file):
                with open(invite_file, 'r', encoding='utf-8') as f:
                    invite = json.load(f)
                os.remove(invite_file)
                debug(f"Found invite: {invite}")
                ready_file = get_ready_file(self.claude_pid)
                if os.path.exists(ready_file):
                    try:
                        with open(ready_file, 'r', encoding='utf-8') as f:
                            ready_data = json.load(f)
                        new_name = ready_data.get('name')
                        if new_name and new_name != self.participant_name:
                            old_name = self.participant_name
                            self.participant_name = new_name
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
        result = self.api_call(f"?channelId={self.channel_id}&since={self.last_poll_time}")
        messages = result.get("messages", [])
        if messages:
            self.last_poll_time = messages[-1].get("timestamp", self.last_poll_time)
        return messages

    def mark_read(self):
        if self.joined and self.participant_id:
            self.api_call("", "POST", {
                "action": "mark_read",
                "channelId": self.channel_id,
                "participantId": self.participant_id
            })

    def sync_name_from_ready_file(self):
        if not self.claude_pid:
            return False
        ready_file = get_ready_file(self.claude_pid)
        if not ready_file:
            return False
        try:
            if os.path.exists(ready_file):
                with open(ready_file, 'r', encoding='utf-8') as f:
                    ready_data = json.load(f)
                new_name = ready_data.get('name')
                if new_name and new_name != self.participant_name:
                    old_name = self.participant_name
                    self.participant_name = new_name
                    debug(f"Synced name from ready file: {old_name} -> {new_name}")
                    if self.joined and self.channel_id:
                        self.api_call("", "POST", {
                            "action": "join",
                            "channelId": self.channel_id,
                            "participant": {
                                "id": self.participant_id,
                                "name": new_name,
                                "type": "claude-terminal",
                                "source": "collab-claude-win wrapper"
                            }
                        })
                        debug(f"Updated name in channel to: {new_name}")
                    return True
        except Exception as e:
            debug(f"Name sync error: {e}")
        return False

    # ------------------------------------------------------------------
    # Submit protocol — A0-verified for claude.exe 2.1.117
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Phase E: JSONL transcript + Plan Mode auto-accept
    # ------------------------------------------------------------------

    def _pty_send(self, text, enter=False):
        """Thread-safe write through pty_lock. Single write path for all
        wrapper-originated keystrokes (inject, check_pending_enter,
        Plan Mode accept) — one path to bugs per Jack's E-risk #2.

        Returns True on success, False if the child is dead or the write raised.
        """
        if not self.proc or not self.proc.isalive():
            return False
        try:
            with self.pty_lock:
                if text:
                    self.proc.write(text)
                if enter:
                    self.proc.write('\r')
            return True
        except Exception as e:
            debug(f"_pty_send error: {e}")
            return False

    def _resolve_transcript(self):
        """Windows-aware JSONL transcript path resolver — RE-RESOLVES every call.

        Claude Code on Windows derives its project-key slug by replacing '\\'
        and ':' with '-'. Example: CWD `C:\\Users\\<windows-user>\\devflow-bridge` →
        project-key `C--Users-owner--devflow-bridge`, directory
        `%USERPROFILE%\\.claude\\projects\\C--Users-owner--devflow-bridge`.
        The shared `jsonl_state_reader.resolve_transcript_path()` uses the
        Linux convention (lstrip('/') + replace('/', '-')) which produces
        the wrong key on Windows. Override here to match Claude Code's
        actual Windows slug derivation.

        **No persistent cache.** Sam's Sprint 60 smoke #1 revealed that Claude
        Code rotates to a new session JSONL partway through a single claude.exe
        lifetime (post-inject the session-id may change, producing a new file
        under the same project dir). A persistent cache locked us onto the
        original file forever — Plan Mode tool_use records in the new file were
        invisible. Per-tick re-resolve is cheap (one exists() + one listdir
        + sort-by-mtime) and runs at poll interval (~2s).

        The `_transcript_path` attribute still exists for compatibility with
        `_reset_state_for_respawn`, but is only used as a change-detection
        hint for debug logging — NOT as a persistent cache.
        """
        cwd = os.getcwd()
        resolved = None

        # Primary: .session-scratch/transcript-path (written by SessionStart hook).
        try:
            tp_file = os.path.join(cwd, '.session-scratch', 'transcript-path')
            with open(tp_file, 'r', encoding='utf-8') as f:
                path = f.read().strip()
            if path and os.path.exists(path):
                resolved = path
        except (FileNotFoundError, PermissionError, OSError):
            pass

        # Fallback: Windows-style project-key derivation.
        if resolved is None:
            try:
                project_key = cwd.replace('\\', '-').replace(':', '-')
                home = os.path.expanduser('~')
                project_dir = os.path.join(home, '.claude', 'projects', project_key)
                if os.path.isdir(project_dir):
                    candidates = [
                        os.path.join(project_dir, f)
                        for f in os.listdir(project_dir)
                        if f.endswith('.jsonl')
                    ]
                    if candidates:
                        resolved = max(candidates, key=os.path.getmtime)
            except (FileNotFoundError, PermissionError, OSError) as e:
                debug(f"_resolve_transcript error: {e}")

        # Log only on change, not every tick.
        if resolved != self._transcript_path:
            debug(f"JSONL transcript (re)resolved: {resolved}")
            self._transcript_path = resolved
        return resolved

    def _close_plan_mode_tail_fd(self):
        """Close the persistent tail-size fd. Idempotent, swallows errors."""
        fd = self._plan_mode_tail_fd
        self._plan_mode_tail_fd = None
        if fd is not None:
            try:
                fd.close()
            except Exception:
                pass

    def _plan_mode_watcher(self):
        """Background thread: ReadDirectoryChangesW on the transcript parent dir.

        Sprint 62 T1.1.d. Sets self._plan_mode_change_event whenever the NTFS
        kernel fires FILE_ACTION_MODIFIED for a .jsonl file in the watched dir.
        Tail loop consumes + clears the event. Polling APIs cannot see NTFS
        writes while the source process is quiesced (Sam Runs 3/4/5), but the
        kernel notification fires regardless of any caching tier.

        Degrades to no-op if pywin32 unavailable (Linux, or Windows without
        `pip install pywin32`). In that case the tail falls back to its
        persistent-fd polling path, which works correctly on ext4.

        Rotation-safe: each outer-loop iteration re-resolves the transcript
        and re-opens a directory handle for its parent. If the transcript
        rotates mid-wait, the inner `while` breaks on the mismatch and the
        outer loop picks up the new parent.
        """
        if not _HAS_WIN32:
            debug("plan_mode_watcher: pywin32 unavailable — falling back to polling")
            return

        debug("plan_mode_watcher: thread started")
        while self.running:
            path = self._resolve_transcript()
            if not path:
                time.sleep(1)
                continue
            parent = os.path.dirname(path)

            try:
                h = win32file.CreateFile(
                    parent,
                    win32con.GENERIC_READ,
                    win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE | win32con.FILE_SHARE_DELETE,
                    None,
                    win32con.OPEN_EXISTING,
                    win32con.FILE_FLAG_BACKUP_SEMANTICS,
                    None,
                )
            except Exception as e:
                debug(f"plan_mode_watcher: CreateFile({parent}) error: {e}")
                time.sleep(5)
                continue

            try:
                # Signal once on entry so the tail picks up any history-read
                # bootstrap state without waiting for the first notification.
                self._plan_mode_change_event.set()
                while self.running:
                    # Blocking call — returns whenever any file in `parent`
                    # is modified/created/deleted. 8KB buffer is plenty for
                    # a dir with a handful of JSONL files.
                    try:
                        results = win32file.ReadDirectoryChangesW(
                            h,
                            8192,
                            False,  # watchSubtree
                            (win32con.FILE_NOTIFY_CHANGE_SIZE
                             | win32con.FILE_NOTIFY_CHANGE_LAST_WRITE),
                            None,
                            None,
                        )
                    except Exception as read_err:
                        debug(f"plan_mode_watcher: ReadDirectoryChangesW error: {read_err}")
                        break  # Drop back to outer loop for re-CreateFile

                    # Rotation check — if transcript moved to a different parent
                    # dir, bail and re-open the watcher on the new parent.
                    current_path = self._resolve_transcript()
                    if current_path and os.path.dirname(current_path) != parent:
                        debug(f"plan_mode_watcher: transcript parent rotated {parent} -> {os.path.dirname(current_path)}")
                        break

                    # Any .jsonl write in the watched dir is a signal worth
                    # re-reading. Even if it's a different session's JSONL,
                    # the resolver may now prefer it (newest mtime).
                    for action, filename in results:
                        if filename.endswith('.jsonl'):
                            self._plan_mode_change_event.set()
                            break
            finally:
                try:
                    win32file.CloseHandle(h)
                except Exception:
                    pass
            # Short settle before re-opening on outer loop
            time.sleep(0.5)
        debug("plan_mode_watcher: thread stopped")

    def _detect_plan_mode(self, record):
        """Pure classifier. If `record` is an assistant message emitting an
        ExitPlanMode tool_use block, return the block's tool_use_id; else None.

        Side-effect-free. Safe to call on every JSONL line read.
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
        """State tracker for Plan Mode pending / accepted gates.

        - ExitPlanMode tool_use → add tool_use_id to _pending_plan_mode at `now`
          (first-seen wins; never re-push an already-accepted id).
        - user tool_result whose tool_use_id is in pending OR accepted → clear it.
        - Anything else → no-op.

        Hermetic: `now` is passed in (not read from clock) per Jack's E-risk #1.
        """
        tu_id = self._detect_plan_mode(record)
        if tu_id is not None:
            if tu_id in self._accepted_plan_mode:
                return  # T2 guard: don't re-pend an already-accepted id
            if tu_id not in self._pending_plan_mode:
                self._pending_plan_mode[tu_id] = now
            return

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
        """Structured telemetry hook — tests monkeypatch this to capture events."""
        timestamp_ms = int(time.time() * 1000)
        extra_str = f" extra={extra}" if extra else ""
        debug(
            f"plan_mode event={event_type} agent={self.participant_name} "
            f"tool_use_id={tool_use_id} ts_ms={timestamp_ms}{extra_str}"
        )

    def _accept_plan_mode_gate(self, tool_use_id, now):
        """Fire '1' + Enter to accept a pending ExitPlanMode plan.

        Single-attempt. Routes through `_pty_send` — same pty_lock-guarded
        path as check_pending_enter and inject_message per Jack's E-risk #2.

        - Unknown id: safe no-op.
        - Success: pending → accepted, emit plan_auto_accepted.
        - _pty_send failure: remove from pending, do NOT add to accepted
          (menu never rendered → no point observing the 10s timeout),
          emit plan_auto_accept_failed reason=tmux_send_failed (name
          retained for log-parser parity with WSL).
        """
        if tool_use_id not in self._pending_plan_mode:
            return False
        ok = self._pty_send('1', enter=True)
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
        """Sweep pending entries; accept any whose age >= PLAN_MODE_DEBOUNCE_SECONDS."""
        for tu_id in list(self._pending_plan_mode.keys()):
            t0 = self._pending_plan_mode.get(tu_id)
            if t0 is None:
                continue
            if (now - t0) >= PLAN_MODE_DEBOUNCE_SECONDS:
                self._accept_plan_mode_gate(tu_id, now)

    def _check_plan_mode_accept_timeout(self, now):
        """Sweep accepted entries; fail any whose age >= PLAN_MODE_ACCEPT_TIMEOUT_SECONDS."""
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
        """Tail new JSONL records and feed the plan-mode observer.

        Skips history on first encounter (so old ExitPlanMode records don't
        trigger keystrokes on startup). Resets offset on transcript path
        change (Claude respawn → new session file) or file shrink (rotation).

        Best-effort + non-blocking.

        Line-boundary guard: seeks back 1 byte and confirms it's '\\n' before
        parsing; if not, it's a partial line and we readline() to discard.
        Correct for both \\n (Unix/Claude default) and \\r\\n (Windows) endings
        per Jack's E-risk #3 — the check succeeds when the previous byte is
        '\\n' regardless of whether it was preceded by '\\r'.

        Path-change semantics (Sprint 60 smoke #2 fix):
          - First encounter ever (tail_path was None): start at EOF. Skips
            history so a stale transcript from a prior wrapper run doesn't
            fire keystrokes.
          - Mid-lifetime rotation (tail_path was non-None, path is different):
            start at byte 0. The new file IS the live session; we must read
            from its beginning to catch ExitPlanMode records written before
            our next tick.
        """
        # NOTE: we do NOT short-circuit on resolve_transcript_path is None here.
        # The module-level import is used only by other WSL paths (jsonl state
        # reader features not needed for Plan Mode). _resolve_transcript() is
        # our own Windows-aware method and handles missing paths via None return.
        path = self._resolve_transcript()
        if not path:
            return

        # Sprint 62 T1.1.d: on Windows with pywin32, only re-read when the
        # ReadDirectoryChangesW watcher has signaled a change. Polling any file-
        # size API returns NTFS-cached metadata that never refreshes while the
        # writing process is quiesced, and even a persistent fd's seek(0,2)
        # reads the same cache (Sam Runs 3/4/5 FAIL). The watcher hooks the
        # kernel notification path — fires on every source-process write.
        # On Linux / missing-pywin32, fall through to polling (ext4 has no
        # equivalent cache lag, so size reads are accurate).
        if _HAS_WIN32:
            if not self._plan_mode_change_event.is_set():
                return
            self._plan_mode_change_event.clear()

        if path != self._plan_mode_tail_path:
            was_first_ever = self._plan_mode_tail_path is None
            self._plan_mode_tail_path = path
            # Rotation: drop the old persistent fd so the next block reopens to the new path.
            self._close_plan_mode_tail_fd()
            # First-encounter: skip history. Mid-lifetime rotation: read from byte 0.
            if was_first_ever:
                self._plan_mode_tail_byte = None  # Sentinel for "skip history on next tick"
            else:
                self._plan_mode_tail_byte = 0
                debug(f"_tail_jsonl: mid-lifetime rotation → reading {path} from byte 0")

        # Sprint 62 T1.1.c: persistent-fd size poll bypasses the Win32 path-level
        # metadata cache that defeated both T1.1.a (fresh-handle) and T1.1.b
        # (fresh-handle + os.listdir refresh). Those both sit on the SAME cache
        # tier — a tier that never refreshes while the writing process is
        # quiesced. A persistent read-handle uses the filesystem's handle-level
        # tracking, which updates on external writes regardless of the path cache.
        # Open lazily here; the rotation-check above closes the fd on path change.
        if self._plan_mode_tail_fd is None:
            try:
                self._plan_mode_tail_fd = open(path, 'rb')
            except (FileNotFoundError, PermissionError, OSError) as e:
                debug(f"_tail_jsonl persistent-fd open error: {e}")
                return

        try:
            self._plan_mode_tail_fd.seek(0, 2)
            file_size = self._plan_mode_tail_fd.tell()
        except (OSError, ValueError) as e:
            # fd went bad (closed externally, deleted file, etc.) — drop and
            # retry on next tick. The rotation-check will reopen on path resolve.
            debug(f"_tail_jsonl persistent-fd seek/tell failed ({e}) — closing for reopen")
            self._close_plan_mode_tail_fd()
            return

        if self._plan_mode_tail_byte is None:
            # First encounter — skip history, start at EOF.
            self._plan_mode_tail_byte = file_size
            debug(f"_tail_jsonl: first encounter, skipping {file_size} bytes of history in {path}")
            return
        if file_size < self._plan_mode_tail_byte:
            self._plan_mode_tail_byte = 0  # File was truncated
        if file_size == self._plan_mode_tail_byte:
            return

        now = time.monotonic()
        records_observed = 0
        try:
            with open(path, 'r', encoding='utf-8') as f:
                if self._plan_mode_tail_byte > 0:
                    f.seek(self._plan_mode_tail_byte - 1)
                    if f.read(1) != '\n':
                        # Mid-line boundary — discard the fragment.
                        f.seek(self._plan_mode_tail_byte)
                        f.readline()
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
                    try:
                        # Diagnostic: log every record type + whether it looks like a plan-mode event.
                        # Caps at 20 per tick to avoid flooding on history catch-up.
                        if records_observed < 20:
                            rtype = record.get('type') if isinstance(record, dict) else 'non-dict'
                            tu_id_hint = self._detect_plan_mode(record)
                            debug(f"_tail_jsonl observed record type={rtype} plan_tu_id={tu_id_hint}")
                        self._observe_jsonl_record_for_plan_mode(record, now)
                        records_observed += 1
                    except Exception as obs_err:
                        # Broad catch + log — Sprint 60 smoke #2 found zero plan_mode
                        # events despite records existing. A silent exception in the
                        # observer was one of the hypotheses. Log explicitly now so
                        # future misses are visible, not swallowed.
                        debug(f"_tail_jsonl observer error on record: {obs_err!r}")
                self._plan_mode_tail_byte = f.tell()
            if records_observed:
                debug(f"_tail_jsonl: observed {records_observed} record(s), byte cursor now {self._plan_mode_tail_byte}")
        except (FileNotFoundError, PermissionError, OSError) as e:
            debug(f"_tail_jsonl_for_plan_mode I/O error: {e}")
        except Exception as e:
            # Anything else — log unconditionally rather than swallow.
            debug(f"_tail_jsonl_for_plan_mode unexpected error: {e!r}")

    def _is_mentioned(self, mentions, content):
        """Determine if this agent is @mentioned in the message.

        Primary: participant-id match in mentions[] (server-computed).
        Fallback: scan content for @<participant_name> with a word-boundary
        suffix check so '@an agent' matches but '@McKayson' doesn't.
        """
        if mentions:
            for m in mentions:
                if isinstance(m, str) and m == self.participant_id:
                    return True
        if self.participant_name:
            import re
            pattern = re.compile(
                r'@' + re.escape(self.participant_name) + r'(?:[^a-zA-Z0-9_-]|$)',
                re.IGNORECASE,
            )
            if pattern.search(content):
                return True
        return False

    def _format_inject_prompt(self, sender, content, reply_to, mentions, channel_id, is_append=False):
        """Build the injected prompt string with channel context + reply-to + mention annotation.

        Matches the WSL wrapper's inject pipeline at scripts/collab-claude.py:1500-1613.
        Annotation lines at the end disambiguate direct @mentions, cc'd messages, and broadcasts.
        """
        ch = channel_id or self.channel_id or "unknown"
        # Prefer the readable channel name over the raw UUID in the injected header.
        if getattr(self, "channel_name", "") and ch == (self.channel_id or ch):
            ch = self.channel_name
        prefix = "\n" if is_append else ""  # Stack pending injects with a newline separator

        reply_line = format_reply_context(reply_to)
        if reply_line:
            prompt = f"{prefix}[Channel message from {sender} in {ch}] {reply_line}: {content}"
        else:
            prompt = f"{prefix}[Channel message from {sender} in {ch}]: {content}"

        is_mentioned = self._is_mentioned(mentions, content)
        if is_mentioned:
            prompt += "\n(@you)"
        elif mentions:
            prompt += "\n(not addressed to you)"
        else:
            prompt += "\n(broadcast)"

        return prompt, is_mentioned

    def inject_message(self, sender, content, reply_to=None, mentions=None, channel_id=None, msg_id=None):
        """Inject a message into Claude's input.

        Submit protocol (A0-verified on claude.exe 2.1.117):
          1. Write literal text to the PTY (no ESC, no bracketed paste).
          2. Set pending_enter = True and record the time.
          3. enter_watchdog() fires '\\r' once Claude has been idle for
             enter_idle_threshold seconds (true quiescence, not fixed sleep).

        If pending_enter is already set (an earlier message is still waiting
        for Enter), this message is APPENDED to the input buffer with a
        leading newline. All accumulated text submits together when Enter
        fires — matches the WSL wrapper's stacking behavior at L1523-1556.

        Long-message handling: >MAX_INJECT_LENGTH chars spill to a temp file
        with a pointer appended, matching WSL L1558-1570.
        """
        if not self.proc or not self.proc.isalive():
            debug("Cannot inject - process not alive")
            return False
        if not self.input_field_ready:
            debug("Cannot inject - input field not yet ready (bootstrap incomplete)")
            return False

        mentions = mentions or []

        # APPEND path: pending Enter means an earlier message is queued.
        # Stack this one into the buffer; single Enter submits the whole lot.
        with self._enter_lock:
            if self.pending_enter:
                try:
                    append_prompt, _ = self._format_inject_prompt(
                        sender, content, reply_to, mentions, channel_id, is_append=True
                    )
                    with self.pty_lock:
                        self.proc.write(append_prompt)
                    debug(f"APPENDED to pending buffer: {append_prompt[:80]}...")
                    return True
                except Exception as e:
                    debug(f"Append inject error: {e}")
                    return False

        try:
            # Long-message overflow
            original_length = len(content)
            if original_length > MAX_INJECT_LENGTH:
                import tempfile
                msg_file = tempfile.NamedTemporaryFile(
                    mode='w', prefix='collab-msg-', suffix='.md',
                    dir=TEMP_DIR, delete=False, encoding='utf-8'
                )
                msg_file.write(f"# Message from {sender}\n\n{content}")
                msg_file.close()
                content = (
                    content[:MAX_INJECT_LENGTH]
                    + f"\n... [truncated, {original_length} chars total — full message at {msg_file.name}]"
                )
                debug(f"Long message ({original_length} chars) spilled to {msg_file.name}")

            prompt, is_mentioned = self._format_inject_prompt(
                sender, content, reply_to, mentions, channel_id, is_append=False
            )
            debug(f"Injecting (mentioned={is_mentioned}): {prompt[:120]}")

            # Write text + mark pending_enter atomically so a racing watchdog
            # tick can't see "no pending_enter" and then write a stray '\r'
            # between our text write and flag set.
            with self._enter_lock:
                with self.pty_lock:
                    self.proc.write(prompt)
                self.pending_enter = True
                self.pending_enter_time = time.time()
                # Reset last_output_time to NOW — otherwise a stale silence
                # from before the write would let the watchdog fire Enter
                # immediately without giving the text time to render.
                self.last_output_time = time.time()

            return True
        except Exception as e:
            debug(f"Inject error: {e}")
            return False

    def check_pending_enter(self):
        """Fire the deferred '\\r' if Claude has quiesced.

        Conditions (all must hold):
          1. pending_enter flag is set
          2. child process still alive
          3. >= 0.2s since text was written (minimum settle)
          4. >= enter_idle_threshold since the last output byte (true idle)

        The fixed-sleep approach would race a TUI redraw; waiting for actual
        output quiescence lets Ink finish rendering our typed text before
        we submit.
        """
        with self._enter_lock:
            if not self.pending_enter:
                return False
            if not self.proc or not self.proc.isalive():
                # Child died before Enter fired — drop the flag silently.
                self.pending_enter = False
                return False

            now = time.time()
            time_since_write = now - self.pending_enter_time
            if time_since_write < 0.2:
                return False

            time_since_output = (
                now - self.last_output_time if self.last_output_time > 0 else float('inf')
            )
            if time_since_output < self.enter_idle_threshold:
                return False

            try:
                with self.pty_lock:
                    self.proc.write('\r')
                self.pending_enter = False
                debug(
                    f"Enter fired after {time_since_write:.2f}s pending, "
                    f"{time_since_output:.2f}s output-quiescence"
                )
                return True
            except Exception as e:
                debug(f"Enter-fire error: {e}")
                return False

    def enter_watchdog(self):
        """Background thread: poll check_pending_enter() every 100ms."""
        debug("Enter watchdog started")
        while self.running:
            try:
                self.check_pending_enter()
            except Exception as e:
                debug(f"Enter watchdog error: {e}")
            time.sleep(0.1)
        debug("Enter watchdog stopped")

    # ------------------------------------------------------------------
    # Threads: poll, reader, input
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Phase B: SSE transport — real-time message push
    # ------------------------------------------------------------------

    def sse_listener(self):
        """Background thread: subscribe to SSE for real-time message push.

        Ported from WSL scripts/collab-claude.py:1861-2065. Risk notes from Jack:
          1. Dedup across SSE + poll — handled via injected_message_ids + _dedup_lock
             (both this path and poll_channel() check + add atomically).
          2. Zombie detection — sse_last_data_time is updated on every received byte;
             _sse_zombie_watchdog() closes _sse_resp if silent >SSE_ZOMBIE_THRESHOLD.
          3. Clean reconnect — self.running is the cancel flag; _sse_resp.close()
             breaks the blocking read; no leaked threads.
          4. Fail counter resets on success — sse_reconnect_failures = 0 set inside
             the connect-success block, not in the except-recovery path.
        """
        debug("SSE listener thread started")
        EVENTS_URL = f"{DEVFLOW_URL}/api/events"
        backoff = 1  # seconds, doubles on failure up to 30s

        while self.running:
            if not self.joined or not self.channel_id:
                time.sleep(1)
                continue

            # participantId REQUIRED since 2026-05-18 leak fix: /api/events drops all
            # collab events unless participantId present + membership verifies. Omitting
            # it = SSE connects but delivers zero real-time messages. (CJack, 2026-06-05)
            url = f"{EVENTS_URL}?types=collab,system&channelId={self.channel_id}&participantId={self.participant_id}"
            headers = {}
            if self.sse_last_event_id:
                headers["Last-Event-ID"] = str(self.sse_last_event_id)

            try:
                req = urllib.request.Request(url, headers=headers)
                resp = urllib.request.urlopen(req, timeout=90)
                self._sse_resp = resp
                self.sse_connected = True
                self.sse_last_data_time = time.time()
                was_zombie = self.sse_zombie_kicked
                self.sse_zombie_kicked = False
                # Risk note #4: reset fail counter on successful connect.
                self.sse_reconnect_failures = 0
                backoff = 1
                debug(f"SSE connected to {url}{' (after zombie)' if was_zombie else ''}")

                # Catch-up poll on every connect/reconnect — covers any gap where
                # SSE was down or where server buffered messages we missed.
                self._sse_catchup_poll(was_zombie)

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
                    # Risk note #2: any received byte resets the zombie timer.
                    self.sse_last_data_time = time.time()

                    char = chunk.decode('utf-8', errors='replace')
                    buffer += char

                    if buffer.endswith('\n'):
                        line = buffer.rstrip('\n')
                        buffer = ""

                        if line == "":
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
                            pass  # SSE comment (server heartbeat) — last_data_time already updated

            except Exception as e:
                debug(f"SSE connection error: {e}")
                was_connected = self.sse_connected
                self.sse_connected = False
                self._sse_resp = None

                # Graceful post-restart: short wait, try again without counting as failure.
                if not was_connected and self.sse_reconnect_failures == 0:
                    debug("SSE disconnect after initial — reconnecting in 3s")
                    time.sleep(3)
                    continue

                self.sse_reconnect_failures += 1
                if self.sse_reconnect_failures >= SSE_MAX_FAILURES:
                    debug(f"SSE failed {self.sse_reconnect_failures} times, falling back to polling for 30s")
                    time.sleep(30)
                    # Reset and try SSE again; polling picks up in the meantime.
                    self.sse_reconnect_failures = 0
                else:
                    time.sleep(min(backoff, 30))
                    backoff = min(backoff * 2, 30)

        self.sse_connected = False
        debug("SSE listener thread stopped")

    def _sse_catchup_poll(self, was_zombie):
        """Fetch any messages that arrived while SSE was down. Queued for the poll thread."""
        try:
            if was_zombie:
                since_ts = time.time() - 120  # 2-minute window for zombie recovery
                since_iso = datetime.fromtimestamp(since_ts, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
                poll_url = (
                    f"{DEVFLOW_URL}/api/collab?channelId={self.channel_id}"
                    f"&participantId={self.participant_id}&since={since_iso}"
                )
                debug(f"SSE zombie catch-up: 2-min window since {since_iso}")
            else:
                poll_url = (
                    f"{DEVFLOW_URL}/api/collab?channelId={self.channel_id}"
                    f"&participantId={self.participant_id}&limit={MAX_CATCHUP_MESSAGES}"
                )
                if self.last_poll_time:
                    try:
                        lpt = datetime.fromisoformat(self.last_poll_time.replace('Z', '+00:00'))
                        widen_ts = lpt.timestamp() - 30  # 30s boundary widen
                        since_iso = datetime.fromtimestamp(widen_ts, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
                        poll_url += f"&since={since_iso}"
                    except Exception:
                        poll_url += f"&since={self.last_poll_time}"

            poll_req = urllib.request.Request(poll_url)
            poll_resp = urllib.request.urlopen(poll_req, timeout=5)
            poll_data = json.loads(poll_resp.read().decode('utf-8'))
            catchup_msgs = poll_data.get('messages', [])
            cutoff_ts = self.last_poll_time or ''
            queued = 0
            for msg in catchup_msgs:
                sender_id = msg.get('from', {}).get('id', '')
                msg_id = msg.get('id')
                msg_ts = msg.get('timestamp', '') or ''
                if sender_id == self.participant_id:
                    continue
                # Strict cursor filter — widen is precision-only, not re-delivery
                if cutoff_ts and msg_ts and msg_ts <= cutoff_ts:
                    continue
                with self._dedup_lock:
                    if msg_id and msg_id in self.injected_message_ids:
                        continue
                self.sse_message_queue.put(msg)
                queued += 1
            if queued:
                debug(f"SSE catch-up: queued {queued} missed message(s) of {len(catchup_msgs)} fetched")
                self._message_event.set()  # Wake the poll thread to drain
        except Exception as e:
            debug(f"SSE catch-up poll failed (non-fatal): {e}")

    def _handle_sse_event(self, event_type, event_data, event_id):
        """Process a received SSE event and queue the message for injection."""
        if event_type == "system:restarting":
            debug("SSE received system:restarting — expected reconnect")
            self.sse_connected = False
            return  # Don't count as failure

        if event_type != "collab:message":
            return
        try:
            data = json.loads(event_data)
            message = data.get("message", {})
            if not message:
                return
            sender_id = message.get("from", {}).get("id", "")
            if sender_id == self.participant_id:
                return
            if sender_id == "system":
                msg_mentions = message.get("mentions", [])
                if self.participant_id not in msg_mentions:
                    return
            recipients = message.get("recipients")
            if recipients and self.participant_id not in recipients:
                return

            # Pre-inject dedup check — avoids a queue entry we'll just drop later.
            msg_id = message.get("id")
            with self._dedup_lock:
                if msg_id and msg_id in self.injected_message_ids:
                    debug(f"SSE event: already-injected {msg_id[:8]}... dropped")
                    return

            self.sse_message_queue.put(message)
            self._message_event.set()
            debug(f"SSE queued from {message.get('from', {}).get('name', '?')}: {message.get('content', '')[:50]}")
        except json.JSONDecodeError as e:
            debug(f"SSE JSON parse error: {e}")
        except Exception as e:
            debug(f"SSE event handling error: {e}")

    def sse_zombie_watchdog(self):
        """Force-close a silent SSE connection so the listener reconnects.

        Risk note #2: if >SSE_ZOMBIE_THRESHOLD seconds since any byte received
        (including server keepalive pings), the stream is dead even if the
        socket claims alive. Close _sse_resp to break the blocking read; the
        listener re-enters its reconnect loop with sse_zombie_kicked=True so
        the next catch-up poll uses the wider 2-minute window.
        """
        debug("SSE zombie watchdog started")
        while self.running:
            try:
                if self.sse_connected and self.sse_last_data_time > 0:
                    silent_for = time.time() - self.sse_last_data_time
                    if silent_for > SSE_ZOMBIE_THRESHOLD:
                        debug(f"SSE zombie detected ({silent_for:.1f}s silent) — kicking")
                        self.sse_zombie_kicked = True
                        resp = self._sse_resp
                        if resp is not None:
                            try:
                                resp.close()
                            except Exception:
                                pass
                        self.sse_connected = False
            except Exception as e:
                debug(f"Zombie watchdog error: {e}")
            time.sleep(5)
        debug("SSE zombie watchdog stopped")

    # ------------------------------------------------------------------
    # Poll thread — consumes the SSE queue first; polls as fallback only
    # ------------------------------------------------------------------

    def poll_channel(self):
        debug("Poll thread started")
        poll_count = 0
        while self.running:
            try:
                poll_count += 1

                invite = self.check_for_invite()
                if invite:
                    if self.joined and invite.get("channelId") == self.channel_id:
                        debug("Rejoin invite detected - was likely kicked")
                        self.joined = False
                    self.join_channel(invite.get("channelId"), invite.get("channelName"))

                if poll_count % 5 == 0:
                    self.sync_name_from_ready_file()

                # Phase E: Plan Mode auto-accept — tail JSONL and run state sweeps.
                # These are fast (microseconds) and only act on state transitions,
                # safe to run every poll iteration.
                if self.input_field_ready:
                    self._tail_jsonl_for_plan_mode()
                    plan_mode_now = time.monotonic()
                    self._check_plan_mode_debounce(plan_mode_now)
                    self._check_plan_mode_accept_timeout(plan_mode_now)

                if self.current_activity == 'typing' and self.last_output_time > 0:
                    silence_time = time.time() - self.last_output_time
                    if silence_time >= self.activity_idle_threshold:
                        self.broadcast_activity('idle')

                if self.joined and self.proc and self.proc.isalive() and self.input_field_ready:
                    idle_time = time.time() - self.last_keystroke
                    if idle_time >= IDLE_THRESHOLD:
                        injected_any = False

                        # Drain SSE queue first — primary path, <50ms latency
                        while True:
                            try:
                                msg = self.sse_message_queue.get_nowait()
                            except queue.Empty:
                                break
                            if self._try_inject(msg):
                                injected_any = True

                        # Fallback: poll the API only when SSE is disconnected.
                        # Avoids double-fetch that would get filtered by dedup anyway
                        # but wastes server calls.
                        if not self.sse_connected:
                            for msg in self.check_messages():
                                if self._try_inject(msg):
                                    injected_any = True

                        if injected_any:
                            self.mark_read()

                # Clear the wake-up event if set — reloop will pick up any pending work
                self._message_event.clear()
            except Exception as e:
                debug(f"Poll error: {e}")

            # Wait up to POLL_INTERVAL, but wake early if SSE signals new messages
            self._message_event.wait(timeout=POLL_INTERVAL)
        debug("Poll thread stopped")

    def _try_inject(self, msg):
        """Dedup-check and inject a queued message. Returns True if injected."""
        msg_id = msg.get("id")
        sender_id = msg.get("from", {}).get("id", "")
        sender = msg.get("from", {}).get("name", "Unknown")
        content = msg.get("content", "")
        reply_to = msg.get("replyTo")
        mentions = msg.get("mentions", []) or []
        msg_channel_id = msg.get("channelId")  # May be absent — inject_message falls back to self.channel_id

        if sender_id == self.participant_id:
            return False
        if sender_id == "system":
            # _handle_sse_event already filters system-not-mentioning-us for SSE path;
            # poll-fallback messages reach here unfiltered.
            if self.participant_id not in mentions:
                return False

        with self._dedup_lock:
            if msg_id and msg_id in self.injected_message_ids:
                return False
            # Reserve the id BEFORE inject_message returns so a racing SSE/poll
            # handler can't double-inject while inject is mid-flight.
            if msg_id:
                self.injected_message_ids.add(msg_id)

        injected = self.inject_message(
            sender, content,
            reply_to=reply_to,
            mentions=mentions,
            channel_id=msg_channel_id,
            msg_id=msg_id,
        )
        if not injected:
            # Inject failed — un-reserve so we can retry on the next pass.
            with self._dedup_lock:
                if msg_id and msg_id in self.injected_message_ids:
                    self.injected_message_ids.discard(msg_id)
            return False
        return True

    def read_output_thread(self):
        """Read PTY output, echo to stdout, and keep a shared buffer for bootstrap-sentinel detection.

        pty_lock is DELIBERATELY NOT held around proc.read(). pywinpty's
        read() blocks until data arrives (especially during long idle
        periods). Holding pty_lock during that block would starve write
        threads — inject_message, check_pending_enter, and input forwarding
        would all hang waiting for the lock. Since only this thread calls
        read(), and ConPTY has separate in/out handles internally, concurrent
        reads + writes are safe without a shared lock.
        (Sprint 60 A1 smoke-test fix — Sam's Run-4 2026-04-22.)
        """
        debug("Read thread started")
        while self.running and self.proc and self.proc.isalive():
            try:
                try:
                    data = self.proc.read(4096)
                except Exception:
                    data = None
                if data:
                    self.last_output_time = time.time()
                    if self.joined and self.input_field_ready:
                        self.broadcast_activity('typing')
                    with self._buffer_lock:
                        self.output_buffer.append(data)
                        # Keep the buffer bounded — last ~32KB is plenty for sentinel work.
                        if len(self.output_buffer) > 256:
                            self.output_buffer = self.output_buffer[-128:]
                    sys.stdout.write(data)
                    sys.stdout.flush()
            except Exception as e:
                if self.running:
                    debug(f"Read error: {e}")
            time.sleep(0.01)
        debug("Read thread stopped")

    def input_thread_func(self):
        """Forward user keystrokes from stdin to the PTY in 4096-byte chunks.

        v1 used os.read(stdin_fd, 1) which was UTF-8-unsafe: multi-byte
        characters split across reads mangled emoji/accented input.
        """
        debug("Input thread started")
        try:
            stdin_fd = sys.stdin.fileno()
            while self.running and self.proc and self.proc.isalive():
                try:
                    data = os.read(stdin_fd, 4096)
                    if not data:
                        continue
                    self.last_keystroke = time.time()
                    try:
                        chars = data.decode('utf-8', errors='replace')
                    except Exception:
                        chars = data.decode('latin-1', errors='replace')
                    with self.pty_lock:
                        self.proc.write(chars)
                except OSError as e:
                    if e.errno == 9:  # stdin closed
                        break
                    debug(f"Input read error: {e}")
                    time.sleep(0.1)
                except Exception as e:
                    debug(f"Input thread error: {e}")
                    time.sleep(0.1)
        except Exception as e:
            debug(f"Input thread setup error: {e}")
        debug("Input thread stopped")

    # ------------------------------------------------------------------
    # Bootstrap wait — block injects until Ink's input field is live
    # ------------------------------------------------------------------

    def wait_for_input_field(self, timeout_s=BOOTSTRAP_MAX_SECONDS, min_wait_s=BOOTSTRAP_MIN_SECONDS):
        """Block until Ink's input field is interactive.

        Minimum flat wait (5s) protects against sentinel matches during
        banner/logo render; after that we scan for reliable ready
        indicators (status line 'accept edits on', prompt glyph, etc.)
        observed in Sam's 2026-04-22 verification run.
        """
        start = time.time()
        while time.time() - start < timeout_s:
            elapsed = time.time() - start
            if elapsed >= min_wait_s:
                with self._buffer_lock:
                    buf = "".join(self.output_buffer)
                if any(sentinel in buf for sentinel in BOOTSTRAP_SENTINELS):
                    self.input_field_ready = True
                    debug(f"Input field ready at t+{elapsed:.1f}s ({sum(len(c) for c in self.output_buffer)} bytes captured)")
                    return True
            time.sleep(0.2)
        # Timeout — proceed anyway but log loudly so failures are traceable.
        self.input_field_ready = True
        debug(f"WARN: no bootstrap sentinel matched within {timeout_s}s; proceeding anyway")
        return False

    # ------------------------------------------------------------------
    # Main lifecycle
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Phase D: restart loop — respawn Claude after context compaction
    # ------------------------------------------------------------------

    def _reset_state_for_respawn(self):
        """Clear every piece of per-claude-lifetime state before respawning.

        Jack's D-note #2: missing one set (e.g. injected_message_ids) causes
        the post-respawn SSE to dedupe legitimate re-fetches and silently
        drop real messages. This method is the exhaustive list.
        """
        # Phase C: Enter state — was Claude mid-submit when it died?
        with self._enter_lock:
            self.pending_enter = False
            self.pending_enter_time = 0.0
        # Phase B: SSE transport — old connection is toast; clear queue + flags
        self.sse_connected = False
        self.sse_last_data_time = 0.0
        self.sse_zombie_kicked = False
        self.sse_reconnect_failures = 0
        # Keep sse_last_event_id so Last-Event-ID reconnect picks up where we were.
        # NOTE: we do NOT close _sse_resp here — the sse_listener thread owns it
        # and will detect the kick via `self.running` / its own error handling.
        try:
            while True:
                self.sse_message_queue.get_nowait()
        except queue.Empty:
            pass
        self._message_event.clear()
        # Phase A: dedup cache — clear so catch-up poll can re-inject messages
        # the old claude.exe never actually processed (its memory is gone)
        with self._dedup_lock:
            self.injected_message_ids.clear()
        # Bootstrap state — new claude.exe, new sentinel wait required
        self.input_field_ready = False
        with self._buffer_lock:
            self.output_buffer = []
        # Activity state
        self.current_activity = 'idle'
        self.last_output_time = 0.0
        self.last_keystroke = time.time()
        # Phase E: Plan Mode state — new claude.exe, old ExitPlanMode ids are
        # meaningless. Also clear transcript path cache so _resolve_transcript
        # re-discovers (new claude_pid = new JSONL file under same project dir).
        self._pending_plan_mode.clear()
        self._accepted_plan_mode.clear()
        self._transcript_path = None
        self._plan_mode_tail_path = None
        self._plan_mode_tail_byte = None
        # Sprint 62 T1.1.c: close the persistent size-poll fd so the next claude.exe
        # gets a fresh handle on its own JSONL when the path-change check fires.
        self._close_plan_mode_tail_fd()
        # Sprint 62 T1.1.d: arm the watcher event so the first tick after respawn
        # reads whatever new state exists. The watcher thread itself survives
        # across respawns (daemon) but may have missed writes during the transition.
        self._plan_mode_change_event.set()
        debug("State reset complete — ready for respawn")

    def _spawn_claude(self, claude_path):
        """Spawn claude.exe in a ConPTY. Sets self.proc + self.claude_pid."""
        rows, cols = get_console_size()
        self.proc = PtyProcess.spawn([claude_path] + self.claude_args, dimensions=(rows, cols))
        self.claude_pid = self.proc.pid
        debug(f"Claude spawned with PID: {self.claude_pid}")
        # Set OTEL resource attributes now that we have agent name + channel.
        if self.participant_name:
            project = get_project_name()
            os.environ['OTEL_RESOURCE_ATTRIBUTES'] = (
                f"agent.name={self.participant_name},"
                f"project={project},"
                f"collab.channel={self.channel_id or ''}"
            )

    def run(self):
        _reject_unc_cwd()  # Fatal early-exit if CWD is \\wsl$\ or \\wsl.localhost\
        _resolve_wsl_tmp()

        claude_path = find_claude_binary()
        if not claude_path:
            print(
                f"Error: Claude not found. Checked:\n  primary: {CLAUDE_BINARY}\n  fallbacks: {CLAUDE_FALLBACK_PATHS}",
                file=sys.stderr,
            )
            return 1
        debug(f"Using Claude at: {claude_path}")

        # Daemon threads are started ONCE — they survive claude.exe respawns
        # and read state off self.proc / self.claude_pid which we update per cycle.
        threads_started = False

        try:
            MAX_RESTARTS = 50  # Matches WSL L2623 — do not bump for Windows parity
            restart_count = 0

            while self.running and restart_count <= MAX_RESTARTS:
                # ---- Spawn --------------------------------------------
                try:
                    self._spawn_claude(claude_path)
                except Exception as e:
                    print(f"Error spawning Claude: {e}", file=sys.stderr)
                    debug(f"Spawn error: {e}")
                    return 1

                self.register_session()

                if not threads_started:
                    # First spawn only — start daemons. They run for the wrapper lifetime.
                    threading.Thread(target=self.poll_channel, daemon=True).start()
                    threading.Thread(target=self.read_output_thread, daemon=True).start()
                    threading.Thread(target=self.sse_listener, daemon=True).start()
                    threading.Thread(target=self.sse_zombie_watchdog, daemon=True).start()
                    threading.Thread(target=self.enter_watchdog, daemon=True).start()
                    threading.Thread(target=self.input_thread_func, daemon=True).start()
                    # Sprint 62 T1.1.d: event-driven Plan Mode JSONL watcher.
                    # Noop on non-Windows; polling fallback in _tail_jsonl_for_plan_mode handles those.
                    threading.Thread(target=self._plan_mode_watcher, daemon=True).start()
                    threading.Thread(target=self.idle_heartbeat_thread, daemon=True).start()
                    threads_started = True

                # ---- Bootstrap + join --------------------------------
                self.wait_for_input_field()

                if restart_count == 0:
                    # First spawn — join the channel if one was configured.
                    if self.channel_id and not self.joined:
                        self.join_channel(self.channel_id)
                else:
                    # Respawn — participant_id is still valid server-side (we never
                    # left), but the session file needs the new claude_pid so
                    # collab_helper.py finds the live process. No re-join API call.
                    if self.joined and self.channel_id:
                        self._write_session_file(self.channel_id)
                        debug(f"Session file refreshed for respawned claude_pid={self.claude_pid}")

                # ---- Wait for this child to exit ---------------------
                debug(f"Entering wait loop for claude_pid={self.claude_pid} (restart {restart_count}/{MAX_RESTARTS})")
                while self.running and self.proc.isalive():
                    time.sleep(0.1)

                exit_status = getattr(self.proc, 'exitstatus', None)
                debug(
                    f"Claude exited (status={exit_status}, restart={restart_count}/{MAX_RESTARTS}). "
                    f"Note: Windows ConPTY may or may not surface the WSL-wrapper compaction signal — "
                    f"ambiguous exit handling flagged per D-note #4."
                )

                if not self.running:
                    break  # Wrapper is shutting down — do not respawn

                try:
                    self.proc.terminate()
                except Exception:
                    pass

                if restart_count >= MAX_RESTARTS:
                    debug(f"MAX_RESTARTS ({MAX_RESTARTS}) reached — exiting cleanly")
                    break

                # ---- Reset wrapper state for respawn -----------------
                self._reset_state_for_respawn()
                restart_count += 1
                debug(f"Restarting Claude (attempt {restart_count}/{MAX_RESTARTS})...")
                time.sleep(2)  # Brief settle between respawns

        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
            debug(f"Run loop error: {e}")
            return 1
        finally:
            self.running = False
            self.leave_channel()
            self.unregister_session()
            # Sprint 62 T1.1.c: drop the persistent size-poll fd on shutdown.
            self._close_plan_mode_tail_fd()
            if self.proc and self.proc.isalive():
                self.proc.terminate()
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
    parser = argparse.ArgumentParser(description="Claude with collab support (Windows)")
    parser.add_argument("--channel", "-c", help="Channel ID to join")
    parser.add_argument("--name", "-n", help="Display name")
    parser.add_argument("--list", "-l", action="store_true", help="List channels")
    parser.add_argument(
        "--system-prompt-file",
        help="Read system prompt from file (shell-safe alternative to --append-system-prompt)",
    )

    args, claude_args = parser.parse_known_args()

    if args.system_prompt_file:
        try:
            with open(args.system_prompt_file, 'r', encoding='utf-8') as f:
                prompt_content = f.read().strip()
            if prompt_content:
                claude_args = ['--append-system-prompt', prompt_content] + claude_args
        except Exception as e:
            print(f"[Collab] Warning: Could not read system prompt file: {e}", file=sys.stderr)

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
