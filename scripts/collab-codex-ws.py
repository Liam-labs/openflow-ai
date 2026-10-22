#!/usr/bin/env python3
r"""
collab-codex-ws.py — Codex AgentChat wrapper using app-server WebSocket transport (Sprint 65)

Replaces the PTY-based collab-codex.py. Instead of spawning Codex in a pexpect PTY
and injecting keystrokes, this wrapper:
  1. Starts `codex app-server --listen ws://127.0.0.1:<PORT>`
  2. Connects via WebSocket (JSON-RPC protocol)
  3. Polls collab channel for messages
  4. Injects via `turn/start` request over WebSocket (no PTY, no keystrokes)
  5. Detects turn completion from `turn/completed` notification

Why: Codex is a compiled Rust binary. Its TUI uses raw-mode terminal event handling
that does not process keystrokes sent via `tmux send-keys`. The WebSocket app-server
transport is the official programmatic integration path.

Usage (WSL/Linux):
  collab-codex-ws --channel <id> [--name <name>] [--cwd <dir>]
                  [--agent-name <agent>] [--agent-dir <dir>]

Usage (native Windows PowerShell):
  .\collab-codex-win.ps1 -Channel <id> -Name <name> -Cwd C:\...\Agent

The Python wrapper is deliberately platform-aware rather than forked. On
Windows it resolves the installed native ``codex.exe``, keeps the app-server
and its tool children in the Windows runtime, and mirrors only small session
coordination records into WSL ``/tmp`` through verified ``wsl.exe`` writes.
"""

import argparse
import asyncio
import json
import os
os.environ["COLLAB_AGENT_WRAPPER"] = "1"
import random
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

from design_reference_harness import (
    codex_managed_gate_required,
    codex_design_gate_args,
    validate_codex_managed_gate_preflight,
)

try:
    import websockets
except ImportError:
    print("Error: websockets not installed. Run: pip install websockets", file=sys.stderr)
    sys.exit(1)

try:
    from reply_context import format_reply_context
except ImportError:  # ships next to this script; a stray copy without it only loses the reply line
    def format_reply_context(reply_to):
        return ""

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEVFLOW_URL = __import__("os").environ.get("DEVFLOW_URL", "http://localhost:3000").rstrip("/")
API_BASE = f"{DEVFLOW_URL}/api/collab"
CODEX_MODEL = "gpt-6-astra"                   # Default model. Override via --model flag.
VALID_EFFORTS = ("low", "medium", "high", "xhigh", "max", "ultra")
POLL_INTERVAL = 2.0                        # Seconds between collab polls
HEARTBEAT_INTERVAL = 25.0                  # Seconds between activity heartbeats
MAX_INJECT_LENGTH = 8000                   # Chars; longer messages get truncated
MAX_CATCHUP_AGE_SECONDS = 480              # 8 min age cap for catch-up messages
IS_WINDOWS = os.name == "nt"
WSL_DISTRO = os.environ.get("DEVFLOW_WSL_DISTRO", "Ubuntu")
WINDOWS_TEMP = os.environ.get("TEMP") or os.environ.get("TMP") or r"C:\Temp"
DEBUG_LOG = os.path.join(
    WINDOWS_TEMP if IS_WINDOWS else "/tmp",
    "collab-codex-ws-debug.log",
)


def _windows_codex_candidates(environ: dict | None = None) -> list[str]:
    """Return deterministic native Codex binary candidates for Windows.

    Prefer the Rust executable installed by the official npm package. Calling
    ``codex.cmd`` through ``cmd.exe`` adds another process and makes argument
    quoting dependent on the shell. The direct executable accepts the same
    app-server arguments and keeps the wrapper's PID/lifecycle relationship
    unambiguous.
    """
    env = os.environ if environ is None else environ
    appdata = env.get("APPDATA", "")
    candidates: list[str] = []
    if appdata:
        candidates.extend([
            os.path.join(
                appdata,
                "npm", "node_modules", "@openai", "codex", "node_modules",
                "@openai", "codex-win32-x64", "vendor",
                "x86_64-pc-windows-msvc", "bin", "codex.exe",
            ),
            os.path.join(
                appdata,
                "npm", "node_modules", "@openai", "codex", "node_modules",
                "@openai", "codex-win32-arm64", "vendor",
                "aarch64-pc-windows-msvc", "bin", "codex.exe",
            ),
        ])
    return candidates


def _resolve_codex_bin(*, native_windows: bool | None = None) -> str:
    """Resolve the platform-native Codex executable, with an explicit override."""
    override = os.environ.get("DEVFLOW_CODEX_BIN", "").strip()
    if override:
        return override

    use_windows = IS_WINDOWS if native_windows is None else native_windows
    if use_windows:
        for candidate in _windows_codex_candidates():
            if os.path.isfile(candidate):
                return candidate
        for name in ("codex.exe", "codex"):
            resolved = shutil.which(name)
            if resolved:
                return resolved
        raise FileNotFoundError(
            "Native Codex executable not found. Install @openai/codex for the "
            "Windows user or set DEVFLOW_CODEX_BIN to codex.exe."
        )

    resolved = shutil.which("codex")
    if resolved:
        return resolved
    fallback = os.path.expanduser("~/.nvm/versions/node/v20.19.5/bin/codex")
    if os.path.isfile(fallback):
        return fallback
    raise FileNotFoundError("Codex executable not found in PATH")


CODEX_BIN = _resolve_codex_bin()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def debug(msg: str) -> None:
    try:
        os.makedirs(os.path.dirname(DEBUG_LOG), exist_ok=True)
        with open(DEBUG_LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} [{os.getpid()}] {msg}\n")
    except Exception:
        pass


def _linux_tmp_path(pid: int, kind: str) -> str:
    """Return the server-visible path for one session coordination record."""
    return f"/tmp/collab-{kind}-{pid}.json"


def _write_server_bridge_file(path: str, payload: dict) -> bool:
    """Atomically write a coordination record into DevFlow's WSL ``/tmp``.

    A Windows process cannot rely on writes through ``\\wsl$`` becoming
    immediately visible to Linux. Sprint 60 established the supported bridge:
    write through ``wsl.exe`` into ext4, then verify from a separate invocation.
    """
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    if not IS_WINDOWS:
        tmp_path = f"{path}.{os.getpid()}.tmp"
        try:
            with open(tmp_path, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp_path, 0o600)
            os.replace(tmp_path, path)
            return True
        except Exception as error:
            debug(f"bridge write failed ({path}): {error}")
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            return False

    command = [
        "wsl.exe", "-d", WSL_DISTRO, "--", "sh", "-c",
        'tmp="$1.$$.tmp"; cat > "$tmp" && chmod 600 "$tmp" && mv -f -- "$tmp" "$1"',
        "devflow-collab-write", path,
    ]
    try:
        write = subprocess.run(command, input=encoded, capture_output=True, timeout=8)
        if write.returncode != 0:
            debug(
                f"bridge write failed ({path}): rc={write.returncode} "
                f"stderr={write.stderr[:200]!r}"
            )
            return False
        verify = subprocess.run(
            ["wsl.exe", "-d", WSL_DISTRO, "--", "test", "-s", path],
            capture_output=True,
            timeout=5,
        )
        if verify.returncode != 0:
            debug(f"bridge write verification failed ({path}): rc={verify.returncode}")
            return False
        return True
    except Exception as error:
        debug(f"bridge write error ({path}): {error}")
        return False


def _remove_server_bridge_file(path: str) -> None:
    """Best-effort removal of a WSL-side coordination record."""
    try:
        if IS_WINDOWS:
            subprocess.run(
                ["wsl.exe", "-d", WSL_DISTRO, "--", "rm", "-f", "--", path],
                capture_output=True,
                timeout=5,
            )
        else:
            os.remove(path)
    except FileNotFoundError:
        pass
    except Exception as error:
        debug(f"bridge cleanup failed ({path}): {error}")


def _find_free_port() -> int:
    """Return a random unused TCP port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_port(port: int, timeout: float = 15.0) -> bool:
    """Block until TCP port is listening or timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except (ConnectionRefusedError, OSError):
            time.sleep(0.25)
    return False


def _codex_app_server_launch_args(
    agent_dir: str,
    port: int,
) -> list[str]:
    """Build app-server args with the native design gate forced on."""
    return [
        CODEX_BIN,
        *codex_design_gate_args(agent_dir),
        "app-server",
        "--listen",
        f"ws://127.0.0.1:{port}",
    ]


def _turn_start_permissions(permission_mode: str) -> dict:
    """Return an explicit non-interactive policy for an AgentChat turn.

    AgentChat cannot display Codex Desktop approval prompts. Leaving these
    fields implicit makes app-server fall back to an interactive policy and
    turns the wrapper's refusal into the misleading error "user rejected".
    """
    if permission_mode == "full-access":
        return {
            "approvalPolicy": "never",
            "sandboxPolicy": {"type": "dangerFullAccess"},
        }
    if permission_mode == "restricted":
        return {
            "approvalPolicy": "never",
            "sandboxPolicy": {
                "type": "workspaceWrite",
                "networkAccess": False,
            },
        }
    raise ValueError("permission mode must be restricted or full-access")


def _turn_start_params(
    thread_id: str,
    prompt: str,
    permission_mode: str,
    *,
    model: str | None = None,
    effort: str | None = None,
    fast_mode: bool | None = None,
) -> dict:
    """Build the complete app-server request for one AgentChat delivery."""
    params = {
        "threadId": thread_id,
        "input": [{"type": "text", "text": prompt}],
        **_turn_start_permissions(permission_mode),
    }
    # These fields override the thread setting for this and subsequent turns.
    # Pin them on every delivery so a persisted Codex default or another
    # session's /model or /fast choice cannot leak into this roster agent.
    if model:
        params["model"] = model
    if effort:
        params["effort"] = effort
    if fast_mode is not None:
        params["serviceTier"] = "fast" if fast_mode else "default"
    return params


def _to_wsl_path(path: str) -> str:
    """Translate a Windows-local or WSL UNC path for a ``wsl.exe`` command."""
    normalized = path.replace("/", "\\")
    unc_prefixes = (
        f"\\\\wsl.localhost\\{WSL_DISTRO}\\",
        f"\\\\wsl$\\{WSL_DISTRO}\\",
    )
    lowered = normalized.lower()
    for prefix in unc_prefixes:
        if lowered.startswith(prefix.lower()):
            return "/" + normalized[len(prefix):].replace("\\", "/")
    match = re.match(r"^([A-Za-z]):[\\/](.*)$", path)
    if match:
        drive, rest = match.groups()
        return f"/mnt/{drive.lower()}/{rest.replace('\\', '/')}"
    return path


def _load_agents_md(cwd: str) -> str | None:
    """Load AGENTS.md from working directory — Codex's system prompt equivalent."""
    path = os.path.join(cwd, "AGENTS.md")
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as f:
                return f.read()
        except Exception as e:
            debug(f"Could not read AGENTS.md: {e}")
    return None


def _get_ready_file(pid: int) -> str:
    return _linux_tmp_path(pid, "ready")


def _get_invite_file(pid: int) -> str:
    return _linux_tmp_path(pid, "invite")


def _get_project_name(cwd: str) -> str:
    try:
        pkg = os.path.join(cwd, "package.json")
        if os.path.isfile(pkg):
            with open(pkg) as f:
                data = json.load(f)
            if data.get("name"):
                return data["name"]
    except Exception:
        pass
    return os.path.basename(cwd)


def _api_call(endpoint: str, method: str = "GET", data: dict | None = None) -> dict:
    url = f"{API_BASE}{endpoint}"
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
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        debug(f"API error {method} {endpoint}: {e}")
        return {"error": str(e)}


def _format_message(sender: str, content: str, channel_id: str,
                    reply_to: dict | None, mentions: list,
                    participant_id: str, participant_name: str) -> str:
    """Format a collab message for injection into Codex's input."""
    # Determine if this agent is @mentioned
    is_mentioned = False
    if mentions:
        for m in mentions:
            if isinstance(m, str) and m == participant_id:
                is_mentioned = True
                break
            if isinstance(m, dict) and m.get("id") == participant_id:
                is_mentioned = True
                break
    if not is_mentioned and participant_name:
        import re
        if re.search(r"@" + re.escape(participant_name) + r"(?:[^a-zA-Z0-9_-]|$)",
                     content, re.IGNORECASE):
            is_mentioned = True

    # Truncate long messages
    if len(content) > MAX_INJECT_LENGTH:
        content = content[:MAX_INJECT_LENGTH] + f"\n... [truncated]"

    # Build prompt
    reply_line = format_reply_context(reply_to)  # names the full id of the message being answered
    if reply_line:
        prompt = f"[Channel message from {sender} in {channel_id}] {reply_line}: {content}"
    else:
        prompt = f"[Channel message from {sender} in {channel_id}]: {content}"

    if is_mentioned:
        prompt += "\n(@you)"
    elif mentions:
        prompt += "\n(not addressed to you)"
    else:
        prompt += "\n(broadcast)"

    return prompt


# ---------------------------------------------------------------------------
# Main wrapper class
# ---------------------------------------------------------------------------

class CodexWSWrapper:
    def __init__(self, *, channel_id=None, participant_name=None,
                 cwd=None, agent_name=None, agent_dir=None, model=None,
                 permission_mode="full-access", effort=None, fast_mode=None):
        self.channel_id = channel_id
        self.channel_name = ""
        self.participant_name = participant_name
        self.participant_id = None
        self.cwd = cwd or os.getcwd()
        self.agent_name = agent_name
        self.agent_dir = agent_dir
        self.model = model or CODEX_MODEL
        if permission_mode not in {"restricted", "full-access"}:
            raise ValueError("permission mode must be restricted or full-access")
        if effort is not None and effort not in VALID_EFFORTS:
            raise ValueError(f"unsupported reasoning effort: {effort}")
        if fast_mode is not None and not isinstance(fast_mode, bool):
            raise ValueError("fast mode must be enabled, disabled, or omitted")
        self.permission_mode = permission_mode
        self.effort = effort
        self.fast_mode = fast_mode
        self.platform = "windows" if IS_WINDOWS else "wsl"

        # App-server state
        self._port: int = _find_free_port()
        self._server_proc: subprocess.Popen | None = None
        self._server_pid: int | None = None
        self._server_log = None

        # WebSocket / protocol state
        self._thread_id: str | None = None
        self._ws_req_id: int = 1
        self._ws_lock = asyncio.Lock()          # serialize WS sends
        self._pending_responses: dict[int, asyncio.Future] = {}

        # Turn state machine
        self._turn_state = "idle"               # 'idle' | 'busy'
        self._turn_complete_event: asyncio.Event | None = None
        self._turn_output_buf: list[str] = []   # accumulates agent/messageDelta text

        # Collab / session state
        self.joined = False
        self.last_poll_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._injected_ids: set[str] = set()
        self._current_activity = "idle"
        self._last_heartbeat = 0.0
        self.home_channel_id = channel_id
        self.home_channel_name = ""
        self._wrapper_pid = os.getpid()

        # Inject queue: messages waiting to be sent to Codex
        self._inject_queue: asyncio.Queue = asyncio.Queue()

        self._running = True
        self._shutdown_event = asyncio.Event()

    # ------------------------------------------------------------------
    # Session registration
    # ------------------------------------------------------------------

    def _register_session(self) -> bool:
        if not self._server_pid:
            return False
        pid = self._server_pid
        if not self.participant_name:
            self.participant_name = _get_project_name(self.cwd)
        payload = {
            "pid": pid,
            "name": self.participant_name,
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "cwd": self.cwd,
            "wrapperPid": self._wrapper_pid,
            "platform": self.platform,
            "agentType": "codex",
        }
        try:
            if not _write_server_bridge_file(_get_ready_file(pid), payload):
                raise RuntimeError("server-visible ready file could not be verified")
            print(f"\033[32m[Collab] Session ready (PID {pid})\033[0m", file=sys.stderr)
            return True
        except Exception as e:
            debug(f"register_session error: {e}")
            print(f"ERROR: Codex session registration failed: {e}", file=sys.stderr)
            return False

    def _write_session_file(self) -> None:
        if not self._server_pid or not self.participant_id:
            return
        pid = self._server_pid
        data = {
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "displayName": self.participant_name,
            "channelName": self.channel_name or "Unknown",
            "pid": pid,
            "agentType": "codex",
            "projectPath": self.cwd,
            "homeChannelId": self.home_channel_id,
            "homeChannelName": self.home_channel_name,
            "platform": self.platform,
            "wrapperPid": self._wrapper_pid,
        }
        try:
            session_dir = os.path.join(self.cwd, ".claude")
            os.makedirs(session_dir, exist_ok=True)
            # Write keyed on app-server PID (UI lifecycle) and wrapper Python PID
            # (COLLAB_WRAPPER_PID lookup from agent-created child processes).
            for keyed_pid in {pid, self._wrapper_pid}:
                project_path = os.path.join(session_dir, f"collab-session-{keyed_pid}.json")
                project_tmp = f"{project_path}.{self._wrapper_pid}.tmp"
                with open(project_tmp, "w", encoding="utf-8") as f:
                    json.dump(data, f)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(project_tmp, project_path)
                if not _write_server_bridge_file(
                    _linux_tmp_path(keyed_pid, "session"),
                    data,
                ):
                    raise RuntimeError(
                        f"server-visible session file failed for PID {keyed_pid}"
                    )
        except Exception as e:
            debug(f"write_session_file error: {e}")
            raise

    def _unregister_session(self) -> None:
        pid = self._server_pid
        if not pid:
            return
        for path in (
            _get_ready_file(pid),
            _get_invite_file(pid),
            _linux_tmp_path(pid, "session"),
            _linux_tmp_path(self._wrapper_pid, "session"),
        ):
            _remove_server_bridge_file(path)
        for path in (
            os.path.join(self.cwd, ".claude", f"collab-session-{pid}.json"),
            os.path.join(self.cwd, ".claude", f"collab-session-{self._wrapper_pid}.json"),
        ):
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
            except Exception as e:
                debug(f"unregister cleanup error ({path}): {e}")

    # ------------------------------------------------------------------
    # Collab channel
    # ------------------------------------------------------------------

    def _join_channel(self) -> bool:
        result = _api_call("", "POST", {
            "action": "join",
            "channelId": self.channel_id,
            "participant": {
                "name": self.participant_name,
                "type": "codex",
                "source": "collab-codex-win wrapper" if IS_WINDOWS else "collab-codex-ws wrapper",
                "pid": self._server_pid,
                "projectPath": self.cwd,
                "deliveryProtocol": "ledger-v1",
            },
        })
        if result.get("success"):
            self.participant_id = result.get("participantId")
            self.joined = True
            channel_data = result.get("channel", {})
            self.channel_name = channel_data.get("name", "")
            # Set last_poll_time from lastRead/joinedAt
            for p in channel_data.get("participants", []):
                if p.get("id") == self.participant_id:
                    self.last_poll_time = (p.get("lastRead") or p.get("joinedAt")
                                          or self.last_poll_time)
                    break
            self.home_channel_name = self.channel_name
            self._write_session_file()
            debug(f"Joined channel {self.channel_id[:8]} as {self.participant_id}")
            return True
        debug(f"Join channel failed: {result.get('error')}")
        return False

    def _broadcast_activity(self, status: str, force: bool = False) -> None:
        if not self.joined or not self.participant_id:
            return
        if status == self._current_activity and not force:
            return
        self._current_activity = status
        self._last_heartbeat = time.time()
        _api_call("", "POST", {
            "action": "heartbeat",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "activityStatus": status,
        })

    def _post_response_to_channel(self, text: str) -> None:
        """Post Codex's turn output directly to the collab channel."""
        if not self.joined or not self.participant_id or not text.strip():
            return
        _api_call("", "POST", {
            "action": "message",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "content": text.strip(),
        })

    def _poll_messages(self) -> list[dict]:
        if not self.joined:
            return []
        result = _api_call(
            f"?channelId={self.channel_id}&since={self.last_poll_time}"
            f"&participantId={self.participant_id}&limit=50"
        )
        return result.get("messages", [])

    def _mark_read(self, timestamp: str | None = None) -> None:
        if not self.joined or not self.participant_id:
            return
        _api_call("", "POST", {
            "action": "markRead",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            **({"timestamp": timestamp} if timestamp else {}),
        })

    # ------------------------------------------------------------------
    # Hook equivalents
    # ------------------------------------------------------------------

    def _run_hook(self, *cmd: str, name: str = "hook") -> None:
        if not all(cmd):
            return
        try:
            launch = list(cmd)
            if IS_WINDOWS and launch[0] == "bash":
                translated = [
                    _to_wsl_path(value)
                    if value.startswith(("/", "\\",)) or re.match(r"^[A-Za-z]:[\\/]", value)
                    else value
                    for value in launch[1:]
                ]
                launch = ["wsl.exe", "-d", WSL_DISTRO, "--", "bash", *translated]
            r = subprocess.run(launch, capture_output=True, text=True, timeout=10)
            if r.returncode != 0:
                debug(f"{name} exited {r.returncode}: {r.stderr.strip()[:200]}")
        except Exception as e:
            debug(f"{name} error: {e}")

    def _run_hook_on_startup(self) -> None:
        if not self.agent_name or not self.agent_dir:
            return
        script = os.path.join(os.path.dirname(__file__), "hooks", "session-scratch-init.sh")
        if os.path.isfile(script):
            self._run_hook("bash", script, self.agent_name, self.agent_dir, name="SessionStart")

    def _run_hook_before_inject(self) -> None:
        if not self.agent_name or not self.agent_dir:
            return
        script = os.path.join(os.path.dirname(__file__), "check-rotate.sh")
        if os.path.isfile(script):
            self._run_hook("bash", script, self.agent_name, self.agent_dir, name="UserPromptSubmit")

    def _run_hook_on_turn_complete(self) -> None:
        if not self.agent_name or not self.agent_dir:
            return
        script = os.path.join(os.path.dirname(__file__), "write-session-end.sh")
        if os.path.isfile(script):
            self._run_hook("bash", script, self.agent_name, self.agent_dir, name="Stop")

    # ------------------------------------------------------------------
    # WebSocket protocol helpers
    # ------------------------------------------------------------------

    async def _ws_send(self, ws, method: str, params: dict) -> dict:
        """Send a JSON-RPC request and wait for its response."""
        req_id = self._ws_req_id
        self._ws_req_id += 1
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending_responses[req_id] = fut
        msg = json.dumps({"id": req_id, "method": method, "params": params})
        async with self._ws_lock:
            await ws.send(msg)
        try:
            result = await asyncio.wait_for(fut, timeout=30.0)
            return result
        except asyncio.TimeoutError:
            self._pending_responses.pop(req_id, None)
            raise TimeoutError(f"No response to {method} within 30s")

    async def _ws_notify(self, ws, method: str, params: dict) -> None:
        """Send a JSON-RPC notification with no response id."""
        async with self._ws_lock:
            await ws.send(json.dumps({"method": method, "params": params}))

    async def _ensure_design_gate_managed(self, ws) -> None:
        """Validate the root-owned hook when this host explicitly requires it."""
        if not codex_managed_gate_required():
            debug("Managed Design Reference gate is not activated on this host")
            return
        cwd = os.path.realpath(self.cwd)
        requirements = await self._ws_send(ws, "configRequirements/read", {})
        hooks = await self._ws_send(ws, "hooks/list", {"cwds": [cwd]})
        validate_codex_managed_gate_preflight(requirements, hooks, cwd)

    async def _ws_listener(self, ws) -> None:
        """Read WebSocket notifications and RPC responses, dispatch to waiters."""
        async for raw in ws:
            if not self._running:
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_id = msg.get("id")
            method = msg.get("method", "")
            params = msg.get("params", {})

            if msg_id is not None and msg_id in self._pending_responses:
                # This is an RPC response
                fut = self._pending_responses.pop(msg_id)
                if not fut.done():
                    if "error" in msg:
                        fut.set_exception(Exception(msg["error"].get("message", "rpc error")))
                    else:
                        fut.set_result(msg.get("result", {}))
                continue

            # Notifications
            if method == "turn/completed":
                status = params.get("turn", {}).get("status", "")
                debug(f"turn/completed: status={status}")
                # Forward accumulated output to channel before unblocking inject worker
                if status == "completed" and self._turn_output_buf:
                    full_text = "".join(self._turn_output_buf)
                    loop = asyncio.get_event_loop()
                    loop.run_in_executor(None, self._post_response_to_channel, full_text)
                if self._turn_complete_event:
                    self._turn_complete_event.set()
                    self._last_turn_status = status
            elif method == "item/agentMessage/delta":
                # Accumulate streaming text fragments for the current turn
                delta = params.get("delta", "")
                if delta:
                    self._turn_output_buf.append(delta)
            elif method == "error":
                err = params.get("error", {})
                debug(f"WS error notification: {err.get('message', '')[:200]}")
                if self._turn_complete_event and not self._turn_complete_event.is_set():
                    self._last_turn_status = "failed"
                    self._turn_complete_event.set()
            # Other notifications (item/*, thread/*, plan/*, etc.) are informational

    # ------------------------------------------------------------------
    # Inject worker (consumes the message queue)
    # ------------------------------------------------------------------

    async def _inject_worker(self, ws) -> None:
        """Drain the inject queue. Sends one turn at a time (waits for completion)."""
        while self._running:
            try:
                item = await asyncio.wait_for(self._inject_queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue

            sender = item["sender"]
            prompt = item["prompt"]
            msg_id = item["msg_id"]
            msg_ts = item["msg_ts"]

            if not self._thread_id:
                debug("No threadId — cannot inject")
                continue

            self._turn_state = "busy"
            self._turn_complete_event = asyncio.Event()
            self._last_turn_status = "unknown"
            self._turn_output_buf = []              # reset for new turn
            self._broadcast_activity("working")
            debug(f"Injecting message from {sender} (id={msg_id})")

            try:
                await self._ws_send(
                    ws,
                    "turn/start",
                    _turn_start_params(
                        self._thread_id,
                        prompt,
                        self.permission_mode,
                        model=self.model,
                        effort=self.effort,
                        fast_mode=self.fast_mode,
                    ),
                )
                debug("turn/start sent, waiting for completion...")
                await asyncio.wait_for(self._turn_complete_event.wait(), timeout=300.0)
                debug(f"Turn complete: {self._last_turn_status}")
                if self._last_turn_status == "completed":
                    self._run_hook_on_turn_complete()
            except asyncio.TimeoutError:
                debug("Turn timed out after 300s")
            except Exception as e:
                debug(f"Inject error: {e}")
            finally:
                self._turn_complete_event = None
                self._turn_state = "idle"
                self._broadcast_activity("idle")
                # Advance poll cursor so we don't re-inject this message
                if msg_ts:
                    self.last_poll_time = msg_ts
                self._mark_read(msg_ts)

    # ------------------------------------------------------------------
    # Poll worker (checks collab channel, fills inject queue)
    # ------------------------------------------------------------------

    async def _poll_worker(self) -> None:
        """Poll the collab channel every POLL_INTERVAL seconds."""
        loop = asyncio.get_event_loop()
        while self._running:
            await asyncio.sleep(POLL_INTERVAL)
            try:
                messages = await loop.run_in_executor(None, self._poll_messages)
                for msg in messages:
                    msg_id = msg.get("id")
                    msg_ts = msg.get("timestamp")
                    if not msg_id:
                        continue
                    if msg_id in self._injected_ids:
                        continue
                    sender_info = msg.get("from", {})
                    if isinstance(sender_info, dict):
                        sender_id = sender_info.get("id", "")
                        sender_name = sender_info.get("name", "Unknown")
                    else:
                        sender_id = ""
                        sender_name = str(sender_info)
                    if sender_id == self.participant_id:
                        continue  # Skip own messages

                    # Check age
                    if msg_ts:
                        try:
                            from datetime import datetime, timezone as tz
                            msg_dt = datetime.fromisoformat(msg_ts.replace("Z", "+00:00"))
                            age = (datetime.now(tz.utc) - msg_dt).total_seconds()
                            if age > MAX_CATCHUP_AGE_SECONDS:
                                continue
                        except Exception:
                            pass

                    prompt = _format_message(
                        sender=sender_name,
                        content=msg.get("content", ""),
                        channel_id=self.channel_name or self.channel_id or "",
                        reply_to=msg.get("replyTo"),
                        mentions=msg.get("mentions", []),
                        participant_id=self.participant_id or "",
                        participant_name=self.participant_name or "",
                    )
                    self._injected_ids.add(msg_id)
                    await self._inject_queue.put({
                        "sender": sender_name,
                        "prompt": prompt,
                        "msg_id": msg_id,
                        "msg_ts": msg_ts,
                    })
                    debug(f"Queued message {msg_id} from {sender_name}")
            except Exception as e:
                debug(f"Poll error: {e}")

    # ------------------------------------------------------------------
    # Heartbeat worker
    # ------------------------------------------------------------------

    async def _heartbeat_worker(self) -> None:
        """Send periodic activity heartbeats."""
        loop = asyncio.get_event_loop()
        while self._running:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            try:
                status = "working" if self._turn_state == "busy" else "idle"
                await loop.run_in_executor(
                    None, lambda: self._broadcast_activity(status, force=True)
                )
            except Exception as e:
                debug(f"Heartbeat error: {e}")

    # ------------------------------------------------------------------
    # Main run
    # ------------------------------------------------------------------

    async def _run_async(self) -> None:
        """Full async lifecycle: start server, connect WS, run all workers."""
        loop = asyncio.get_event_loop()

        # Start codex app-server
        debug(
            f"Starting native Codex app-server on port {self._port} "
            f"(platform={self.platform}, permission={self.permission_mode}, bin={CODEX_BIN})"
        )
        # Inject wrapper PID so Codex subprocesses can locate the session file via collab_helper
        server_env = os.environ.copy()
        server_env["COLLAB_WRAPPER_PID"] = str(os.getpid())
        # This wrapper owns outbound publication from the structured app-server
        # stream.  Tell collab_helper.py to reject model-initiated posts so the
        # same answer cannot be published once by the model and once here.
        server_env["DEVFLOW_RESPONSE_ROUTING"] = "server-auto-post"
        server_env.setdefault("PYTHONUTF8", "1")
        server_env.setdefault("PYTHONIOENCODING", "utf-8")
        server_log_path = os.path.join(
            WINDOWS_TEMP if IS_WINDOWS else "/tmp",
            f"collab-codex-app-server-{self._wrapper_pid}.log",
        )
        os.makedirs(os.path.dirname(server_log_path), exist_ok=True)
        self._server_log = open(server_log_path, "ab", buffering=0)
        popen_kwargs = {
            "stdout": self._server_log,
            "stderr": self._server_log,
            "env": server_env,
            "cwd": self.cwd,
        }
        if IS_WINDOWS:
            popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self._server_proc = subprocess.Popen(  # type: ignore[arg-type]
            _codex_app_server_launch_args(
                self.agent_dir or self.cwd,
                self._port,
            ),
            **popen_kwargs,
        )
        self._server_pid = self._server_proc.pid

        # Wait for server to be ready
        ready = await loop.run_in_executor(None, _wait_for_port, self._port, 15.0)
        if not ready:
            exit_code = self._server_proc.poll()
            print(
                "ERROR: codex app-server did not start in time "
                f"(exit={exit_code}, log={server_log_path})",
                file=sys.stderr,
            )
            return

        # Register session (DevFlow UI discovery)
        registered = await loop.run_in_executor(None, self._register_session)
        if not registered:
            return
        await loop.run_in_executor(None, self._run_hook_on_startup)

        # Join collab channel
        if self.channel_id:
            joined = await loop.run_in_executor(None, self._join_channel)
            if not joined:
                print("WARNING: failed to join collab channel", file=sys.stderr)

        # Connect to app-server WebSocket
        async with websockets.connect(f"ws://127.0.0.1:{self._port}") as ws:
            # Start listener as a background task FIRST — _ws_send depends on it
            # to dispatch RPC responses to pending futures.
            listener_task = asyncio.create_task(self._ws_listener(ws))

            # 1. initialize
            init_result = await self._ws_send(ws, "initialize", {
                "clientInfo": {"name": "collab-codex-ws", "version": "1.0.0"}
            })
            debug(f"initialized: {list(init_result.keys())}")
            await self._ws_notify(ws, "initialized", {})
            await self._ensure_design_gate_managed(ws)

            # 2. thread/start — load AGENTS.md as baseInstructions
            agents_md = _load_agents_md(self.cwd)
            thread_params: dict = {
                "cwd": self.cwd,
                "model": self.model,
                "sandbox": (
                    "danger-full-access"
                    if self.permission_mode == "full-access"
                    else "workspace-write"
                ),
                "approvalPolicy": "never",
            }
            if self.fast_mode is not None:
                thread_params["serviceTier"] = (
                    "fast" if self.fast_mode else "default"
                )
            if agents_md:
                thread_params["baseInstructions"] = agents_md
                debug(f"Loaded AGENTS.md ({len(agents_md)} chars)")

            thread_result = await self._ws_send(ws, "thread/start", thread_params)
            self._thread_id = thread_result.get("thread", {}).get("id")
            if not self._thread_id:
                print(f"ERROR: thread/start failed: {thread_result}", file=sys.stderr)
                return

            debug(f"Thread started: {self._thread_id}")
            self._broadcast_activity("idle")
            print(f"\033[32m[Collab] Codex ready (app-server PID {self._server_pid}, thread {self._thread_id[:8]})\033[0m",
                  file=sys.stderr)

            # 3. Run until the app-server connection ends or the wrapper receives
            # a shutdown signal. ``asyncio.gather`` would wait forever on the WS
            # listener after SIGTERM because no one closed the socket.
            worker_tasks = [
                listener_task,
                asyncio.create_task(self._inject_worker(ws)),
                asyncio.create_task(self._poll_worker()),
                asyncio.create_task(self._heartbeat_worker()),
            ]
            shutdown_task = asyncio.create_task(self._shutdown_event.wait())
            _done, pending = await asyncio.wait(
                [*worker_tasks, shutdown_task],
                return_when=asyncio.FIRST_COMPLETED,
            )
            self._running = False
            await ws.close()
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    def run(self) -> None:
        """Entry point: run the wrapper until interrupted."""
        import signal as _signal

        def _shutdown(signum, frame):
            debug(f"Signal {signum} — shutting down")
            self._running = False
            self._shutdown_event.set()

        _signal.signal(_signal.SIGTERM, _shutdown)
        _signal.signal(_signal.SIGINT, _shutdown)
        if hasattr(_signal, "SIGBREAK"):
            _signal.signal(_signal.SIGBREAK, _shutdown)

        try:
            asyncio.run(self._run_async())
        except KeyboardInterrupt:
            pass
        finally:
            self._unregister_session()
            if self._server_proc:
                try:
                    self._server_proc.terminate()
                    self._server_proc.wait(timeout=5)
                except Exception:
                    pass
            if self._server_log:
                try:
                    self._server_log.close()
                except Exception:
                    pass
            debug("Wrapper exited")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Codex AgentChat wrapper (WebSocket mode)")
    parser.add_argument("--channel", dest="channel_id", help="Collab channel ID to join")
    parser.add_argument("--name", dest="participant_name", help="Agent display name")
    parser.add_argument("--cwd", dest="cwd", default=None, help="Working directory for Codex")
    parser.add_argument("--agent-name", dest="agent_name", help="Agent name for hooks (e.g. Heimdall)")
    parser.add_argument("--agent-dir", dest="agent_dir", help="Agent directory for hooks")
    parser.add_argument("--model", dest="model", default=CODEX_MODEL,
                        help=f"Model to use (default: {CODEX_MODEL})")
    parser.add_argument(
        "--effort",
        choices=VALID_EFFORTS,
        default="medium",
        help="Reasoning effort pinned on every AgentChat turn (default: medium)",
    )
    parser.add_argument(
        "--fast-mode",
        choices=("enabled", "disabled"),
        default="disabled",
        help="Pin Codex service tier: enabled=fast, disabled=default",
    )
    parser.add_argument(
        "--permission-mode",
        choices=("restricted", "full-access"),
        default="full-access",
        help=(
            "AgentChat turn access policy. Full access is the Windows-runtime "
            "default because interactive Codex approval prompts are not visible in AgentChat."
        ),
    )
    args = parser.parse_args()

    wrapper = CodexWSWrapper(
        channel_id=args.channel_id,
        participant_name=args.participant_name,
        cwd=args.cwd or os.getcwd(),
        agent_name=args.agent_name,
        agent_dir=args.agent_dir,
        model=args.model,
        permission_mode=args.permission_mode,
        effort=args.effort,
        fast_mode=args.fast_mode == "enabled",
    )
    wrapper.run()


if __name__ == "__main__":
    main()
