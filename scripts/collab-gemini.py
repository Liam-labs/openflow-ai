#!/usr/bin/env python3
"""
Collab Gemini Wrapper (pexpect version)

Wraps the Gemini CLI using pexpect for proper PTY handling.
All Gemini sessions started with this wrapper can be dynamically
pulled into collab channels via the DevFlow UI.

Usage:
  collab-gemini [gemini args...]              # Start without channel (can join later)
  collab-gemini --channel <id> [gemini args...] # Start in a channel
"""

import atexit
import os

# Who the people are is configuration, not code. Unset: neutral wording (our own agents set these in their environment).
OWNER_PROSE = os.environ.get("DEVFLOW_OWNER_NAME", "").strip() or "the owner"
ARCHITECT_NAME = os.environ.get("DEVFLOW_ARCHITECT_NAME", "").strip() or "the Architect"
LEAD_NAME = os.environ.get("DEVFLOW_LEAD_NAME", "").strip() or "the Team Lead"
os.environ["COLLAB_AGENT_WRAPPER"] = "1"
import sys
import json
import time
import signal
import argparse
import subprocess
import threading
import urllib.request
import urllib.error
import shutil

try:
    import pexpect
except ImportError:
    print("\033[31mError: pexpect not installed. Run: pip install pexpect\033[0m", file=sys.stderr)
    sys.exit(1)

# Configuration
DEVFLOW_URL = __import__("os").environ.get("DEVFLOW_URL", "http://localhost:3000").rstrip("/")
API_BASE = f"{DEVFLOW_URL}/api/collab"
POLL_INTERVAL = 2  # seconds
IDLE_THRESHOLD = 1.5  # seconds since last keystroke before injecting

# Find Gemini binary - use real binary, not the shim at ~/bin/gemini
GEMINI_BINARY = os.path.expanduser("~/.nvm/versions/node/v20.19.5/bin/gemini")

# Debug log
DEBUG_LOG = "/tmp/collab-gemini-debug.log"


def debug(msg):
    """Write debug message to log file"""
    try:
        with open(DEBUG_LOG, "a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    except:
        pass


def download_collab_image(url):
    """Download a collab image URL to /tmp/ and return the local path.
    Returns None if download fails."""
    try:
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


class CollabGeminiWrapper:
    def __init__(self, channel_id=None, participant_name=None, gemini_args=None):
        self.channel_id = channel_id
        self.participant_name = participant_name
        self.participant_id = None
        self.gemini_args = gemini_args or []
        self.child = None  # pexpect child process
        self.last_keystroke = time.time()
        self.last_poll_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.running = True
        self.joined = False
        self.gemini_pid = None
        self.wrapper_pid = os.getpid()
        # Output capture for auto-posting
        self.output_buffer = ""
        self.capturing_response = False
        self.last_injected_message = None
        # Shell mode detection - prevent injecting into shell
        self.in_shell_mode = False
        self.last_output_line = ""
        self.pending_submit = False  # Text sent, waiting for safe time to send Enter
        self.last_output_time = time.time()
        self._shutdown_hook_fired = False  # prevent duplicate Stop-hook events
        # Activity heartbeat — keeps lastSeen fresh so frozen-detection
        # can distinguish live agents from truly-frozen ones (T2.7).
        self.current_activity = 'idle'  # idle, typing, working
        self.last_heartbeat_time = 0
        self.heartbeat_interval = 5.0
        self.idle_heartbeat_interval = 30.0

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

    def register_session(self):
        """Register session using Gemini's PID so UI can find it"""
        if not self.gemini_pid:
            debug("Cannot register - Gemini PID not yet known")
            return

        if not self.participant_name:
            self.participant_name = get_project_name()

        try:
            with open(get_ready_file(self.gemini_pid), 'w') as f:
                json.dump({
                    "pid": self.gemini_pid,
                    "name": self.participant_name,
                    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "cwd": os.getcwd(),
                    "wrapperPid": self.wrapper_pid,
                    "type": "gemini"
                }, f)
            print(f"\033[32m[Collab] Session ready (PID {self.gemini_pid}) - can be added to channels via DevFlow UI\033[0m", file=sys.stderr)
            debug(f"Session registered: {self.participant_name} (Gemini PID: {self.gemini_pid})")
        except Exception as e:
            print(f"\033[33m[Collab] Warning: {e}\033[0m", file=sys.stderr)

    def unregister_session(self):
        """Clean up registration files"""
        if self.gemini_pid:
            for f in [get_ready_file(self.gemini_pid), get_invite_file(self.gemini_pid)]:
                try:
                    os.remove(f)
                except:
                    pass

    def _flush_session_log(self):
        """Flush pending scratch buffers on wrapper exit without synthetic logs."""
        self._run_hook_on_shutdown()

    # ------------------------------------------------------------------
    # Lifecycle hooks (ported from collab-codex.py, 2026-06-05)
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
        """UserPromptSubmit equivalent: log rotation + context injection before injecting.

        Fires:
          1. check-rotate.sh — session rotation check
          2. context-inject.py — keyword-cluster injection + drift prevention
             (includes S2.5 skill-index.md injection for SG-1 skill discovery)
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

    def join_channel(self, channel_id, channel_name=None):
        self.channel_id = channel_id
        result = self.api_call("", "POST", {
            "action": "join",
            "channelId": channel_id,
            "participant": {
                "name": self.participant_name,
                "type": "gemini",
                "source": "collab-gemini wrapper (WSL)"
            }
        })
        if result.get("success"):
            self.participant_id = result.get("participantId")
            self.joined = True
            team_lead_id = result.get("teamLeadId")

            # Inject welcome message with role context
            if self.child and self.child.isalive():
                time.sleep(1.0)  # Wait for TUI to settle
                if team_lead_id == self.participant_id:
                    self.inject_message("System", "You are the Team Lead for this channel. Set a clear outcome and owner, use the sprint board when multi-person coordination benefits from it, trust agents to choose implementation details, and apply review/testing in proportion to real risk. Distil decisions and outcomes for " + OWNER_PROSE + "; keep detailed evidence in DevFlow records. This channel uses targeted delivery, so you receive direct mentions and broadcasts, not messages targeted to other agents.")
                elif team_lead_id:
                    self.inject_message("System", "You are a specialist on this channel. Work autonomously toward the assigned outcome, choose proportionate verification, and record nonessential discoveries as follow-ups rather than blockers. Use the sprint board when a board task exists. Keep channel communication focused on decisions, outcomes, and genuine blockers. This channel uses targeted delivery, so you receive direct mentions and broadcasts, not messages targeted to other agents.")

            self.last_poll_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            channel_display = channel_name or channel_id[:8]
            print(f"\033[32m[Collab] Joined '{channel_display}' as {self.participant_name}\033[0m", file=sys.stderr)
            debug(f"Joined channel: {channel_display}")
            self._write_session_file(channel_id, channel_name)
            return True
        debug(f"Failed to join channel: {result}")
        return False

    def _write_session_file(self, channel_id, channel_name=None):
        """Write PID-specific session file"""
        try:
            session_dir = os.path.join(os.getcwd(), '.claude')
            os.makedirs(session_dir, exist_ok=True)
            pid_session_file = os.path.join(session_dir, f'collab-session-{self.gemini_pid}.json')
            session_data = {
                "channelId": channel_id,
                "participantId": self.participant_id,
                "displayName": self.participant_name,
                "channelName": channel_name or "Unknown",
                "pid": self.gemini_pid
            }
            with open(pid_session_file, 'w') as f:
                json.dump(session_data, f)
            debug(f"Wrote session file: {pid_session_file}")
        except Exception as e:
            debug(f"Failed to write session file: {e}")

    def leave_channel(self):
        if self.joined and self.participant_id:
            self.api_call("", "POST", {
                "action": "leave",
                "channelId": self.channel_id,
                "participantId": self.participant_id
            })
            print(f"\033[33m[Collab] Left channel\033[0m", file=sys.stderr)

    def check_for_invite(self):
        """Check for channel invite file"""
        if not self.gemini_pid:
            return None
        try:
            invite_file = get_invite_file(self.gemini_pid)
            if os.path.exists(invite_file):
                with open(invite_file, 'r') as f:
                    invite = json.load(f)
                os.remove(invite_file)
                debug(f"Found invite: {invite}")
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

    def broadcast_activity(self, status, force=False):
        """Broadcast activity status to keep lastSeen fresh for frozen-detection.

        Without this, non-Claude wrappers emit zero liveness signal and
        frozen-detection has nothing to read → false FROZEN (T2.7).
        """
        if not self.joined or not self.channel_id or not self.participant_id:
            return
        if status == self.current_activity and not force:
            return
        self.current_activity = status
        self.last_heartbeat_time = time.time()
        self.api_call("", "POST", {
            "action": "heartbeat",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "activityStatus": status,
        })

    def post_to_channel(self, content):
        """Post a message to the channel"""
        if not self.joined or not self.participant_id:
            debug("Cannot post - not joined")
            return False

        # Clean up the content thoroughly
        import re
        clean_content = content

        # Remove ALL ANSI escape sequences
        clean_content = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', clean_content)
        clean_content = re.sub(r'\x1b\][^\x07]*\x07', '', clean_content)
        clean_content = re.sub(r'\x1b[()][AB012]', '', clean_content)

        # Remove tool output boxes and lines
        lines = clean_content.split('\n')
        filtered_lines = []
        for line in lines:
            # Skip box drawing lines and tool status lines
            if any(c in line for c in '╭╮╰╯│─┌┐└┘├┤┬┴┼'):
                continue
            if '✓' in line and ('ReadFile' in line or 'Shell' in line or 'WriteFile' in line):
                continue
            
            # Remove response markers and prompt chars
            l = re.sub(r'[✦⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●○◐◑◒◓]', '', line)
            l = re.sub(r'^>\s*', '', l)
            
            # Only add if it has content
            if l.strip():
                filtered_lines.append(l.strip())

        clean_content = '\n'.join(filtered_lines)

        debug(f"Cleaned content: {clean_content[:100]}...")

        if not clean_content or len(clean_content) < 5:
            return False

        result = self.api_call("", "POST", {
            "action": "message",
            "channelId": self.channel_id,
            "participantId": self.participant_id,
            "content": clean_content
        })
        if result.get("success"):
            debug(f"Posted to channel: {clean_content[:50]}...")
            return True
        debug(f"Failed to post: {result}")
        return False

    def inject_message(self, sender, content):
        """Inject a message into Gemini's input using pexpect - deferred Enter"""
        if not self.child or not self.child.isalive():
            debug("Cannot inject - child not alive")
            return False

        # If in shell mode, try to exit first
        if self.in_shell_mode:
            debug("In shell mode - sending Ctrl+C to exit")
            try:
                self.child.send('\x03')  # Ctrl+C
                time.sleep(0.5)
            except:
                pass

        try:
            prompt = f"[Channel message from {sender}]: {content}"
            debug(f"Injecting (deferred Enter): {prompt}")
            # Send ONLY the text - NO Enter yet!
            # Enter will be sent when we detect the > prompt in output_filter
            self.child.send(prompt)
            self.pending_submit = True  # Flag that we need to send Enter later
            # Start capturing output for this response
            self.capturing_response = True
            self.output_buffer = ""
            self.last_injected_message = content
            self.broadcast_activity('working')
            return True
        except Exception as e:
            debug(f"Inject error: {e}")
            return False

    def inject_context(self):
        """Inject collab context to help Gemini understand the setup"""
        if not self.child or not self.child.isalive():
            return
        if not self.joined or not self.channel_id or not self.participant_id:
            debug("Cannot inject context - not joined yet")
            return

        # Build minimal runtime context. The wrapper captures and posts Gemini's
        # final output; teaching a second HTTP send here caused duplicate channel
        # messages and contradicted the generated harness alignment.
        session_file = f".claude/collab-session-{self.gemini_pid}.json"
        context = f"""IMPORTANT CONTEXT: You are in a DevFlow Collab channel.

CHANNEL INFO:
- Channel ID: {self.channel_id}
- Participant ID: {self.participant_id}
- Session file: {session_file}

MESSAGE DELIVERY:
- Write one complete plain-text response normally.
- This wrapper posts the final response automatically.
- Do not call curl, collab_helper.py, or another posting command for the same response.

Messages from others: [Channel message from NAME]: content
Respond only when directly addressed or when a human broadcast is relevant to your role.
A mention alone does not require an acknowledgement. Follow channel-communication.md: finalise Plan.md, assign sprint tasks, then execute quietly. During execution report only hard blockers to {ARCHITECT_NAME} or completed-task findings that affect the next phase to {ARCHITECT_NAME} or {LEAD_NAME}. No intermediate handoffs, confirmations, ready checks, correction reports, stage assessments, freeze/hold announcements, or progress updates. Answer direct human questions; planning and hard-blocker resolution may be discussed."""

        self.child.send(context)
        time.sleep(0.1)
        self.child.send('\r')
        debug(f"Injected full collab context with channel {self.channel_id[:8]}...")

    def poll_channel(self):
        """Background thread: poll for invites and messages"""
        debug("Poll thread started")
        while self.running:
            try:
                invite = self.check_for_invite()
                if invite:
                    if self.joined and invite.get("channelId") == self.channel_id:
                        debug("Rejoin invite detected")
                        self.joined = False
                    self.join_channel(invite.get("channelId"), invite.get("channelName"))

                if self.joined and self.child and self.child.isalive():
                    idle_time = time.time() - self.last_keystroke
                    if idle_time >= IDLE_THRESHOLD:
                        messages = self.check_messages()
                        injected_any = False
                        for msg in messages:
                            sender = msg.get("from", {}).get("name", "Unknown")
                            content = msg.get("content", "")
                            sender_id = msg.get("from", {}).get("id", "")

                            # Download images to /tmp/ so agents can view them with Read tool
                            image_urls = msg.get("metadata", {}).get("imageUrls", [])
                            if image_urls:
                                img_lines = []
                                for url in image_urls:
                                    local_path = download_collab_image(url)
                                    if local_path:
                                        img_lines.append(f"[Image: {local_path}]")
                                    else:
                                        img_lines.append(f"[Image: {url}]")
                                url_text = "\n".join(img_lines)
                                content = f"{content}\n{url_text}" if content else url_text

                            if sender_id == self.participant_id or sender_id == "system":
                                continue
                            if self.inject_message(sender, content):
                                injected_any = True
                        if injected_any:
                            self.mark_read()
            except Exception as e:
                debug(f"Poll error: {e}")

            # Periodic idle heartbeat — keeps lastSeen fresh so
            # frozen-detection doesn't false-flag live agents (T2.7)
            now = time.time()
            since_heartbeat = now - self.last_heartbeat_time if self.last_heartbeat_time > 0 else float('inf')
            if self.joined and not self.capturing_response and since_heartbeat >= self.idle_heartbeat_interval:
                self.broadcast_activity('idle', force=True)

            time.sleep(POLL_INTERVAL)
        debug("Poll thread stopped")

    def run(self):
        # Find Gemini binary
        gemini_bin = GEMINI_BINARY
        if not os.path.exists(gemini_bin):
            gemini_bin = shutil.which("gemini")
        if not gemini_bin:
            print(f"\033[31mError: Gemini not found. Install it or set GEMINI_BINARY path.\033[0m", file=sys.stderr)
            return 1

        # Build command - default to interactive mode
        args = list(self.gemini_args) if self.gemini_args else ["-y"]
        # S2.5: pin a model that works on oauth-personal (settings.json's default
        # gemini-3.5-flash 404s fleet-wide; gemini-2.5-flash runs) + grant the SG-1
        # skills dir so the injected skill-index.md catalog's "Read .../SKILL.md"
        # paths clear Gemini's workspace-sandboxed read_file (-y only auto-approves,
        # it does NOT widen the sandbox — mirrors Antigravity's dir-grant). Guards
        # leave an explicit caller-supplied model/dir intact.
        if not any(a in ("-m", "--model") for a in args):
            args += ["-m", "gemini-2.5-flash"]
        if "--include-directories" not in args:
            args += ["--include-directories", os.path.expanduser("~/DevFlow/data/skills")]
        cmd = f"{gemini_bin} {' '.join(args)}"

        debug(f"Starting Gemini: {cmd}")
        print(f"\033[36m[Collab] Starting: {cmd}\033[0m", file=sys.stderr)

        try:
            self.child = pexpect.spawn(cmd, encoding='utf-8', timeout=None)
            self.gemini_pid = self.child.pid
            debug(f"Gemini spawned with PID: {self.gemini_pid}")

            self.register_session()

            # SessionStart hook — init .session-scratch/
            self._run_hook_on_startup()

            try:
                rows, cols = os.popen('stty size', 'r').read().split()
                self.child.setwinsize(int(rows), int(cols))
            except:
                self.child.setwinsize(24, 80)

            def handle_resize(signum, frame):
                try:
                    rows, cols = os.popen('stty size', 'r').read().split()
                    self.child.setwinsize(int(rows), int(cols))
                except:
                    pass

            signal.signal(signal.SIGWINCH, handle_resize)

            # SIGTERM handler — write session log before shutting down
            def handle_sigterm(signum, frame):
                debug("SIGTERM received — flushing session log")
                self._flush_session_log()
                self.running = False
                if self.child and self.child.isalive():
                    self.child.close()

            signal.signal(signal.SIGTERM, handle_sigterm)

            # atexit handler — belt-and-suspenders for any other exit path
            atexit.register(self._flush_session_log)

            poll_thread = threading.Thread(target=self.poll_channel, daemon=True)
            poll_thread.start()

            if self.channel_id:
                self.join_channel(self.channel_id)
                # Wait for Gemini to be ready, then inject context
                time.sleep(2)
                self.inject_context()

            debug("Starting interact()")

            def input_filter(data):
                self.last_keystroke = time.time()
                # User is typing, stop capturing (they're taking over)
                if self.capturing_response:
                    self.capturing_response = False
                return data

            def output_filter(data):
                # Handle both bytes and str
                if isinstance(data, bytes):
                    data_str = data.decode('utf-8', errors='replace')
                else:
                    data_str = data

                self.last_output_time = time.time()
                self.last_output_line = data_str

                # Detect shell mode ($ prompt at end of line)
                # Shell prompts typically end with $ followed by space
                if data_str.rstrip().endswith('$') or '\n$ ' in data_str or data_str.strip() == '$':
                    if not self.in_shell_mode:
                        debug("Detected shell mode ($ prompt)")
                    self.in_shell_mode = True

                # Detect conversation mode (> prompt)
                if data_str.rstrip().endswith('>') or '\n> ' in data_str:
                    if self.in_shell_mode:
                        debug("Exited shell mode (> prompt)")
                    self.in_shell_mode = False

                    # If we have pending text to submit, send Enter now
                    if self.pending_submit:
                        debug("Detected > prompt with pending submit - sending Enter")
                        try:
                            time.sleep(0.1)  # Small delay for stability
                            self.child.send('\r')
                            self.pending_submit = False
                        except Exception as e:
                            debug(f"Error sending Enter: {e}")

                # Capture output when we're expecting a response
                if self.capturing_response and self.joined:
                    self.output_buffer += data_str

                    # Check if response is complete
                    # Gemini uses ✦ for responses, > for input prompt
                    has_response = '✦' in self.output_buffer
                    # Check for prompt patterns - sometimes it's just > at the end
                    has_prompt = '\n> ' in self.output_buffer or self.output_buffer.strip().endswith('>')

                    # Debug the buffer state occasionally (to avoid flooding log)
                    if len(self.output_buffer) > 20 and self.output_buffer.strip().endswith('>'):
                        debug(f"Buffer check - has_response: {has_response}, has_prompt: {has_prompt}, len: {len(self.output_buffer)}")

                    is_complete = has_response and has_prompt
                    if is_complete:
                        # Extract the response (remove the prompt line)
                        response = self.output_buffer
                        # Clean up - remove the injected message echo and prompt
                        lines = response.split('\n')
                        clean_lines = []
                        for line in lines:
                            # Skip lines that are just prompts or echo of input
                            stripped = line.strip()
                            if stripped == '>' or stripped.startswith('[Channel message'):
                                continue
                            if stripped:
                                clean_lines.append(stripped)
                        if clean_lines:
                            final_response = ' '.join(clean_lines)
                            # Post to channel in background
                            threading.Thread(
                                target=self.post_to_channel,
                                args=(final_response,),
                                daemon=True
                            ).start()
                        self.capturing_response = False
                        self.output_buffer = ""
                        self.broadcast_activity('idle')
                return data

            self.child.interact(input_filter=input_filter, output_filter=output_filter)

        except pexpect.exceptions.ExceptionPexpect as e:
            print(f"\033[31mError: {e}\033[0m", file=sys.stderr)
            debug(f"Pexpect error: {e}")
            return 1
        except KeyboardInterrupt:
            pass
        finally:
            self.running = False
            self._flush_session_log()
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
    parser = argparse.ArgumentParser(description="Gemini with collab support")
    parser.add_argument("--channel", "-c", help="Channel ID to join")
    parser.add_argument("--name", "-n", help="Display name", default="Gemini")
    parser.add_argument("--list", "-l", action="store_true", help="List channels")

    args, gemini_args = parser.parse_known_args()

    if args.list:
        list_channels()
        return 0

    wrapper = CollabGeminiWrapper(
        channel_id=args.channel,
        participant_name=args.name,
        gemini_args=gemini_args
    )
    return wrapper.run()


if __name__ == "__main__":
    sys.exit(main())
