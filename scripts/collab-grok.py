#!/usr/bin/env python3
"""
collab-grok.py — Grok AI agent for DevFlow collab channels.

Unlike collab-claude.py (which wraps the Claude CLI via pexpect), this script
calls the xAI API directly using the openai SDK pointed at https://api.x.ai/v1.
The Python process itself IS the agent — no subprocess or PTY required.

Session protocol (same contracts as collab-claude.py):
  /tmp/collab-ready-{PID}.json    — agent is available for channel join
  /tmp/collab-session-{PID}.json  — active session info (read by collab_helper.py)
  {CWD}/.claude/collab-session-{PID}.json — project-local session copy

Usage:
  collab-grok.py --channel <id> --name <name>
  collab-grok.py --channel <id> --name <name> --model grok-4.7
  collab-grok.py --channel <id> --name <name> --system-prompt-file /path/to/prompt.md
"""

import atexit
import os
os.environ["COLLAB_AGENT_WRAPPER"] = "1"
import sys
import json
import time
import signal
import argparse
import threading
import queue
import traceback
import subprocess
import urllib.request
import urllib.error
import concurrent.futures
from agent_stream_writer import safe_append_stream_message

try:
    from reply_context import format_reply_context
except ImportError:  # ships next to this script; a stray copy without it only loses the reply line
    def format_reply_context(reply_to):
        return ""

try:
    from openai import OpenAI
except ImportError:
    print("Error: openai not installed. Run: pip install openai", file=sys.stderr)
    sys.exit(1)

# Optional tool execution layer (grok_tools.py in same directory)
try:
    import sys as _sys
    _sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from grok_tools import (
        TOOL_DEFINITIONS,
        execute_tool,
        call_xai_with_tools,
        is_progress_only_response,
        preload_rag_models,
        build_xai_kwargs,
    )
    _TOOLS_AVAILABLE = True
except ImportError:
    _TOOLS_AVAILABLE = False
    TOOL_DEFINITIONS = []
    execute_tool = None
    call_xai_with_tools = None
    is_progress_only_response = None
    preload_rag_models = None
    build_xai_kwargs = None

# Optional TokenPulse integration — record xAI API calls to the Pulse SQLite DB
_PULSE_ADAPTER_AVAILABLE = False
_record_xai_response = None
_PULSE_DB_PATH = None
_pulse_sqlite3 = None
try:
    import sqlite3 as _pulse_sqlite3
    _PULSE_COLLECTOR_PATH = os.path.join(os.path.expanduser("~"), "Pulse/src/collector")
    if _PULSE_COLLECTOR_PATH not in sys.path:
        sys.path.insert(0, _PULSE_COLLECTOR_PATH)
    from adapters import record_xai_response as _record_xai_response
    from schema import DB_PATH as _PULSE_DB_PATH
    _PULSE_ADAPTER_AVAILABLE = True
except (ImportError, Exception):
    pass

# ─── Configuration ────────────────────────────────────────────────────────────
DEVFLOW_URL = __import__("os").environ.get("DEVFLOW_URL", "http://localhost:3000").rstrip("/")
DEVFLOW_API_BASE = f"{DEVFLOW_URL}/api/collab"
XAI_BASE_URL = "https://api.x.ai/v1"
DEFAULT_MODEL = "grok-4.7"
MAX_HISTORY_TURNS = 20      # Max conversation turns kept in memory (each = 1 user + 1 assistant)
MAX_RESPONSE_CHARS = 8000   # Truncate Grok responses at this length before posting
POLL_INTERVAL = 2.0         # Seconds between fallback API polls (when SSE not connected)
HEARTBEAT_INTERVAL = 30.0   # Seconds between idle heartbeats
XAI_CALL_TIMEOUT = 120.0    # Max seconds for one xAI API request (set on the client)
# A tool-using turn makes several requests in a row; reasoning models such as
# grok-4.7 can need a few minutes in total, so the whole turn gets its own budget.
XAI_TURN_TIMEOUT = 600.0    # Max seconds for a whole reply, including every tool round
WATCHDOG_STUCK_THRESHOLD = XAI_TURN_TIMEOUT + 30.0  # Seconds before watchdog considers processing stuck
DEBUG_LOG = "/tmp/collab-grok-debug.log"


def debug(msg: str) -> None:
    """Write timestamped debug entry to log file."""
    try:
        with open(DEBUG_LOG, "a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} [{os.getpid()}] {msg}\n")
    except Exception:
        pass


def _write_crash_report(reason: str, signum: int = 0, exc_info=None) -> str:
    """Write a crash diagnostic report to /tmp/grok-crash-{name}-{pid}.json.

    Called on SIGTERM, SIGINT, and unhandled exceptions to capture the full
    state of the agent at time of crash for post-mortem analysis.

    Returns the path of the written file (empty string on failure).
    """
    pid = os.getpid()
    name = os.environ.get("_GROK_AGENT_NAME", "unknown")
    report_path = f"/tmp/grok-crash-{name}-{pid}.json"

    try:
        # Capture all thread stacks
        thread_stacks = {}
        for tid, frame in sys._current_frames().items():
            try:
                thread_name = next(
                    (t.name for t in threading.enumerate() if t.ident == tid),
                    f"Thread-{tid}"
                )
                stack = traceback.format_stack(frame)
                thread_stacks[thread_name] = "".join(stack)
            except Exception:
                pass

        # Capture exception info if provided
        exc_text = None
        if exc_info:
            exc_text = "".join(traceback.format_exception(*exc_info))

        # Capture memory info (/proc/meminfo on Linux, vm_stat on macOS)
        mem_info = {}
        try:
            import proc_info
            mem_info = {k: v for k, v in proc_info.mem_info_kb().items()
                        if k in ("MemTotal", "MemFree", "MemAvailable", "SwapTotal", "SwapFree")}
        except Exception:
            pass

        # Capture active tmux sessions (the key diagnostic for kill-session origin)
        tmux_sessions = []
        try:
            result = subprocess.run(
                ["tmux", "list-sessions", "-F", "#{session_name} created=#{session_created}"],
                capture_output=True, text=True, timeout=3
            )
            tmux_sessions = [s for s in result.stdout.strip().split("\n") if s]
        except Exception:
            pass

        # Last 20 lines of the debug log
        recent_debug = []
        try:
            with open(DEBUG_LOG) as f:
                recent_debug = f.readlines()[-20:]
        except Exception:
            pass

        # Who recently called kill? Check /proc for suspicious processes (heuristic)
        killer_hint = []
        try:
            result = subprocess.run(
                ["ps", "-eo", "pid,ppid,lstart,cmd", "--no-headers"],
                capture_output=True, text=True, timeout=3
            )
            for line in result.stdout.split("\n"):
                if any(kw in line.lower() for kw in ["tmux", "kill", "roster", "collab-pty"]):
                    killer_hint.append(line.strip())
        except Exception:
            pass

        report = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "agent_name": name,
            "pid": pid,
            "reason": reason,
            "signal": signum,
            "exception": exc_text,
            "thread_stacks": thread_stacks,
            "memory_mb": {k: v // 1024 for k, v in mem_info.items()},
            "tmux_sessions": tmux_sessions,
            "recent_debug_log": recent_debug,
            "killer_hint": killer_hint,
        }

        with open(report_path, "w") as f:
            json.dump(report, f, indent=2)

        debug(f"Crash report written to {report_path}")
        return report_path

    except Exception as e:
        debug(f"Failed to write crash report: {e}")
        return ""


def load_grok_api_key() -> str:
    """Return GROK_API_KEY from environment or ~/.secrets.

    Parses export statements from ~/.secrets without sourcing the shell file,
    avoiding any risk of executing shell logic.
    """
    key = os.environ.get("GROK_API_KEY", "").strip()
    if key:
        return key

    secrets_path = os.path.expanduser("~/.secrets")
    if os.path.exists(secrets_path):
        try:
            with open(secrets_path) as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("export GROK_API_KEY="):
                        val = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if val:
                            return val
        except Exception as e:
            debug(f"Error reading ~/.secrets: {e}")

    return ""


# ─── Main Wrapper Class ────────────────────────────────────────────────────────

class CollabGrokWrapper:
    """
    Grok collab agent wrapper.

    Connects to a DevFlow collab channel, receives messages via SSE (with
    HTTP polling as fallback), calls the xAI API for each message, and
    posts the response back to the channel.

    Thread model:
      - sse_listener_thread  : SSE stream reader (real-time push)
      - heartbeat_thread     : Periodic heartbeat to keep presence alive
      - message_loop_thread  : Drains message queue → spawns process_message per msg
    """

    def __init__(
        self,
        channel_id: str,
        participant_name: str,
        model: str = DEFAULT_MODEL,
        system_prompt: str = "",
        tool_executor=None,
    ):
        self.channel_id = channel_id
        self.participant_name = participant_name
        self.model = model
        # Build full scaffolded system prompt (identity + CLAUDE.md hierarchy + rules + memory + explicit)
        self.system_prompt = self._build_scaffolded_prompt(system_prompt)
        # Optional callable: tool_executor(tool_name, tool_args) -> str
        # Wired in by the tool execution layer (Phase 2 Task 3)
        self.tool_executor = tool_executor

        self.pid = os.getpid()
        self.running = True
        self.joined = False
        self.participant_id: str | None = None
        self.channel_name = ""  # Set after successful join_channel()

        # Pulse DB metadata (derived from CWD at startup)
        self._pulse_project = self._detect_project()

        # Message tracking
        self.last_poll_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.injected_message_ids: set[str] = set()

        # Conversation history: list of {"role": "user"|"assistant", "content": str}
        # Maintained across messages for multi-turn context.
        self.conversation_history: list[dict] = []

        # Token usage tracking: written to /tmp/grok-usage-{pid}.json after each API call
        self.token_usage = {"input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0, "total_tokens": 0}

        # Activity tracking
        self.current_activity = "idle"
        self.last_heartbeat_time = 0.0

        # SSE state
        self.sse_connected = False
        self.sse_message_queue: queue.Queue = queue.Queue()
        self.sse_last_event_id: str | None = None
        self.sse_reconnect_failures = 0

        # Prevent concurrent xAI API calls
        self.processing_lock = threading.Lock()
        self.processing_start_time: float = 0.0   # When current processing started (0 = idle)
        self._shutdown_hook_fired = False          # prevent duplicate Stop-hook events

        # Initialize xAI client
        api_key = load_grok_api_key()
        if not api_key:
            print(
                "Error: GROK_API_KEY not found. "
                "Add 'export GROK_API_KEY=...' to ~/.secrets or set it in the environment.",
                file=sys.stderr,
            )
            sys.exit(1)

        self.client = OpenAI(api_key=api_key, base_url=XAI_BASE_URL, timeout=XAI_CALL_TIMEOUT)
        debug(f"Initialized: name={participant_name}, model={model}, pid={self.pid}")

    # ── DevFlow collab API ─────────────────────────────────────────────────────

    def _api_call(self, endpoint: str, method: str = "GET", data: dict | None = None) -> dict:
        """Make an HTTP call to the DevFlow collab API."""
        url = f"{DEVFLOW_API_BASE}{endpoint}"
        try:
            if method == "GET":
                req = urllib.request.Request(url)
            else:
                req = urllib.request.Request(
                    url,
                    data=json.dumps(data).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method=method,
                )
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            debug(f"API error [{method} {endpoint}]: {e}")
            return {"error": str(e)}

    def _broadcast_activity(self, status: str, force: bool = False) -> None:
        """Send heartbeat/activity update to the channel."""
        if not self.joined or not self.participant_id:
            return
        if status == self.current_activity and not force:
            return
        self.current_activity = status
        self.last_heartbeat_time = time.time()
        debug(f"Activity: {status}{'(forced)' if force else ''}")
        self._api_call("", "POST", {
            "action": "heartbeat",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "activityStatus": status,
        })

    # ── Session file management ────────────────────────────────────────────────

    def _register_session(self) -> None:
        """Write /tmp/collab-ready-{PID}.json so the DevFlow UI can find this agent."""
        try:
            ready = {
                "pid": self.pid,
                "name": self.participant_name,
                "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "cwd": os.getcwd(),
                "wrapperPid": self.pid,   # No separate wrapper — process IS the agent
                "agentType": "grok",
            }
            with open(f"/tmp/collab-ready-{self.pid}.json", "w") as f:
                json.dump(ready, f)
            print(f"[Grok] Session ready (PID {self.pid}) — can be added to channels via DevFlow UI", file=sys.stderr)
            debug(f"Ready file written for PID {self.pid}")
        except Exception as e:
            debug(f"Failed to write ready file: {e}")

    def _write_session_file(self, channel_name: str = "") -> None:
        """Write PID-specific session files for collab_helper.py compatibility.

        Two locations are written (same as collab-claude.py):
          1. /tmp/collab-session-{PID}.json     (CWD-independent, checked first by helper)
          2. {CWD}/.claude/collab-session-{PID}.json (project-local fallback)

        Fields match CollabSession.load() expectations in collab_helper.py:
          channelId, participantId, displayName, agentType, projectPath
        """
        session_data = {
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "displayName": self.participant_name,
            "channelName": channel_name or "Unknown",
            "pid": self.pid,
            "agentType": "grok",
            "projectPath": os.getcwd(),
        }
        try:
            # /tmp/ first (CWD-independent)
            tmp_path = f"/tmp/collab-session-{self.pid}.json"
            with open(tmp_path, "w") as f:
                json.dump(session_data, f)

            # Project-local copy
            claude_dir = os.path.join(os.getcwd(), ".claude")
            os.makedirs(claude_dir, exist_ok=True)
            local_path = os.path.join(claude_dir, f"collab-session-{self.pid}.json")
            with open(local_path, "w") as f:
                json.dump(session_data, f)

            debug(f"Session files written: {tmp_path} + {local_path}")
        except Exception as e:
            debug(f"Failed to write session files: {e}")

    # ── Scaffolding loader ─────────────────────────────────────────────────────

    @staticmethod
    def _detect_project() -> str:
        """Extract project name from CWD. ~/Pulse/Team/X → 'Pulse'."""
        cwd = os.getcwd()
        parts = [p for p in cwd.split("/") if p]
        try:
            team_idx = parts.index("Team")
            if team_idx > 0:
                return parts[team_idx - 1]
        except ValueError:
            pass
        return parts[-1] if parts else "unknown"

    def _record_to_pulse(self, usage, duration_ms: int = 0) -> None:
        """Persist one xAI API call's token usage to the TokenPulse database."""
        if not _PULSE_ADAPTER_AVAILABLE or not usage:
            return
        try:
            details = getattr(usage, "prompt_tokens_details", None)
            cached = (getattr(details, "cached_tokens", 0) or 0) if details else 0
            response_dict = {
                "model": self.model,
                "usage": {
                    "prompt_tokens": getattr(usage, "prompt_tokens", 0) or 0,
                    "completion_tokens": getattr(usage, "completion_tokens", 0) or 0,
                    "total_tokens": getattr(usage, "total_tokens", 0) or 0,
                    "prompt_tokens_details": {"cached_tokens": cached},
                },
            }
            conn = _pulse_sqlite3.connect(_PULSE_DB_PATH, timeout=5)
            try:
                _record_xai_response(
                    conn,
                    response_dict,
                    agent_name=self.participant_name,
                    project=self._pulse_project,
                    collab_channel=self.channel_name,
                    duration_ms=duration_ms,
                )
            finally:
                conn.close()
            debug(
                f"Pulse: recorded {response_dict['usage']['prompt_tokens']}in/"
                f"{response_dict['usage']['completion_tokens']}out for {self.model}"
            )
        except Exception as e:
            debug(f"Pulse record error: {e}")

    def _report_to_tokenpulse(
        self,
        input_tokens: int,
        output_tokens: int,
        cache_read_tokens: int,
    ) -> None:
        """POST per-request token usage to TokenPulse ingest endpoint (fire-and-forget).

        Runs in a daemon thread so it never blocks the main processing flow.
        All exceptions are caught silently — TokenPulse being down must not affect Grok.
        """
        def _post() -> None:
            try:
                payload = json.dumps({
                    "provider": "xai",
                    "model": self.model,
                    "agent_name": self.participant_name,
                    "project": self._pulse_project,
                    "collab_channel": self.channel_name or self.channel_id,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cache_read_tokens": cache_read_tokens,
                    "duration_ms": 0,
                }).encode("utf-8")
                req = urllib.request.Request(
                    "http://localhost:8420/api/ingest",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=5) as _resp:
                    pass
            except Exception as e:
                debug(f"TokenPulse ingest error (non-critical): {e}")

        t = threading.Thread(target=_post, daemon=True)
        t.start()

    @staticmethod
    def _load_file_safe(path: str, max_lines: int = 0) -> str:
        """Return file contents, or empty string if missing/unreadable."""
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                if max_lines:
                    lines = []
                    for i, line in enumerate(f):
                        if i >= max_lines:
                            break
                        lines.append(line)
                    return "".join(lines).strip()
                return f.read().strip()
        except Exception:
            return ""

    def _build_scaffolded_prompt(self, explicit_prompt: str) -> str:
        """Build a full system prompt from scaffolding files + optional explicit prompt.

        Load order (mirrors Claude Code's CLAUDE.md hierarchy):
          1. Identity line (always first — so Grok knows its name)
          2. ~/.claude/CLAUDE.md (global user instructions)
          3. CLAUDE.md files walking up from CWD to home dir (project-level instructions)
          4. {CWD}/.claude/rules/*.md (personality, directives, workspace, expertise,
             skill-index.md — S2.6 SG-1 skill catalog for on-demand skill loading)
          5. {CWD}/alignment-grok.md (runtime-specific adjustments)
          6. ~/.claude/projects/{encoded}/memory/MEMORY.md (persistent memory, max 200 lines)
          7. Explicit system prompt (from --system-prompt-file), if provided
        """
        sections: list[str] = []
        cwd = os.getcwd()
        home = os.path.expanduser("~")

        # 1. Identity — always first
        sections.append(
            f"Your name is {self.participant_name}. "
            f"You are a Grok AI agent on the DevFlow multi-agent platform. "
            f"You work alongside Claude and Gemini agents as an expert software engineer. "
            f"Be concise, technically precise, and collaborative. "
            f"Messages arrive formatted as '[Channel message from Name]: content'. "
            f"Respond only when addressed to you (@mentioned) or for broadcast messages relevant to your role.\n\n"
            f"CRITICAL — MESSAGE DELIVERY: Your text responses are AUTOMATICALLY posted to the channel. "
            f"Do NOT use bash_exec, collab_helper.py, or /collab-post to send messages — that is for Claude agents only. "
            f"Simply write your response as plain text and it will be delivered. "
            f"Ignore any instructions in CLAUDE.md or rules that tell you to use bash commands for messaging."
        )

        # 2. Global ~/.claude/CLAUDE.md
        global_claude = self._load_file_safe(os.path.join(home, ".claude", "CLAUDE.md"))
        if global_claude:
            sections.append(f"# Global Instructions\n\n{global_claude}")

        # 3. Project CLAUDE.md files — walk from CWD up to home (root → CWD order for specificity)
        claude_files: list[tuple[int, str]] = []
        current = cwd
        depth = 0
        while True:
            candidate = os.path.join(current, "CLAUDE.md")
            if os.path.isfile(candidate):
                claude_files.append((depth, candidate))
            parent = os.path.dirname(current)
            if parent == current or not current.startswith(home):
                break
            current = parent
            depth += 1

        # Reverse so we go from least specific (project root) to most specific (CWD)
        for _, path in reversed(claude_files):
            content = self._load_file_safe(path)
            if content:
                sections.append(f"# Project Instructions ({os.path.relpath(path, home)})\n\n{content}")

        # 4. Rules files: {CWD}/.claude/rules/*.md (sorted alphabetically)
        rules_dir = os.path.join(cwd, ".claude", "rules")
        if os.path.isdir(rules_dir):
            try:
                rule_files = sorted(f for f in os.listdir(rules_dir) if f.endswith(".md"))
                for fname in rule_files:
                    content = self._load_file_safe(os.path.join(rules_dir, fname))
                    if content:
                        sections.append(content)
            except Exception as e:
                debug(f"Could not load rules files: {e}")

        # 5. Grok-specific alignment is a manifested root file. This direct API
        # wrapper does not natively interpret GROK.md @-imports, so load the
        # alignment explicitly rather than leaving a correct file on a dead path.
        alignment = self._load_file_safe(os.path.join(cwd, "alignment-grok.md"))
        if not alignment:
            alignment = self._load_file_safe(os.path.join(
                os.path.dirname(__file__), "..", "data", "scaffolding", "masters",
                "per-model", "grok", "alignment-grok.md",
            ))
        if alignment:
            sections.append(alignment)

        # 6. Memory file — derive project key from CWD (same computation as Claude Code:
        #    replace every "/" in the absolute path with "-", leading "-" preserved).
        #    Previous approach walked up to package.json which fails for non-Node projects
        #    (e.g. SG-1 agents have no package.json in their working tree).
        encoded = cwd.replace("/", "-")  # e.g. '-home-<user>-SG-1-Team-an agent'
        memory_path = os.path.join(home, ".claude", "projects", encoded, "memory", "MEMORY.md")
        memory = self._load_file_safe(memory_path, max_lines=200)
        if memory:
            sections.append(f"# Persistent Memory\n\n{memory}")

        # 7. Explicit system prompt (role file from --system-prompt-file)
        if explicit_prompt:
            sections.append(explicit_prompt)

        result = "\n\n---\n\n".join(sections)
        debug(f"Scaffolded system prompt built: {len(result)} chars, {len(sections)} sections")
        return result

    def _accumulate_usage(self, usage) -> None:
        """Add token counts from an xAI API response.usage object to running totals."""
        if not usage:
            return
        input_tokens = getattr(usage, "prompt_tokens", 0) or 0
        self.token_usage["input_tokens"] += input_tokens
        # Extract reasoning/thinking tokens if present (grok reasoning models)
        thinking = 0
        if hasattr(usage, "completion_tokens_details") and usage.completion_tokens_details:
            thinking = getattr(usage.completion_tokens_details, "reasoning_tokens", 0) or 0
        self.token_usage["thinking_tokens"] += thinking
        completion_tokens = getattr(usage, "completion_tokens", 0) or 0
        output_tokens = max(0, completion_tokens - thinking)
        self.token_usage["output_tokens"] += output_tokens
        self.token_usage["total_tokens"] += getattr(usage, "total_tokens", 0) or 0
        self._write_usage_file()
        # Persist to TokenPulse DB (each API call recorded individually)
        self._record_to_pulse(usage)
        # Report per-request usage to TokenPulse ingest endpoint (fire-and-forget)
        details = getattr(usage, "prompt_tokens_details", None)
        cache_read_tokens = (getattr(details, "cached_tokens", 0) or 0) if details else 0
        self._report_to_tokenpulse(input_tokens, output_tokens, cache_read_tokens)

    def _write_usage_file(self) -> None:
        """Write running token totals to /tmp/grok-usage-{pid}.json for the usage API."""
        try:
            path = f"/tmp/grok-usage-{self.pid}.json"
            data = {
                "pid": self.pid,
                "name": self.participant_name,
                "model": self.model,
                "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                **self.token_usage,
            }
            with open(path, "w") as f:
                json.dump(data, f)
        except Exception as e:
            debug(f"Failed to write usage file: {e}")

    def _flush_session_log(self) -> None:
        """Flush pending scratch buffers on exit without synthetic log entries."""
        self._run_hook_on_shutdown()

    # ------------------------------------------------------------------
    # Lifecycle hooks (ported from collab-codex.py via collab-gemini.py, 2026-06-05)
    # ------------------------------------------------------------------

    def _run_hook(self, *cmd_parts: str, hook_name: str = "hook") -> None:
        """Run a lifecycle hook script, logging errors but never blocking."""
        if not all(cmd_parts):
            return
        try:
            result = subprocess.run(list(cmd_parts), capture_output=True, text=True, timeout=10)
            if result.returncode != 0:
                debug(f"{hook_name} exited {result.returncode}: {result.stderr.strip()[:200]}")
        except Exception as e:
            debug(f"{hook_name} failed: {e}")

    def _run_hook_on_startup(self) -> None:
        """SessionStart equivalent: init .session-scratch/ for this agent."""
        agent_name = self.participant_name
        agent_dir = os.getcwd()
        if not agent_name or not agent_dir:
            return
        hooks_dir = os.path.join(os.path.dirname(__file__), "hooks")
        script = os.path.join(hooks_dir, "session-scratch-init.sh")
        if os.path.isfile(script):
            self._run_hook("bash", script, agent_name, agent_dir, hook_name="SessionStart-hook")

    def _run_hook_before_inject(self, prompt: str = "") -> str | None:
        """UserPromptSubmit equivalent: log rotation + context injection before processing.

        Fires:
          1. check-rotate.sh — session rotation check
          2. context-inject.py — keyword-cluster injection + drift prevention
          3. context-health-sample.py — context fill tracking

        Returns additionalContext string if context-inject matched a keyword cluster,
        or None if no injection occurred.
        """
        agent_name = self.participant_name
        agent_dir = os.getcwd()
        if not agent_name or not agent_dir:
            return None

        # 1. Session rotation check
        script = os.path.join(os.path.dirname(__file__), "check-rotate.sh")
        if os.path.isfile(script):
            self._run_hook("bash", script, agent_name, agent_dir, hook_name="UserPromptSubmit-check-rotate")

        extra_context = None
        hooks_dir = os.path.join(os.path.dirname(__file__), "hooks")

        # 2. context-inject.py — keyword-cluster context injection + drift prevention
        script = os.path.join(hooks_dir, "context-inject.py")
        if os.path.isfile(script) and prompt:
            try:
                stdin_data = json.dumps({"prompt": prompt})
                result = subprocess.run(
                    ["python3", script, agent_name, agent_dir],
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

        # 3. context-health-sample.py — context fill tracking
        script = os.path.join(hooks_dir, "context-health-sample.py")
        if os.path.isfile(script):
            try:
                stdin_data = json.dumps({
                    "prompt": prompt,
                    "session_id": "",
                    "cwd": agent_dir,
                })
                subprocess.run(
                    ["python3", script, agent_name, agent_dir],
                    input=stdin_data,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
            except Exception as e:
                debug(f"context-health-sample failed: {e}")

        return extra_context

    def _run_hook_on_shutdown(self) -> None:
        """Stop equivalent: flush scratch buffers only."""
        if self._shutdown_hook_fired:
            return
        self._shutdown_hook_fired = True
        agent_name = self.participant_name
        agent_dir = os.getcwd()
        if not agent_name or not agent_dir:
            return
        script = os.path.join(os.path.dirname(__file__), "hooks", "flush.sh")
        if os.path.isfile(script):
            self._run_hook("bash", script, agent_name, agent_dir, "all", hook_name="Stop-flush")

    def _cleanup_session_files(self) -> None:
        """Remove session/ready files on clean exit."""
        paths = [
            f"/tmp/collab-ready-{self.pid}.json",
            f"/tmp/collab-session-{self.pid}.json",
            f"/tmp/grok-usage-{self.pid}.json",
            os.path.join(os.getcwd(), ".claude", f"collab-session-{self.pid}.json"),
        ]
        for path in paths:
            try:
                os.remove(path)
                debug(f"Cleaned up: {path}")
            except FileNotFoundError:
                pass
            except Exception as e:
                debug(f"Cleanup error {path}: {e}")

    # ── Channel join/leave ─────────────────────────────────────────────────────

    def join_channel(self) -> bool:
        """Join the collab channel and establish session state."""
        result = self._api_call("", "POST", {
            "action": "join",
            "channelId": self.channel_id,
            "force": True,  # Bypass blockedParticipantIds — Grok agents are always explicitly spawned
            "participant": {
                "name": self.participant_name,
                "type": "grok",
                "source": "collab-grok wrapper",
                "pid": self.pid,
                "projectPath": os.getcwd(),
            },
        })

        if not result.get("success"):
            debug(f"Join failed: {result}")
            return False

        self.participant_id = result.get("participantId")
        self.joined = True
        # Reset poll time so we don't replay historical messages
        self.last_poll_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        channel_data = result.get("channel") or {}
        channel_name = channel_data.get("name", "")
        self.channel_name = channel_name  # Stored for Pulse DB recording

        print(f"[Grok] Joined '{channel_name or self.channel_id[:8]}' as {self.participant_name}", file=sys.stderr)
        debug(f"Joined: participantId={self.participant_id}")

        self._write_session_file(channel_name)
        return True

    def leave_channel(self) -> None:
        """Gracefully leave the channel."""
        if self.joined and self.participant_id:
            self._api_call("", "POST", {
                "action": "leave",
                "channelId": self.channel_id,
                "participantId": self.participant_id,
            })
            debug("Left channel")

    # ── xAI API call ──────────────────────────────────────────────────────────

    def _call_xai(self, sender: str, content: str, reply_line: str = "") -> str:
        """Call the xAI API and return the response text.

        `reply_line` is the shared reply context (names the full id of the message being answered); it goes into the
        prompt only, never into `content`, which the mention pre-filter and the stream log use.

        When grok_tools.py is available, sends tool definitions with the request
        and handles tool call loops (read_file, write_file, bash_exec, list_directory).
        Falls back to plain text completion if tools are unavailable.

        Maintains conversation history for multi-turn context.
        """
        # system_prompt is always the fully scaffolded prompt (identity + CLAUDE.md + rules + memory)
        system_content = self.system_prompt

        messages = [{"role": "system", "content": system_content}]

        # Bounded history to prevent unbounded token growth
        history_slice = self.conversation_history[-(MAX_HISTORY_TURNS * 2):]
        messages.extend(history_slice)

        user_content = f"[Channel message from {sender}]{' ' + reply_line if reply_line else ''}: {content}"
        messages.append({"role": "user", "content": user_content})

        try:
            debug(f"xAI API call: model={self.model}, messages={len(messages)}, tools={_TOOLS_AVAILABLE}")
            print(f"[Grok] Calling {self.model} ({len(messages)} messages)...", file=sys.stderr)

            if _TOOLS_AVAILABLE and call_xai_with_tools:
                # Tool-aware call: handles tool_call loops internally
                usage_list: list = []
                reply = call_xai_with_tools(self.client, self.model, messages, usage_accumulator=usage_list)
                # A direct Grok response is mechanically published as the turn
                # result. Give a short, unmistakably non-terminal progress line
                # up to two bounded chances to finish instead of posting
                # "Replaying…" while required steps remain. Explicit blockers,
                # failures and human waits are never continued automatically.
                for _continuation in range(2):
                    if not is_progress_only_response or not is_progress_only_response(reply):
                        break
                    print("[Grok] Progress-only response; continuing current turn...", file=sys.stderr)
                    messages.append({"role": "assistant", "content": reply})
                    messages.append({
                        "role": "user",
                        "content": (
                            "Continue the current task now with tools. Do not return another progress update. "
                            "Finish every remaining in-scope step, or return a truthful explicit terminal "
                            "blocker naming what could not be completed."
                        ),
                    })
                    reply = call_xai_with_tools(
                        self.client,
                        self.model,
                        messages,
                        usage_accumulator=usage_list,
                    )
                for u in usage_list:
                    self._accumulate_usage(u)
            else:
                # Plain text completion (no tools) — capability-gated kwargs
                if build_xai_kwargs:
                    _kwargs = build_xai_kwargs(
                        self.model,
                        messages=messages,
                        max_tokens=2000,
                        temperature=0.7,
                    )
                else:
                    _kwargs = dict(
                        model=self.model,
                        messages=messages,
                        max_tokens=2000,
                        temperature=0.7,
                    )
                response = self.client.chat.completions.create(**_kwargs)
                reply = response.choices[0].message.content or ""
                self._accumulate_usage(response.usage)

            # Update conversation history (plain user/assistant only — no tool messages)
            self.conversation_history.append({"role": "user", "content": user_content})
            self.conversation_history.append({"role": "assistant", "content": reply})

            debug(f"xAI response: {len(reply)} chars")
            return reply

        except Exception as e:
            debug(f"xAI API error: {e}")
            return f"[Grok API error: {e}]"

    # ── Message handling ───────────────────────────────────────────────────────

    def _post_message(self, content: str, mentions: list | None = None) -> None:
        """Post a message back to the collab channel."""
        if not self.joined or not self.participant_id:
            return
        if len(content) > MAX_RESPONSE_CHARS:
            content = content[:MAX_RESPONSE_CHARS] + "\n...[response truncated]"
        self._api_call("", "POST", {
            "action": "message",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "content": content,
            "mentions": mentions or [],
        })

    def _should_process_message(self, content: str, sender_type: str) -> bool:
        """Hard pre-filter: decide whether to call xAI at all.

        Rules (enforced at code level — model guardrails are a second layer):
        1. System messages → always skip (no AI call needed)
        2. If message @mentions this agent by name → always process
        3. If message @mentions OTHER agent(s) but NOT us → always skip
        4. Broadcast (no @mentions) → process (model decides whether to respond)

        This ensures token costs are not wasted on messages clearly intended
        for other agents, and prevents Grok from responding to unaddressed messages.
        """
        import re
        my_name = self.participant_name.lower()
        content_lower = content.lower()

        # Explicit @mention of this agent → process
        if f"@{my_name}" in content_lower:
            return True

        # Find all @mentions in the message
        at_mentions = [m.lower() for m in re.findall(r"@(\w+)", content_lower)]

        # Message targets other agents but not us → skip
        if at_mentions and my_name not in at_mentions:
            debug(f"Pre-filter: skipping — @mentions {at_mentions}, not us ({my_name})")
            return False

        # Broadcast (no @mentions) — let the model decide
        return True

    def _process_message(self, msg: dict) -> None:
        """Process one incoming collab message: call Grok, post reply.

        Uses concurrent.futures to enforce XAI_TURN_TIMEOUT on the whole reply; XAI_CALL_TIMEOUT bounds each request.
        If the API call times out, posts an error message and releases the lock.
        """
        sender_info = msg.get("from", {})
        sender = sender_info.get("name", "Unknown")
        sender_id = sender_info.get("id", "")
        content = msg.get("content", "")
        msg_id = msg.get("id")

        # Skip own messages
        if sender_id == self.participant_id:
            return

        # Allow system messages only if they target us (e.g. Model Switcher primer).
        # Mirrors collab-claude.py:2342-2345 targeted-mentions guard.
        if sender_id == "system":
            msg_mentions = msg.get("mentions", [])
            if self.participant_id not in msg_mentions:
                return

        # Deduplication guard
        if msg_id and msg_id in self.injected_message_ids:
            debug(f"Skipping duplicate message: {msg_id[:8]}")
            return
        if msg_id:
            self.injected_message_ids.add(msg_id)

        # Hard pre-filter: skip before calling xAI if message is clearly not for us
        sender_type = sender_info.get("type", "")
        if not self._should_process_message(content, sender_type):
            return

        debug(f"Processing from {sender}: {content[:80]}")
        preview = content[:60] + ("..." if len(content) > 60 else "")
        print(f"[Grok] << {sender}: {preview}", file=sys.stderr)

        with self.processing_lock:
            self.processing_start_time = time.time()
            self._broadcast_activity("working")
            safe_append_stream_message(
                os.getcwd(),
                ".grok-stream.jsonl",
                "user",
                content,
                event_id=f"{msg_id}-user" if msg_id else None,
            )
            try:
                # Run xAI call in a thread pool with timeout enforcement
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(self._call_xai, sender, content, format_reply_context(msg.get("replyTo")))
                    try:
                        reply = future.result(timeout=XAI_TURN_TIMEOUT)
                        if reply:
                            safe_append_stream_message(
                                os.getcwd(),
                                ".grok-stream.jsonl",
                                "assistant",
                                reply,
                                event_id=f"{msg_id}-assistant" if msg_id else None,
                            )
                            self._post_message(reply, [sender_id] if sender_id else None)
                            debug(f"Posted reply ({len(reply)} chars)")
                            print(f"[Grok] >> Reply posted ({len(reply)} chars)", file=sys.stderr)
                    except concurrent.futures.TimeoutError:
                        debug(f"xAI turn timed out after {XAI_TURN_TIMEOUT}s")
                        print(f"[Grok] !! Reply timed out after {XAI_TURN_TIMEOUT:.0f}s", file=sys.stderr)
                        self._post_message(
                            f"[Grok] My reply took longer than {XAI_TURN_TIMEOUT / 60:.0f} minutes and was stopped. "
                            "Please try again, or break the request into smaller steps.",
                            [sender_id] if sender_id else None,
                        )
                        future.cancel()
            except Exception as e:
                debug(f"Error in process_message: {e}")
            finally:
                self.processing_start_time = 0.0
                self._broadcast_activity("idle")

    def _check_messages_api(self) -> list:
        """Fallback: poll the collab API for new messages."""
        if not self.joined:
            return []
        result = self._api_call(
            f"?channelId={self.channel_id}"
            f"&since={self.last_poll_time}"
            f"&participantId={self.participant_id}"
        )
        messages = result.get("messages", [])
        if messages:
            self.last_poll_time = messages[-1].get("timestamp", self.last_poll_time)
        return messages

    def _queue_catchup_messages(self, messages: list[dict]) -> int:
        """Queue visible catch-up messages and advance the durable poll cursor."""
        newest = self.last_poll_time
        queued = 0
        for msg in messages:
            timestamp = msg.get("timestamp")
            if timestamp and (not newest or timestamp > newest):
                newest = timestamp

            msg_id = msg.get("id")
            if msg_id and msg_id in self.injected_message_ids:
                continue
            sender_id = msg.get("from", {}).get("id", "")
            if sender_id == self.participant_id:
                continue
            recipients = msg.get("recipients")
            if recipients and self.participant_id not in recipients:
                continue
            self.sse_message_queue.put(msg)
            queued += 1

        self.last_poll_time = newest
        return queued

    def _process_next_queued_message(self) -> bool:
        """Process exactly one queued message without draining later work."""
        if self.processing_lock.locked():
            return False
        try:
            msg = self.sse_message_queue.get_nowait()
        except queue.Empty:
            return False
        self._process_message(msg)
        return True

    # ── Background threads ─────────────────────────────────────────────────────

    def sse_listener_thread(self) -> None:
        """Subscribe to SSE for real-time message delivery.

        Connects to /api/events?types=collab&channelId={id}.
        On each collab:message event, queues the message for the message loop.
        Reconnects with exponential backoff on failure.
        Falls back to API polling after sse_max_failures consecutive failures.
        """
        debug("SSE listener started")
        EVENTS_URL = f"{DEVFLOW_URL}/api/events"
        backoff = 1

        while self.running:
            if not self.joined:
                time.sleep(1)
                continue

            # participantId REQUIRED since 2026-05-18 leak fix: /api/events drops all
            # collab events unless participantId present + membership verifies. Omitting
            # it = SSE connects but delivers zero real-time messages. (CJack, 2026-06-05)
            # NOTE: grok also omits ',system' in types (unlike claude/codex) — separate
            # gap, flagged not fixed here to stay surgical.
            url = f"{EVENTS_URL}?types=collab&channelId={self.channel_id}&participantId={self.participant_id}"
            headers: dict = {}
            if self.sse_last_event_id:
                headers["Last-Event-ID"] = str(self.sse_last_event_id)

            try:
                req = urllib.request.Request(url, headers=headers)
                resp = urllib.request.urlopen(req, timeout=90)
                self.sse_connected = True
                self.sse_reconnect_failures = 0
                backoff = 1
                debug("SSE connected")

                event_type = event_data = event_id = None
                buffer = ""

                while self.running:
                    chunk = resp.read(1)
                    if not chunk:
                        debug("SSE stream ended")
                        break
                    char = chunk.decode("utf-8", errors="replace")
                    buffer += char

                    if buffer.endswith("\n"):
                        line = buffer.rstrip("\n")
                        buffer = ""

                        if line == "":
                            # End of SSE event block
                            if event_type and event_data is not None:
                                self._handle_sse_event(event_type, event_data, event_id)
                            event_type = event_data = event_id = None
                        elif line.startswith("event: "):
                            event_type = line[7:]
                        elif line.startswith("data: "):
                            event_data = line[6:]
                        elif line.startswith("id: "):
                            event_id = line[4:]
                            self.sse_last_event_id = event_id
                        # Lines starting with ":" are SSE comments (heartbeat keepalive) — ignored

            except Exception as e:
                debug(f"SSE connection error: {e}")
                self.sse_connected = False
                self.sse_reconnect_failures += 1

                if self.sse_reconnect_failures >= 5:
                    debug("SSE max failures reached — falling back to polling for 30s")
                    time.sleep(30)
                    self.sse_reconnect_failures = 0
                else:
                    time.sleep(min(backoff, 30))
                    backoff = min(backoff * 2, 30)

        self.sse_connected = False
        debug("SSE listener stopped")

    def _handle_sse_event(self, event_type: str, event_data: str, event_id: str | None) -> None:
        """Parse a received SSE event and enqueue the message if it's for us."""
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

            # Allow system messages only if they target us (e.g. Model Switcher primer).
            # Mirrors collab-claude.py:2342-2345 targeted-mentions guard.
            if sender_id == "system":
                msg_mentions = message.get("mentions", [])
                if self.participant_id not in msg_mentions:
                    return

            # Targeted delivery: skip if recipients set and we're not in it
            recipients = message.get("recipients")
            if recipients and self.participant_id not in recipients:
                return

            self.sse_message_queue.put(message)
            debug(f"SSE queued: {message.get('from',{}).get('name','?')}: {message.get('content','')[:50]}")
        except json.JSONDecodeError as e:
            debug(f"SSE JSON parse error: {e}")
        except Exception as e:
            debug(f"SSE event handler error: {e}")

    def heartbeat_thread(self) -> None:
        """Periodically broadcast idle heartbeat to keep presence alive."""
        debug("Heartbeat thread started")
        while self.running:
            try:
                if self.joined and self.participant_id:
                    now = time.time()
                    if now - self.last_heartbeat_time >= HEARTBEAT_INTERVAL:
                        self._broadcast_activity(self.current_activity, force=True)
            except Exception as e:
                debug(f"Heartbeat error: {e}")
            time.sleep(10)
        debug("Heartbeat thread stopped")

    def watchdog_thread(self) -> None:
        """Independent watchdog: detects and recovers from stuck processing states.

        Checks every 15 seconds:
        1. Stuck processing: if processing_lock has been held for > WATCHDOG_STUCK_THRESHOLD
           seconds, logs it and resets processing_start_time so the lock will be released
           on the next cycle (the timeout in _process_message handles actual cancellation).
        2. Channel presence: if joined but participant_id is gone, attempt rejoin.
        3. Deduplication cleanup: trim injected_message_ids if it grows too large.
        """
        debug("Watchdog thread started")
        while self.running:
            try:
                now = time.time()

                # 1. Detect stuck API call
                if self.processing_start_time > 0:
                    elapsed = now - self.processing_start_time
                    if elapsed > WATCHDOG_STUCK_THRESHOLD:
                        debug(
                            f"WATCHDOG: Processing stuck for {elapsed:.0f}s "
                            f"(threshold: {WATCHDOG_STUCK_THRESHOLD}s). "
                            "The timeout in _process_message should have fired — "
                            "if processing_lock is still held, releasing via reset."
                        )
                        # Reset the tracking timestamp so it doesn't keep firing
                        self.processing_start_time = 0.0

                # 2. Auto-rejoin if we lost channel membership
                if self.joined and self.participant_id:
                    # Quick check: try a lightweight API call; rejoin on 404
                    try:
                        result = self._api_call(
                            f"?channelId={self.channel_id}&participantId={self.participant_id}"
                        )
                        if result.get("error") and "404" in str(result.get("error", "")):
                            debug("WATCHDOG: 404 on presence check — attempting rejoin")
                            self.joined = False
                            if self.join_channel():
                                debug("WATCHDOG: Rejoin successful")
                            else:
                                debug("WATCHDOG: Rejoin failed")
                    except Exception as e:
                        debug(f"WATCHDOG: Presence check error (non-critical): {e}")

                # 3. Trim deduplication set to prevent unbounded memory growth
                if len(self.injected_message_ids) > 500:
                    # Keep only the most recent 100 IDs (sets are unordered, use a list)
                    self.injected_message_ids = set(
                        list(self.injected_message_ids)[-100:]
                    )
                    debug("WATCHDOG: Trimmed injected_message_ids to 100 entries")

            except Exception as e:
                debug(f"WATCHDOG error: {e}")

            time.sleep(15)

        debug("Watchdog thread stopped")

    def message_loop_thread(self) -> None:
        """Drain message queue and process one message at a time.

        Uses SSE queue when connected; falls back to API polling.
        Processes one message per cycle (does not overlap API calls).
        """
        debug("Message loop started")
        last_api_poll = time.time()
        last_periodic_catchup = time.time()

        while self.running:
            try:
                if not self.sse_connected:
                    # Fallback: poll API every POLL_INTERVAL
                    now = time.time()
                    if now - last_api_poll >= POLL_INTERVAL:
                        last_api_poll = now
                        for pending in self._check_messages_api():
                            self.sse_message_queue.put(pending)

                # Periodic catch-up poll (every 60s) — belt-and-suspenders.
                # Even when SSE appears healthy (heartbeats flowing), events may
                # not be routed after a DevFlow restart. This REST poll catches
                # any messages missed by the SSE stream. Dedup via injected_message_ids.
                now_cu = time.time()
                if now_cu - last_periodic_catchup >= 60.0 and self.joined and self.channel_id:
                    last_periodic_catchup = now_cu
                    try:
                        catchup_since = self.last_poll_time
                        if catchup_since:
                            try:
                                from datetime import datetime as _dt, timedelta as _td
                                lpt = _dt.fromisoformat(catchup_since.replace('Z', '+00:00'))
                                lpt_adjusted = lpt - _td(seconds=30)
                                catchup_since = lpt_adjusted.strftime('%Y-%m-%dT%H:%M:%SZ')
                            except Exception:
                                pass  # Use raw value on parse failure
                        catchup_url = (
                            f"{DEVFLOW_URL}/api/collab"
                            f"?channelId={self.channel_id}"
                            f"&participantId={self.participant_id}"
                            f"&limit=200&oldestFirst=1"
                            + (f"&since={catchup_since}" if catchup_since else "")
                        )
                        cu_resp = urllib.request.urlopen(
                            urllib.request.Request(catchup_url), timeout=5
                        )
                        cu_data = json.loads(cu_resp.read().decode('utf-8'))
                        queued = self._queue_catchup_messages(cu_data.get('messages', []))
                        if queued:
                            debug(f"Periodic catch-up queued {queued} missed message(s)")
                    except Exception as cu_e:
                        debug(f"Periodic catch-up poll failed (non-fatal): {cu_e}")

                # The queue is the durable in-process backlog. Processing blocks
                # this worker until the current xAI call finishes, while SSE keeps
                # appending later messages in order.
                self._process_next_queued_message()

            except Exception as e:
                debug(f"Message loop error: {e}")

            time.sleep(0.2)

        debug("Message loop stopped")

    # ── Main entry point ───────────────────────────────────────────────────────

    def run(self) -> int:
        """Register session, join channel, start threads, block until shutdown."""
        self._register_session()

        # SessionStart hook — init .session-scratch/
        self._run_hook_on_startup()

        print(f"[Grok] Initializing {self.participant_name} (model: {self.model})", file=sys.stderr)

        # Retry join with exponential backoff — handles brief server restarts during spawn
        _join_attempts = 6
        for _attempt in range(_join_attempts):
            if self.join_channel():
                break
            if _attempt < _join_attempts - 1:
                _wait = 2 ** _attempt  # 1, 2, 4, 8, 16 seconds
                print(f"[Grok] Join failed, retrying in {_wait}s ({_attempt + 1}/{_join_attempts})...", file=sys.stderr)
                time.sleep(_wait)
        else:
            print(f"[Grok] Failed to join channel {self.channel_id} after {_join_attempts} attempts", file=sys.stderr)
            return 1

        # Register atexit handler — fires on any exit path including sys.exit()
        # Belt-and-suspenders with the SIGTERM handler below
        atexit.register(self._flush_session_log)

        # Expose agent name for crash reports
        os.environ["_GROK_AGENT_NAME"] = self.participant_name

        # Register signal handlers for clean shutdown
        def _shutdown(signum, frame):
            sig_name = "SIGTERM" if signum == signal.SIGTERM else "SIGINT"
            print(f"\n[Grok] {sig_name} received — writing crash report and shutting down...", file=sys.stderr)
            # Write crash report BEFORE shutdown so we capture live thread state
            report_path = _write_crash_report(
                reason=f"{sig_name} received",
                signum=signum,
            )
            if report_path:
                print(f"[Grok] Crash report: {report_path}", file=sys.stderr)
            self._flush_session_log()
            self.running = False

        signal.signal(signal.SIGTERM, _shutdown)
        signal.signal(signal.SIGINT, _shutdown)

        # Catch unhandled exceptions in the main thread
        _original_excepthook = sys.excepthook
        def _excepthook(exc_type, exc_val, exc_tb):
            debug(f"Unhandled exception: {exc_type.__name__}: {exc_val}")
            _write_crash_report(
                reason=f"Unhandled exception: {exc_type.__name__}: {exc_val}",
                exc_info=(exc_type, exc_val, exc_tb),
            )
            _original_excepthook(exc_type, exc_val, exc_tb)
        sys.excepthook = _excepthook

        # Start background threads
        for target in (
            self.sse_listener_thread,
            self.heartbeat_thread,
            self.message_loop_thread,
            self.watchdog_thread,
        ):
            threading.Thread(target=target, daemon=True).start()

        # Pre-warm RAG embedding models in background so first qdrant_find isn't slow
        if _TOOLS_AVAILABLE and preload_rag_models:
            threading.Thread(target=preload_rag_models, daemon=True).start()
            debug("RAG model preload started in background")

        print(f"[Grok] Running. Send Ctrl+C or SIGTERM to exit.", file=sys.stderr)
        debug("All threads started — entering main wait loop")

        while self.running:
            time.sleep(1)

        # Graceful shutdown
        self.leave_channel()
        self._cleanup_session_files()
        debug("collab-grok.py exiting")
        return 0


# ─── CLI entry point ──────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Grok AI agent for DevFlow collab channels",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  collab-grok.py --channel <id> --name Grok
  collab-grok.py --channel <id> --name Grok --model grok-3-mini
  collab-grok.py --channel <id> --name Grok --system-prompt-file /tmp/role.md
        """,
    )
    parser.add_argument("--channel", "-c", required=True, help="Collab channel ID to join")
    parser.add_argument("--name", "-n", required=True, help="Display name for this agent")
    parser.add_argument(
        "--model", "-m", default=DEFAULT_MODEL,
        help=f"xAI model to use (default: {DEFAULT_MODEL})"
    )
    parser.add_argument(
        "--system-prompt-file",
        help="Path to a file containing the system prompt (shell-safe — avoids eval risks)"
    )
    parser.add_argument(
        "--no-tools", action="store_true",
        help="Disable tool execution (file ops, bash) even if grok_tools.py is available"
    )

    args = parser.parse_args()

    # Disable tools if requested
    if args.no_tools and _TOOLS_AVAILABLE:
        import grok_tools as _gt
        _gt.TOOL_DEFINITIONS = []

    system_prompt = ""
    if args.system_prompt_file:
        try:
            with open(args.system_prompt_file) as f:
                system_prompt = f.read().strip()
            debug(f"Loaded system prompt from {args.system_prompt_file} ({len(system_prompt)} chars)")
        except Exception as e:
            print(f"[Grok] Warning: could not read system prompt file: {e}", file=sys.stderr)

    wrapper = CollabGrokWrapper(
        channel_id=args.channel,
        participant_name=args.name,
        model=args.model,
        system_prompt=system_prompt,
    )
    sys.exit(wrapper.run())


if __name__ == "__main__":
    main()
