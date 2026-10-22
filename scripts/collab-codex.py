#!/usr/bin/env python3
"""
collab-codex.py — OpenAI Codex CLI collab wrapper (Sprint 64)

Wraps the Codex CLI using pexpect for proper PTY handling.
All Codex sessions started with this wrapper can be dynamically
pulled into DevFlow collab channels.

Modelled on collab-claude.py. Key differences:
  - Binary: ~/.nvm/.../bin/codex
  - System prompt: AGENTS.md in working dir (not --append-system-prompt)
  - JSONL: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  - Completion signal: response_item with payload.phase=='final_answer'
  - No Plan Mode (Codex has no equivalent)
  - agentType: "codex"

Usage:
  collab-codex --channel <id> [codex args...]
  collab-codex [codex args...]  # Start without channel
"""

import os

DEVFLOW_HOME = os.environ.get("DEVFLOW_HOME") or os.path.join(os.path.expanduser("~"), "DevFlow")
# Who the people are is configuration, not code. Unset: neutral wording (our own agents set these in their environment).
OWNER_PROSE = os.environ.get("DEVFLOW_OWNER_NAME", "").strip() or "the owner"
ARCHITECT_NAME = os.environ.get("DEVFLOW_ARCHITECT_NAME", "").strip() or "the Architect"
LEAD_NAME = os.environ.get("DEVFLOW_LEAD_NAME", "").strip() or "the Team Lead"
os.environ["COLLAB_AGENT_WRAPPER"] = "1"
import codecs
import sys
import json
import time
import signal
import argparse
import threading
import queue
import datetime
import re
import urllib.request
import urllib.error
import urllib.parse
import subprocess
import random

import proc_info
from codex_workspace_trust import ensure_codex_workspace_trusted
from design_reference_harness import (
    codex_design_gate_args,
    validate_codex_managed_gate_if_required,
)

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


# ---------------------------------------------------------------------------
# Codex JSONL helpers (replaces jsonl_state_reader import from collab-claude.py)
# Codex writes ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
# Turn-complete signal: response_item event with payload.phase == 'final_answer'
# ---------------------------------------------------------------------------

CODEX_JSONL_TAIL_BYTES = 32768  # 32KB tail for state scanning
CODEX_CONTEXT_TAIL_BYTES = 262144  # Bounded tail for latest token_count sample
CODEX_AUTO_COMPACT_RATIO = 0.68  # Compact before observed long-session degradation (~70%)
CODEX_AUTO_COMPACT_COOLDOWN_SECONDS = 300.0

COLLAB_RESPONSE_ACTION_RE = re.compile(
    r'["\']action["\']\s*:\s*["\']collab\.(?:message|cross_channel_message)["\']'
)


def contains_collab_response_signal(buffer):
    """Detect a real local or cross-channel collab send in recent TUI output."""
    return (
        ('Bash(' in buffer and 'collab_helper' in buffer)
        or COLLAB_RESPONSE_ACTION_RE.search(buffer) is not None
    )


def select_working_wsl_interop(candidates, probe):
    """Return the first WSL interop socket that can launch a Windows process."""
    for candidate in candidates:
        try:
            probe(candidate)
            return candidate
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def refresh_wsl_interop_environment():
    """Replace a stale inherited WSL_INTEROP before Codex starts.

    Long-lived DevFlow processes can retain an interop endpoint from a WSL
    session that no longer exists. Codex probes ``cmd.exe`` during startup; a
    stale socket leaves that probe hanging before the TUI can render.
    """
    inherited = os.environ.get('WSL_INTEROP')
    candidates = []
    if inherited:
        candidates.append(inherited)
    try:
        names = sorted(
            (name for name in os.listdir('/run/WSL') if re.fullmatch(r'\d+_interop', name)),
            key=lambda name: int(name.split('_', 1)[0]),
            reverse=True,
        )
        candidates.extend(os.path.join('/run/WSL', name) for name in names)
    except OSError:
        pass

    candidates = list(dict.fromkeys(candidates))

    def probe(socket_path):
        if not os.path.exists(socket_path):
            raise FileNotFoundError(socket_path)
        env = os.environ.copy()
        env['WSL_INTEROP'] = socket_path
        subprocess.run(
            ['/mnt/c/WINDOWS/system32/cmd.exe', '/d', '/s', '/c', 'exit', '0'],
            cwd='/mnt/c',
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
            check=True,
        )

    working = select_working_wsl_interop(candidates, probe)
    if working:
        os.environ['WSL_INTEROP'] = working
        debug(f"Using working WSL interop endpoint: {working}")
    else:
        os.environ.pop('WSL_INTEROP', None)
        debug("No working WSL interop endpoint found; removed stale WSL_INTEROP")
    return working


class Utf8StreamDecoder:
    """Incrementally decode a byte stream without splitting UTF-8 code points."""

    def __init__(self):
        self._decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')

    def decode(self, chunk: bytes, final: bool = False) -> str:
        return self._decoder.decode(chunk, final=final)

# Startup banners are rendered by the Codex TUI with styling and cursor/title
# updates that may be split across pexpect output chunks. Matching uses a
# normalised copy; output_filter still returns the original data unchanged.
ANSI_OSC_RE = re.compile(r'\x1b\](?:[^\x1b\x07]|\x1b(?!\\))*(?:\x07|\x1b\\)')
ANSI_OSC_INCOMPLETE_RE = re.compile(r'\x1b\][^\x1b\x07]*$')
ANSI_CSI_RE = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
ANSI_ESCAPE_RE = re.compile(r'\x1b[@-_]')


def _strip_terminal_controls(text: str) -> str:
    """Strip ANSI OSC/CSI and residual C0 controls from terminal output."""
    text = ANSI_OSC_RE.sub('', text)
    text = ANSI_OSC_INCOMPLETE_RE.sub('', text)
    text = ANSI_CSI_RE.sub('', text)
    text = ANSI_ESCAPE_RE.sub('', text)
    return ''.join(char for char in text if ord(char) >= 32 and ord(char) != 127)


def _normalise_cwd(path: str) -> str:
    """Return a stable path identity for transcript ownership checks."""
    return os.path.realpath(os.path.abspath(os.path.expanduser(path)))


def _transcript_session_cwd(jsonl_path: str) -> str | None:
    """Read the first session_meta payload cwd from a Codex rollout."""
    try:
        with open(jsonl_path, "r", errors="replace") as f:
            # session_meta is the first event in normal rollouts. Keep the read
            # bounded so corrupt/non-Codex JSONL files cannot cause a full scan.
            for _ in range(64):
                line = f.readline()
                if not line:
                    break
                try:
                    entry = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if entry.get("type") != "session_meta":
                    continue
                cwd = entry.get("payload", {}).get("cwd")
                return cwd if isinstance(cwd, str) and cwd else None
    except (FileNotFoundError, PermissionError, OSError):
        pass
    return None


def _process_tree_pids(root_pid: int | None) -> list[int]:
    """Return ``root_pid`` and its descendants (read from /proc on Linux, from pgrep on macOS)."""
    if not root_pid:
        return []
    pending = [int(root_pid)]
    seen = set()
    while pending and len(seen) < 128:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        pending.extend(proc_info.children(pid))
    return list(seen)


def resolve_codex_transcript_for_pid(root_pid: int | None, expected_cwd: str | None = None) -> str | None:
    """Resolve the rollout actually opened by a Codex process tree.

    The files a process has open (/proc/<pid>/fd, or lsof on macOS) provide a process-owned session identity. This is stronger
    than cwd+mtime, which aliases when multiple agents share one project.
    """
    expected = _normalise_cwd(expected_cwd) if expected_cwd else None
    candidates = set()
    for pid in _process_tree_pids(root_pid):
        for target in proc_info.open_files(pid):
            if '/.codex/sessions/' not in target or not target.endswith('.jsonl'):
                continue
            if expected:
                cwd = _transcript_session_cwd(target)
                if not cwd or _normalise_cwd(cwd) != expected:
                    continue
            candidates.add(target)
    if not candidates:
        return None
    try:
        return max(candidates, key=os.path.getmtime)
    except (FileNotFoundError, OSError):
        return None


def resolve_codex_transcript_path(
    expected_cwd: str | None = None,
    not_before: float | None = None,
) -> str | None:
    """Find the newest Codex rollout for a cwd and child-start boundary.

    This is a fallback for the process-owned `/proc` resolver. It scans the
    complete session tree so long-lived sessions survive calendar rollover,
    but rejects rollouts predating the current child.
    """
    home = os.path.expanduser("~")
    normalised_expected = _normalise_cwd(expected_cwd) if expected_cwd else None
    sessions_root = os.path.join(home, '.codex', 'sessions')
    candidates = []
    try:
        for root, _dirs, names in os.walk(sessions_root):
            for name in names:
                if not name.endswith('.jsonl'):
                    continue
                candidate = os.path.join(root, name)
                try:
                    if not_before is not None and os.path.getmtime(candidate) < not_before - 2.0:
                        continue
                except OSError:
                    continue
                if normalised_expected:
                    session_cwd = _transcript_session_cwd(candidate)
                    if not session_cwd or _normalise_cwd(session_cwd) != normalised_expected:
                        continue
                candidates.append(candidate)
    except (OSError, FileNotFoundError):
        return None
    if not candidates:
        return None
    try:
        return max(candidates, key=os.path.getmtime)
    except (OSError, FileNotFoundError):
        return None


def check_codex_jsonl_state(jsonl_path: str, after_byte: int = 0) -> str | None:
    """Scan Codex JSONL for turn completion.

    Returns:
        'idle'       — response_item with payload.phase='final_answer' found (turn complete)
        'processing' — any response_item after the most recent final_answer
        None         — no relevant events or file unavailable

    Note: discriminator is payload.phase == 'final_answer', NOT payload.channel == 'final'.
    Confirmed against live JSONL shape: type=response_item, payload.role=assistant,
    payload.phase=final_answer, payload.content[0].type=output_text.
    """
    try:
        file_size = os.path.getsize(jsonl_path)
        if file_size == 0 or file_size <= after_byte:
            return None

        with open(jsonl_path, "r", errors="replace") as f:
            start = max(after_byte, file_size - CODEX_JSONL_TAIL_BYTES)
            if start > 0:
                f.seek(start)
                f.readline()  # discard partial first line
            content = f.read()

        for line in reversed(content.splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if (entry.get("type") == "event_msg"
                    and entry.get("payload", {}).get("type") in {"task_complete", "turn_aborted"}):
                # Both events are terminal boundaries. In particular, Codex can
                # write a reasoning response_item immediately before
                # turn_aborted; treating that older item as active leaves the
                # wrapper permanently busy after a manual recovery interrupt.
                return "idle"
            if entry.get("type") != "response_item":
                continue
            payload = entry.get("payload", {})
            phase = payload.get("phase")
            if phase == "final_answer":
                return "idle"
            # Codex reasoning and tool-call response_items do not carry
            # role='assistant'. Treat the newest non-final response_item as
            # active work; otherwise an older final_answer can incorrectly
            # make a busy startup/tool turn appear idle.
            return "processing"

        return None
    except (FileNotFoundError, PermissionError, OSError):
        return None


# Mirrors jsonl_state_reader.NO_REPLY_MARKER: an agent that deliberately sends
# nothing ends its final answer with a line holding only this marker, so a turn
# that also did other work (and so ends in text) can still close quietly.
NO_REPLY_MARKER = "NO_REPLY"


def _ends_with_no_reply_marker(text) -> bool:
    if not isinstance(text, str):
        return False
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return bool(lines) and lines[-1] == NO_REPLY_MARKER


def codex_final_response_disposition(jsonl_path: str, after_byte: int = 0) -> str | None:
    """Classify the Codex turn that completed after `after_byte`.

    Mirrors jsonl_state_reader.final_response_disposition for the Codex
    transcript shape, so both wrappers answer the same question the same way.

    'text'  — a final_answer carrying non-empty output_text
    'empty' — the turn reached task_complete AND carried an explicit, parseable
              final answer whose text was blank or ended with a line holding
              only NO_REPLY_MARKER
    None    — unknown: unreadable, truncated, still running, or aborted. An
              aborted turn is an interruption, not a decision to stay silent, so
              it stays unknown and the caller keeps its warning.
    """
    try:
        file_size = os.path.getsize(jsonl_path)
        if file_size <= after_byte:
            return None
        with open(jsonl_path, "r", errors="replace") as f:
            if after_byte:
                # Discard a partial line only when the boundary falls mid-line;
                # on an exact newline this would eat the new turn's first entry.
                f.seek(after_byte - 1)
                if f.read(1) != "\n":
                    f.readline()
            content = f.read()
    except (FileNotFoundError, PermissionError, OSError):
        return None

    pending_final_text = None
    disposition = None
    for line in content.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            # Do not retain an earlier blank completion across unreadable data:
            # the malformed/truncated record may be the current final answer.
            return None
        if not isinstance(entry, dict):
            return None
        etype = entry.get("type")
        payload = entry.get("payload")
        if etype in {"event_msg", "response_item"} and not isinstance(payload, dict):
            return None
        payload = payload or {}
        if etype == "event_msg":
            ptype = payload.get("type")
            if ptype == "task_started":
                # A new turn invalidates any older completed disposition. If
                # this turn has not produced a trustworthy final yet, silence
                # is not proven and the corrective must remain enabled.
                disposition = None
                pending_final_text = None
            elif ptype == "task_complete":
                # Pair completion only with the immediately pending final from
                # the same transcript sequence. A task_complete without one is
                # an unknown completed turn and must override any older result.
                if pending_final_text is True:
                    disposition = "text"
                elif pending_final_text is False:
                    disposition = "empty"
                else:
                    disposition = None
                pending_final_text = None
            elif ptype == "turn_aborted":
                return None  # interrupted, not silent
            continue
        if etype == "response_item" and payload.get("role") == "user":
            # Defensive mirror of task_started for transcripts where the event
            # is absent or truncated but the user message itself is present.
            disposition = None
            pending_final_text = None
            continue
        if etype == "response_item" and payload.get("phase") == "final_answer":
            # A final envelope without a structurally valid content field is
            # not an explicit blank answer. Keep the result unknown so corrupt
            # transcript data cannot suppress the corrective (or crash us).
            blocks = payload.get("content")
            if not isinstance(blocks, list):
                return None
            final_text = "\n".join(
                b.get("text") or ""
                for b in blocks
                if isinstance(b, dict)
                and b.get("type") == "output_text"
                and isinstance(b.get("text"), str)
            )
            pending_final_text = bool(final_text.strip())
            if not pending_final_text and any(not isinstance(b, dict) for b in blocks):
                return None
            if pending_final_text and _ends_with_no_reply_marker(final_text):
                # Explicit no-reply marker: treat exactly like a blank final,
                # which still needs task_complete before it proves silence.
                pending_final_text = False
        elif etype == "response_item" and pending_final_text is not None:
            # A non-final response item after a candidate final starts another
            # sequence; a later completion must not pair with the older final.
            pending_final_text = None
    if pending_final_text is True:
        # Non-empty text is enough to preserve the corrective even if the
        # completion record has not landed yet.
        return "text"
    # 'empty' requires BOTH a completed turn and an explicit, parseable final
    # answer that was blank. Either alone is unknown:
    #   - task_complete with no parseable final answer could be a malformed or
    #     truncated final-response line that the parser skipped — classifying
    #     that as silence would suppress a genuinely lost reply;
    #   - a blank final answer without task_complete is a turn still in flight.
    if pending_final_text is False:
        return None
    return disposition


def read_codex_context_usage(jsonl_path: str) -> tuple[int, int] | None:
    """Return the latest live-context token count and model window.

    Codex writes cumulative and per-turn usage in ``event_msg.token_count``.
    ``last_token_usage.total_tokens`` is the current live context; cumulative
    totals grow for the lifetime of a rollout and cannot drive compaction.
    """
    try:
        file_size = os.path.getsize(jsonl_path)
        if file_size <= 0:
            return None
        with open(jsonl_path, "rb") as handle:
            start = max(0, file_size - CODEX_CONTEXT_TAIL_BYTES)
            handle.seek(start)
            content = handle.read()
        lines = content.splitlines()
        if start > 0 and lines:
            lines = lines[1:]  # discard a possibly partial first JSONL record
        for raw_line in reversed(lines):
            try:
                entry = json.loads(raw_line)
            except (json.JSONDecodeError, UnicodeDecodeError, ValueError, TypeError):
                continue
            if entry.get("type") != "event_msg":
                continue
            payload = entry.get("payload") or {}
            if payload.get("type") != "token_count":
                continue
            info = payload.get("info") or {}
            usage = info.get("last_token_usage") or {}
            used = usage.get("total_tokens")
            window = info.get("model_context_window")
            if isinstance(used, (int, float)) and isinstance(window, (int, float)) and window > 0:
                return int(used), int(window)
        return None
    except (FileNotFoundError, PermissionError, OSError):
        return None


def verify_codex_message_ingested(jsonl_path: str, search_text: str, after_byte: int = 0) -> bool:
    """Check if search_text appears in Codex JSONL after after_byte offset."""
    try:
        file_size = os.path.getsize(jsonl_path)
        if file_size <= after_byte:
            return False
        with open(jsonl_path, "r", errors="replace") as f:
            f.seek(after_byte)
            content = f.read(file_size - after_byte)
        return search_text in content
    except (FileNotFoundError, PermissionError, OSError):
        return False


def delivery_token(message_id: str, participant_id: str | None = None) -> str:
    """Stable recipient-scoped idempotency token for one Codex user turn."""
    identity = f"{participant_id}:{message_id}" if participant_id else message_id
    return f"[[collab-delivery:{identity}]]"


def find_codex_delivery_token_offset(jsonl_path: str, token: str, after_byte: int = 0) -> int | None:
    """Prove ingestion from a complete typed user-input record, never an echo."""
    if not isinstance(token, str) or not token or after_byte < 0:
        return None
    try:
        token_bytes = token.encode('utf-8')
        with open(jsonl_path, 'rb') as f:
            # An existing partial record straddling the saved boundary is not
            # a new user input. Never parse a JSON fragment as a whole record.
            if after_byte:
                f.seek(after_byte - 1)
                if f.read(1) != b'\n':
                    f.readline()
            while True:
                start = f.tell()
                line = f.readline(1024 * 1024)
                if not line:
                    return None
                if not line.endswith(b'\n'):
                    # Bound memory even for giant tool records, and do not
                    # accept a still-being-written user record before newline.
                    while line and not line.endswith(b'\n'):
                        line = f.readline(1024 * 1024)
                    continue
                if token_bytes not in line:
                    continue
                try:
                    entry = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                if not isinstance(entry, dict) or entry.get('type') != 'response_item':
                    continue
                payload = entry.get('payload')
                if not isinstance(payload, dict) or payload.get('role') != 'user':
                    continue
                content = payload.get('content')
                if not isinstance(content, list):
                    continue
                for item in content:
                    if (isinstance(item, dict) and item.get('type') == 'input_text'
                            and isinstance(item.get('text'), str)
                            and token in item['text'].splitlines()):
                        return start + line.index(token_bytes) + len(token_bytes)
    except (FileNotFoundError, PermissionError, OSError):
        return None


# Configuration
DEVFLOW_URL = __import__("os").environ.get("DEVFLOW_URL", "http://localhost:3000").rstrip("/")
API_BASE = f"{DEVFLOW_URL}/api/collab"
DELIVERY_API_BASE = f"{DEVFLOW_URL}/api/collab/deliveries"
VOICE_TURN_CANCEL_API_BASE = f"{DEVFLOW_URL}/api/voice/turn/cancel"
DELIVERY_PROTOCOL = "ledger-v1"
ALERTS_API = f"{DEVFLOW_URL}/api/alerts"
# A wrapper whose durable claims are refused because it is not the seat's current
# owner (HTTP 409) re-asserts its identity, then reports itself degraded instead
# of retrying every second for hours while its heartbeat says idle (Jack, 15-17
# Oct 2026: 85,573 refused claims, 37 hours of "online").
CLAIM_REFUSAL_REPAIR_AFTER = 3
CLAIM_REPAIR_MIN_GAP_SECONDS = 60.0
CLAIM_REFUSAL_DEGRADE_AFTER_SECONDS = 90.0
CLAIM_NORMAL_INTERVAL_SECONDS = 1.0
CLAIM_REFUSED_INTERVAL_SECONDS = 30.0
CLAIM_REFUSAL_LOG_EVERY_SECONDS = 60.0
CLAIM_FAULT_DETAIL = "Not picking up messages: delivery claims refused"
ACTIVE_DELIVERY_LOCAL_MAX_SECONDS = 120.0
STALE_JSONL_PROCESSING_SECONDS = 30.0
STARTUP_READY_TIMEOUT_SECONDS = 60.0
POLL_INTERVAL = 2  # seconds
IDLE_THRESHOLD = 1.5  # seconds since last keystroke before injecting
MAX_CATCHUP_AGE_SECONDS = 480  # Max age (8 min) for inbox file catch-up only (the owner's directive: older messages dropped)
MAX_CATCHUP_MESSAGES = 50  # Max messages to fetch on reconnect catch-up (replaces time-based cap for SSE/poll paths)

# Codex binary path
CODEX_BINARY = os.path.expanduser("~/.nvm/versions/node/v20.19.5/bin/codex")

# Debug log
DEBUG_LOG = "/tmp/collab-codex-debug.log"

# Deterministic startup failures must not enter the normal session restart loop.
# These markers are matched only against the bounded pre-ready output buffer.
FATAL_STARTUP_MARKERS = (
    "Error loading config.toml",
)
STARTUP_READY_MARKERS = (
    ">_ OpenAI Codex (v",
)
STARTUP_TRUST_MARKERS = (
    "Do you trust the contents of this directory?",
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


class CollabCodexWrapper:
    def __init__(self, channel_id=None, participant_name=None, codex_args=None,
                 agent_name=None, agent_dir=None, model=None, effort=None,
                 fast_mode=None):
        self.channel_id = channel_id
        self.channel_name = ""  # Resolved channel display name (set in join_channel)
        self.participant_name = participant_name
        self.participant_id = None
        self.codex_args = codex_args or []
        self.model = model or 'gpt-6-astra'
        self.effort = effort  # reasoning effort: low|medium|high|xhigh|max|ultra (maps to model_reasoning_effort)
        self.fast_mode = fast_mode  # True -> service_tier=fast; False -> default
        self.MAX_RESPONSE_CHARS = 8000  # Truncate responses before auto-posting
        # Session-bound hook support. Per-message hooks are intentionally disabled;
        # durable scaffolding is loaded at startup and DevFlow records outcomes.
        self.agent_name = agent_name  # e.g. "an agent"
        self.agent_dir = agent_dir    # e.g. "~/SG-1/Team/an agent"
        self.child = None  # pexpect child process
        self.last_keystroke = time.time()
        self.last_poll_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.running = True
        self.joined = False
        self.codex_pid = None  # Claude's PID (child), used for registration
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
        # NOTE: This is NOT a hard timeout. After 3s of silence, we CHECK CPU activity.
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
        self.last_injected_source_channel = None  # Cross-channel delivery: channel the reply goes to
        self.last_injected_was_mentioned = False  # True if the message we're processing was a direct @mention
        self.last_injected_msg_id = None  # Message ID currently being processed
        self._response_window_msg_id = None  # Logical inbound owning last_inject_time_iso
        self._corrective_sent_msg_id = None  # At most one corrective turn per inbound message
        self.delivery_timeout_logged = False  # True if 60s timeout already logged for current msg
        self.last_cpu_times = {}  # Track CPU times for process tree to detect thinking
        # Deferred Enter mechanism - send text first, Enter later when idle
        self.pending_enter = False  # True if text was sent but Enter not yet
        self.pending_submit_key = 'Enter'  # Enter when idle; Tab queues during an active turn
        self.pending_mark_read = False  # True if mark_read should fire after Claude finishes processing
        self.pending_mark_read_timestamp = None  # Timestamp of the message being processed
        self.pending_enter_time = 0  # When text was sent
        self._enter_lock = threading.Lock()  # Protects pending_enter read-check-act across threads
        self.enter_idle_threshold = 0.5  # Seconds of no output before sending Enter
        # SSE push: real-time message delivery (replaces polling for messages)
        self.sse_connected = False  # True when SSE stream is active
        self.sse_message_queue = queue.Queue()  # Messages received via SSE
        self.sse_last_event_id = None  # For reconnection with Last-Event-ID
        self.sse_reconnect_failures = 0  # Count consecutive SSE failures
        self.sse_max_failures = 5  # Fall back to polling after this many failures
        self.sse_last_data_time = 0  # When we last received any byte from the stream (for zombie detection)
        self._sse_resp = None  # Current SSE response object — allows external close() to break blocking read
        self.sse_zombie_kicked = False  # True if last disconnect was zombie-triggered (wider catch-up on reconnect)
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
        self._voice_delivery_wakeup = threading.Event()
        # Codex JSONL state tracking
        self._last_jsonl_state: str | None = None  # Previous state for change-based logging
        self._jsonl_check_count = 0  # Throttle repeated processing-state diagnostics
        self._auto_compact_last_attempt_mono = 0.0
        # Set when this wrapper fires /compact; cleared once the rules are re-read.
        self._post_compact_reinject_pending = False
        # JSONL ingestion verification (Sprint 45 T2.1)
        self._verify_pending = False  # True while waiting for JSONL confirmation
        self._verify_search_text: str | None = None  # Snippet to find in enqueue entry
        self._verify_after_byte: int = 0  # JSONL size before Enter — scan only new entries
        self._verify_start_time: float = 0  # When verification started (monotonic)
        self._verify_msg_id: str | None = None  # Message ID being verified
        self._verify_msg_ts: str | None = None  # Message timestamp for cursor advancement on verify
        self._verify_timeout: float = 5.0  # Seconds before declaring ingestion failure
        self._base_verify_timeout: float = 5.0  # Base timeout for exponential backoff
        # Delivery retry tracking (Sprint 45 T3.4)
        self._retry_attempts: dict = {}  # msg_id → retry count
        self.MAX_DELIVERY_RETRIES: int = 3
        # Codex JSONL state (completion detection)
        self._codex_transcript_path: str | None = None
        self._codex_transcript_byte: int = 0  # byte offset after last inject
        self._inject_transcript_byte: int = 0  # byte offset at moment of last inject — only extract responses AFTER this
        # Per-child lifecycle: a spawned PID is not advertised as ready until
        # the Codex TUI banner proves startup completed.
        self._child_startup_output = ''
        self._child_startup_proven = False
        self._child_ready_registered = False
        self._fatal_startup_error: str | None = None
        self._child_spawn_wall = 0.0
        self._child_spawn_mono = 0.0
        self._startup_trust_answered = False
        # Durable delivery authority. This wrapper advertises the protocol at
        # join; the server opts in only after that capability is persisted.
        self.delivery_protocol = DELIVERY_PROTOCOL
        self._active_delivery: dict | None = None
        self._active_delivery_started_mono = 0.0
        self._renew_delivery_supported = True
        self._last_delivery_claim_mono = 0.0
        self._delivery_claim_interval = CLAIM_NORMAL_INTERVAL_SECONDS
        self._claim_refusals = 0
        self._claim_refusing_since = 0.0
        self._claim_degraded = False
        self._claim_fault_alerted = False
        self._last_claim_repair_mono = 0.0
        self._claim_refusal_log_mono = 0.0
        self._claim_refusals_unlogged = 0
        self._delivery_recovery_checked = False
        self._last_delivery_recovery_mono = 0.0
        self._verify_timeout_logged = False
        self._voice_cancel_interrupts: set = set()
        # A new spoken turn may arrive after the current turn has already sent
        # its correlated reply but while Codex is still doing background work.
        # Track the one C-c sent for that delivery so a transient handled ACK
        # failure cannot cause repeated interrupts.
        self._voice_followup_interrupts: set = set()

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

    # Plan Mode methods removed — Codex has no Plan Mode equivalent.


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

    def _tmux_send(self, text, enter=False, key=None):
        """Send literal text and an optional submit key via tmux (thread-safe).

        Routes through tmux → pane stdin → interact() select loop → child_fd.
        This avoids concurrent os.write(child_fd) races between poll/watchdog threads.
        Falls back to pexpect.send() (with lock) if not running inside tmux.

        Args:
            text: Literal text to send (empty string OK when submitting a key).
            enter: Backward-compatible shorthand for ``key='Enter'``.
            key: Optional named key (``Enter``, ``Tab``, or ``C-u``).
        Returns:
            True on success, False on failure.
        """
        submit_key = key or ('Enter' if enter else None)
        if submit_key not in (None, 'Enter', 'Tab', 'C-u'):
            debug(f"_tmux_send rejected unsupported key: {submit_key}")
            return False

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
                if submit_key:
                    fallback_keys = {'Enter': '\r', 'Tab': '\t', 'C-u': '\x15'}
                    self.child.send(fallback_keys[submit_key])
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
            if submit_key:
                result = _run_with_retry(
                    ['tmux', 'send-keys', '-t', self.tmux_pane_target, submit_key]
                )
                if result.returncode != 0:
                    debug(f"_tmux_send {submit_key} failed (rc={result.returncode}): {result.stderr.strip()}")
                    return False
            return True
        except Exception as e:
            debug(f"_tmux_send error: {e}")
            return False

    def _send_child_input(self, text='', key=None, bracketed=False):
        """Write automated input directly to Codex's child PTY.

        Automated input sent through the outer tmux pane is relayed by
        ``pexpect.interact()`` in 1000-byte reads. Codex can therefore redraw
        or submit before a long prompt has fully arrived. A direct, locked PTY
        write bypasses that relay, and bracketed paste makes the prompt one TUI
        paste operation. The loop also prevents short writes from truncating it.
        """
        if key not in (None, 'Enter', 'Tab', 'C-u', 'C-c'):
            debug(f"_send_child_input rejected unsupported key: {key}")
            return False

        key_bytes = {'Enter': b'\r', 'Tab': b'\t', 'C-u': b'\x15', 'C-c': b'\x03'}
        payload = text.encode('utf-8') if text else b''
        if payload and bracketed:
            payload = b'\x1b[200~' + payload + b'\x1b[201~'
        if key:
            payload += key_bytes[key]
        if not payload:
            return True

        lock = getattr(self, '_child_write_lock', None)
        if lock is None:
            lock = threading.Lock()
            self._child_write_lock = lock

        try:
            with lock:
                child = getattr(self, 'child', None)
                if not (child and child.isalive()):
                    return False
                child_fd = getattr(child, 'child_fd', None)
                if not isinstance(child_fd, int) or child_fd < 0:
                    debug("_send_child_input: child PTY fd unavailable")
                    return False
                written = 0
                while written < len(payload):
                    count = os.write(child_fd, payload[written:])
                    if count <= 0:
                        debug(
                            f"_send_child_input: zero-byte write after "
                            f"{written}/{len(payload)} bytes"
                        )
                        return False
                    written += count
            return True
        except (OSError, ValueError) as e:
            debug(f"_send_child_input failed: {e}")
            return False

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

    def _capture_background_pids(self):
        """Snapshot Claude's child PIDs shortly after spawn to identify background daemons.

        MCP servers and other persistent helpers are spawned at startup and run
        indefinitely. Their background CPU (event loops, heartbeats) would otherwise
        keep is_process_tree_active() returning True even when Claude is idle.
        Called once via a daemon thread ~3s after Claude spawns.
        """
        if not self.codex_pid:
            return
        try:
            result = subprocess.run(
                ['pgrep', '-P', str(self.codex_pid)],
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

    def _delivery_api_call(self, payload):
        """Call the durable-delivery endpoint; failures leave server state replayable."""
        try:
            req = urllib.request.Request(
                DELIVERY_API_BASE,
                data=json.dumps(payload).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read().decode('utf-8')).get('error', str(e))
            except Exception:
                detail = str(e)
            if e.code == 409 and 'current wrapper' in str(detail):
                self._log_claim_refusal(detail)
            else:
                debug(f"Delivery API conflict/error ({e.code}): {detail}")
            return {'error': detail, 'status': e.code}
        except Exception as e:
            debug(f"Delivery API error: {e}")
            return {'error': str(e)}

    def _fetch_delivery_records(self, message_id=None):
        """Read server-owned delivery state for voice follow-up fencing."""
        query = {
            'channelId': getattr(self, 'channel_id', None),
            'participantId': getattr(self, 'participant_id', None),
        }
        if message_id:
            query['messageId'] = message_id
        try:
            request = urllib.request.Request(
                f"{DELIVERY_API_BASE}?{urllib.parse.urlencode(query)}",
                method='GET',
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                body = json.loads(response.read().decode('utf-8'))
            records = body.get('records') if isinstance(body, dict) else None
            return records if isinstance(records, list) else []
        except Exception as e:
            debug(f"Delivery API read failed: {e}")
            return []

    def _voice_cancel_api_call(self, payload=None, method='GET'):
        """Call the local synthetic voice-cancel contract."""
        try:
            if method == 'GET':
                query = urllib.parse.urlencode(payload or {})
                request = urllib.request.Request(
                    f"{VOICE_TURN_CANCEL_API_BASE}?{query}", method='GET'
                )
            else:
                request = urllib.request.Request(
                    VOICE_TURN_CANCEL_API_BASE,
                    data=json.dumps(payload or {}).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    method='POST',
                )
            with urllib.request.urlopen(request, timeout=3) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode('utf-8'))
            except Exception:
                body = {'error': str(e.reason)}
            body['status'] = e.code
            return body
        except Exception as e:
            debug(f"Voice cancel API call failed: {e}")
            return {'error': str(e)}

    def _delivery_owner_id(self):
        return (
            f"codex:{getattr(self, 'participant_id', None) or 'unjoined'}:"
            f"{getattr(self, 'wrapper_pid', os.getpid())}"
        )

    def _uses_durable_delivery(self):
        return getattr(self, 'delivery_protocol', None) == DELIVERY_PROTOCOL

    @staticmethod
    def _is_owner_refusal(result):
        """True when the server refused because this wrapper is not the seat's current owner."""
        return (
            isinstance(result, dict)
            and result.get('status') == 409
            and 'current wrapper' in str(result.get('error', ''))
        )

    def _log_claim_refusal(self, detail):
        """One log line a minute for a refusal that can repeat every second."""
        now = time.monotonic()
        if now - getattr(self, '_claim_refusal_log_mono', 0.0) >= CLAIM_REFUSAL_LOG_EVERY_SECONDS:
            suppressed = getattr(self, '_claim_refusals_unlogged', 0)
            note = f" ({suppressed} more since the last note)" if suppressed else ""
            debug(f"Delivery API conflict/error (409): {detail}{note}")
            self._claim_refusal_log_mono = now
            self._claim_refusals_unlogged = 0
        else:
            self._claim_refusals_unlogged = getattr(self, '_claim_refusals_unlogged', 0) + 1

    def _note_claim_result(self, result):
        """Track owner refusals of durable claims. Returns True when this claim was refused.

        A refusal is a fault of this seat, not an empty queue: re-assert the
        wrapper's identity, then stop reporting idle and raise an alert if the
        server still refuses, and slow the retries so a stuck seat does not hammer
        the server for hours.
        """
        if not self._is_owner_refusal(result):
            if getattr(self, '_claim_refusals', 0):
                self._recover_from_claim_refusals()
            return False
        now = time.monotonic()
        if not getattr(self, '_claim_refusals', 0):
            self._claim_refusing_since = now
        self._claim_refusals = getattr(self, '_claim_refusals', 0) + 1
        if (self._claim_refusals >= CLAIM_REFUSAL_REPAIR_AFTER
                and now - getattr(self, '_last_claim_repair_mono', 0.0) >= CLAIM_REPAIR_MIN_GAP_SECONDS):
            self._last_claim_repair_mono = now
            self._repair_seat_identity()
        if (not getattr(self, '_claim_degraded', False)
                and now - self._claim_refusing_since >= CLAIM_REFUSAL_DEGRADE_AFTER_SECONDS):
            self._enter_claim_fault()
        return True

    def _join_payload(self, channel_id, force=False):
        """The join request: how this wrapper describes itself to the server."""
        payload = {
            "action": "join",
            "channelId": channel_id,
            "participant": {
                "name": self.participant_name,
                "type": "codex",
                "source": "collab-codex wrapper",
                # The durable owner ID is keyed to the long-lived wrapper PID,
                # not the replaceable Codex child PID.
                "pid": self.wrapper_pid,
                "projectPath": os.getcwd(),  # Include projectPath for stable ID generation
                "deliveryProtocol": self.delivery_protocol,
            }
        }
        if force:
            payload["force"] = True
        return payload

    def _repair_seat_identity(self):
        """Re-send this wrapper's join so the server restores its type, protocol and pid.

        join_channel() also injects role context and resets visit state; a repair must not.
        """
        if not getattr(self, 'channel_id', None):
            return False
        debug("Durable claims refused: re-asserting this wrapper's identity with the server")
        result = self.api_call("", "POST", self._join_payload(self.channel_id))
        if not (isinstance(result, dict) and result.get('success')):
            debug(f"Seat identity repair failed: {result}")
            return False
        new_id = result.get('participantId')
        if new_id and new_id != getattr(self, 'participant_id', None):
            debug(f"Seat identity changed by re-join: {self.participant_id} -> {new_id}")
            self.participant_id = new_id
        self._last_delivery_claim_mono = 0.0  # try the next claim at once
        return True

    def _enter_claim_fault(self):
        """Identity repair did not help: stop looking healthy, slow down and tell a person."""
        self._claim_degraded = True
        self._delivery_claim_interval = CLAIM_REFUSED_INTERVAL_SECONDS
        debug(
            f"DEGRADED: durable claims refused {self._claim_refusals} time(s) over "
            f"{time.monotonic() - self._claim_refusing_since:.0f}s; no longer reporting idle, retrying every "
            f"{CLAIM_REFUSED_INTERVAL_SECONDS:.0f}s"
        )
        self.broadcast_activity(getattr(self, 'current_activity', None) or 'idle', force=True)
        self._raise_claim_fault_alert()

    def _raise_claim_fault_alert(self):
        """One dashboard alert per fault episode."""
        if getattr(self, '_claim_fault_alerted', False):
            return
        self._claim_fault_alerted = True
        name = getattr(self, 'participant_name', None) or 'A Codex seat'
        body = {
            "title": f"Codex seat cannot claim messages: {name}",
            "severity": "high",
            "source": "collab-codex wrapper",
            "message": (
                f"{name}'s wrapper has had its durable delivery claims refused {self._claim_refusals} times "
                "(Delivery owner is not the participant current wrapper) and re-joining did not fix it. "
                "It is not picking up queued messages. Restart the session from the roster."
            ),
            "metadata": {
                "channelId": getattr(self, 'channel_id', None),
                "participantId": getattr(self, 'participant_id', None),
                "wrapperPid": getattr(self, 'wrapper_pid', None),
                "refusals": self._claim_refusals,
            },
        }

        def _post():
            try:
                request = urllib.request.Request(
                    ALERTS_API,
                    data=json.dumps(body).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    method='POST',
                )
                urllib.request.urlopen(request, timeout=5).close()
            except Exception as e:
                debug(f"Claim-fault alert failed: {e}")

        threading.Thread(target=_post, daemon=True).start()

    def _recover_from_claim_refusals(self):
        debug(f"Durable claims accepted again after {self._claim_refusals} refusal(s)")
        was_degraded = getattr(self, '_claim_degraded', False)
        self._claim_refusals = 0
        self._claim_refusing_since = 0.0
        self._claim_degraded = False
        self._claim_fault_alerted = False
        self._delivery_claim_interval = CLAIM_NORMAL_INTERVAL_SECONDS
        if was_degraded:
            self.broadcast_activity(getattr(self, 'current_activity', None) or 'idle', force=True)

    def _claim_durable_delivery(self, message_id=None):
        """Atomically claim one pending item only when this Codex child is ready."""
        if (not self._uses_durable_delivery() or self._active_delivery is not None
                or not self._child_startup_proven or not self.joined
                or getattr(self, 'is_processing', False)
                or not self.channel_id or not self.participant_id
                or not self.child or not self.child.isalive()):
            return None
        # Local is_processing is authoritative only for turns initiated by the
        # wrapper. Startup prompts, direct terminal input, and tool work can
        # begin outside inject_message(), so verify transcript ground truth at
        # the claim boundary as well. A busy runtime leaves the record pending.
        if self._check_jsonl_state() == 'processing':
            return None
        now = time.monotonic()
        if now - self._last_delivery_claim_mono < self._delivery_claim_interval:
            return None
        self._last_delivery_claim_mono = now
        payload = {
            'action': 'claim',
            'channelId': getattr(self, 'channel_id', None),
            'participantId': getattr(self, 'participant_id', None),
            'ownerId': self._delivery_owner_id(),
            'leaseMs': 30000,
        }
        if message_id:
            payload['messageId'] = message_id
        result = self._delivery_api_call(payload)
        if self._note_claim_result(result):
            return None
        record = result.get('record') if isinstance(result, dict) else None
        if not record:
            return None
        self._active_delivery = record
        self._active_delivery_started_mono = time.monotonic()
        debug(
            f"Durable delivery claimed: {record.get('messageId', '')[:8]} "
            f"lease={record.get('lease', {}).get('id', '')[:8]} attempt={record.get('attempts')}"
        )
        if record.get('attempts', 0) > getattr(self, 'MAX_DELIVERY_RETRIES', 3):
            debug(
                f"Durable delivery {record.get('messageId', '')[:8]} exceeded wrapper retry ceiling; "
                "quarantining without injection"
            )
            self._dead_letter_active_delivery('wrapper_attempt_ceiling')
            return None
        if record.get('attempts', 0) > 1 or record.get('recoveryReason'):
            token = record.get('token') or delivery_token(
                record.get('messageId', ''), self.participant_id
            )
            existing = self._find_existing_delivery_token(token, record.get('transcriptPath'))
            if existing:
                transcript_path, token_end = existing
                debug(
                    f"Durable retry found existing token for {record.get('messageId', '')[:8]}; "
                    "suppressing reinjection"
                )
                if self._transition_active_delivery(
                    'ingested', transcript_path=transcript_path, transcript_byte=token_end
                ):
                    if check_codex_jsonl_state(transcript_path, token_end) == 'idle':
                        self._complete_active_delivery()
                return None
        return record.get('message')

    def _find_existing_delivery_token(self, token, recorded_path=None):
        """Find a token only in the recorded or current child transcript.

        Global cwd scans are intentionally forbidden: they are both expensive
        during mass restart and unsafe when multiple agents share a project.
        """
        if not token:
            return None
        candidates = []
        current = self._resolve_transcript()
        if current:
            candidates.append(current)
        if recorded_path and recorded_path not in candidates:
            candidates.insert(0, recorded_path)
        for path in candidates:
            token_end = find_codex_delivery_token_offset(path, token, 0)
            if token_end is not None:
                return path, token_end
        return None

    def _recover_ingested_delivery(self):
        """Resolve crash ambiguity before claiming fresh pending work."""
        if (not self._uses_durable_delivery() or self._active_delivery is not None
                or not self._child_startup_proven or not self.joined
                or not self.channel_id or not self.participant_id):
            return False
        now = time.monotonic()
        if now - self._last_delivery_recovery_mono < 5.0:
            return False
        self._last_delivery_recovery_mono = now
        result = self._delivery_api_call({
            'action': 'recover',
            'channelId': getattr(self, 'channel_id', None),
            'participantId': getattr(self, 'participant_id', None),
            'ownerId': self._delivery_owner_id(),
        })
        record = result.get('record') if isinstance(result, dict) else None
        if not record:
            return False
        self._active_delivery = record
        self._active_delivery_started_mono = time.monotonic()
        transcript = record.get('transcriptPath')
        token = record.get('token') or delivery_token(record.get('messageId', ''), self.participant_id)
        token_end = find_codex_delivery_token_offset(transcript, token, 0) if transcript else None
        if token_end is None:
            # Legacy verifiers could mistake their own tool output for input.
            # A persisted "ingested" label must not perpetuate that false proof.
            self._dead_letter_active_delivery('recovery_unverified_ingestion')
            return False
        if check_codex_jsonl_state(transcript, token_end) == 'idle':
            debug(f"Recovery scan found completed token {record.get('messageId', '')[:8]}")
            return self._complete_active_delivery()

        # The prior runtime accepted this turn but did not finish. Replaying it
        # creates a second generation with the same logical delivery, so place
        # it in the visible quarantine queue for operator resolution.
        if self._dead_letter_active_delivery('recovery_incomplete_turn'):
            debug(f"Recovery scan quarantined incomplete token {record.get('messageId', '')[:8]}")
        return False

    def _transition_active_delivery(self, state, transcript_path=None, transcript_byte=None):
        record = self._active_delivery
        lease = record.get('lease') if isinstance(record, dict) else None
        if not record or not lease:
            return False
        payload = {
            'action': 'transition',
            'channelId': getattr(self, 'channel_id', None),
            'participantId': getattr(self, 'participant_id', None),
            'recordId': record.get('id'),
            'leaseId': lease.get('id'),
            'ownerId': self._delivery_owner_id(),
            'state': state,
        }
        if transcript_path:
            payload['transcriptPath'] = transcript_path
        if transcript_byte is not None:
            payload['transcriptByte'] = transcript_byte
        result = self._delivery_api_call(payload)
        updated = result.get('record') if isinstance(result, dict) else None
        if not updated:
            return False
        self._active_delivery = updated
        debug(f"Durable delivery {record.get('messageId', '')[:8]} -> {state}")
        self._sync_voice_session_file()
        return True

    def _renew_active_delivery(self):
        """Extend the lease while one accepted Codex submission is still unresolved."""
        if not getattr(self, '_renew_delivery_supported', True):
            return False
        record = self._active_delivery
        lease = record.get('lease') if isinstance(record, dict) else None
        if not record or not lease or record.get('state') == 'handled':
            return False
        started_mono = getattr(self, '_active_delivery_started_mono', 0.0)
        if (record.get('state') in ('leased', 'submitted')
                and started_mono
                and time.monotonic() - started_mono >= ACTIVE_DELIVERY_LOCAL_MAX_SECONDS):
            # Let reconciliation settle the accepted submit. Renewing here
            # would keep the local safety ceiling from ever expiring.
            return False
        expires_at = lease.get('expiresAt')
        try:
            expiry = datetime.datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=datetime.timezone.utc)
            remaining = (expiry - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
            if remaining > 12:
                return False
        except (AttributeError, TypeError, ValueError):
            pass
        result = self._delivery_api_call({
            'action': 'renew',
            'channelId': self.channel_id,
            'participantId': self.participant_id,
            'recordId': record.get('id'),
            'leaseId': lease.get('id'),
            'ownerId': self._delivery_owner_id(),
        })
        updated = result.get('record') if isinstance(result, dict) else None
        if not updated:
            if (isinstance(result, dict) and result.get('status') == 400
                    and 'Unknown delivery action' in str(result.get('error', ''))):
                # Deployment compatibility: a new wrapper can briefly meet an
                # older API. Disable renewal after the first explicit rejection
                # instead of hammering the endpoint every 200ms.
                self._renew_delivery_supported = False
                debug('Durable delivery lease renewal unsupported by live API; disabled for this wrapper')
            return False
        self._active_delivery = updated
        debug(f"Durable delivery {record.get('messageId', '')[:8]} lease renewed")
        return True

    def _release_active_delivery(self, reason, requeue=False):
        record = self._active_delivery
        lease = record.get('lease') if isinstance(record, dict) else None
        if not record or not lease:
            return False
        result = self._delivery_api_call({
            'action': 'requeue' if requeue else 'release',
            'channelId': self.channel_id,
            'participantId': self.participant_id,
            'recordId': record.get('id'),
            'leaseId': lease.get('id'),
            'ownerId': self._delivery_owner_id(),
            'reason': reason,
        })
        if not isinstance(result, dict) or not result.get('record'):
            return False
        updated = result.get('record')
        outcome = 'settled without replay' if updated.get('state') == 'handled' else 'requeued'
        debug(f"Durable delivery {record.get('messageId', '')[:8]} {outcome}: {reason}")
        return True

    def _dead_letter_active_delivery(self, reason):
        """Quarantine an ambiguous delivery instead of replaying or dropping it."""
        active = getattr(self, '_active_delivery', None)
        if not active:
            return False
        lease = active.get('lease') or {}
        result = self._delivery_api_call({
            'action': 'deadletter',
            'channelId': getattr(self, 'channel_id', None),
            'participantId': getattr(self, 'participant_id', None),
            'recordId': active.get('id'),
            'leaseId': lease.get('id', ''),
            'ownerId': self._delivery_owner_id(),
            'reason': reason,
        })
        if isinstance(result, dict) and result.get('record'):
            debug(f"Durable delivery {active.get('messageId', '')[:8]} quarantined: {reason}")
            self._clear_active_delivery_state(reason)
            return True
        debug(f"Durable delivery quarantine failed for {active.get('messageId', '')[:8]}: {result}")
        return False

    def _clear_active_delivery_state(self, reason):
        """Clear wrapper-local delivery state without changing runtime activity.

        The server ledger remains the authority. Local delivery bookkeeping must
        never outlive its lease and block later claims, but clearing it must not
        pretend the Codex turn stopped processing.
        """
        active = getattr(self, '_active_delivery', None)
        if active:
            debug(
                f"Clearing local durable delivery {active.get('messageId', '')[:8]} "
                f"({active.get('state', 'unknown')}): {reason}"
            )
        self._active_delivery = None
        self._active_delivery_started_mono = 0.0
        self._verify_pending = False
        self._verify_search_text = None
        self._verify_after_byte = 0
        self._verify_start_time = 0
        self._verify_msg_id = None
        self._verify_msg_ts = None
        self.pending_mark_read = False
        self.pending_mark_read_timestamp = None
        self.last_injected_msg_id = None
        self.delivery_timeout_logged = False
        self._verify_timeout_logged = False
        self._sync_voice_session_file()

    def _active_voice_delivery_context(self):
        """Return only a complete, reply-eligible server delivery identity."""
        record = getattr(self, '_active_delivery', None)
        if not isinstance(record, dict) or record.get('state') not in ('submitted', 'ingested'):
            return None
        voice = ((record.get('message') or {}).get('metadata') or {}).get('voice') or {}
        if voice.get('kind') != 'riley.voice.turn':
            return None
        required = (
            record.get('id'), record.get('messageId'),
            voice.get('conversationSessionId'), voice.get('audioTurnId'),
        )
        if not all(isinstance(value, str) and value for value in required):
            return None
        revision = voice.get('revision')
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
            return None
        return {
            'recordId': record['id'],
            'messageId': record['messageId'],
            'conversationSessionId': voice['conversationSessionId'],
            'audioTurnId': voice['audioTurnId'],
            'revision': revision,
        }

    def _sync_voice_session_file(self):
        if getattr(self, 'joined', False) and getattr(self, 'channel_id', None):
            self._write_session_file(self.channel_id, getattr(self, 'channel_name', None))

    def _voice_reply_hint(self, message_id):
        active = getattr(self, '_active_delivery', None)
        if (not isinstance(active, dict) or active.get('messageId') != message_id
                or (((active.get('message') or {}).get('metadata') or {}).get('voice') or {}).get('kind')
                != 'riley.voice.turn'):
            return ''
        return (
            '\n[Riley Voice delivery: Keep the spoken reply to one brief sentence, ideally under 12 words. '
            'For longer work, send one short acknowledgement or decision promptly, then do the work; '
            'use collab_helper.py --text-only --stdin for subsequent detailed chat updates. '
            'Do not claim completion before verification. The helper correlates the first spoken '
            'reply automatically; do not send unfinished speech as a new command.]'
        )

    def _active_delivery_is_voice(self):
        active = getattr(self, '_active_delivery', None)
        voice = (((active or {}).get('message') or {}).get('metadata') or {}).get('voice') or {}
        return voice.get('kind') == 'riley.voice.turn'

    def _consume_voice_delivery_wakeup(self):
        event = getattr(self, '_voice_delivery_wakeup', None)
        if (event is None or not event.is_set() or not self._uses_durable_delivery()
                or getattr(self, 'is_processing', False) or getattr(self, 'pending_enter', False)
                or getattr(self, '_active_delivery', None) is not None):
            return False
        event.clear()
        # This is only a wake-up, never a targeted claim or a FIFO bypass. The
        # normal claim path still verifies startup, actual idle state and lease.
        self._last_delivery_claim_mono = 0.0
        return True

    def _check_voice_cancel_request(self):
        """Interrupt only the exact active voice delivery owned by this wrapper."""
        active = getattr(self, '_active_delivery', None)
        if not isinstance(active, dict):
            return False
        voice = ((active.get('message') or {}).get('metadata') or {}).get('voice') or {}
        lease = active.get('lease') or {}
        if voice.get('kind') != 'riley.voice.turn' or not lease.get('id'):
            return False
        result = self._voice_cancel_api_call({
            'channelId': self.channel_id,
            'participantId': self.participant_id,
            'ownerId': self._delivery_owner_id(),
        })
        requested = result.get('record') if isinstance(result, dict) else None
        if not requested:
            return False

        requested_voice = ((requested.get('message') or {}).get('metadata') or {}).get('voice') or {}
        control = requested.get('voiceControl') or {}
        expected_revision = control.get('expectedRevision')
        requested_lease_id = (
            (requested.get('lease') or {}).get('id')
            or control.get('cancelledLeaseId')
        )
        exact_match = (
            requested.get('id') == active.get('id')
            and requested.get('messageId') == active.get('messageId')
            and requested_lease_id == lease.get('id')
            and requested_voice.get('revision') == voice.get('revision') == expected_revision
        )
        if not exact_match:
            debug('Ignored voice cancel that did not match the active message, lease, and revision')
            return False

        # Before Enter, clear only the claimed composer text. Once submitted,
        # C-c is the authoritative barge-in signal for this exact Codex turn.
        cancel_id = control.get('cancelId')
        if not isinstance(cancel_id, str) or not cancel_id:
            return False
        interrupted = getattr(self, '_voice_cancel_interrupts', None)
        if interrupted is None:
            interrupted = set()
            self._voice_cancel_interrupts = interrupted
        if cancel_id not in interrupted:
            interrupt_key = (
                'C-u'
                if control.get('cancelDisposition') == 'pending_cancelled'
                else 'C-c'
            )
            if not self._send_child_input(key=interrupt_key):
                return False
            interrupted.add(cancel_id)
        acknowledged = self._voice_cancel_api_call({
            'action': 'ack',
            'cancelId': cancel_id,
            'channelId': self.channel_id,
            'participantId': self.participant_id,
            'expectedMessageId': requested.get('messageId'),
            'expectedRevision': expected_revision,
            'recordId': requested.get('id'),
            'leaseId': lease.get('id'),
            'ownerId': self._delivery_owner_id(),
        }, method='POST')
        if not isinstance(acknowledged, dict) or not acknowledged.get('record'):
            debug(f"Voice cancel acknowledgement failed: {acknowledged}")
            return False
        interrupted.discard(cancel_id)
        self._clear_active_delivery_state('voice_cancelled')
        return True

    def _interrupt_answered_voice_for_followup(self):
        """Yield an answered voice turn when a newer spoken turn is pending.

        The correlated channel response is the proof that the current spoken
        turn has a useful result. Until the server records that proof, a wakeup
        cannot interrupt the turn. The pending record check also prevents an
        SSE replay of the active message from interrupting its own work.
        """
        wakeup = getattr(self, '_voice_delivery_wakeup', None)
        active = getattr(self, '_active_delivery', None)
        if (wakeup is None or not wakeup.is_set() or not isinstance(active, dict)
                or active.get('state') != 'ingested'
                or not getattr(self, 'is_processing', False)
                or getattr(self, 'pending_enter', False)):
            return False
        voice = ((active.get('message') or {}).get('metadata') or {}).get('voice') or {}
        lease = active.get('lease') or {}
        record_id = active.get('id')
        message_id = active.get('messageId')
        if (voice.get('kind') != 'riley.voice.turn' or not record_id
                or not message_id or not lease.get('id')):
            return False

        interrupted = getattr(self, '_voice_followup_interrupts', None)
        if interrupted is None:
            interrupted = set()
            self._voice_followup_interrupts = interrupted
        if record_id not in interrupted:
            records = self._fetch_delivery_records()
            server_active = next((record for record in records
                if record.get('id') == record_id
                and record.get('messageId') == message_id), None)
            active_control = (server_active or {}).get('voiceControl') or {}
            server_lease = (server_active or {}).get('lease') or {}
            exact_answered_active = (
                isinstance(server_active, dict)
                and server_active.get('state') == 'ingested'
                and server_lease.get('id') == lease.get('id')
                and isinstance(active_control.get('responseMessageId'), str)
                and bool(active_control.get('responseMessageId'))
            )
            pending_followup = any(
                record.get('state') == 'pending'
                and record.get('messageId') != message_id
                and ((((record.get('message') or {}).get('metadata') or {}).get('voice') or {})
                     .get('kind') == 'riley.voice.turn')
                for record in records
            )
            if not exact_answered_active or not pending_followup:
                return False
            if not self._send_child_input(key='C-c'):
                return False
            interrupted.add(record_id)
            debug(f"Interrupted answered voice delivery {message_id[:8]} for pending follow-up")

        if not self._complete_active_delivery():
            return False
        interrupted.discard(record_id)
        # Keep the voice wakeup set. The normal idle/claim gate will take the
        # pending record as soon as Codex confirms the interrupted turn ended.
        message_event = getattr(self, '_message_event', None)
        if message_event is not None:
            message_event.set()
        return True

    def _reconcile_active_delivery(self, now=None, now_mono=None):
        """Drop stale local authority once its server lease cannot be valid.

        A later claim/recovery call atomically reacquires the server record. The
        monotonic ceiling covers malformed or missing lease timestamps so no
        local state can become an unbounded queue blocker.
        """
        active = getattr(self, '_active_delivery', None)
        if not active:
            return False

        now = now or datetime.datetime.now(datetime.timezone.utc)
        now_mono = time.monotonic() if now_mono is None else now_mono
        expires_at = (active.get('lease') or {}).get('expiresAt')
        lease_expired = False
        if expires_at:
            try:
                expiry = datetime.datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
                if expiry.tzinfo is None:
                    expiry = expiry.replace(tzinfo=datetime.timezone.utc)
                lease_expired = now >= expiry
            except (TypeError, ValueError):
                debug(
                    f"Invalid durable lease expiry for "
                    f"{active.get('messageId', '')[:8]}: {expires_at!r}"
                )

        started_mono = getattr(self, '_active_delivery_started_mono', 0.0)
        state = active.get('state')
        local_lifetime_exceeded = bool(
            state in ('leased', 'submitted')
            and started_mono
            and now_mono - started_mono >= ACTIVE_DELIVERY_LOCAL_MAX_SECONDS
        )
        orphaned_pre_ingestion = bool(
            state in ('leased', 'submitted')
            and not getattr(self, 'pending_enter', False)
            and not getattr(self, '_verify_pending', False)
            and not getattr(self, 'is_processing', False)
        )
        if not lease_expired and not local_lifetime_exceeded and not orphaned_pre_ingestion:
            return False

        reason = (
            'server_lease_expired' if lease_expired
            else 'local_lifetime_exceeded' if local_lifetime_exceeded
            else 'orphaned_pre_ingestion_state'
        )
        if (local_lifetime_exceeded and not lease_expired
                and (active.get('lease') or {}).get('id')):
            # Enter was accepted but transcript confirmation never arrived.
            # Never convert ambiguity into a successful delivery. Quarantine
            # the record for operator inspection instead of replaying or dropping.
            self._clear_codex_composer()
            if not self._dead_letter_active_delivery('jsonl_ingestion_timeout'):
                return False
        elif local_lifetime_exceeded:
            self._clear_codex_composer()
        self._clear_active_delivery_state(reason)
        wake_event = getattr(self, '_message_event', None)
        if wake_event:
            wake_event.set()
        return True

    def _clear_codex_composer(self):
        """Clear text left visible after a swallowed submit before retrying."""
        try:
            self._send_child_input(key='C-u')
        except Exception as e:
            debug(f"Failed to clear Codex composer after submit failure: {e}")

    def _complete_active_delivery(self):
        """Move an ingested item to handled and only then advance UI read state."""
        active = self._active_delivery
        if not active or active.get('state') != 'ingested':
            return False
        handled_ts = active.get('message', {}).get('timestamp')
        message_id = active.get('messageId', '')
        if not self._transition_active_delivery('handled'):
            return False
        if handled_ts:
            self.mark_read(message_timestamp=handled_ts)
            self._save_cursor_timestamp(handled_ts)
        debug(f"Durable delivery {message_id[:8]} handled; read cursor advanced causally")
        self._clear_active_delivery_state('handled')
        return True

    def _resolve_transcript(self) -> str | None:
        """Resolve the transcript owned by the current Codex child."""
        cached = getattr(self, '_codex_transcript_path', None)
        if cached and os.path.isfile(cached):
            owned = resolve_codex_transcript_for_pid(
                getattr(self, 'codex_pid', None), self.agent_dir or os.getcwd()
            )
            if owned and os.path.realpath(owned) == os.path.realpath(cached):
                return cached
            if not owned:
                try:
                    child_start = getattr(self, '_child_spawn_wall', 0.0)
                    if not child_start or os.path.getmtime(cached) >= child_start - 2.0:
                        return cached
                except OSError:
                    pass
            debug(f"Codex JSONL ownership moved to current child rollout: {owned}")
            cached = None
        path = resolve_codex_transcript_for_pid(
            getattr(self, 'codex_pid', None), self.agent_dir or os.getcwd()
        )
        if not path:
            path = resolve_codex_transcript_path(
                self.agent_dir or os.getcwd(),
                getattr(self, '_child_spawn_wall', 0.0) or None,
            )
        if path:
            # Cache on _codex_transcript_path for byte-offset tracking
            if path != self._codex_transcript_path:
                self._codex_transcript_path = path
                self._codex_transcript_byte = 0
                self._inject_transcript_byte = 0  # Reset — new file, new byte offsets
                debug(f"Codex JSONL transcript discovered: {path}")
        return path

    def _check_jsonl_state(self) -> str | None:
        """Check Codex JSONL for turn completion.
        Returns 'idle' when response_item phase='final_answer' seen, 'processing' otherwise."""
        path = self._resolve_transcript()
        if not path:
            return None
        result = check_codex_jsonl_state(path, self._codex_transcript_byte)
        if result == 'processing':
            try:
                stale = time.time() - os.path.getmtime(path) >= STALE_JSONL_PROCESSING_SECONDS
            except OSError:
                stale = False
            if stale and not self.is_process_tree_active():
                debug(
                    "Ignoring stale JSONL processing marker: transcript has not "
                    f"changed for {STALE_JSONL_PROCESSING_SECONDS:.0f}s and child tree is idle"
                )
                result = None
        if result != self._last_jsonl_state:
            debug(f"Codex JSONL state change: {self._last_jsonl_state} -> {result}")
            self._last_jsonl_state = result
        return result

    def _maybe_auto_compact_context(self) -> bool:
        """Start Codex compaction only at a clean, idle message boundary."""
        if (self.is_processing or self.pending_enter
                or getattr(self, '_verify_pending', False)
                or getattr(self, '_active_delivery', None)):
            return False
        child = getattr(self, 'child', None)
        if not (child and child.isalive()):
            return False
        now_mono = time.monotonic()
        last_attempt = getattr(self, '_auto_compact_last_attempt_mono', 0.0)
        if now_mono - last_attempt < CODEX_AUTO_COMPACT_COOLDOWN_SECONDS:
            return False
        transcript = self._resolve_transcript()
        if not transcript:
            return False
        sample = read_codex_context_usage(transcript)
        if not sample:
            return False
        used, window = sample
        ratio = used / window
        if ratio < CODEX_AUTO_COMPACT_RATIO:
            return False

        self._auto_compact_last_attempt_mono = now_mono
        if not self._send_child_input('/compact', key='Enter'):
            debug(
                f"Codex auto-compact submit failed at {used}/{window} "
                f"tokens ({ratio:.1%})"
            )
            return False
        # Compaction summarises the transcript, and a summariser routinely drops
        # standing behavioural rules (arXiv 2606.22528: 0% violation in-context,
        # 30-59% after compaction, 0% again when the rule is pinned). Claude agents
        # re-read the rules from disk via the SessionStart(compact) hook; Codex has
        # no equivalent, so arm a re-read for the moment this turn finishes.
        self._post_compact_reinject_pending = True
        # Keep delivery injection behind the compaction turn. The ordinary
        # idle detector will release queued work once Codex finishes.
        self.is_processing = True
        self.last_output_time = time.time()
        self.last_keystroke = self.last_output_time
        self.output_seen_since_inject = False
        self.idle_since = 0
        self.broadcast_activity('working', force=True)
        debug(
            f"Codex auto-compact started at {used}/{window} "
            f"tokens ({ratio:.1%})"
        )
        return True

    def _run_hook(self, *cmd_parts: str, hook_name: str = "hook") -> None:
        """Run a lifecycle hook script, logging errors but never blocking the wrapper."""
        if not all(cmd_parts):
            return  # Skip if any arg is missing (agent_name/agent_dir not set)
        try:
            result = subprocess.run(list(cmd_parts), capture_output=True, text=True, timeout=10)
            if result.returncode != 0:
                debug(f"{hook_name} exited {result.returncode}: {result.stderr.strip()[:200]}")
        except Exception as e:
            debug(f"{hook_name} failed: {e}")

    @staticmethod
    def _load_file_safe(path: str, max_lines: int = 0) -> str:
        """Return bounded UTF-8 file content, or an empty string on failure."""
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                if max_lines:
                    lines = []
                    for index, line in enumerate(f):
                        if index >= max_lines:
                            break
                        lines.append(line)
                    return "".join(lines).strip()
                return f.read().strip()
        except (FileNotFoundError, PermissionError, OSError):
            return ""

    @staticmethod
    def _session_location_note() -> str:
        """Which machine this session runs on, as a do-not-save note.

        Printed from the same registry the permanent Runtime-Location.md uses
        (data/scaffolding/runtime_location.py), so an agent that moves between
        the desktop and the laptop never holds a stale location in memory.
        Empty on any failure: the permanent note still tells it how to find out.
        """
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data",
                              "scaffolding", "runtime_location.py")
        try:
            done = subprocess.run([sys.executable, script, "session-note"],
                                  capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return ""
        return done.stdout.strip() if done.returncode == 0 else ""

    def _build_scaffolded_prompt(self) -> str:
        """Build the Codex startup identity + a pointer to lean current context.

        Codex natively discovers AGENTS.md once per run, so static project rules
        stay on that supported surface. Mutable history is intentionally excluded
        from AGENTS.md to avoid cache invalidation and must NOT be inlined into
        this prompt either.
        This prompt is a positional CLI arg to `codex`, spawned over a real PTY
        (pexpect). Codex's Ink-based TUI renders that arg into terminal scrollback
        on spawn; a multi-KB inline blob leaves the renderer with a large history
        to redraw on every subsequent frame, and every later real-time keystroke
        injection (a channel message arriving mid-session) races that redraw.
        Observed 2026-07-17: this caused injected messages to land in the PTY but
        never reach Codex's actual turn (confirmed via empty diff in the session
        JSONL), which the wrapper's own staleness detection then "fixed" by
        killing and respawning the session — recreating the same fragile state.
        So: keep this prompt SHORT. Write the mutable content to a scratch file
        and have Codex read it with its own tools, the same way it reads AGENTS.md.
        """
        cwd = os.path.realpath(self.agent_dir or os.getcwd())
        home = os.path.expanduser("~")

        mutable_files = (
            ("Pending Handoff", os.path.join(cwd, "logs", "handoff.md"), 80),
            ("Agent Expertise", os.path.join(cwd, "Expertise.md"), 200),
            ("System Ownership", os.path.join(cwd, "SystemOwnership.json"), 120),
        )
        sections = [
            "# Context Use Contract\n\n"
            "The current role rules and current user or Team Lead assignment govern "
            "how work is done. Memory, expertise, handoff, and ownership are required "
            "operational context. Apply their durable facts and preferences, while "
            "treating old task process as inactive unless the current handoff or "
            "assignment keeps it pending. Current explicit instructions and files "
            "resolve conflicts."
        ]
        location_note = self._session_location_note()
        if location_note:
            sections.append(location_note)
        for heading, mutable_path, max_lines in mutable_files:
            content = self._load_file_safe(mutable_path, max_lines=max_lines)
            if content:
                sections.append(f"# {heading}\n\n{content}")

        encoded = cwd.replace("/", "-")
        memory_candidates = (
            os.path.join(home, ".claude", "projects", encoded, "memory", "MEMORY.md"),
            os.path.join(cwd, "MEMORY.md"),
        )
        for memory_path in memory_candidates:
            memory = self._load_file_safe(memory_path, max_lines=200)
            if memory:
                sections.append(f"# Persistent Memory\n\n{memory}")
                break

        today = self._load_file_safe(os.path.join(cwd, "logs", "today.md"))
        current_date = datetime.date.today().isoformat()
        if today and current_date in today:
            today_tail = "\n".join(today.splitlines()[-40:]).strip()
            if today_tail:
                sections.append(f"# Current-Date Log Tail\n\n{today_tail}")

        preload_note = ""
        if sections:
            preload_dir = os.path.join(cwd, ".session-scratch")
            os.makedirs(preload_dir, exist_ok=True)
            preload_path = os.path.join(preload_dir, "codex-startup-context.md")
            with open(preload_path, "w", encoding="utf-8") as f:
                f.write("\n\n---\n\n".join(sections))
            preload_note = (
                f" Before first reply, silently read {preload_path} as required "
                "operational context."
            )

        result = (
            f"[SYSTEM: You are {self.participant_name} in a DevFlow collab channel. "
            "Post via shell-safe stdin: "
            "CLAUDE_PID=${COLLAB_WRAPPER_PID:-$PPID} python3 "
            f"{DEVFLOW_HOME}/scripts/collab_helper.py --to <Name> --stdin <<'DEVFLOW_MESSAGE', "
            "then the response and marker on its own line. Never quote response text: Bash can expand Markdown/$/$(...). "
            "Terminal output is invisible; always use the helper. For another channel add --channel <id>. "
            "--to names the recipient; --broadcast means everyone; one is required. "
            "A mention requires attention, not an acknowledgement. Follow channel-communication.md: finalise Plan.md, assign sprint tasks, then execute quietly until completion or a hard blocker. Also treat human broadcasts "
            "as addressed to every participant: act when relevant to your role; otherwise stay silent. "
            "Broadcast only to address everyone. "
            f"Execution: report only hard blockers to {ARCHITECT_NAME} or completion affecting the next phase to {ARCHITECT_NAME}/{LEAD_NAME}. "
            "No handoff, confirmation, ready, correction, stage, freeze/hold, or progress chatter. "
            "Answer human questions; discuss plans and hard blockers. "
                        "Send once. Use Markdown and real "
            "line breaks when they improve scanning; **bold** and <u>underline</u> are available. Never send "
            "literal \\n for layout."
            f"{preload_note} Answer only [Channel message from ...] blocks, including "
            "one that arrives inside this same input.]"
        )
        debug(f"Codex scaffolded startup prompt built: {len(result)} chars (preload file: {bool(sections)})")
        return result

    def _build_codex_launch_args(self) -> list[str]:
        """Return Codex CLI args with the lean context scaffold as initial prompt."""
        default_args = [
            '-s', 'danger-full-access',
            '-a', 'never',
            '-m', self.model,
        ]
        # Map DevFlow effort level to Codex CLI model_reasoning_effort config.
        # Codex supports: none|minimal|low|medium|high|xhigh|max|ultra
        # DevFlow uses: low|medium|high|xhigh|max|ultra (all valid Codex values)
        if self.effort:
            default_args.extend(['-c', f'model_reasoning_effort="{self.effort}"'])
        # The shared AgentChat profile is not per-agent state. Pin the roster's
        # selection on every launch so one session's /fast toggle cannot affect
        # another agent after a restart.
        if getattr(self, 'fast_mode', None) is not None:
            service_tier = 'fast' if self.fast_mode else 'default'
            default_args.extend(['-c', f'service_tier="{service_tier}"'])
        try:
            startup_prompt = self._build_scaffolded_prompt()
        except Exception as e:
            debug(f"Failed to build Codex startup scaffold: {e}")
            startup_prompt = (
                f"[SYSTEM: You are {self.participant_name} in a DevFlow collab channel. "
                "Wait for an inbound channel message before responding.]"
            )
        return (
            default_args
            + [
                arg for arg in self.codex_args
                if arg not in default_args
                and arg != '--dangerously-bypass-approvals-and-sandbox'
            ]
            # Gate config must follow caller/profile overrides so a stray
            # ``features.hooks=false`` cannot disable the native boundary.
            + codex_design_gate_args(self.agent_dir or os.getcwd())
            # Keep this after caller-supplied args so an inherited/profile-level
            # ``false`` cannot re-enable paste-burst swallowing for tmux input.
            + ['-c', 'disable_paste_burst=true']
            + [startup_prompt]
        )

    def _run_hook_on_startup(self) -> None:
        """SessionStart equivalent: initialise .session-scratch/ for this agent."""
        if not self.agent_name or not self.agent_dir:
            return
        hooks_dir = os.path.join(os.path.dirname(__file__), "hooks")
        script = os.path.join(hooks_dir, "session-scratch-init.sh")
        if os.path.isfile(script):
            self._run_hook("bash", script, self.agent_name, self.agent_dir, hook_name="SessionStart-hook")

    def _run_hook_before_inject(self, prompt: str = "") -> str | None:
        """UserPromptSubmit equivalent: log rotation + context injection before injecting.

        Ported from collab-antigravity.py T1.1 (2026-05-25). Fires:
          1. check-rotate.sh — session rotation check (existing Codex behaviour)
          2. context-inject.py — keyword-cluster injection + drift prevention
             (includes S2.3 skill-index.md injection for SG-1 skill discovery)
          3. context-health-sample.py — context fill tracking (noop for Codex, no Claude session_id)

        Returns additionalContext string if context-inject matched a keyword cluster,
        or None if no injection occurred.
        """
        if not self.agent_name or not self.agent_dir:
            return None

        # 1. Session rotation check (existing behaviour preserved)
        script = os.path.join(os.path.dirname(__file__), "check-rotate.sh")
        if os.path.isfile(script):
            self._run_hook("bash", script, self.agent_name, self.agent_dir, hook_name="UserPromptSubmit-check-rotate")

        extra_context = None
        hooks_dir = os.path.join(os.path.dirname(__file__), "hooks")

        # 2. context-inject.py — keyword-cluster context injection + drift prevention
        script = os.path.join(hooks_dir, "context-inject.py")
        if os.path.isfile(script) and prompt:
            try:
                stdin_data = json.dumps({"prompt": prompt})
                result = subprocess.run(
                    ["python3", script, self.agent_name, self.agent_dir],
                    input=stdin_data,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if result.returncode == 0 and result.stdout.strip():
                    try:
                        output = json.loads(result.stdout)
                        ctx = output.get("hookSpecificOutput", {}).get(
                            "additionalContext", ""
                        )
                        if ctx:
                            extra_context = ctx
                            debug(f"context-inject: {len(ctx)} chars injected")
                    except json.JSONDecodeError:
                        debug(
                            f"context-inject: non-JSON stdout: "
                            f"{result.stdout.strip()[:200]}"
                        )
                elif result.returncode != 0:
                    debug(
                        f"context-inject exited {result.returncode}: "
                        f"{result.stderr.strip()[:200]}"
                    )
            except Exception as e:
                debug(f"context-inject failed: {e}")

        # 3. context-health-sample.py — context fill tracking (noop for Codex)
        script = os.path.join(hooks_dir, "context-health-sample.py")
        if os.path.isfile(script):
            try:
                stdin_data = json.dumps({
                    "prompt": prompt,
                    "session_id": "",
                    "cwd": self.agent_dir,
                })
                subprocess.run(
                    ["python3", script, self.agent_name, self.agent_dir],
                    input=stdin_data,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
            except Exception as e:
                debug(f"context-health-sample failed: {e}")

        return extra_context

    def _reinject_after_compaction(self) -> None:
        """Re-read the behavioural rules from disk after a compaction turn.

        Claude's equivalent is the SessionStart hook with the ``compact`` matcher,
        whose stdout the runtime injects directly. Codex has no such hook, so the
        wrapper hosts it: run the same script, write its output to the scratch
        directory, and hand Codex a short instruction to read that file.

        The content deliberately does NOT go through the PTY. A large payload in
        the terminal input stream is what broke Codex message delivery on
        2026-07-17 — bulk context renders into the Ink TUI scrollback and races
        every later keystroke injection. Same rule as ``_build_scaffolded_prompt``:
        keep the input stream short, put the bulk in a file the model reads itself.
        """
        if not self.agent_dir:
            return
        script = os.path.join(os.path.dirname(__file__), "hooks", "post-compact-reinject.sh")
        if not os.path.isfile(script):
            debug("Post-compact reinject skipped — hook script not found")
            return
        try:
            result = subprocess.run(
                ["bash", script, self.agent_dir],
                capture_output=True, text=True, timeout=15,
            )
        except Exception as error:
            debug(f"Post-compact reinject hook failed: {error}")
            return
        body = (result.stdout or "").strip()
        if not body:
            debug("Post-compact reinject produced no output — nothing to re-read")
            return
        try:
            scratch_dir = os.path.join(self.agent_dir, ".session-scratch")
            os.makedirs(scratch_dir, exist_ok=True)
            path = os.path.join(scratch_dir, "codex-post-compact.md")
            with open(path, "w", encoding="utf-8") as f:
                f.write(body)
        except Exception as error:
            debug(f"Post-compact reinject could not write scratch file: {error}")
            return
        prompt = (
            f"[SYSTEM: Context was just compacted. Read {path} now and follow it "
            "before your next reply. No response to this message.]"
        )
        if self._send_child_input(prompt, key='Enter'):
            debug(f"Post-compact reinject queued ({len(body)} chars via {path})")
        else:
            debug("Post-compact reinject submit failed")

    def _run_hook_on_turn_complete(self) -> None:
        """Stop equivalent: write session-end marker to logs after Codex completes a turn."""
        if not self.agent_name or not self.agent_dir:
            return
        script = os.path.join(os.path.dirname(__file__), "write-session-end.sh")
        if os.path.isfile(script):
            self._run_hook("bash", script, self.agent_name, self.agent_dir, hook_name="Stop-hook")

    def is_process_tree_active(self):
        """Check if Claude's process tree has significant CPU activity.

        Returns True only if the process tree consumed meaningful CPU since last check.
        Filters out idle overhead (event loop, GC, TUI rendering) which produces
        small tick increments even when Claude is sitting at a prompt doing nothing.
        """
        if not self.codex_pid:
            return False
        try:
            # Get all PIDs in Claude's process tree
            pids = [self.codex_pid]
            try:
                result = subprocess.run(
                    ['pgrep', '-P', str(self.codex_pid)],
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
                            if pid not in self.background_pids or pid == self.codex_pid}

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
            return CLAIM_FAULT_DETAIL if getattr(self, '_claim_degraded', False) else None
        # Codex JSONL doesn't expose per-tool names the same way Claude does
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
        import socket
        return {
            "hostId": os.environ.get("DEVFLOW_HOST_ID") or socket.gethostname(),
            "pid": self.codex_pid,
            "wrapperPid": self.wrapper_pid,
            "tmuxSession": self._host_tmux_session or None,
            "cwd": os.getcwd(),
            "model": None,
        }

    def register_session(self):
        """Register session using Codex's PID so UI can find it"""
        if not self.codex_pid:
            debug("Cannot register - Codex PID not yet known")
            return

        # Set name if not provided
        if not self.participant_name:
            self.participant_name = get_project_name()

        try:
            with open(get_ready_file(self.codex_pid), 'w') as f:
                json.dump({
                    "pid": self.codex_pid,
                    "name": self.participant_name,
                    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "cwd": os.getcwd(),
                    "wrapperPid": self.wrapper_pid
                }, f)
            print(f"\033[32m[Collab] Session ready (PID {self.codex_pid}) - can be added to channels via DevFlow UI\033[0m", file=sys.stderr)
            debug(f"Session registered: {self.participant_name} (Codex PID: {self.codex_pid})")
        except Exception as e:
            print(f"\033[33m[Collab] Warning: {e}\033[0m", file=sys.stderr)

    def _reset_child_startup_state(self):
        """Reset lifecycle evidence before spawning a new Codex child."""
        self._child_startup_output = ''
        self._child_startup_proven = False
        self._child_ready_registered = False
        self._fatal_startup_error = None
        self._child_spawn_wall = time.time()
        self._child_spawn_mono = time.monotonic()
        self._startup_trust_answered = False

    def _observe_child_startup_output(self, data):
        """Record startup output and register only after a ready banner."""
        if self._child_startup_proven or self._fatal_startup_error:
            return self._child_startup_proven

        text = data if isinstance(data, str) else data.decode('utf-8', errors='replace')
        self._child_startup_output = (self._child_startup_output + text)[-16384:]
        normalised_output = _strip_terminal_controls(self._child_startup_output)

        # Fatal markers take precedence so mixed output cannot advertise a
        # failed process as ready.
        for marker in FATAL_STARTUP_MARKERS:
            if marker in normalised_output:
                self._fatal_startup_error = marker
                debug(f"Fatal Codex startup error detected: {marker}")
                return False

        if (not getattr(self, '_startup_trust_answered', False)
                and any(marker in normalised_output for marker in STARTUP_TRUST_MARKERS)):
            self._startup_trust_answered = True
            debug("Codex startup trust prompt detected — selecting trusted directory")
            # Codex presents the trusted option first. Sending `1` plus Enter is
            # deterministic even if the highlighted default changes.
            self._send_child_input('1', key='Enter')

        if any(marker in normalised_output for marker in STARTUP_READY_MARKERS):
            self._child_startup_proven = True
            self._register_ready_child()
            return True
        return False

    def _check_startup_timeout(self):
        """Terminate an alive child that never reaches the ready banner."""
        if self._child_startup_proven or self._fatal_startup_error or not self.child:
            return False
        started = getattr(self, '_child_spawn_mono', 0.0)
        if not started or time.monotonic() - started < STARTUP_READY_TIMEOUT_SECONDS:
            return False
        self._fatal_startup_error = 'startup readiness timeout'
        debug(
            f"Codex startup readiness timed out after {STARTUP_READY_TIMEOUT_SECONDS:.0f}s; "
            "terminating blocked child"
        )
        try:
            self.child.terminate(force=True)
        except Exception as error:
            debug(f"Failed to terminate startup-blocked child: {error}")
        return True

    def _register_ready_child(self):
        """Publish ready/session files exactly once for a proven child."""
        if self._child_ready_registered or not self._child_startup_proven:
            return
        self.register_session()
        if self.joined and self.channel_id:
            self._write_session_file(self.channel_id)
        self._child_ready_registered = True

    def _cleanup_child_files(self, child_pid):
        """Remove registration/session files belonging to an exited child."""
        if not child_pid:
            return

        files_to_remove = [
            get_ready_file(child_pid),
            get_invite_file(child_pid),
            f'/tmp/collab-session-{child_pid}.json',
            os.path.join(os.getcwd(), '.claude', f'collab-session-{child_pid}.json'),
        ]
        # Session files are keyed by wrapper PID but contain the current child
        # PID. Remove them only when they still reference this failed child.
        wrapper_session_files = [
            f'/tmp/collab-session-{self.wrapper_pid}.json',
            os.path.join(os.getcwd(), '.claude', f'collab-session-{self.wrapper_pid}.json'),
        ]
        for path in wrapper_session_files:
            try:
                with open(path, 'r') as f:
                    session_data = json.load(f)
                if session_data.get('pid') == child_pid:
                    files_to_remove.append(path)
            except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
                pass

        for path in files_to_remove:
            try:
                os.remove(path)
                debug(f"Cleaned failed child file: {path}")
            except FileNotFoundError:
                pass
            except OSError as e:
                debug(f"Failed child cleanup error ({path}): {e}")

    def _startup_exit_is_fatal(self, exit_status):
        """Return whether an exit must stop the normal restart loop."""
        if self._fatal_startup_error:
            return True
        return not self._child_startup_proven and exit_status not in (None, 0)

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
                    if pid == self.codex_pid or pid == self.wrapper_pid:
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
                    if pid == self.codex_pid or pid == self.wrapper_pid:
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
        all_pids = []
        if self.codex_pid:
            all_pids.append(self.codex_pid)
        if self.wrapper_pid and self.wrapper_pid not in all_pids:
            all_pids.append(self.wrapper_pid)

        for pid in all_pids:
            files_to_remove = [
                get_ready_file(pid),
                get_invite_file(pid),
                f'/tmp/collab-session-{pid}.json',
                os.path.join(os.getcwd(), '.claude', f'collab-session-{pid}.json'),
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
        payload = self._join_payload(channel_id, force=force)
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
            # Skip if codex_pid not yet known (pre-spawn join) — the restart loop
            # calls _write_session_file() again after Codex spawns with the real PID.
            if self.codex_pid:
                self._write_session_file(channel_id, channel_name)

            # Fetch agent's role from roster
            self._fetch_role_from_roster(result.get("channel"))

            # Inject concise role context once on join. Durable scaffolding owns
            # methodology; this bootstrap must not create extra gates.
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
        """Write PID-specific session file for /collab-post skill compatibility.

        Writes session file for the wrapper PID (not codex-node or rust).
        collab_helper.py walks up the process tree from os.getppid() to find
        an ancestor with a session file, so a single file at the wrapper PID
        covers all tiers (bash → rust → node → wrapper).
        """
        try:
            session_dir = os.path.join(os.getcwd(), '.claude')
            os.makedirs(session_dir, exist_ok=True)

            session_data = {
                "channelId": channel_id,
                "participantId": self.participant_id,
                "displayName": self.participant_name,
                "channelName": channel_name or "Unknown",
                "pid": self.codex_pid,
                "agentType": "codex",
                "projectPath": os.getcwd(),
                "homeChannelId": self.home_channel_id,
                "homeChannelName": self.home_channel_name
            }
            active_voice_delivery = self._active_voice_delivery_context()
            if active_voice_delivery:
                session_data["activeVoiceDelivery"] = active_voice_delivery

            # Write session file for wrapper PID — collab_helper.py walks up
            # the process tree to find it, so no per-tier files needed.
            pid = self.wrapper_pid
            pid_session_file = os.path.join(session_dir, f'collab-session-{pid}.json')
            with open(pid_session_file, 'w') as f:
                json.dump(session_data, f)
            tmp_session_file = f'/tmp/collab-session-{pid}.json'
            with open(tmp_session_file, 'w') as f:
                json.dump(session_data, f)

            debug(f"Wrote session file: {pid_session_file} + {tmp_session_file}")

            # NOTE: Do NOT create shared symlink (.claude/collab-session.json).
            # When multiple agents share the same project directory, the symlink
            # gets overwritten by the last agent to join, causing identity confusion.
            # Each agent is identified exclusively by their PID-specific session file.

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
        if not self.codex_pid:
            return
        try:
            import datetime
            invite_file = get_invite_file(self.codex_pid)
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
                        debug(f"Startup sweep: removing stale invite ({age_s:.0f}s old) for PID {self.codex_pid}")
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
        if not self.codex_pid:
            return None
        try:
            invite_file = get_invite_file(self.codex_pid)
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
                ready_file = get_ready_file(self.codex_pid)
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
        if self._uses_durable_delivery():
            # Tagged records are claimed from the ledger. Polling only wakes the
            # claim loop and must never inject the canonical payload directly.
            durable = [
                msg for msg in messages
                if msg.get('metadata', {}).get('durableDelivery') == DELIVERY_PROTOCOL
            ]
            if durable:
                self._message_event.set()
            messages = [msg for msg in messages if msg not in durable]
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

    def check_inbox(self):
        """Check inbox file for unread messages missed by SSE/polling.

        The server writes every delivered message to a persistent inbox file
        ({projectPath}/.claude/inbox-{participantId}.json). This method reads
        unread messages and queues them into the SSE message queue for the
        normal processing pipeline. Read state advances only after confirmed
        injection, never when the item is merely queued.

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
                        'from': {'id': msg.get('senderId', 'inbox'), 'name': sender_name},
                        'content': msg.get('content', ''),
                        'timestamp': msg.get('timestamp', ''),
                        'replyTo': reply_to,
                        'mentions': msg.get('mentions') or [],
                        'recipients': msg.get('recipients'),
                        'metadata': msg.get('metadata') or {},
                    }

                    if (self._uses_durable_delivery()
                            and api_msg['metadata'].get('durableDelivery') == DELIVERY_PROTOCOL):
                        # Inbox is a wake-up leg only for ledger-backed Codex.
                        # The claim loop owns the canonical envelope and routing.
                        self._message_event.set()
                        continue

                    self.sse_message_queue.put(api_msg)
                    # Queueing is not delivery. Keep the inbox record unread
                    # until the normal consumer confirms injection and adds the
                    # ID to injected_message_ids; the dedup branch above marks
                    # it read on a later pass. This preserves the disk safety
                    # net across compaction, crashes, and queue-drain races.
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

        Reads the channel JSON file directly and looks for a message where
        from.id matches our participant_id and timestamp is >= last_inject_time_iso.

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
            # ISO 8601 timestamps with the same format and trailing Z compare
            # correctly as plain strings (lexicographic == chronological).
            inject_iso = self.last_inject_time_iso
            for channel_id in channel_ids:
                query = urllib.parse.urlencode({'channelId': channel_id, 'since': inject_iso, 'limit': 200})
                with urllib.request.urlopen(f"{API_BASE}?{query}", timeout=5) as resp:
                    data = json.loads(resp.read().decode('utf-8'))
                messages = data.get('messages') if isinstance(data, dict) else None
                if not isinstance(messages, list):
                    return True  # Unexpected shape — fail open
                for m in messages:
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
        if not self.codex_pid:
            return False
        try:
            ready_file = get_ready_file(self.codex_pid)
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
                                "type": "codex",
                                "source": "collab-codex wrapper",
                                "pid": self.wrapper_pid,
                                "projectPath": os.getcwd()
                            }
                        })
                        debug(f"Updated name in channel to: {new_name}")
                    return True
        except Exception as e:
            debug(f"Name sync error: {e}")
        return False

    def inject_message(self, sender, content, reply_to=None, mentions=None, channel_id=None, msg_timestamp=None, msg_id=None):
        """Inject a message into Codex's input using a deferred submit key.

        This method sends text first. ``check_pending_enter()`` later sends
        Enter for an idle composer or Tab to queue behind an active Codex turn.

        Args:
            sender: Name of message sender
            content: Message content
            reply_to: Optional reply context dict
            mentions: List of mentioned participant IDs/names
            msg_timestamp: ISO timestamp of original message (for age markers)
            msg_id: Message ID for delivery telemetry (optional)
        """
        if not self.child or not self.child.isalive():
            debug("Cannot inject - child not alive")
            return False

        # Codex assigns different semantics to composer submission while a turn
        # is active: Enter steers the current turn, while Tab queues the message
        # for the next turn. Channel messages are independent turns, so preserve
        # that boundary instead of interrupting the response already in flight.
        submit_key = 'Tab' if self.is_processing else 'Enter'

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
                active = getattr(self, '_active_delivery', None)
                token_prefix = ''
                if active and active.get('messageId') == msg_id:
                    token_prefix = f"\n{active.get('token') or delivery_token(msg_id, self.participant_id)}"
                reply_line = format_reply_context(reply_to)  # names the full id of the message being answered
                if reply_line:
                    append_prompt = f"{token_prefix}\n[Channel message from {sender} in {ch}] {reply_line}: {content}"
                else:
                    append_prompt = f"{token_prefix}\n[Channel message from {sender} in {ch}]: {content}"
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
                    append_prompt += "\n(@you)"
                elif mentions:
                    append_prompt += "\n(not addressed to you)"
                else:
                    append_prompt += "\n(broadcast)"
                append_prompt += self._voice_reply_hint(msg_id)
                # Append to the Codex composer (the deferred key submits the batch).
                if self._send_child_input(append_prompt, bracketed=True):
                    debug(f"APPENDED to pending input buffer (mentioned={is_mentioned_append}): {append_prompt[:80]}...")
                    return True
                else:
                    debug("Failed to append to input buffer")
                    return False

        try:
            # The direct child-PTY writer sends a complete bracketed paste and
            # handles partial writes. Preserve the full body in the user turn;
            # an abbreviated preview plus a file path can hide instructions.

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
            reply_line = format_reply_context(reply_to)  # names the full id of the message being answered
            if reply_line:
                prompt = f"[Channel message from {sender} in {ch}] {reply_line}: {content}"
            else:
                prompt = f"[Channel message from {sender} in {ch}]: {content}"

            active = getattr(self, '_active_delivery', None)
            if active and active.get('messageId') == msg_id:
                prompt = f"{active.get('token') or delivery_token(msg_id, self.participant_id)}\n{prompt}"

            if is_mentioned:
                prompt += "\n(@you)"
            elif mentions:
                prompt += "\n(not addressed to you)"
            else:
                prompt += "\n(broadcast)"
            prompt += self._voice_reply_hint(msg_id)

            debug(f"Injecting text (Enter deferred, mentioned={is_mentioned}): {prompt}")

            # Capture the transcript boundary before text can be submitted. The
            # old post-Enter size read could race past the newly-ingested token.
            path = self._resolve_transcript()
            if path:
                try:
                    self._inject_transcript_byte = os.path.getsize(path)
                except OSError:
                    self._inject_transcript_byte = 0

            # Serialize text send + pending_enter under _enter_lock to prevent
            # hook-triggered commands from interleaving with the injected message.
            with self._enter_lock:
                if not self._send_child_input(prompt, bracketed=True):
                    debug("inject_message: child PTY write returned False, aborting")
                    if msg_id:
                        self.log_delivery_failure(msg_id, "tmux_send_failed")
                    return False
                self.last_injected_msg_id = msg_id
                self.pending_mark_read_timestamp = msg_timestamp
                self.pending_enter = True
                self.pending_enter_time = time.time()
                self.pending_submit_key = submit_key

            # Optional verification — log-only, never retry the send. Durable
            # voice delivery has authoritative JSONL ingestion verification;
            # avoid adding a fixed 300ms pane-render wait to its critical path.
            if self.tmux_pane_target and not self._active_delivery_is_voice():
                time.sleep(0.3)  # Give Ink time to render the input
                verify_snippet = prompt[:40]
                pane_content = self._capture_tmux_pane()
                if verify_snippet in pane_content:
                    debug("Inject: delivery verified via pane capture")
                else:
                    debug("Inject: text not found in pane capture (Ink render delay) — proceeding anyway")

            debug(f"Text sent, {submit_key} deferred (prevents paste/turn-transition races)")

            # Mark as processing and broadcast 'working' immediately.
            # IMPORTANT: also reset last_output_time to NOW so the CPU check loop doesn't
            # see a stale (e.g. 177s old) silence_time and immediately declare idle before
            # Claude has had a chance to start generating output (Task 1 root-cause fix).
            self.idle_since = 0
            self.is_processing = True
            # NOTE: do NOT reset _last_posted_response here — SSE catch-up replays
            # the same message multiple times, each inject would clear the dedupe
            # guard and cause duplicate auto-posts. The guard resets on transcript
            # file change instead (see _resolve_transcript).
            self.last_output_time = time.time()  # Reset stale timestamp — prevents premature CPU-idle
            self.output_seen_since_inject = False  # No output yet — use extended idle threshold
            self.collab_response_sent = False  # Reset — track if agent responds via collab
            self._collab_detect_buf = ''  # Reset detection buffer for new message
            from datetime import datetime, timezone
            # Channel file timestamps use 3-decimal millisecond ISO 8601 (e.g.
            # 2026-04-10T15:02:53.052Z). Match that format exactly so plain
            # string comparison stays chronological in _agent_responded_since_last_inject.
            if not msg_id or getattr(self, '_response_window_msg_id', None) != msg_id:
                _now_utc = datetime.now(timezone.utc)
                self.last_inject_time_iso = _now_utc.strftime('%Y-%m-%dT%H:%M:%S.') + f'{_now_utc.microsecond // 1000:03d}Z'
                self.last_inject_time_mono = time.monotonic()
                self._response_window_msg_id = msg_id
                self._corrective_sent_msg_id = None
            self.last_injected_sender = sender
            self.last_injected_was_mentioned = is_mentioned
            self.last_injected_source_channel = cross_channel_source_id(content)
            self.broadcast_activity('working', force=True)  # Always broadcast on inject — dedup skip hides state changes

            return True
        except Exception as e:
            debug(f"Inject error: {e}")
            self.is_processing = False
            return False

    def _record_submit_success(self, submit_key):
        """Advance delivery state after the child PTY accepts Enter/Tab.

        Both the fast poller and the independent watchdog submit input. Keeping
        the state transition here prevents either path from bypassing durable
        verification and leaving a leased record behind.
        """
        self.pending_enter = False
        self.pending_submit_key = 'Enter'
        if submit_key == 'Tab':
            # A queued follow-up is not written to JSONL until Codex promotes
            # it after the active turn. Immediate verification would therefore
            # be a guaranteed false timeout.
            debug("Queued channel message for the next Codex turn via Tab")
            return True

        transcript = self._resolve_transcript()
        active = getattr(self, '_active_delivery', None)
        if active:
            # Persist the exact child transcript before ingestion so crash
            # recovery never needs a global rollout-tree scan.
            self._transition_active_delivery(
                'submitted',
                transcript_path=transcript,
                transcript_byte=getattr(self, '_inject_transcript_byte', 0) if transcript else None,
            )
        # Durable delivery must always start its verification timeout, even
        # while compaction/transcript rollover temporarily leaves no JSONL path.
        if transcript or active:
            self._verify_after_byte = (
                getattr(self, '_inject_transcript_byte', 0) if transcript else 0
            )
            self._verify_search_text = (
                active.get('token') or delivery_token(active.get('messageId'), self.participant_id)
                if active
                else (f'[Channel message from {self.last_injected_sender}' if self.last_injected_sender else None)
            )
            self._verify_start_time = time.time()
            self._verify_msg_id = self.last_injected_msg_id
            self._verify_msg_ts = self.pending_mark_read_timestamp
            self._verify_pending = bool(self._verify_search_text)
            self._verify_timeout_logged = False
            if self._verify_pending:
                transcript_state = transcript or 'awaiting transcript'
                debug(
                    f"JSONL verify: started (searching for {self._verify_search_text!r} "
                    f"after byte {self._verify_after_byte}; {transcript_state})"
                )
        return True

    def check_pending_enter(self):
        """Check if we should send the deferred Enter/Tab submit key.

        Only sends the key if:
        1. There's a pending submission from inject_message()
        2. Codex has been idle (no output) for enter_idle_threshold seconds
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
                if getattr(self, '_active_delivery', None):
                    self._release_active_delivery('child_died_before_submit')
                    # The child is gone; local authority is invalid regardless
                    # of whether the server NACK was reachable.
                    self._clear_active_delivery_state('child_died_before_submit')
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
                self.pending_submit_key = 'Enter'
                self.pending_mark_read = False
                self.pending_mark_read_timestamp = None
                return False

            time_since_inject = time.time() - self.pending_enter_time
            time_since_output = time.time() - self.last_output_time if self.last_output_time > 0 else float('inf')

            # Minimum delay after sending text
            if time_since_inject < 0.2:
                return False

            # Voice text is already fenced by a server lease and exact JSONL
            # token. Submit after the minimum paste-settle window instead of
            # adding the ordinary 500ms UI-idle guard to a spoken turn.
            enter_idle_threshold = (
                0.2 if self._active_delivery_is_voice() else self.enter_idle_threshold
            )

            # Check if Claude is idle (no output for threshold)
            # Also send if we've waited too long (5s max) to prevent stuck messages
            max_wait = 5.0
            if time_since_output >= enter_idle_threshold or time_since_inject >= max_wait:
                try:
                    submit_key = getattr(self, 'pending_submit_key', 'Enter')
                    debug(f"Sending deferred {submit_key} (idle: {time_since_output:.2f}s, waited: {time_since_inject:.2f}s)")
                    if not self._send_child_input(key=submit_key):
                        debug(f"Deferred {submit_key} send failed — keeping pending state for retry")
                        return False
                    return self._record_submit_success(submit_key)
                except Exception as e:
                    debug(f"Error sending deferred submit key: {e} — keeping pending state for retry")
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
        if jsonl_state == 'processing':
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
            return False
        if not self.last_injected_was_mentioned or not self.last_injected_sender:
            return False
        current_msg_id = getattr(self, '_response_window_msg_id', None)
        if current_msg_id and getattr(self, '_corrective_sent_msg_id', None) == current_msg_id:
            debug(f"Corrective reminder suppressed — already sent once for {current_msg_id[:8]}")
            return False

        with self._enter_lock:
            if self.pending_enter:
                debug("Corrective reminder skipped — pending_enter is True (inject in progress)")
                return False
            reminder = (
                f"[SYSTEM: No channel post from you this turn. If you meant to reply to "
                f"@{self.last_injected_sender}, it was NOT sent: the channel cannot see terminal output. "
                f"Re-send using collab_helper.py --to <Name> --stdin with a single-quoted heredoc. "
                f"Never put response text in a quoted shell argument. If no reply is needed, send nothing "
                f"and end your final answer with a line containing only {NO_REPLY_MARKER}.]"
            )
            self._send_child_input(reminder, key='Enter', bracketed=True)
            self._corrective_sent_msg_id = current_msg_id or '__legacy__'
        debug("Corrective re-injection sent for terminal-only @mention response")
        return True

    def check_verify_ingestion(self):
        """Poll the JSONL transcript to confirm message ingestion.

        Returns True if ingestion confirmed, False otherwise.

        Ledger-backed items acknowledge only an exact delivery token observed
        after the pre-submit byte boundary. A missing token releases the lease
        for retry. Legacy items retain the historical log-only timeout behavior.
        """
        if not self._verify_pending:
            return False

        elapsed = time.time() - self._verify_start_time
        transcript = self._resolve_transcript()

        if transcript and self._verify_search_text:
            token_end = find_codex_delivery_token_offset(
                transcript, self._verify_search_text, self._verify_after_byte
            )
            if token_end is not None:
                active = getattr(self, '_active_delivery', None)
                if active:
                    if not self._transition_active_delivery(
                        'ingested', transcript_path=transcript, transcript_byte=token_end
                    ):
                        # Token is durable in JSONL, but the server ACK failed.
                        # Keep verification live and retry the idempotent transition.
                        return False
                    self._codex_transcript_byte = token_end
                    self._track_injected_id(self._verify_msg_id)
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
            active = getattr(self, '_active_delivery', None)
            if active:
                # tmux/pane acceptance is not runtime-ingestion proof. If no
                # transcript exists, quarantine this ambiguous submit instead
                # of replaying it or falsely marking it handled.
                if transcript is None:
                    debug(
                        f"JSONL VERIFY: transcript unavailable after {elapsed:.1f}s "
                        f"— quarantining delivery, no retry"
                    )
                    quarantined = self._dead_letter_active_delivery('transcript_unavailable')
                    if quarantined:
                        self._verify_pending = False
                    if not getattr(self, '_verify_timeout_logged', False):
                        self._verify_timeout_logged = True
                        self.log_delivery_failure(
                            msg_id, 'transcript_unavailable', elapsed_ms=int(elapsed * 1000)
                        )
                    return False
                # A successful tmux submit can sit queued behind startup/tool work
                # for far longer than five seconds. Releasing here caused the exact
                # same token to be submitted repeatedly before Codex eventually
                # wrote the first copy to JSONL. Keep the exclusive lease and scan
                # until the late ingestion appears.
                if not getattr(self, '_verify_timeout_logged', False):
                    self._verify_timeout_logged = True
                    debug(
                        f"JSONL VERIFY: delayed after {elapsed:.1f}s — retaining lease; no replay"
                    )
                    self.log_delivery_failure(msg_id, 'jsonl_ingestion_timeout',
                        elapsed_ms=int(elapsed * 1000))
                return False
            self._verify_pending = False
            debug(f"JSONL VERIFY: TIMEOUT after {elapsed:.1f}s — logging only, no retry/rewind (Sprint 51 T2)")
            self.log_delivery_failure(msg_id, 'jsonl_ingestion_timeout',
                elapsed_ms=int(elapsed * 1000))
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
                            submit_key = getattr(self, 'pending_submit_key', 'Enter')
                            debug(f"WATCHDOG: Pending {submit_key} stuck for {elapsed:.1f}s — retrying")
                            try:
                                if self._send_child_input(key=submit_key):
                                    self._record_submit_success(submit_key)
                                else:
                                    debug(f"WATCHDOG: {submit_key} retry failed — pending state retained")
                            except Exception as e:
                                debug(f"WATCHDOG: Failed to send {submit_key}: {e}; pending state retained")
            except Exception as e:
                debug(f"WATCHDOG error: {e}")
            time.sleep(5)
        debug("Watchdog thread stopped")

    def sse_listener(self):
        """Background thread: subscribe to SSE for real-time message push.

        Connects to /api/events?types=collab&channelId={id} and receives
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
                            poll_url = f"{DEVFLOW_URL}/api/collab?channelId={self.channel_id}&participantId={self.participant_id}&since={since_iso}&limit={MAX_CATCHUP_MESSAGES}&oldestFirst=1"
                            debug(f"SSE zombie catch-up: using 2-min window since {since_iso}")
                        else:
                            poll_url = f"{DEVFLOW_URL}/api/collab?channelId={self.channel_id}&participantId={self.participant_id}&limit={MAX_CATCHUP_MESSAGES}&oldestFirst=1"
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
                        catchup_msgs = []
                        page_url = poll_url
                        # Page oldest-first so a backlog larger than the server
                        # limit cannot permanently hide its oldest records.
                        for _page in range(20):
                            poll_req = urllib.request.Request(page_url)
                            poll_resp = urllib.request.urlopen(poll_req, timeout=5)
                            poll_data = json.loads(poll_resp.read().decode('utf-8'))
                            page_messages = poll_data.get('messages', [])
                            catchup_msgs.extend(page_messages)
                            if not poll_data.get('hasMore') or not page_messages:
                                break
                            next_since = page_messages[-1].get('timestamp')
                            if not next_since:
                                break
                            page_url = (
                                f"{DEVFLOW_URL}/api/collab?channelId={self.channel_id}"
                                f"&participantId={self.participant_id}&since={next_since}"
                                f"&limit={MAX_CATCHUP_MESSAGES}&oldestFirst=1"
                            )
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
                            if self._should_skip_own_message(msg):
                                continue
                            if (self._uses_durable_delivery()
                                    and msg.get('metadata', {}).get('durableDelivery') == DELIVERY_PROTOCOL):
                                self._message_event.set()
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
                            # Immediately wake poll thread and trigger idle drain.
                            # The slow-poll idle drain (every POLL_INTERVAL=2s) can miss
                            # messages because the Codex TUI spinner continuously resets
                            # last_keystroke, keeping idle_time below IDLE_THRESHOLD.
                            # Setting _message_event forces an immediate poll-loop iteration
                            # so the idle drain fires without waiting for the next slow-poll
                            # cycle or for keystroke silence.
                            self._message_event.set()
                    except Exception as ce:
                        debug(f"SSE catch-up poll failed (non-fatal): {ce}")

                # Read SSE stream line-by-line
                event_type = None
                event_data = None
                event_id = None
                buffer = ""
                utf8_decoder = Utf8StreamDecoder()

                while self.running:
                    chunk = resp.read(1)
                    if not chunk:
                        debug("SSE stream ended (empty read)")
                        break

                    # Any received byte resets the zombie detection timer
                    self.sse_last_data_time = time.time()

                    char = utf8_decoder.decode(chunk)
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

            # Normal agent output must never loop back into the same agent.
            # Explicitly marked, self-addressed automation reminders are the
            # narrow exception: their purpose is to start a fresh agent turn.
            if self._should_skip_own_message(message):
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

            if (self._uses_durable_delivery()
                    and message.get('metadata', {}).get('durableDelivery') == DELIVERY_PROTOCOL):
                # SSE is a wake-up only. The poll thread obtains the embedded
                # payload from an atomic server lease.
                voice = message.get('metadata', {}).get('voice') or {}
                if voice.get('kind') == 'riley.voice.turn':
                    wakeup = getattr(self, '_voice_delivery_wakeup', None)
                    if wakeup is not None:
                        wakeup.set()
                self._message_event.set()
                debug(f"SSE woke durable claim for {message.get('id', '')[:8]}")
                return

            # Queue for the poll loop to inject (thread-safe)
            self.sse_message_queue.put(message)
            self._message_event.set()  # Wake poll thread immediately
            debug(f"SSE queued message from {message.get('from', {}).get('name', '?')}: {message.get('content', '')[:50]}")
        except json.JSONDecodeError as e:
            debug(f"SSE JSON parse error: {e}")
        except Exception as e:
            debug(f"SSE event handling error: {e}")

    def _should_skip_own_message(self, message):
        """Return True for own output, except an explicit self reminder.

        The metadata flag alone is insufficient. The message must also target
        this exact participant in ``mentions`` so a malformed cron cannot turn
        an ordinary channel post into a feedback loop.
        """
        sender_id = message.get("from", {}).get("id", "")
        if sender_id != self.participant_id:
            return False
        metadata = message.get("metadata") or {}
        mentions = message.get("mentions") or []
        return not (
            metadata.get("allowSelfDelivery") is True
            and self.participant_id in mentions
        )

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
                slow_poll_counter += 1

                # Local delivery authority is lease-bounded. Reconcile before
                # every state-machine step so a stale claim can never jam the
                # participant's entire queue.
                self._check_voice_cancel_request()
                self._interrupt_answered_voice_for_followup()
                self._renew_active_delivery()
                self._reconcile_active_delivery()
                self._check_startup_timeout()

                # Fast check: deferred Enter (runs every 200ms)
                self.check_pending_enter()

                # Fast check: JSONL ingestion verification (runs every 200ms)
                self.check_verify_ingestion()

                # Retry a failed handled ACK without reopening delivery. The
                # exact-token byte boundary makes this causally safe.
                active_delivery = getattr(self, '_active_delivery', None)
                if (active_delivery and active_delivery.get('state') == 'ingested'
                        and not self.is_processing
                        and self._check_jsonl_state() == 'idle'):
                    self._complete_active_delivery()

                # Fast check: detect processing from non-inject sources via JSONL (runs every 200ms)
                self.check_jsonl_processing_start()

                # No Plan Mode for Codex — nothing to do here.

                # Fast check: drain SSE queue while processing (runs every 200ms)
                # Without this, messages sit in sse_message_queue until idle
                # transition — causing 10-20s delays. Draining here lets
                # inject_message() batch them into the input buffer immediately.
                if (not self._uses_durable_delivery()
                        and self.is_processing and self.joined and self.child
                        and self.child.isalive() and self.sse_connected):
                    _drained = 0
                    while not self.sse_message_queue.empty() and _drained < 20:
                        try:
                            _qm = self.sse_message_queue.get_nowait()
                        except queue.Empty:
                            break
                        _qm_id = _qm.get("id")
                        _qm_sid = _qm.get("from", {}).get("id", "")
                        if self._should_skip_own_message(_qm):
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

                # Fast check: idle transition detection (runs every 200ms)
                # Detects when agent finishes processing and immediately drains
                # the SSE queue — eliminates the 2s slow-poll lag.
                if self.is_processing and self.last_output_time > 0:
                    _now = time.time()
                    _silence = _now - self.last_output_time
                    _threshold = self.activity_idle_threshold if self.output_seen_since_inject else self.initial_idle_threshold
                    if _silence >= _threshold and not self.is_process_tree_active():
                        # Check JSONL ground truth before declaring idle
                        # Codex states: 'idle' (final_answer), 'processing' (still generating), None
                        _jsonl_state = self._check_jsonl_state()
                        if _jsonl_state == 'processing':
                            # Codex is still generating — NOT idle despite silence+CPU
                            self._jsonl_check_count += 1
                            if self._jsonl_check_count % 25 == 1:  # Log every 25th check (~5s at 200ms)
                                debug(f"JSONL override: Codex still processing, suppressing idle transition ({_silence:.1f}s silence)")
                            continue
                        # 'idle' (final_answer confirmed) or None — proceed with idle transition
                        if _jsonl_state == 'idle':
                            debug(f"JSONL confirms idle: final_answer detected ({_silence:.1f}s silence)")
                            self._run_hook_on_turn_complete()
                        elif _jsonl_state is None:
                            debug(f"JSONL unavailable — assuming idle ({_silence:.1f}s silence)")
                        self._jsonl_check_count = 0
                        # Silent AND CPU idle — truly done
                        self.is_processing = False
                        self.idle_since = _now
                        self.broadcast_activity('idle')
                        debug(f"Fast idle transition: {_silence:.1f}s silence, CPU idle")
                        if self._post_compact_reinject_pending:
                            self._post_compact_reinject_pending = False
                            self._reinject_after_compaction()
                        self._complete_active_delivery()
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
                            debug(f"Suppressed premature corrective: only {_time_since_inject:.1f}s since inject (need 30s). Agent likely still processing.")
                        # No channel post covers two opposite situations: the
                        # reply went to the terminal (recoverable — warn), or the
                        # agent deliberately said nothing (correct — close
                        # quietly). Only the transcript separates them, and only
                        # for the turn that began at this delivery. Anything
                        # short of proven emptiness keeps the warning.
                        _silent_turn = False
                        if not agent_responded and self.last_injected_sender and _time_since_inject >= 30:
                            _t = self._resolve_transcript()
                            _after = getattr(self, '_verify_after_byte', 0) or 0
                            _disposition = codex_final_response_disposition(_t, _after) if _t else None
                            _silent_turn = _disposition == "empty"
                            if _silent_turn:
                                debug(
                                    "Deliberate silence: turn completed with no final answer "
                                    f"after byte {_after} — closing without a corrective"
                                )
                        if (not agent_responded and not _silent_turn and self.last_injected_sender
                                and _time_since_inject >= 30
                                and getattr(self, '_corrective_sent_msg_id', None)
                                != getattr(self, '_response_window_msg_id', None)):
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
                        # Long Codex rollouts can begin emitting malformed,
                        # terminal-only final text before the CLI's own late
                        # compaction. Compact proactively after the real channel
                        # response is durable, never while a delivery is queued.
                        if agent_responded and self._maybe_auto_compact_context():
                            continue
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
                                    if self._should_skip_own_message(_msg):
                                        _skip = True
                                    if not _skip:
                                        with self._dedup_lock:
                                            if _msg_id and _msg_id in self.injected_message_ids:
                                                _skip = True
                                    if not _skip:
                                        _ts = _msg.get("timestamp")
                                        if self.inject_message(_sender, _content, _reply, _mentions, channel_id=self.channel_id, msg_timestamp=_ts, msg_id=_msg_id):
                                            if _msg_id:
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
                                                        self._track_injected_id(_nid)
                                                        self.log_delivery_event(_nid, "delivered")
                                                    self.pending_mark_read_timestamp = _nts
                                                    _bc += 1
                                            if _bc > 0:
                                                debug(f"Batched {_bc} additional message(s) after idle transition")
                                except queue.Empty:
                                    pass  # No messages waiting

                # Slow check: API operations (runs every POLL_INTERVAL)
                if self._consume_voice_delivery_wakeup():
                    slow_poll_counter = slow_poll_threshold
                if slow_poll_counter >= slow_poll_threshold:
                    slow_poll_counter = 0
                    poll_count += 1

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
                                if (self._uses_durable_delivery()
                                        and cu_msg.get('metadata', {}).get('durableDelivery') == DELIVERY_PROTOCOL):
                                    self._message_event.set()
                                    continue
                                with self._dedup_lock:
                                    cu_already_seen = cu_id and cu_id in self.injected_message_ids
                                if cu_already_seen:
                                    continue
                                cu_sender_id = cu_msg.get('from', {}).get('id', '')
                                if self._should_skip_own_message(cu_msg):
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

                    # Periodic inbox catch-up (every ~120 seconds / 60 polls)
                    # Reads unread messages from the disk-based inbox file.
                    # Runs regardless of SSE state — inbox is a safety net that
                    # catches messages SSE silently drops (Sprint 50 T2).
                    if poll_count % 60 == 0 and self.joined and self.participant_id:
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
                    if (self.joined and self.child and self.child.isalive()
                            and not self.pending_enter and not self.is_processing
                            and getattr(self, '_active_delivery', None) is None):
                        idle_time = time.time() - self.last_keystroke
                        # Drain when idle long enough OR when messages are waiting in the
                        # SSE queue. The Codex TUI spinner continuously resets last_keystroke,
                        # which can keep idle_time below IDLE_THRESHOLD indefinitely and
                        # prevent catch-up messages from ever being injected.
                        has_queued = (
                            (self.sse_connected and not self.sse_message_queue.empty())
                            or self._uses_durable_delivery()
                        )
                        if idle_time >= IDLE_THRESHOLD or has_queued:
                            # Get messages from SSE queue (real-time) or fall back to polling
                            messages = []
                            self._recover_ingested_delivery()
                            durable_message = self._claim_durable_delivery()
                            if durable_message:
                                messages = [durable_message]
                            elif self.sse_connected:
                                # Pop ONE message per poll cycle — remaining stay queued for next cycle.
                                # Drain-all-process-one would lose queued messages silently.
                                try:
                                    messages = [self.sse_message_queue.get_nowait()]
                                except queue.Empty:
                                    messages = []
                            else:
                                # SSE not connected — fall back to API polling
                                messages = self.check_messages()

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

                                # A live server lease outranks the wrapper-local
                                # cache (explicit dup-over-drop recovery). Legacy
                                # wake-up paths retain local dedup.
                                claimed = getattr(self, '_active_delivery', None)
                                is_claimed = bool(claimed and claimed.get('messageId') == msg_id)
                                if not is_claimed:
                                    with self._dedup_lock:
                                        if msg_id and msg_id in self.injected_message_ids:
                                            debug(f"Skipping already-injected message: {msg_id[:8]}...")
                                            continue

                                # Skip own output unless this is an explicitly
                                # marked, self-addressed automation reminder.
                                if self._should_skip_own_message(msg):
                                    continue
                                # Allow system messages only if they mention us (e.g. keep-alive pings)
                                if sender_id == "system" and self.participant_id not in mentions:
                                    continue

                                # Only inject ONE message per poll cycle, wait for it to be submitted
                                msg_ts = msg.get("timestamp")
                                if self.inject_message(sender, content, reply_to, mentions, channel_id=self.channel_id, msg_timestamp=msg_ts, msg_id=msg_id):
                                    active_delivery = getattr(self, '_active_delivery', None)
                                    is_durable = bool(
                                        active_delivery and active_delivery.get('messageId') == msg_id
                                    )
                                    if msg_id:
                                        # Track for delivery timeout detection
                                        self.last_injected_msg_id = msg_id
                                        self.delivery_timeout_logged = False
                                        if not is_durable:
                                            self._track_injected_id(msg_id)
                                            # Legacy telemetry retains tmux-accepted semantics.
                                            self.log_delivery_event(msg_id, "delivered")
                                    # Cursor advancement deferred to JSONL verification
                                    # success (Sprint 50 T1). Do NOT advance here.
                                    # mark_read deferred to after Claude finishes processing
                                    # (see is_processing=False block). This prevents phantom reads
                                    # where lastRead advances past messages Claude never handled.
                                    self.pending_mark_read = not is_durable
                                    self.pending_mark_read_timestamp = msg_ts
                                    # Drain remaining queued messages into the input buffer.
                                    # inject_message() will APPEND them (pending_enter is now True).
                                    # This batches multiple messages into one submission.
                                    batch_count = 0
                                    while (not is_durable and not self.sse_message_queue.empty()
                                           and batch_count < 20):
                                        try:
                                            next_msg = self.sse_message_queue.get_nowait()
                                        except queue.Empty:
                                            break
                                        next_id = next_msg.get("id")
                                        next_sender_id = next_msg.get("from", {}).get("id", "")
                                        if self._should_skip_own_message(next_msg):
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
                                                self._track_injected_id(next_id)
                                                self.log_delivery_event(next_id, "delivered")
                                            self.pending_mark_read_timestamp = next_ts
                                            batch_count += 1
                                            debug(f"Batch append {batch_count}: {next_sender}")
                                    if batch_count > 0:
                                        debug(f"Batched {batch_count} additional message(s) into input buffer")
                                    break  # All queued messages processed
                                elif getattr(self, '_active_delivery', None):
                                    self._release_active_delivery('tmux_send_failed')
                                    self._clear_active_delivery_state('tmux_send_failed')

                    # Check forwarding queue for cross-channel messages (every slow poll)
                    if (self.joined and self.child and self.child.isalive()
                            and not self.pending_enter and not self.is_processing
                            and getattr(self, '_active_delivery', None) is None):
                        self.check_forward_queue()

            except Exception as e:
                debug(f"Poll error: {e}")

            # Wait for next cycle — wakes early if SSE pushes a new message
            self._message_event.wait(timeout=fast_poll_interval)
            self._message_event.clear()
        debug("Poll thread stopped")

    def run(self):
        # Find Codex binary
        if not os.path.exists(CODEX_BINARY):
            print(f"\033[31mError: Codex not found at {CODEX_BINARY}\033[0m", file=sys.stderr)
            return 1

        debug(f"Starting Codex: {CODEX_BINARY} {self.codex_args}")

        try:
            MAX_RESTARTS = 5
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

            # SessionStart equivalent: initialise .session-scratch/ layout
            self._run_hook_on_startup()

            # Start SSE listener thread — real-time message push (replaces polling for messages)
            sse_thread = threading.Thread(target=self.sse_listener, daemon=True)
            sse_thread.start()

            # Join channel once — persists across Claude restarts.
            if self.channel_id:
                self.join_channel(self.channel_id, force=True)
                # Inbox catch-up: read any messages the server wrote to disk that
                # SSE/polling missed (e.g. crash recovery, API saturation).
                # Queues into sse_message_queue for the normal processing pipeline.
                self.check_inbox()

            # I/O filters — defined once, shared across all restart iterations.
            # Custom input filter to track keystrokes
            def input_filter(data):
                self.last_keystroke = time.time()
                return data

            # Custom output filter to detect activity (Claude generating response)
            def output_filter(data):
                self.last_output_time = time.time()
                self._observe_child_startup_output(data)
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

            # Restart loop — Codex is respawned after each clean exit (e.g. context compaction).
            # Max MAX_RESTARTS to prevent infinite loops on persistent failures.
            while restart_count <= MAX_RESTARTS:
                # The managed Design Reference gate is an explicitly activated host
                # requirement.  Unprovisioned hosts default to disabled; once an operator
                # sets DEVFLOW_CODEX_MANAGED_GATE_MODE=required, keep the original
                # fail-closed behavior for missing, unsafe, or corrupt root-owned policy.
                try:
                    validate_codex_managed_gate_if_required()
                except RuntimeError as error:
                    print(
                        f"\033[31m[Collab] Codex managed Design Reference gate preflight failed: "
                        f"{error}\033[0m",
                        file=sys.stderr,
                    )
                    debug(f"Managed Design Reference gate preflight failed: {error}")
                    return 1
                final_args = self._build_codex_launch_args()
                # Provisioning normally pre-registers this exact path. Keep a
                # launch-time guard as well so manually added or legacy agents
                # can never block on Codex's first-run trust prompt.
                ensure_codex_workspace_trusted(os.getcwd())
                refresh_wsl_interop_environment()
                self._reset_child_startup_state()
                # Spawn Codex in a real PTY using pexpect
                self.child = pexpect.spawn(CODEX_BINARY, final_args, encoding='utf-8', timeout=None)
                # Disable pexpect's 50ms sleep-before-send
                self.child.delaybeforesend = 0

                # Get Codex's PID - crucial for session registration
                self.codex_pid = self.child.pid
                # Reset JSONL transcript tracking on each spawn (new session file)
                self._codex_transcript_path = None
                self._codex_transcript_byte = 0
                if restart_count == 0:
                    debug(f"Codex spawned with PID: {self.codex_pid}")
                else:
                    debug(f"Codex respawned with PID: {self.codex_pid} (restart {restart_count}/{MAX_RESTARTS})")

                # Schedule one-time background PID snapshot ~3s after spawn (Task 4).
                # After 3s, MCP servers and persistent helpers are running; we snapshot
                # their PIDs so is_process_tree_active() can exclude them from CPU delta.
                def _schedule_bg_pid_capture():
                    time.sleep(3)
                    self._capture_background_pids()
                threading.Thread(target=_schedule_bg_pid_capture, daemon=True).start()

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

                # interact() returned — Codex exited (e.g. after context compaction).
                # Close first so pexpect populates exitstatus before classification.
                try:
                    self.child.close(force=False)
                except Exception:
                    try:
                        self.child.close(force=True)
                    except Exception:
                        pass
                exit_status = self.child.exitstatus
                debug(
                    f"Codex exited (status={exit_status}, restarts={restart_count}/{MAX_RESTARTS}, "
                    f"startup_proven={self._child_startup_proven})"
                )
                exited_pid = self.codex_pid
                self._cleanup_child_files(exited_pid)

                active_delivery = getattr(self, '_active_delivery', None)
                if active_delivery:
                    state = active_delivery.get('state')
                    accepted = state in ('submitted', 'ingested')
                    reason = 'child_exit_after_submit' if accepted else 'child_exit_before_ingestion'
                    if accepted:
                        self._dead_letter_active_delivery(reason)
                    else:
                        self._release_active_delivery(reason, requeue=False)
                    # Server lease/recovery state remains authoritative if the
                    # call failed; never let stale wrapper memory block respawn.
                    self._clear_active_delivery_state(reason)

                if self._startup_exit_is_fatal(exit_status):
                    reason = self._fatal_startup_error or f"exit status {exit_status} before ready"
                    print(f"\033[31m[Collab] Codex startup failed: {reason}\033[0m", file=sys.stderr)
                    debug(f"Fatal startup exit; stopping restart loop: {reason}")
                    return 1

                if restart_count >= MAX_RESTARTS:
                    debug(f"Max restarts ({MAX_RESTARTS}) reached, wrapper exiting")
                    break

                # Reset state before respawn — prevents stale flags from previous session
                self.is_processing = False
                with self._enter_lock:
                    self.pending_enter = False
                    self.pending_enter_time = 0
                    self.pending_submit_key = 'Enter'
                self.collab_response_sent = False
                self.pending_mark_read = False
                self.pending_mark_read_timestamp = None
                debug("State reset before respawn")

                restart_count += 1
                backoff_seconds = min(30.0, 2 ** restart_count) + random.uniform(0.0, 1.0)
                debug(
                    f"Restarting Codex (attempt {restart_count}/{MAX_RESTARTS}) "
                    f"after {backoff_seconds:.1f}s backoff"
                )
                time.sleep(backoff_seconds)

        except pexpect.exceptions.ExceptionPexpect as e:
            print(f"\033[31mError: {e}\033[0m", file=sys.stderr)
            debug(f"Pexpect error: {e}")
            return 1
        except KeyboardInterrupt:
            pass
        finally:
            self.running = False
            # Sprint 58 T1 — flush any in-flight dedup state before exit so the
            # next session loads the full set of handled message IDs.
            try:
                if self._dedup_dirty:
                    self._persist_injected_ids()
            except Exception as e:
                debug(f"Final dedup persist failed: {e}")
            # NOTE: do NOT leave the channel on exit. The participant persists
            # across wrapper restarts so the agent doesn't disappear from the channel.
            # DevFlow join with force=True handles participant deduplication.
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
    parser = argparse.ArgumentParser(description="Codex with collab support")
    parser.add_argument("--channel", "-c", help="Channel ID to join")
    parser.add_argument("--name", "-n", help="Display name")
    parser.add_argument("--list", "-l", action="store_true", help="List channels")
    parser.add_argument("--agent-name", help="Agent name for hook scripts (e.g. 'Builder')")
    parser.add_argument("--agent-dir", help="Agent directory for hook scripts (e.g. ~/DevFlow/Team/Builder)")
    parser.add_argument("--model", default="gpt-6-astra", help="Model to use (default: gpt-6-astra)")
    parser.add_argument("--effort", default=None, help="Reasoning effort level: low|medium|high|xhigh|max|ultra")
    parser.add_argument("--fast-mode", choices=("enabled", "disabled"), default=None,
                        help="Pin Codex Fast mode for this agent")
    # Note: Codex reads system prompt from AGENTS.md in the working directory.
    # No --system-prompt-file flag needed — scaffolding writes AGENTS.md directly.

    args, codex_args = parser.parse_known_args()

    if args.list:
        list_channels()
        return 0

    wrapper = CollabCodexWrapper(
        channel_id=args.channel,
        participant_name=args.name,
        codex_args=codex_args,
        agent_name=args.agent_name,
        agent_dir=args.agent_dir,
        model=args.model,
        effort=args.effort,
        fast_mode=(args.fast_mode == "enabled") if args.fast_mode is not None else None,
    )
    return wrapper.run()


if __name__ == "__main__":
    sys.exit(main())
