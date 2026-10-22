#!/usr/bin/env python3
"""
collab-antigravity.py — Antigravity CLI collab wrapper (print mode)

Wraps agy (Google's Antigravity CLI v1.0.0) in --print mode.
Polls the collab channel for @mentions, invokes agy --print per message,
and posts responses back to the channel.

agy --print is designed for programmatic use: JSON stdout contains the response
and conversation ID, while the exit code signals completion. No Ink TUI, no
output-stabilization heuristics, no completion guessing.

Each mention starts a fresh print-mode conversation. The wrapper uses agy's
JSON output contract to recover the real conversation ID and response text.

Key infrastructure:
- Keyring env sourcing (~/.keyring-env): GNOME keyring vars for OAuth
- trustedFolders auto-register: pre-approves agent_dir so agy skips
  the workspace-trust prompt
"""

import os
os.environ["COLLAB_AGENT_WRAPPER"] = "1"
import sys
import json
import re
import time
import signal
import argparse
import subprocess
import urllib.request
import urllib.error
from agent_stream_writer import safe_append_stream_message
from design_reference_harness import ensure_antigravity_design_gate_hook

try:
    from reply_context import format_reply_context
except ImportError:  # ships next to this script; a stray copy without it only loses the reply line
    def format_reply_context(reply_to):
        return ""

# ─── Configuration ───────────────────────────────────────────────────────────

DEVFLOW_URL = __import__("os").environ.get("DEVFLOW_URL", "http://localhost:3000").rstrip("/")
API_BASE = f"{DEVFLOW_URL}/api/collab"
POLL_INTERVAL = 2  # seconds between inbox polls
AGY_BINARY = os.path.expanduser("~/.local/bin/agy")
DEBUG_LOG = "/tmp/collab-antigravity-debug.log"
AGY_TIMEOUT = 300  # max seconds for an agy --print invocation

# Image-attachment support: AgentChat saves shared images to this directory
# and exposes them via /api/collab/images/<filename>. The wrapper resolves
# those URLs back to local paths so Gemini can read the files via its tools.
COLLAB_IMAGES_DIR = os.path.expanduser("~/DevFlow/.AppData/collab-images")


def debug(msg: str) -> None:
    """Write debug message to log file (with PID for multi-wrapper tracing)."""
    try:
        with open(DEBUG_LOG, "a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} [{os.getpid()}] {msg}\n")
    except Exception:
        pass


def pane_log(msg: str) -> None:
    """Write activity event to stdout (tmux pane) for terminal-button visibility."""
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# ─── Collab API helpers ──────────────────────────────────────────────────────

def api_get(endpoint: str) -> dict:
    """GET request to collab API."""
    try:
        url = f"{API_BASE}{endpoint}"
        req = urllib.request.Request(url, method="GET")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        debug(f"api_get({endpoint}) error: {e}")
        return {}


def api_post(endpoint: str, data: dict) -> dict:
    """POST request to collab API."""
    try:
        url = f"{API_BASE}{endpoint}"
        body = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        debug(f"api_post({endpoint}) error: {e}")
        return {}


# ─── Keyring env sourcing ────────────────────────────────────────────────────

def load_keyring_env() -> dict:
    """Source ~/.keyring-env export lines for OAuth token exchange.

    agy uses GNOME keyring for OAuth token storage. The keyring socket path
    (GNOME_KEYRING_CONTROL), SSH agent, and DBus session address must be
    inherited from the interactive session that performed the OAuth flow.

    Returns a dict of env vars to merge into agy's subprocess environment.
    If ~/.keyring-env is missing, returns {} — graceful no-op.
    """
    env = {}
    keyring_env_file = os.path.expanduser('~/.keyring-env')
    if os.path.exists(keyring_env_file):
        with open(keyring_env_file) as f:
            for line in f:
                line = line.strip()
                if line.startswith('export ') and '=' in line:
                    k, v = line[7:].split('=', 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    return env


# ─── Main wrapper ────────────────────────────────────────────────────────────

class CollabAntigravityWrapper:
    """Print-mode wrapper bridging collab channel @mentions to agy --print.

    Spawns agy --print per message via subprocess. No pexpect, no tmux
    injection, no output-stabilization heuristics — exit code signals
    completion, stdout is the response.
    """

    def __init__(
        self,
        channel_id: str,
        participant_name: str,
        agent_name: str | None = None,
        agent_dir: str | None = None,
        model: str | None = None,
        effort: str | None = None,
    ):
        self.channel_id = channel_id
        self.participant_name = participant_name
        self.participant_id: str | None = None
        self.agent_name = agent_name or participant_name
        self.agent_dir = agent_dir or os.getcwd()
        self.model = model
        self.effort = effort if effort in {"low", "medium", "high"} else None
        self.running = True
        self.joined = False

        # Polling state
        self.last_poll_time: str | None = None

        # Dedup: track processed message IDs
        self.processed_ids: set = set()
        self._dedup_max = 200

        # Processing state
        self.is_processing = False
        self.last_injected_msg_id: str | None = None

        # Heartbeat
        self.last_heartbeat_time = 0.0
        self.heartbeat_interval = 5.0
        self.idle_heartbeat_interval = 30.0
        self.current_activity: str | None = None

        # Load and resolve GEMINI.md prompt-prefix (Option 2)
        self.system_prefix = self._resolve_gemini_md()

        debug(
            f"Wrapper init: agent={self.agent_name} channel={channel_id} "
            f"dir={self.agent_dir}"
        )

    # ─── Channel lifecycle ───────────────────────────────────────────────────

    def join_channel(self) -> bool:
        """Join the collab channel and register as a participant."""
        participant_id = f"antigravity-{os.getpid()}-{int(time.time())}"
        result = api_post("", {
            "action": "join",
            "channelId": self.channel_id,
            "participant": {
                "id": participant_id,
                "type": "agent",
                "name": self.agent_name,
                "source": "Antigravity CLI",
                "pid": os.getpid(),
                "projectPath": self.agent_dir,
            },
        })
        if result.get("success"):
            self.participant_id = result.get("participantId") or participant_id
            self.joined = True
            debug(f"Joined channel {self.channel_id} as {self.participant_id}")
            pane_log(f"Connected to channel {self.channel_id}")
            return True
        else:
            debug(f"Join failed: {result.get('error', 'unknown')}")
            return False

    def leave_channel(self) -> None:
        """Leave the collab channel."""
        if not self.participant_id:
            return
        api_post("", {
            "action": "leave",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
        })
        debug(f"Left channel {self.channel_id}")

    # ─── Session file (agent shell-exec of collab_helper.py / ask_liam.py) ────

    def _session_file_paths(self) -> list[str]:
        """Session-file lookup paths, keyed on the wrapper PID.

        collab_helper.py / ask_liam.py resolve the session by reading
        CLAUDE_PID (= COLLAB_WRAPPER_PID, exported into agy's env) and
        looking for collab-session-<pid>.json in /tmp and {agent_dir}/.claude.
        Keying on the stable wrapper PID means the process-tree walk from any
        agy shell-exec child also resolves it even if the env var doesn't
        propagate. Mirrors the Codex wrapper (collab-codex-ws.py).
        """
        pid = os.getpid()
        return [
            f"/tmp/collab-session-{pid}.json",
            os.path.join(self.agent_dir, ".claude", f"collab-session-{pid}.json"),
        ]

    def _write_session_file(self) -> None:
        """Write the collab session file so the agent can shell-exec
        collab_helper.py / ask_liam.py.

        Antigravity agents have no PTY path (collab-pty.ts) writing this file
        for them — the wrapper must do it itself, or every shell-exec fails
        with "no collab session found".
        """
        if not self.participant_id:
            return
        data = {
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "displayName": self.agent_name,
            "channelName": "Unknown",
            "pid": os.getpid(),
            "agentType": "gemini",
            "projectPath": self.agent_dir,
        }
        for path in self._session_file_paths():
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w") as f:
                    json.dump(data, f)
            except Exception as e:
                debug(f"write_session_file error ({path}): {e}")
        debug(
            f"Wrote session file pid={os.getpid()} "
            f"participant={self.participant_id}"
        )

    def _remove_session_file(self) -> None:
        """Remove the wrapper's session files on shutdown (hygiene)."""
        for path in self._session_file_paths():
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
            except Exception as e:
                debug(f"remove_session_file error ({path}): {e}")

    # ─── Hook support ────────────────────────────────────────────────────────

    def _run_hook(self, *cmd_parts: str, hook_name: str = "hook") -> None:
        """Run a lifecycle hook script, logging errors but never blocking."""
        if not all(cmd_parts):
            return
        try:
            result = subprocess.run(
                list(cmd_parts), capture_output=True, text=True, timeout=10,
            )
            if result.returncode != 0:
                debug(
                    f"{hook_name} exited {result.returncode}: "
                    f"{result.stderr.strip()[:200]}"
                )
        except Exception as e:
            debug(f"{hook_name} failed: {e}")

    def _run_hook_on_startup(self) -> None:
        """SessionStart equivalent: init .session-scratch/ for this agent."""
        if not self.agent_name or not self.agent_dir:
            return
        hooks_dir = os.path.join(os.path.dirname(__file__), "hooks")
        script = os.path.join(hooks_dir, "session-scratch-init.sh")
        if os.path.isfile(script):
            self._run_hook(
                "bash", script, self.agent_name, self.agent_dir,
                hook_name="SessionStart-hook",
            )

    def _run_hook_on_prompt_received(self, prompt: str) -> str | None:
        """UserPromptSubmit equivalent: context-inject + context-health before agy --print.

        Fires both hooks Claude agents receive on UserPromptSubmit.
        context-inject.py includes S2.4 skill-index.md injection for SG-1 skill
        discovery (Cluster J catalog) — non-Claude skill bridge, same as Codex S2.3.
        Returns additionalContext string if context-inject matched a keyword cluster,
        or None if no injection occurred.

        Divergence from Claude:
        - context-health-sample.py writes to /tmp/claude-ctx-{session_id} which
          requires a Claude session ID. Antigravity agents have no Claude session,
          so the script exits early (no-op). Called anyway for parity and so it
          picks up automatically if agy adds session tracking later.
        - context-inject.py uses .claude/.prompt-counter and .claude/.board-counter
          (agent-dir relative). These work identically for antigravity agents since
          agent_dir is their working directory.
        """
        extra_context = None
        hooks_dir = os.path.join(os.path.dirname(__file__), "hooks")

        # context-inject.py — keyword-cluster context injection + drift prevention
        script = os.path.join(hooks_dir, "context-inject.py")
        if os.path.isfile(script):
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

        # context-health-sample.py — context fill tracking
        # Noop for antigravity (no Claude session_id) but fires for parity.
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

    def _run_hook_on_turn_complete(self) -> None:
        """Stop equivalent: write session-end marker after each turn."""
        if not self.agent_name or not self.agent_dir:
            return
        script = os.path.join(os.path.dirname(__file__), "write-session-end.sh")
        if os.path.isfile(script):
            self._run_hook(
                "bash", script, self.agent_name, self.agent_dir,
                hook_name="Stop-hook",
            )

    # ─── Message polling ─────────────────────────────────────────────────────

    def poll_messages(self) -> list[dict]:
        """Poll for new messages since last_poll_time."""
        if self.last_poll_time is None:
            self.last_poll_time = time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
            )

        params = f"?channelId={self.channel_id}&since={self.last_poll_time}"
        if self.participant_id:
            params += f"&participantId={self.participant_id}"

        result = api_get(params)
        messages = result.get("messages", [])
        if messages:
            newest = max(
                msg.get("timestamp", self.last_poll_time or "")
                for msg in messages
            )
            if newest > (self.last_poll_time or ""):
                self.last_poll_time = newest

        return messages

    def is_mentioned(self, msg: dict) -> bool:
        """Check if the agent is @mentioned in a message."""
        content = msg.get("content", "")
        name = self.agent_name.lower()
        if f"@{name}" in content.lower():
            return True
        mentions = msg.get("mentions", [])
        if mentions:
            for m in mentions:
                if isinstance(m, dict) and m.get("name", "").lower() == name:
                    return True
        return False

    # ─── Response posting ────────────────────────────────────────────────────

    def post_message(self, content: str, reply_to_msg: dict | None = None) -> bool:
        """Post a message to the collab channel."""
        if not self.participant_id:
            debug("Cannot post: no participant_id")
            return False

        payload: dict = {
            "action": "message",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "content": content,
        }
        if reply_to_msg:
            payload["replyTo"] = reply_to_msg.get("id")

        result = api_post("", payload)
        ok = result.get("success", False)
        if not ok:
            debug(f"Post failed: {result.get('error', 'unknown')}")
        return ok

    def post_heartbeat(self) -> None:
        """Send a heartbeat to keep lastSeen fresh."""
        if not self.participant_id:
            return
        api_post("", {
            "action": "heartbeat",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
        })

    def broadcast_activity(self, status: str) -> None:
        """Broadcast activity status (working/idle) for UI animations.

        Mirrors collab-claude.py:783 — same payload shape, no activityDetail for v1.
        """
        if not self.joined or not self.channel_id or not self.participant_id:
            return
        if status == self.current_activity:
            return

        self.current_activity = status
        self.last_heartbeat_time = time.time()
        debug(f"Broadcasting activity: {status}")
        api_post("", {
            "action": "heartbeat",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "activityStatus": status,
        })

    # ─── agy print-mode invocation ───────────────────────────────────────────

    def _ensure_trusted(self) -> None:
        """Pre-register agent_dir in trustedFolders.json.

        agy -i blocks on a workspace-trust prompt if the working directory
        isn't trusted. Populating this before any agy invocation prevents
        the interactive trust prompt from blocking startup.

        Also applies to print mode — agy may check trust even in
        non-interactive mode depending on version.
        """
        trust_file = os.path.expanduser('~/.gemini/trustedFolders.json')
        try:
            if os.path.exists(trust_file):
                with open(trust_file) as f:
                    trust = json.load(f)
            else:
                trust = {}
            if self.agent_dir not in trust:
                trust[self.agent_dir] = 'TRUST_FOLDER'
                os.makedirs(os.path.dirname(trust_file), exist_ok=True)
                with open(trust_file, 'w') as f:
                    json.dump(trust, f, indent=2)
                debug(f"Added {self.agent_dir} to trustedFolders.json")
        except Exception as e:
            debug(f"trustedFolders update failed (non-fatal): {e}")

    def _resolve_gemini_md(self) -> str:
        """Resolve GEMINI.md imports inline."""
        gemini_path = os.path.join(self.agent_dir, "GEMINI.md")
        if not os.path.isfile(gemini_path):
            debug(f"GEMINI.md not found at {gemini_path}")
            return ""
        
        resolved_lines = []
        try:
            with open(gemini_path, "r") as f:
                for line in f:
                    if line.startswith("@"):
                        import_path = line[1:].strip()
                        full_import_path = os.path.abspath(os.path.join(self.agent_dir, import_path))
                        if os.path.isfile(full_import_path):
                            try:
                                with open(full_import_path, "r") as imp_f:
                                    resolved_lines.append(imp_f.read())
                            except Exception as e:
                                debug(f"Failed to read imported file {full_import_path}: {e}")
                        else:
                            debug(f"Imported file not found: {full_import_path}")
                    else:
                        resolved_lines.append(line)
            debug(f"Resolved GEMINI.md successfully from {gemini_path}")
        except Exception as e:
            debug(f"Failed to read GEMINI.md: {e}")
        return "\n".join(resolved_lines).strip()

    def _record_conversation_id(self, conv_id: str) -> None:
        """T1.1 (Sprint A): append this turn's agy conversation id to a per-agent
        log so the rich-terminal display can find the turn's steps DB.

        agy stores each conversation as
        ~/.gemini/antigravity-cli/conversations/<id>.db (SQLite). Print mode
        creates a fresh conversation per invocation and returns its real ID in
        JSON output. The global dir is shared by every agent, so the display
        cannot tell which db is ours without this map.
        Consumer resolves the agent's working dir, then reads the LAST line for the
        current turn or all lines for the full session. Append-only + best-effort:
        never raises into the turn path.
        """
        try:
            conv_dir = os.path.join(
                os.path.expanduser("~"), ".gemini", "antigravity-cli", "conversations"
            )
            record = {
                "conversationId": conv_id,
                "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "dbPath": os.path.join(conv_dir, f"{conv_id}.db"),
                "agent": self.agent_name,
            }
            log_path = os.path.join(self.agent_dir, ".antigravity-conversations.jsonl")
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
            debug(f"recorded conversation id {conv_id} -> {log_path}")
        except Exception as e:
            debug(f"_record_conversation_id failed: {e}")

    def _refresh_agent_stream(self) -> bool:
        """Decode completed Antigravity turn DBs into the common live feed."""
        decoder = os.path.join(os.path.dirname(__file__), "antigravity_decode.py")
        try:
            result = subprocess.run(
                [sys.executable, decoder, self.agent_dir],
                capture_output=True,
                text=True,
                timeout=30,
                cwd=self.agent_dir,
            )
            stream_path = os.path.join(self.agent_dir, ".antigravity-stream.jsonl")
            if result.returncode != 0:
                debug(f"agent stream decoder failed: {result.stderr[:200]}")
                return False
            return os.path.isfile(stream_path) and os.path.getsize(stream_path) > 0
        except Exception as e:
            debug(f"agent stream decoder failed: {e}")
            return False

    def _resolve_image_paths(self, msg: dict) -> list[str]:
        """Extract local file paths for images attached to a channel message.

        AgentChat saves shared images to COLLAB_IMAGES_DIR and exposes them as
        http://localhost:3000/api/collab/images/<filename>. This method converts
        those URLs (and any direct image data in the 'images' field) to absolute
        local paths that Gemini can read via its file tools.

        Returns a list of absolute file paths for images that exist on disk.
        """
        paths: list[str] = []

        # Source 1: metadata.imageUrls — URLs from user image attachments
        image_urls: list[str] = (
            msg.get("metadata", {}).get("imageUrls", [])
            or []
        )
        for url in image_urls:
            # url format: /api/collab/images/<filename>
            filename = url.rsplit("/", 1)[-1]
            local_path = os.path.join(COLLAB_IMAGES_DIR, filename)
            if os.path.isfile(local_path):
                paths.append(local_path)
                debug(f"Resolved image URL {url} -> {local_path}")
            else:
                debug(f"Image URL resolved to missing file: {local_path}")

        # Source 2: images[] field — PTY/posted images with a saved url
        images: list[dict] = msg.get("images") or []
        for img in images:
            url = img.get("url", "")
            if url:
                filename = url.rsplit("/", 1)[-1]
                local_path = os.path.join(COLLAB_IMAGES_DIR, filename)
                if os.path.isfile(local_path):
                    paths.append(local_path)
                    debug(f"Resolved image field -> {local_path}")

        # Source 3: image (single) — same shape, single object
        single: dict | None = msg.get("image")
        if single:
            url = single.get("url", "")
            if url:
                filename = url.rsplit("/", 1)[-1]
                local_path = os.path.join(COLLAB_IMAGES_DIR, filename)
                if os.path.isfile(local_path):
                    paths.append(local_path)
                    debug(f"Resolved single image -> {local_path}")

        # Deduplicate
        seen: set = set()
        unique: list[str] = []
        for p in paths:
            if p not in seen:
                seen.add(p)
                unique.append(p)
        return unique

    def _run_agy(self, prompt: str, image_paths: list[str] | None = None) -> tuple[int, str, str]:
        """Run agy --print with the given prompt.

        agy --print is designed for programmatic use:
        - JSON stdout = response text + actual conversation ID
        - exit code 0 = success
        - no Ink TUI, no ANSI noise, no completion guessing

        Each invocation omits --conversation and --continue, causing agy print
        mode to create a fresh conversation. Passing a newly minted UUID to
        --conversation is invalid: that flag resumes an existing conversation,
        and agy 1.1.19 can complete the model turn internally but still exit 1
        with no stdout when the requested conversation does not exist.

        JSON output supplies both the actual conversation ID and final response.
        The system-prefix (identity + alignment guardrails from GEMINI.md) carries
        context across turns.
        Stateless agy + stateful prefix.

        Image support: when image_paths is provided, local file paths are
        included in the prompt so Gemini can read them via its file tools.
        COLLAB_IMAGES_DIR is always registered as a workspace directory
        so the agent has access.

        Returns (exit_code, stdout, stderr).
        """
        keyring_env = load_keyring_env()
        # COLLAB_WRAPPER_PID lets the agent's shell-exec of collab_helper.py /
        # ask_liam.py resolve the session file the wrapper wrote (keyed on this
        # PID). $PPID inside the agy process chain lands on an intermediate
        # with no session file, so the explicit env var is required.
        env = {
            **os.environ,
            **keyring_env,
            "HOME": os.path.expanduser("~"),
            "COLLAB_WRAPPER_PID": str(os.getpid()),
        }

        # Build full prompt: system-prefix (identity + alignment) is the
        # context-carrier. Each invocation is a fresh agy --print call with
        # a new conversation ID — no accumulated transcript, no --continue.
        # Stateless agy + stateful prefix.
        if hasattr(self, 'system_prefix') and self.system_prefix:
            full_prompt = f"{self.system_prefix}\n\n---\n\nUser: {prompt}"
        else:
            full_prompt = prompt

        # Inject image paths into the prompt so Gemini knows what to read.
        # Local file paths are machine-readable; Gemini's file tools can open
        # them directly since COLLAB_IMAGES_DIR is in the workspace.
        if image_paths:
            image_lines = []
            for i, p in enumerate(image_paths):
                ext = os.path.splitext(p)[1].lower().lstrip(".")
                mime_map = {
                    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                    "webp": "image/webp", "gif": "image/gif", "bmp": "image/bmp",
                }
                mime = mime_map.get(ext, "image/png")
                image_lines.append(f"[Attached Image {i+1}: {p} ({mime})]")
            full_prompt = "\n".join(image_lines) + "\n\n" + full_prompt
            debug(f"Injected {len(image_paths)} image path(s) into prompt")

        # Always register both the agent dir AND collab-images dir so Gemini
        # file tools can read attached images.
        args = [
            AGY_BINARY,
            '--add-dir', self.agent_dir,
            '--add-dir', COLLAB_IMAGES_DIR,
            '--dangerously-skip-permissions',
        ]
        if self.model:
            args.extend(['--model', self.model])
        if self.effort:
            args.extend(['--effort', self.effort])
        args.extend([
            '--output-format', 'json',
            '--print',
            full_prompt,
        ])

        debug(f"Running agy --print (len={len(prompt)})")
        start_time = time.time()
        pane_log(f"agy --print ({len(prompt)} chars)...")
        try:
            ensure_antigravity_design_gate_hook(self.agent_dir)
            result = subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=AGY_TIMEOUT,
                cwd=self.agent_dir,
                env=env,
            )
            try:
                payload = json.loads(result.stdout)
            except (json.JSONDecodeError, TypeError) as exc:
                elapsed = time.time() - start_time
                error = f"invalid JSON from agy --print: {exc}"
                debug(
                    f"agy exit={result.returncode} stdout={len(result.stdout)} "
                    f"stderr={len(result.stderr)} parse_error={error}"
                )
                pane_log(
                    f"agy response invalid: exit={result.returncode}, "
                    f"{elapsed:.1f}s"
                )
                return result.returncode or 1, "", error

            if not isinstance(payload, dict):
                elapsed = time.time() - start_time
                error = "invalid JSON from agy --print: expected an object"
                debug(
                    f"agy exit={result.returncode} stdout={len(result.stdout)} "
                    f"stderr={len(result.stderr)} parse_error={error}"
                )
                pane_log(
                    f"agy response invalid: exit={result.returncode}, "
                    f"{elapsed:.1f}s"
                )
                return result.returncode or 1, "", error

            conv_id = payload.get("conversation_id")
            if isinstance(conv_id, str) and conv_id:
                self._record_conversation_id(conv_id)

            response = payload.get("response", "")
            if not isinstance(response, str):
                response = ""
            filtered_stdout = response.strip()

            status = str(payload.get("status", "")).upper()
            if result.returncode == 0 and status and status != "SUCCESS":
                result = subprocess.CompletedProcess(
                    result.args,
                    1,
                    stdout=result.stdout,
                    stderr=result.stderr or f"agy status={status}",
                )

            # CoT safety net: strip chain-of-thought narration lines that
            # survive the GEMINI.md prompt-engineering suppression.
            # Patterns from alignment-antigravity.md CoT SUPPRESSION guardrail:
            # "I will first...", "Let me check...", "I need to...", "Let's..."
            COT_PATTERN = re.compile(
                r'^\s*(I will\b|Let me\b|I need to\b|Let\'s\b|'
                r'I\'ll\b|First,?\s*I|Next,?\s*I|Now,?\s*I)',
                re.IGNORECASE,
            )
            filtered_stdout = '\n'.join(
                line for line in filtered_stdout.split('\n')
                if not COT_PATTERN.match(line)
            ).strip()
            elapsed = time.time() - start_time
            debug(
                f"agy exit={result.returncode} "
                f"stdout={len(result.stdout)} stderr={len(result.stderr)} "
                f"filtered_stdout={len(filtered_stdout)}"
            )
            pane_log(f"agy responded: {len(filtered_stdout)} chars, exit={result.returncode}, {elapsed:.1f}s")
            return result.returncode, filtered_stdout, result.stderr
        except subprocess.TimeoutExpired:
            debug(f"agy timed out after {AGY_TIMEOUT}s")
            pane_log(f"TIMEOUT: agy did not respond within {AGY_TIMEOUT}s")
            return -1, "", f"timeout after {AGY_TIMEOUT}s"
        except FileNotFoundError:
            debug(f"agy binary not found at {AGY_BINARY}")
            pane_log(f"ERROR: agy binary not found at {AGY_BINARY}")
            return -1, "", f"binary not found: {AGY_BINARY}"
        except Exception as e:
            debug(f"agy invocation error: {e}")
            pane_log(f"ERROR: agy invocation failed: {e}")
            return -1, "", str(e)

    # ─── Main loop ───────────────────────────────────────────────────────────

    def run(self) -> None:
        """Main entry point: join channel, poll for messages, process @mentions."""
        if not os.path.isfile(AGY_BINARY):
            debug(f"FATAL: agy binary not found at {AGY_BINARY}")
            print(
                f"\033[31mError: Antigravity CLI not found at {AGY_BINARY}. "
                "Install and try again.\033[0m",
                file=sys.stderr,
            )
            sys.exit(1)

        # Join channel
        if not self.join_channel():
            debug("FATAL: failed to join channel")
            sys.exit(1)

        # Write session file so the agent's shell-exec of collab_helper.py /
        # ask_liam.py can resolve channel + participant. Antigravity has no
        # PTY path to write it, so the wrapper does it itself (Codex parity).
        self._write_session_file()

        # Pre-register working directory as trusted
        self._ensure_trusted()

        # SessionStart hook
        self._run_hook_on_startup()

        # Register signal handlers for clean shutdown
        def _shutdown(signum, frame):
            debug(f"Received signal {signum}, shutting down")
            self.running = False

        signal.signal(signal.SIGTERM, _shutdown)
        signal.signal(signal.SIGINT, _shutdown)

        debug("Entering main loop")
        last_heartbeat = time.time()

        while self.running:
            try:
                # Poll for new messages
                messages = self.poll_messages()
                for msg in messages:
                    msg_id = msg.get("id", "")
                    if msg_id and msg_id not in self.processed_ids:
                        self.processed_ids.add(msg_id)
                        # Prune dedup set if large
                        if len(self.processed_ids) > self._dedup_max:
                            keep = sorted(
                                self.processed_ids,
                                key=lambda x: x if isinstance(x, str) else "",
                            )[-self._dedup_max:]
                            self.processed_ids = set(keep)

                        if not self.is_mentioned(msg):
                            continue

                        sender = msg.get("from", "unknown")
                        content = msg.get("content", "")

                        # Resolve attached images to local file paths so Gemini
                        # can read them via its file tools.
                        image_paths = self._resolve_image_paths(msg)

                        debug(
                            f"Processing @mention from {sender}: "
                            f"content={len(content)} chars images={len(image_paths)}"
                        )
                        pane_log(
                            f"@mention from {sender} "
                            f"({len(content)} chars, {len(image_paths)} images)"
                        )

                        self.is_processing = True
                        self.last_injected_msg_id = msg_id

                        self.broadcast_activity("working")
                        safe_append_stream_message(
                            self.agent_dir,
                            ".antigravity-stream.jsonl",
                            "user",
                            content,
                            event_id=f"{msg_id}-user" if msg_id else None,
                        )

                        # The reply line names the full id of the message being answered; it goes to the model only,
                        # never into `content`, which the stream log above already recorded.
                        reply_line = format_reply_context(msg.get("replyTo"))
                        exit_code, stdout, stderr = self._run_agy(
                            f"{reply_line}\n{content}" if reply_line else content, image_paths=image_paths or None
                        )

                        decoded_stream = self._refresh_agent_stream()

                        if exit_code == 0 and stdout.strip():
                            if not decoded_stream:
                                safe_append_stream_message(
                                    self.agent_dir,
                                    ".antigravity-stream.jsonl",
                                    "assistant",
                                    stdout.strip(),
                                    event_id=f"{msg_id}-assistant" if msg_id else None,
                                )
                            self.post_message(stdout.strip(), reply_to_msg=msg)
                            debug(f"Response posted ({len(stdout)} chars)")
                            pane_log(f"Response posted ({len(stdout)} chars)")
                        else:
                            debug(
                                f"No response posted: exit={exit_code} "
                                f"stdout={len(stdout)} stderr={stderr[:200]}"
                            )
                            pane_log(f"No response: exit={exit_code} stdout={len(stdout)} stderr={len(stderr)}")
                            sender_name = sender.get("name") if isinstance(sender, dict) else None
                            target = f"@{sender_name} " if sender_name else ""
                            self.post_message(
                                f"{target}I received this message, but the Antigravity runtime "
                                f"failed before returning a response (exit {exit_code}). I did "
                                "not retry automatically because the turn may have made partial "
                                "changes.",
                                reply_to_msg=msg,
                            )

                        self.is_processing = False

                        self.broadcast_activity("idle")

                        # Stop hook — session-end marker after each turn
                        self._run_hook_on_turn_complete()

                # Heartbeat
                now = time.time()
                hb_interval = (
                    self.heartbeat_interval
                    if self.is_processing
                    else self.idle_heartbeat_interval
                )
                if now - last_heartbeat > hb_interval:
                    self.post_heartbeat()
                    last_heartbeat = now

                time.sleep(POLL_INTERVAL)

            except KeyboardInterrupt:
                debug("KeyboardInterrupt")
                break
            except Exception as e:
                debug(f"Main loop error: {e}")
                time.sleep(POLL_INTERVAL)

        debug("Main loop exited, cleaning up")
        self.is_processing = False
        self.leave_channel()
        self._remove_session_file()


# ─── CLI entry point ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Antigravity CLI collab wrapper — print mode, subprocess.run per message"
    )
    parser.add_argument("--channel", required=True, help="Collab channel ID")
    parser.add_argument("--name", required=True, help="Participant display name")
    parser.add_argument(
        "--agent-name", default=None,
        help="Agent name for @mention detection (defaults to --name)",
    )
    parser.add_argument(
        "--agent-dir", default=None,
        help="Working directory for agy (defaults to cwd)",
    )
    parser.add_argument(
        "--model", default=None,
        help="Native Antigravity model profile (for example gemini-3.8-flash-medium; `agy models` lists them)",
    )
    parser.add_argument(
        "--effort", choices=("low", "medium", "high"), default=None,
        help="Antigravity reasoning effort for this session",
    )
    parser.add_argument(
        "--dangerously-skip-permissions", action="store_true", default=True,
        help="Auto-approve tool permissions (always on for agents)",
    )
    args = parser.parse_args()

    wrapper = CollabAntigravityWrapper(
        channel_id=args.channel,
        participant_name=args.name,
        agent_name=args.agent_name,
        agent_dir=args.agent_dir,
        model=args.model,
        effort=args.effort,
    )
    wrapper.run()


if __name__ == "__main__":
    main()
