#!/usr/bin/env python3
"""
Collab Agent Wrapper (unified version)

Wraps AI CLI agents (Claude, Gemini) using pexpect for proper PTY handling.
All sessions started with this wrapper can be dynamically pulled into
collab channels via the DevFlow UI.

Usage:
  collab-agent claude [args...]           # Start Claude
  collab-agent gemini [args...]           # Start Gemini
  collab-agent --name "My Agent" claude   # Custom display name
  collab-agent --channel <id> claude      # Start in a channel
  collab-agent --list                     # List available channels

Bash aliases (add to ~/.bashrc):
  alias claude="collab-agent claude"
  alias gemini="collab-agent gemini"
"""

import os

# Who the people are is configuration, not code. Unset: neutral wording (our own agents set these in their environment).
OWNER_PROSE = os.environ.get("DEVFLOW_OWNER_NAME", "").strip() or "the owner"
os.environ["COLLAB_AGENT_WRAPPER"] = "1"
import re
import sys
import json
import time
import signal
import argparse
import threading
import urllib.request
import urllib.error

try:
    import pexpect
except ImportError:
    print("\033[31mError: pexpect not installed. Run: pip install pexpect\033[0m", file=sys.stderr)
    sys.exit(1)

# Compiled regex for stripping ANSI escape sequences
# Handles: CSI (with optional ? prefix), OSC sequences, charset switches, simple escapes
_ANSI_RE = re.compile(
    r'\x1b\[[\?]?[0-9;]*[a-zA-Z]'   # CSI sequences: \x1b[...X and \x1b[?...X
    r'|\x1b\][^\x07]*\x07'            # OSC sequences: \x1b]...BEL
    r'|\x1b\][^\x1b]*\x1b\\'          # OSC sequences: \x1b]...ST
    r'|\x1b[()][A-Z0-9]'              # Character set switches: \x1b(B, \x1b)0
    r'|\x1b[78HM><=]'                 # Simple escapes: save/restore cursor, etc.
)


def strip_ansi(text):
    """Strip all ANSI escape sequences from text"""
    return _ANSI_RE.sub('', text)


def download_collab_image(url):
    """Download a collab image URL to /tmp/ and return the local path.
    Returns None if download fails."""
    try:
        # Extract filename from URL (e.g. 1ea9e78c-...-0.png)
        filename = url.split("/")[-1]
        local_path = f"/tmp/collab-img-{filename}"
        if os.path.exists(local_path):
            return local_path
        urllib.request.urlretrieve(url, local_path)
        return local_path
    except Exception as e:
        debug(f"Failed to download image {url}: {e}")
        return None


# Injection state machine constants
INJECT_IDLE = 'IDLE'
INJECT_TEXT_INJECTED = 'TEXT_INJECTED'
INJECT_AWAITING_PROMPT = 'AWAITING_PROMPT'
INJECT_ENTER_SENT = 'ENTER_SENT'
INJECT_PROCESSING = 'PROCESSING'

# Configuration (can be overridden via environment variables)
DEVFLOW_URL = __import__("os").environ.get("DEVFLOW_URL", "http://localhost:3000").rstrip("/")
API_BASE = os.environ.get("DEVFLOW_API_BASE", f"{DEVFLOW_URL}/api/collab")
POLL_INTERVAL = int(os.environ.get("COLLAB_POLL_INTERVAL", "2"))  # seconds
IDLE_THRESHOLD = float(os.environ.get("COLLAB_IDLE_THRESHOLD", "1.5"))  # seconds since last keystroke before injecting
HEARTBEAT_INTERVAL = int(os.environ.get("COLLAB_HEARTBEAT_INTERVAL", "30"))  # seconds between heartbeats
AWAY_THRESHOLD = int(os.environ.get("COLLAB_AWAY_THRESHOLD", "300"))  # seconds (5 min) idle before sending 'away' status

# Auto-join config locations (checked in order)
AUTO_JOIN_CONFIGS = [
    os.path.expanduser("~/.config/devflow/collab-config.json"),
    ".claude/collab-config.json",
]

# Agent binary paths (fallbacks if not found in PATH)
AGENT_BINARY_FALLBACKS = {
    "claude": os.path.expanduser("~/.local/bin/claude"),
    "gemini": os.path.expanduser("~/.nvm/versions/node/v20.19.5/bin/gemini"),
}


def find_agent_binary(agent_type):
    """Find agent binary dynamically, checking fallbacks first to avoid wrapper recursion"""
    import shutil

    # IMPORTANT: Check explicit fallback FIRST to avoid infinite recursion
    # The wrapper shim (e.g., ~/bin/gemini) would be found by shutil.which()
    # before the real binary, causing the wrapper to spawn itself endlessly
    fallback = AGENT_BINARY_FALLBACKS.get(agent_type)
    if fallback and os.path.exists(fallback):
        return fallback

    # Check common locations (excluding ~/bin where wrappers live)
    common_paths = [
        os.path.expanduser(f"~/.local/bin/{agent_type}"),
        f"/usr/local/bin/{agent_type}",
        f"/usr/bin/{agent_type}",
    ]
    for path in common_paths:
        if os.path.exists(path):
            return path

    # Last resort: check PATH but exclude ~/bin to avoid finding our wrapper
    binary = shutil.which(agent_type)
    if binary:
        # Don't return the wrapper shim
        wrapper_dir = os.path.expanduser("~/bin")
        if not binary.startswith(wrapper_dir):
            return binary

    return None

# Debug log
DEBUG_LOG = "/tmp/collab-agent-debug.log"
DEBUG_LOG_MAX_SIZE = 1024 * 1024  # 1MB max before rotation


def debug(msg):
    """Write debug message to log file with rotation (includes PID for multi-agent disambiguation)"""
    try:
        # Rotate log if too large
        if os.path.exists(DEBUG_LOG):
            size = os.path.getsize(DEBUG_LOG)
            if size > DEBUG_LOG_MAX_SIZE:
                # Rotate: rename current to .old, start fresh
                old_log = DEBUG_LOG + ".old"
                try:
                    if os.path.exists(old_log):
                        os.remove(old_log)
                    os.rename(DEBUG_LOG, old_log)
                except OSError:
                    pass

        with open(DEBUG_LOG, "a") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} [PID:{os.getpid()}] {msg}\n")
    except:
        pass


def get_invite_file(pid=None):
    return f"/tmp/collab-invite-{pid or os.getpid()}.json"


def get_ready_file(pid=None):
    return f"/tmp/collab-ready-{pid or os.getpid()}.json"


def cleanup_stale_sessions():
    """Clean up stale ready/invite files from crashed sessions"""
    import glob
    cleaned = 0

    for pattern in ["/tmp/collab-ready-*.json", "/tmp/collab-invite-*.json"]:
        for filepath in glob.glob(pattern):
            try:
                # Extract PID from filename
                filename = os.path.basename(filepath)
                # Format: collab-ready-{pid}.json or collab-invite-{pid}.json
                parts = filename.replace('.json', '').split('-')
                if len(parts) >= 3:
                    pid_str = parts[-1]
                    pid = int(pid_str)

                    # Check if process is still running
                    try:
                        os.kill(pid, 0)  # Doesn't actually kill, just checks existence
                    except OSError:
                        # Process doesn't exist, remove stale file
                        os.remove(filepath)
                        cleaned += 1
                        debug(f"Cleaned up stale session file: {filepath}")
            except (ValueError, IndexError, OSError) as e:
                debug(f"Error checking session file {filepath}: {e}")

    if cleaned > 0:
        debug(f"Cleaned up {cleaned} stale session file(s)")
    return cleaned


def count_active_sessions():
    """Count how many collab-agent sessions are currently running"""
    import glob
    count = 0
    for filepath in glob.glob("/tmp/collab-ready-*.json"):
        try:
            filename = os.path.basename(filepath)
            parts = filename.replace('.json', '').split('-')
            if len(parts) >= 3:
                pid = int(parts[-1])
                try:
                    os.kill(pid, 0)  # Check if process exists
                    count += 1
                except OSError:
                    pass  # Process dead, don't count
        except (ValueError, IndexError):
            pass
    return count


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


def get_auto_join_channel(force=False):
    """
    Get channel to auto-join on startup.

    Args:
        force: If True, bypass config check (used with --auto-join flag)

    Priority:
    1. Config file with explicit channelId
    2. Config file with autoJoin: true (discover channel)
    3. CLI --auto-join flag (force=True) discovers most recent channel

    Returns: (channel_id, channel_name) or (None, None)
    """
    auto_join_enabled = force  # CLI flag can force auto-join

    # Check config files for explicit channel or auto-join flag
    for config_path in AUTO_JOIN_CONFIGS:
        try:
            if os.path.exists(config_path):
                with open(config_path) as f:
                    config = json.load(f)
                    # If explicit channel ID provided, use it
                    if config.get('autoJoin') and config.get('channelId'):
                        debug(f"Found explicit channel in config: {config_path}")
                        return config.get('channelId'), config.get('channelName')
                    # Otherwise, remember that auto-join is enabled
                    if config.get('autoJoin'):
                        auto_join_enabled = True
                        debug(f"Auto-join enabled via config: {config_path}")
        except Exception as e:
            debug(f"Error reading config {config_path}: {e}")

    # If auto-join not enabled, return early
    if not auto_join_enabled:
        return None, None

    # Query API for available channels
    try:
        req = urllib.request.Request(f"{API_BASE}?action=list")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            channels = data.get("channels", [])

            if not channels:
                return None, None

            # If there's only one channel, auto-join it
            if len(channels) == 1:
                ch = channels[0]
                debug(f"Auto-joining only channel: {ch.get('name')}")
                return ch.get('id'), ch.get('name')

            # If there's a channel marked as default
            for ch in channels:
                if ch.get('settings', {}).get('isDefault'):
                    debug(f"Auto-joining default channel: {ch.get('name')}")
                    return ch.get('id'), ch.get('name')

            # Otherwise, return the most recently active channel
            if channels:
                # Sort by lastActivity descending
                sorted_channels = sorted(
                    channels,
                    key=lambda c: c.get('lastActivity', ''),
                    reverse=True
                )
                ch = sorted_channels[0]
                debug(f"Auto-joining most recent channel: {ch.get('name')}")
                return ch.get('id'), ch.get('name')

    except Exception as e:
        debug(f"Error querying channels: {e}")

    return None, None


class CollabAgentWrapper:
    def __init__(self, agent_type, channel_id=None, participant_name=None, agent_args=None, auto_join=False):
        self.agent_type = agent_type
        self.channel_id = channel_id
        self.channel_name = None  # For display purposes
        self.participant_name = participant_name
        self.participant_id = self._load_identity() # Load persisted ID if available
        self.agent_args = agent_args or []
        self.auto_join = auto_join  # Auto-join most recent channel on startup
        self.child = None  # pexpect child process
        self.last_keystroke = time.time()
        self.last_poll_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.last_heartbeat = 0
        self.input_buffer = ""
        self.running = True
        self.joined = False
        self.agent_pid = None  # Agent's PID (child), used for registration
        self.wrapper_pid = os.getpid()  # Wrapper's PID (parent)
        self.injected_message_ids = []  # Track injected messages to prevent duplicates (list for FIFO cleanup)
        self.max_injected_ids = 500  # Limit to prevent memory leak
        self.last_injection_time = 0  # Rate limiting for message injection
        self.injection_cooldown = 2.0  # Minimum seconds between injections
        self.state_lock = threading.Lock()  # Protects joined, participant_id, channel_id
        self.inject_lock = threading.Lock()  # Protects inject_state to prevent race conditions
        self.api_available = True  # Tracks if API is reachable
        self.last_api_check = 0  # Last time we checked API availability
        self.api_check_interval = 60  # Check every 60s if API was down

        # Busy state & Queueing
        self.is_busy = False
        self.message_queue = []
        self.output_buffer = ""
        self.last_output_time = time.time()  # Track when we last saw output
        self.idle_timeout = 1.0  # Seconds of no output = agent is idle (reduced for snappier response)

        # Injection state machine (replaces boolean pending_submit)
        self.inject_state = INJECT_IDLE  # Current state
        self.inject_state_time = 0  # When state last changed
        self.enter_retry_count = 0  # Number of Enter retries in ENTER_SENT state
        self.max_enter_retries = 3  # Max Enter retries before giving up
        self.awaiting_prompt_timeout = 300  # 5 minute safety valve for AWAITING_PROMPT
        self.prompts = {
            "claude": ["❯", "> "],  # Claude prompt patterns (❯ is the main one)
            "gemini": ["> ", "Enter your prompt:", "Type a message..."]
        }

    def _load_identity(self):
        """Load persisted participant ID from project-specific file"""
        try:
            identity_file = os.path.join(os.getcwd(), '.claude', f'collab-identity-{self.agent_type}.json')
            if os.path.exists(identity_file):
                with open(identity_file, 'r') as f:
                    data = json.load(f)
                    p_id = data.get('participantId')
                    if p_id:
                        debug(f"Loaded persisted identity: {p_id}")
                        return p_id
        except Exception as e:
            debug(f"Failed to load identity: {e}")
        return None

    def _save_identity(self, participant_id):
        """Persist participant ID to project-specific file"""
        try:
            session_dir = os.path.join(os.getcwd(), '.claude')
            os.makedirs(session_dir, exist_ok=True)
            identity_file = os.path.join(session_dir, f'collab-identity-{self.agent_type}.json')
            
            with open(identity_file, 'w') as f:
                json.dump({"participantId": participant_id}, f)
            debug(f"Persisted identity: {participant_id}")
        except Exception as e:
            debug(f"Failed to save identity: {e}")

    def api_call(self, endpoint, method="GET", data=None, retries=3):
        """Make API call with exponential backoff retry on failure"""
        url = f"{API_BASE}{endpoint}"
        last_error = None

        for attempt in range(retries):
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
            except urllib.error.URLError as e:
                last_error = e
                if attempt < retries - 1:
                    # Exponential backoff: 1s, 2s, 4s...
                    wait_time = 2 ** attempt
                    debug(f"API error (attempt {attempt + 1}/{retries}): {e}. Retrying in {wait_time}s...")
                    time.sleep(wait_time)
            except Exception as e:
                last_error = e
                debug(f"API error: {e}")
                break  # Don't retry on non-network errors

        debug(f"API call failed after {retries} attempts: {last_error}")
        return {"error": str(last_error)}

    def check_api_health(self):
        """Check if API is reachable, update api_available status"""
        try:
            req = urllib.request.Request(f"{API_BASE}?health=1")
            with urllib.request.urlopen(req, timeout=3) as resp:
                if not self.api_available:
                    print(f"\033[32m[Collab] API connection restored!\033[0m", file=sys.stderr)
                    debug("API connection restored")
                self.api_available = True
                return True
        except Exception as e:
            if self.api_available:
                print(f"\033[33m[Collab] API unreachable - collab features disabled. Will retry.\033[0m", file=sys.stderr)
                debug(f"API health check failed: {e}")
            self.api_available = False
            return False

    def register_session(self):
        """Register session using agent's PID so UI can find it"""
        if not self.agent_pid:
            debug("Cannot register - agent PID not yet known")
            return

        # Set name if not provided
        if not self.participant_name:
            # Use Agent-{pid} as fallback instead of directory name to avoid confusion
            self.participant_name = f"Agent-{self.agent_pid}"

        try:
            with open(get_ready_file(self.agent_pid), 'w') as f:
                json.dump({
                    "pid": self.agent_pid,
                    "name": self.participant_name,
                    "agentType": self.agent_type,
                    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "cwd": os.getcwd(),
                    "wrapperPid": self.wrapper_pid
                }, f)
            print(f"\033[32m[Collab] {self.agent_type.capitalize()} session ready (PID {self.agent_pid}) - can be added to channels via DevFlow UI\033[0m", file=sys.stderr)
            debug(f"Session registered: {self.participant_name} ({self.agent_type}, PID: {self.agent_pid})")
        except Exception as e:
            print(f"\033[33m[Collab] Warning: {e}\033[0m", file=sys.stderr)

    def unregister_session(self):
        """Clean up registration files"""
        if self.agent_pid:
            for f in [get_ready_file(self.agent_pid), get_invite_file(self.agent_pid)]:
                try:
                    os.remove(f)
                except:
                    pass

    def join_channel(self, channel_id, channel_name=None):
        with self.state_lock:
            self.channel_id = channel_id
            if channel_name:
                self.channel_name = channel_name  # Store for Pulse DB recording
        result = self.api_call("", "POST", {
            "action": "join",
            "channelId": channel_id,
            "participant": {
                "name": self.participant_name,
                "type": f"{self.agent_type}-terminal",
                "source": "collab-agent wrapper",
                "pid": self.agent_pid,
                "projectPath": os.getcwd()
            }
        })
        if result.get("success"):
            with self.state_lock:
                self.participant_id = result.get("participantId")
                self.joined = True
            team_lead_id = result.get("teamLeadId")
            
            # Inject role context using immediate injection (we know agent is at prompt)
            if self.child and self.child.isalive():
                time.sleep(1.5) # Wait for TUI to fully settle and show prompt
                if team_lead_id == self.participant_id:
                    self.inject_message_immediate("System", "You are the Team Lead for this channel. Set a clear outcome and owner, use the sprint board when multi-person coordination benefits from it, trust agents to choose implementation details, and apply review/testing in proportion to real risk. Distil decisions and outcomes for " + OWNER_PROSE + "; keep detailed evidence in DevFlow records. This channel uses targeted delivery, so you receive direct mentions and broadcasts, not messages targeted to other agents.")
                elif team_lead_id:
                    self.inject_message_immediate("System", "You are a specialist on this channel. Work autonomously toward the assigned outcome, choose proportionate verification, and record nonessential discoveries as follow-ups rather than blockers. Use the sprint board when a board task exists. Keep channel communication focused on decisions, outcomes, and genuine blockers. This channel uses targeted delivery, so you receive direct mentions and broadcasts, not messages targeted to other agents.")

            # Inject agent-type-specific etiquette rules (e.g. Gemini broadcast guardrails)
            etiquette_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                          '..', 'docs', f'{self.agent_type.upper()}-COLLAB-ETIQUETTE.md')
            etiquette_path = os.path.normpath(etiquette_path)
            if os.path.exists(etiquette_path) and self.child and self.child.isalive():
                try:
                    with open(etiquette_path) as ef:
                        etiquette_content = ef.read().strip()
                    time.sleep(0.5)
                    self.inject_message_immediate("System", etiquette_content)
                    debug(f"Injected etiquette rules from {etiquette_path}")
                except Exception as e:
                    debug(f"Could not load etiquette file: {e}")

            # Set poll time to now so we don't get historical messages
            self.last_poll_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            channel_display = channel_name or channel_id[:8]
            print(f"\033[32m[Collab] Joined '{channel_display}' as {self.participant_name}\033[0m", file=sys.stderr)
            debug(f"Joined channel: {channel_display}")

            # Write session file for /collab-post skill to use
            self._write_session_file(channel_id, channel_name)
            
            # Persist identity for future sessions
            if self.participant_id:
                self._save_identity(self.participant_id)

            return True
        debug(f"Failed to join channel: {result}")
        return False

    def _write_session_file(self, channel_id, channel_name=None):
        """Write PID-specific session file for /collab-post skill compatibility"""
        try:
            session_dir = os.path.join(os.getcwd(), '.claude')
            os.makedirs(session_dir, exist_ok=True)

            # Use PID-specific filename to allow multiple agents in same project
            pid_session_file = os.path.join(session_dir, f'collab-session-{self.agent_pid}.json')
            generic_session_file = os.path.join(session_dir, 'collab-session.json')

            session_data = {
                "channelId": channel_id,
                "participantId": self.participant_id,
                "displayName": self.participant_name,
                "channelName": channel_name or "Unknown",
                "pid": self.agent_pid,
                "agentType": self.agent_type
            }

            # Write PID-specific file ONLY (no symlink to prevent session hijacking)
            with open(pid_session_file, 'w') as f:
                json.dump(session_data, f)

            # Remove any stale generic session file to prevent confusion
            try:
                if os.path.exists(generic_session_file):
                    os.remove(generic_session_file)
            except Exception:
                pass

            debug(f"Wrote session file: {pid_session_file}")
        except Exception as e:
            debug(f"Failed to write session file: {e}")

    def leave_channel(self):
        with self.state_lock:
            if not self.joined or not self.participant_id:
                return
            channel_id = self.channel_id
            participant_id = self.participant_id

        self.api_call("", "POST", {
            "action": "leave",
            "channelId": channel_id,
            "participantId": participant_id
        })
        print(f"\033[33m[Collab] Left channel\033[0m", file=sys.stderr)

    def check_for_invite(self):
        """Check for channel invite file using agent's PID"""
        if not self.agent_pid:
            return None
        try:
            invite_file = get_invite_file(self.agent_pid)
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
        with self.state_lock:
            if not self.joined or not self.channel_id:
                return []
            channel_id = self.channel_id
            participant_id = self.participant_id

        # IMPORTANT: Pass participantId for targeted message delivery filtering
        result = self.api_call(f"?channelId={channel_id}&since={self.last_poll_time}&participantId={participant_id}")

        # Handle API errors gracefully
        if result.get("error"):
            debug(f"API error in check_messages: {result.get('error')}")
            return []

        # Check if we are still in the participants list
        participants = result.get("participants", [])
        if participants:
            is_member = any(p.get("id") == participant_id for p in participants)
            if not is_member:
                debug("No longer in participant list - resetting joined state")
                with self.state_lock:
                    self.joined = False
                    # Don't clear channel_id yet, might be used for /rejoin later
                    # but set to None for polling safety
                    self.participant_id = None
                return []

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

    def send_heartbeat(self):
        """Send periodic heartbeat to API to update lastSeen and presence status"""
        with self.state_lock:
            if not self.joined or not self.participant_id:
                return
            channel_id = self.channel_id
            participant_id = self.participant_id

        now = time.time()
        if now - self.last_heartbeat < HEARTBEAT_INTERVAL:
            return

        idle_time = now - self.last_keystroke
        status = 'away' if idle_time >= AWAY_THRESHOLD else 'online'

        try:
            self.api_call("", "POST", {
                "action": "heartbeat",
                "channelId": channel_id,
                "participantId": participant_id,
                "status": status
            })
            self.last_heartbeat = now
            debug(f"Sent heartbeat (status: {status})")
        except Exception as e:
            debug(f"Heartbeat error: {e}")

    def _set_inject_state(self, new_state):
        """Transition inject state machine (must hold inject_lock)"""
        old_state = self.inject_state
        self.inject_state = new_state
        self.inject_state_time = time.time()
        if old_state != new_state:
            debug(f"Inject state: {old_state} → {new_state}")

    def process_queue(self):
        """Process queued messages if agent is not busy"""
        if not self.message_queue:
            return False

        # Only inject if state machine is IDLE
        with self.inject_lock:
            if self.inject_state != INJECT_IDLE:
                return False

        # Check if agent is ready to receive messages
        # Option 1: Prompt was detected (is_busy = False)
        # Option 2: Time-based fallback - no output for idle_timeout seconds
        time_since_output = time.time() - self.last_output_time
        is_idle_by_time = time_since_output >= self.idle_timeout

        if self.is_busy and not is_idle_by_time:
            # Still busy and not enough idle time
            return False

        if is_idle_by_time and self.is_busy:
            debug(f"Time-based idle detection: {time_since_output:.1f}s since last output")
            self.is_busy = False

        # Get oldest message
        msg = self.message_queue[0]
        sender = msg.get("from", {}).get("name", "Unknown")
        content = msg.get("content", "")

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

        debug(f"Processing queued message from {sender} (queue size: {len(self.message_queue)})")

        # Use immediate injection (text + Enter in one shot) because process_queue
        # only runs when the agent is confirmed idle at the prompt. The deferred-Enter
        # state machine is unreliable here because:
        # 1. output_filter's 500-char window can miss the prompt after long text injection
        # 2. _check_inject_state's fallback has timing issues with active output
        # Since we KNOW the agent is at the prompt (that's how we got here), just send Enter.
        if self.inject_message_immediate(sender, content):
            # Remove from queue only if successful
            self.message_queue.pop(0)
            return True

        return False

    def inject_message_immediate(self, sender, content):
        """Inject a message and send Enter immediately (no deferred prompt detection).

        Use this for messages where we KNOW the agent is at the prompt, such as:
        - Welcome messages after joining a channel
        - System messages during setup

        Unlike inject_message(), this bypasses the state machine entirely and
        sends text + Enter in one shot with a short delay between them.
        """
        if not self.child or not self.child.isalive():
            debug("Cannot inject immediate - child not alive")
            return False

        try:
            prompt = f"[Channel message from {sender}]: {content}"
            debug(f"Injecting immediate (text + Enter): {prompt[:100]}...")

            # Send the text
            self.child.send(prompt)

            # Brief delay to let the TUI render the text in the input area
            time.sleep(0.3)

            # Send Enter immediately - we know the agent is at the prompt
            self.child.send('\r')

            self.last_injection_time = time.time()
            self.is_busy = True
            debug("Immediate inject complete (text + Enter sent)")
            return True
        except Exception as e:
            debug(f"Immediate inject error: {e}")
            return False

    def inject_message(self, sender, content):
        """Inject a message into agent's input using pexpect with rate limiting"""
        if not self.child or not self.child.isalive():
            debug("Cannot inject - child not alive")
            return False

        # Guard: only inject when state machine is IDLE
        with self.inject_lock:
            if self.inject_state != INJECT_IDLE:
                debug(f"Cannot inject - state is {self.inject_state}, not IDLE")
                return False

        # Rate limiting - don't flood the agent
        now = time.time()
        time_since_last = now - self.last_injection_time
        if time_since_last < self.injection_cooldown:
            wait_time = self.injection_cooldown - time_since_last
            debug(f"Rate limiting: waiting {wait_time:.1f}s before injection")
            time.sleep(wait_time)

        try:
            # Format as a clear prompt for the agent to respond to
            # Include receiver identity to prevent agents from losing track of who they are
            prompt = f"[Channel message from {sender}]: {content}"
            if self.participant_name and sender != "System":
                prompt += f"\n(You are {self.participant_name}. Use /collab-post to respond.)"
            debug(f"Injecting text (no Enter yet): {prompt}")

            # Send ONLY the message text - NO Enter!
            # This mimics typing while Claude is busy - text goes to input buffer
            # Enter will be sent later when we detect the prompt (see output_filter)
            self.child.send(prompt)

            self.last_injection_time = time.time()
            with self.inject_lock:
                self._set_inject_state(INJECT_TEXT_INJECTED)
                self.enter_retry_count = 0
            self.is_busy = True  # Mark as busy
            return True
        except Exception as e:
            debug(f"Inject error: {e}")
            return False

    def _check_inject_state(self):
        """Check inject state machine and handle transitions (called from poll thread).

        This runs on the fast inner loop (300ms) to reduce Enter submission latency.
        output_filter (main thread) is the PRIMARY handler for prompt detection.
        This method handles fallback cases where output_filter doesn't fire
        (e.g., agent is idle, no new PTY output).
        """
        with self.inject_lock:
            state = self.inject_state
            elapsed = time.time() - self.inject_state_time

            if state == INJECT_IDLE:
                return  # Nothing to do

            elif state == INJECT_TEXT_INJECTED:
                # Text was sent, waiting for prompt to appear
                time_since_output = time.time() - self.last_output_time

                # Give output_filter 3 seconds to handle it first
                if elapsed > 3 and time_since_output > self.idle_timeout:
                    # output_filter hasn't fired - check if prompt is showing
                    prompts = self.prompts.get(self.agent_type, ["> "])
                    clean_buffer = strip_ansi(self.output_buffer[-500:])
                    is_at_prompt = any(p in clean_buffer for p in prompts)

                    if is_at_prompt:
                        debug(f"Fallback: prompt detected in TEXT_INJECTED after {elapsed:.1f}s, sending Enter")
                        try:
                            self.child.send('\r')
                            self._set_inject_state(INJECT_ENTER_SENT)
                            self.enter_retry_count = 0
                        except Exception as e:
                            debug(f"Error sending fallback Enter: {e}")

                # Separate check: if agent has been busy for >30s with continuous output,
                # transition to AWAITING_PROMPT so we keep watching for the prompt.
                # This must NOT be nested inside the idle_timeout check above, because
                # when the agent is actively outputting, time_since_output stays low
                # and the idle_timeout condition is never true.
                # Only transition if we're still in TEXT_INJECTED (the block above may
                # have already transitioned to ENTER_SENT).
                if elapsed > 30 and self.inject_state == INJECT_TEXT_INJECTED:
                    debug(f"TEXT_INJECTED for {elapsed:.1f}s without prompt - transitioning to AWAITING_PROMPT")
                    self._set_inject_state(INJECT_AWAITING_PROMPT)

            elif state == INJECT_AWAITING_PROMPT:
                # Was TEXT_INJECTED for >30s, agent was busy, still watching for prompt
                # No idle_timeout check here — if prompt is in the buffer, send Enter immediately.
                # output_filter is the primary handler but may miss it if the prompt arrives
                # in a chunk that doesn't trigger prompt detection (e.g., partial ANSI sequences).
                prompts = self.prompts.get(self.agent_type, ["> "])
                clean_buffer = strip_ansi(self.output_buffer[-500:])
                is_at_prompt = any(p in clean_buffer for p in prompts)

                if is_at_prompt:
                    debug(f"AWAITING_PROMPT: prompt detected after {elapsed:.1f}s, sending Enter")
                    try:
                        self.child.send('\r')
                        self._set_inject_state(INJECT_ENTER_SENT)
                        self.enter_retry_count = 0
                        self.output_buffer = ""  # Clear to avoid re-detection
                    except Exception as e:
                        debug(f"Error sending Enter from AWAITING_PROMPT: {e}")
                elif elapsed > self.awaiting_prompt_timeout:
                    # Safety valve: give up after 5 minutes (absolute last resort)
                    debug(f"AWAITING_PROMPT: safety valve after {elapsed:.1f}s - resetting to IDLE")
                    self._set_inject_state(INJECT_IDLE)

            elif state == INJECT_ENTER_SENT:
                # Enter was sent, waiting for agent to start processing
                if elapsed > 10 and self.enter_retry_count < self.max_enter_retries:
                    # Prompt might still be showing - retry Enter
                    prompts = self.prompts.get(self.agent_type, ["> "])
                    clean_buffer = strip_ansi(self.output_buffer[-500:])
                    is_at_prompt = any(p in clean_buffer for p in prompts)

                    if is_at_prompt:
                        self.enter_retry_count += 1
                        debug(f"ENTER_SENT: retry #{self.enter_retry_count} after {elapsed:.1f}s")
                        try:
                            self.child.send('\r')
                            self.inject_state_time = time.time()  # Reset timer
                        except Exception as e:
                            debug(f"Error retrying Enter: {e}")
                elif elapsed > 10 and self.enter_retry_count >= self.max_enter_retries:
                    # All retries exhausted - reset
                    debug(f"ENTER_SENT: max retries exhausted, resetting to IDLE")
                    self._set_inject_state(INJECT_IDLE)

            elif state == INJECT_PROCESSING:
                # Agent is working - output_filter handles transition back to IDLE
                # Nothing to do here from the poll thread
                pass

    def _start_gemini_usage_reporter(self):
        """Start a background daemon thread that reports Gemini token usage to TokenPulse.

        Only runs when agent_type == 'gemini'. Polls the Gemini session file every 10 seconds
        and POSTs new messages with token data to http://localhost:8420/api/ingest.
        """
        if self.agent_type != "gemini":
            return

        def _reporter():
            import glob as _glob

            TOKENPULSE_INGEST = "http://localhost:8420/api/ingest"
            POLL_SECONDS = 10

            # Resolve project name from CWD using ~/.gemini/projects.json
            cwd = os.getcwd()
            gemini_project = None
            try:
                projects_file = os.path.expanduser("~/.gemini/projects.json")
                if os.path.exists(projects_file):
                    with open(projects_file) as pf:
                        projects_map = json.load(pf)
                    # projects.json maps cwd -> project_name
                    gemini_project = projects_map.get(cwd)
                    debug(f"[usage_reporter] Gemini project for '{cwd}': {gemini_project}")
            except Exception as e:
                debug(f"[usage_reporter] Could not read projects.json: {e}")

            # Derive project name: prefer Team/{agent} directory structure detection
            # e.g. /home/user/Pulse/Team/Janet -> project=Pulse
            _cwd_parts = cwd.replace('\\', '/').split('/')
            cwd_project = os.path.basename(cwd)  # default: basename fallback
            if 'Team' in _cwd_parts:
                _team_idx = len(_cwd_parts) - 1 - _cwd_parts[::-1].index('Team')
                if _team_idx > 0:
                    cwd_project = _cwd_parts[_team_idx - 1]

            # Track how many messages we have already reported (start from current
            # count so we don't re-report history that existed before we started)
            reported_count = None  # None = not yet initialised
            last_session_file = None

            while True:
                try:
                    time.sleep(POLL_SECONDS)

                    # Find the Gemini session file to read
                    session_file = None

                    if gemini_project:
                        # Look in the project-specific chats directory
                        chats_dir = os.path.expanduser(
                            f"~/.gemini/tmp/{gemini_project}/chats/"
                        )
                        pattern = os.path.join(chats_dir, "session-*.json")
                        matches = _glob.glob(pattern)
                        if matches:
                            # Use the most recently modified session file
                            session_file = max(matches, key=os.path.getmtime)

                    if not session_file:
                        # Fallback: scan all project dirs for most recent session
                        pattern = os.path.expanduser("~/.gemini/tmp/*/chats/session-*.json")
                        matches = _glob.glob(pattern)
                        if matches:
                            session_file = max(matches, key=os.path.getmtime)

                    if not session_file:
                        # Session file not created yet — agent may still be starting up
                        continue

                    # If the session file changed (new session started), reset counter
                    if session_file != last_session_file:
                        debug(f"[usage_reporter] New session file: {session_file}")
                        last_session_file = session_file
                        reported_count = None  # Force re-init below

                    # Read the session file
                    try:
                        with open(session_file) as sf:
                            session_data = json.load(sf)
                    except Exception as e:
                        debug(f"[usage_reporter] Could not read session file: {e}")
                        continue

                    messages = session_data.get("messages", [])
                    if not isinstance(messages, list):
                        continue

                    # Initialise baseline on first successful read so we skip history
                    if reported_count is None:
                        reported_count = len(messages)
                        debug(f"[usage_reporter] Initialised at {reported_count} messages (skipping history)")
                        continue

                    # Process only new messages
                    new_messages = messages[reported_count:]
                    for msg in new_messages:
                        tokens = msg.get("tokens")
                        if not tokens:
                            continue

                        payload = {
                            "provider": "google",
                            "model": msg.get("model", "gemini"),
                            "agent_name": self.participant_name or "",
                            "project": cwd_project,
                            "collab_channel": self.channel_name or self.channel_id or "",
                            "input_tokens": tokens.get("input", 0),
                            "output_tokens": tokens.get("output", 0),
                            "cache_read_tokens": tokens.get("cached", 0),
                            "duration_ms": 0,
                        }

                        try:
                            req = urllib.request.Request(
                                TOKENPULSE_INGEST,
                                data=json.dumps(payload).encode("utf-8"),
                                headers={"Content-Type": "application/json"},
                                method="POST",
                            )
                            with urllib.request.urlopen(req, timeout=5) as resp:
                                resp.read()  # consume response
                            debug(
                                f"[usage_reporter] Reported tokens: "
                                f"in={payload['input_tokens']} "
                                f"out={payload['output_tokens']} "
                                f"cached={payload['cache_read_tokens']}"
                            )
                        except Exception as e:
                            debug(f"[usage_reporter] Failed to POST to TokenPulse: {e}")

                    reported_count = len(messages)

                except Exception as e:
                    debug(f"[usage_reporter] Unexpected error: {e}")

        t = threading.Thread(target=_reporter, daemon=True, name="gemini-usage-reporter")
        t.start()
        debug("[usage_reporter] Gemini usage reporter thread started")

    def poll_channel(self):
        """Background thread: poll for invites and messages.

        Uses a fast inner loop (300ms) for state machine checks and a slow outer
        loop (2-3s) for API operations to reduce Enter submission latency.
        """
        debug("Poll thread started")
        session_count_check_time = 0  # Track when we last checked session count
        current_poll_interval = POLL_INTERVAL
        last_api_poll_time = 0  # Track when we last did API operations
        fast_loop_interval = 0.3  # 300ms for state machine checks
        last_periodic_catchup = 0  # Track last periodic catch-up poll time

        while self.running:
            try:
                now = time.time()

                # === FAST PATH (every 300ms): state machine checks ===
                self._check_inject_state()

                # === SLOW PATH (every 2-3s): API operations ===
                time_since_api_poll = now - last_api_poll_time
                if time_since_api_poll < current_poll_interval:
                    time.sleep(fast_loop_interval)
                    continue

                last_api_poll_time = now

                # Check session count every 30 seconds to adjust poll interval
                if now - session_count_check_time >= 30:
                    session_count = count_active_sessions()
                    old_interval = current_poll_interval
                    current_poll_interval = 3 if session_count > 3 else POLL_INTERVAL
                    if current_poll_interval != old_interval:
                        debug(f"Adjusted poll interval: {current_poll_interval}s ({session_count} active sessions)")
                    session_count_check_time = now

                # Graceful degradation: periodically check API health if it was down
                if not self.api_available and (now - self.last_api_check) >= self.api_check_interval:
                    self.last_api_check = now
                    if self.check_api_health():
                        # API is back! Re-register session
                        self.register_session()

                # Skip collab features if API is unavailable
                if not self.api_available:
                    time.sleep(fast_loop_interval)
                    continue

                # Always check for invites - handles both initial join and rejoin after kick
                invite = self.check_for_invite()
                if invite:
                    # If already joined same channel, this is a rejoin after kick
                    if self.joined and invite.get("channelId") == self.channel_id:
                        debug("Rejoin invite detected - was likely kicked")
                        self.joined = False  # Reset so join_channel works properly
                    # Use displayName from invite if provided (fixes naming issue)
                    if invite.get("displayName"):
                        self.participant_name = invite.get("displayName")
                        debug(f"Using displayName from invite: {self.participant_name}")
                    self.join_channel(invite.get("channelId"), invite.get("channelName"))

                # Send periodic heartbeat
                self.send_heartbeat()

                # Check for messages
                with self.state_lock:
                    is_joined = self.joined
                if is_joined and self.child and self.child.isalive():
                    messages = self.check_messages()
                    for msg in messages:
                        msg_id = msg.get("id")
                        sender_id = msg.get("from", {}).get("id", "")

                        # Skip already-injected messages (prevents duplicates)
                        if msg_id and msg_id in self.injected_message_ids:
                            continue

                        # Skip own messages and system messages
                        if sender_id == self.participant_id or sender_id == "system":
                            continue

                        # Add to queue instead of injecting immediately
                        debug(f"Queueing message {msg_id} from {sender_id}")
                        self.message_queue.append(msg)

                        if msg_id:
                            self.injected_message_ids.append(msg_id)
                            # Prevent memory leak - keep only last N message IDs
                            if len(self.injected_message_ids) > self.max_injected_ids:
                                self.injected_message_ids = self.injected_message_ids[-self.max_injected_ids:]

                    # Try to process queue
                    if self.process_queue():
                        self.mark_read()

                # Periodic catch-up poll (every 60s) — belt-and-suspenders.
                # Even when SSE appears healthy (heartbeats flowing), events may
                # not be routed after a DevFlow restart. This REST poll catches
                # any messages missed by the SSE stream. Dedup via injected_message_ids.
                if now - last_periodic_catchup >= 60.0 and self.joined and self.channel_id:
                    last_periodic_catchup = now
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
                            f"&limit=10"
                            + (f"&since={catchup_since}" if catchup_since else "")
                        )
                        cu_resp = urllib.request.urlopen(
                            urllib.request.Request(catchup_url), timeout=5
                        )
                        cu_data = json.loads(cu_resp.read().decode('utf-8'))
                        queued = 0
                        for cu_msg in cu_data.get('messages', []):
                            cu_id = cu_msg.get('id')
                            if cu_id and cu_id in self.injected_message_ids:
                                continue
                            cu_sender_id = cu_msg.get('from', {}).get('id', '')
                            if cu_sender_id == self.participant_id or cu_sender_id == "system":
                                continue
                            cu_recipients = cu_msg.get('recipients')
                            if cu_recipients and self.participant_id not in cu_recipients:
                                continue
                            self.message_queue.append(cu_msg)
                            if cu_id:
                                self.injected_message_ids.append(cu_id)
                                if len(self.injected_message_ids) > self.max_injected_ids:
                                    self.injected_message_ids = self.injected_message_ids[-self.max_injected_ids:]
                            queued += 1
                        if queued:
                            debug(f"Periodic catch-up queued {queued} missed message(s)")
                    except Exception as cu_e:
                        debug(f"Periodic catch-up poll failed (non-fatal): {cu_e}")

            except Exception as e:
                debug(f"Poll error: {e}")

            time.sleep(fast_loop_interval)
        debug("Poll thread stopped")

    def run(self):
        # Clean up stale session files from crashed wrappers
        cleanup_stale_sessions()

        # Find agent binary dynamically
        binary = find_agent_binary(self.agent_type)
        if not binary:
            print(f"\033[31mError: {self.agent_type} not found in PATH or common locations\033[0m", file=sys.stderr)
            print(f"\033[33mTip: Install {self.agent_type} or add it to your PATH\033[0m", file=sys.stderr)
            return 1

        # Build command
        cmd = binary
        if self.agent_args:
            cmd = f"{binary} {' '.join(self.agent_args)}"

        debug(f"Starting {self.agent_type}: {cmd}")

        # Set OTEL telemetry vars before spawning so Claude Code inherits them.
        # Use setdefault for base vars (don't override user's custom config).
        # Always override OTEL_RESOURCE_ATTRIBUTES — derive fresh from CWD so
        # project/agent/channel are always correct regardless of shell env state.
        os.environ.setdefault('CLAUDE_CODE_ENABLE_TELEMETRY', '1')
        os.environ.setdefault('OTEL_METRICS_EXPORTER', 'otlp')
        os.environ.setdefault('OTEL_LOGS_EXPORTER', 'otlp')
        os.environ.setdefault('OTEL_EXPORTER_OTLP_PROTOCOL', 'grpc')
        os.environ.setdefault('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4317')
        os.environ.setdefault('OTEL_LOG_TOOL_DETAILS', '1')
        os.environ.setdefault('OTEL_METRICS_INCLUDE_SESSION_ID', 'true')

        # Derive project from CWD: /Pulse/Team/Janet -> project=Pulse
        _cwd = os.getcwd()
        _cwd_parts = _cwd.replace('\\', '/').split('/')
        _project = os.path.basename(_cwd)  # fallback
        if 'Team' in _cwd_parts:
            _team_idx = len(_cwd_parts) - 1 - _cwd_parts[::-1].index('Team')
            if _team_idx > 0:
                _project = _cwd_parts[_team_idx - 1]
        _agent_name = self.participant_name or 'user'
        # Resolve channel display name before spawn (join_channel hasn't run yet).
        # Try collab-channels.json to map UUID -> name, falling back to raw value.
        _channel = self.channel_name or ''
        if not _channel and self.channel_id:
            try:
                _ch_path = os.path.join((os.environ.get('DEVFLOW_HOME') or os.path.join(os.path.expanduser('~'), 'DevFlow')), '.AppData', 'collab-channels.json')
                with open(_ch_path) as _cf:
                    _ch_data = json.load(_cf)
                _ch_list = _ch_data if isinstance(_ch_data, list) else _ch_data.get('channels', [])
                for _ch in _ch_list:
                    if _ch.get('id') == self.channel_id:
                        _channel = _ch.get('name', '') or self.channel_id
                        break
                else:
                    _channel = self.channel_id  # not found; use ID as-is
            except Exception:
                _channel = self.channel_id or ''
        os.environ['OTEL_RESOURCE_ATTRIBUTES'] = (
            f"agent.name={_agent_name},"
            f"project={_project},"
            f"collab.channel={_channel}"
        )
        debug(f"Set OTEL_RESOURCE_ATTRIBUTES: {os.environ['OTEL_RESOURCE_ATTRIBUTES']}")

        try:
            # Spawn agent in a real PTY using pexpect
            self.child = pexpect.spawn(cmd, encoding='utf-8', timeout=None)

            # Get agent's PID - this is crucial for registration
            self.agent_pid = self.child.pid
            debug(f"{self.agent_type} spawned with PID: {self.agent_pid}")

            # Check API health before registering
            self.check_api_health()

            # Now register with agent's PID so UI can find us (if API available)
            if self.api_available:
                self.register_session()
            else:
                print(f"\033[33m[Collab] Starting without collab - will retry connection in background.\033[0m", file=sys.stderr)

            # Set window size to match terminal
            try:
                rows, cols = os.popen('stty size', 'r').read().split()
                self.child.setwinsize(int(rows), int(cols))
            except:
                self.child.setwinsize(24, 80)

            # Handle window resize
            def handle_resize(signum, frame):
                try:
                    rows, cols = os.popen('stty size', 'r').read().split()
                    self.child.setwinsize(int(rows), int(cols))
                except:
                    pass

            signal.signal(signal.SIGWINCH, handle_resize)

            # Handle termination signals for clean shutdown (prevents orphaned PTYs)
            def handle_terminate(signum, frame):
                sig_name = "SIGTERM" if signum == signal.SIGTERM else "SIGHUP"
                debug(f"Received {sig_name}, initiating clean shutdown")
                self.running = False
                self.leave_channel()
                self.unregister_session()
                if self.child and self.child.isalive():
                    self.child.close()
                sys.exit(0)

            signal.signal(signal.SIGTERM, handle_terminate)
            signal.signal(signal.SIGHUP, handle_terminate)

            # Start polling thread
            poll_thread = threading.Thread(target=self.poll_channel, daemon=True)
            poll_thread.start()

            # Start Gemini token usage reporter (no-op for non-gemini agents)
            self._start_gemini_usage_reporter()

            # Start the initial channel join in parallel with interact(). The
            # join path injects role/etiquette prompts after the TUI settles.
            # Running it synchronously here meant pexpect had no active reader:
            # Gemini could fill/redraw its PTY, store the pasted prompt, and
            # leave Enter unprocessed until a human typed into tmux. Once
            # interact() owns the I/O loop, startup injection follows the same
            # proven path as later channel messages.
            def start_channel_join(channel_id, channel_name):
                startup_join_thread = threading.Thread(
                    target=self.join_channel,
                    args=(channel_id, channel_name),
                    daemon=True,
                    name=f"collab-{self.agent_type}-startup-join",
                )
                startup_join_thread.start()

            # If we have a channel to join immediately
            if self.channel_id:
                start_channel_join(self.channel_id, self.channel_name)
            # Auto-join: discover and join a channel automatically
            elif self.auto_join:
                auto_channel_id, auto_channel_name = get_auto_join_channel(force=True)
                if auto_channel_id:
                    print(f"\033[36m[Collab] Auto-joining channel: {auto_channel_name or auto_channel_id[:8]}\033[0m", file=sys.stderr)
                    start_channel_join(auto_channel_id, auto_channel_name)
                else:
                    print(f"\033[33m[Collab] No channels found for auto-join. Use DevFlow UI to create one.\033[0m", file=sys.stderr)
            # Check config for auto-join (no CLI flag, but config enabled)
            else:
                auto_channel_id, auto_channel_name = get_auto_join_channel(force=False)
                if auto_channel_id:
                    print(f"\033[36m[Collab] Auto-joining channel (via config): {auto_channel_name or auto_channel_id[:8]}\033[0m", file=sys.stderr)
                    start_channel_join(auto_channel_id, auto_channel_name)

            # Give control to the user - this handles all I/O
            debug("Starting interact()")

            # Check if we have a proper TTY before attempting interact()
            if not sys.stdin.isatty():
                print(f"\033[31m[Collab] Error: stdin is not a TTY. Cannot run interactive mode.\033[0m", file=sys.stderr)
                print(f"\033[33m[Collab] Try running directly in a terminal, not through a pipe or script.\033[0m", file=sys.stderr)
                debug("stdin is not a TTY, cannot interact()")
                return 1

            # Custom input filter to track keystrokes and intercept commands
            def input_filter(data):
                self.last_keystroke = time.time()
                # Handle both bytes and str (pexpect may pass either)
                text = data.decode('utf-8', errors='ignore') if isinstance(data, bytes) else data
                self.input_buffer += text

                if "\r" in text or "\n" in text:
                    self.is_busy = True # User submitted command, mark as busy
                    
                    if "/leave" in self.input_buffer:
                        with self.state_lock:
                            was_joined = self.joined
                        if was_joined:
                            self.leave_channel()
                            with self.state_lock:
                                self.joined = False
                                self.participant_id = None
                            print(f"\r\033[33m[Collab] Disconnected from channel.\033[0m\n", file=sys.stderr)
                    elif "/rejoin" in self.input_buffer:
                        with self.state_lock:
                            is_joined = self.joined
                            has_channel = self.channel_id is not None
                        if not is_joined and has_channel:
                            print(f"\r\033[36m[Collab] Rejoining channel...\033[0m\n", file=sys.stderr)
                            with self.state_lock:
                                channel_id = self.channel_id
                                channel_name = self.channel_name
                            if self.join_channel(channel_id, channel_name):
                                print(f"\r\033[32m[Collab] Rejoined successfully!\033[0m\n", file=sys.stderr)
                            else:
                                print(f"\r\033[31m[Collab] Failed to rejoin.\033[0m\n", file=sys.stderr)
                        elif is_joined:
                            print(f"\r\033[33m[Collab] Already in a channel. Use /leave first.\033[0m\n", file=sys.stderr)
                        else:
                            print(f"\r\033[33m[Collab] No previous channel to rejoin.\033[0m\n", file=sys.stderr)
                    elif "/collab-status" in self.input_buffer:
                        with self.state_lock:
                            is_joined = self.joined
                            channel_id = self.channel_id
                            channel_name = self.channel_name
                        status = "connected" if is_joined else "disconnected"
                        channel_info = f" to {channel_name or channel_id[:8] if channel_id else 'none'}" if channel_id else ""
                        print(f"\r\033[36m[Collab] Status: {status}{channel_info}\033[0m\n", file=sys.stderr)
                    self.input_buffer = ""

                return data

            def output_filter(data):
                # Monitor output to detect when agent is ready (not busy)
                text = data.decode('utf-8', errors='ignore') if isinstance(data, bytes) else data
                self.output_buffer += text
                self.last_output_time = time.time()  # Track output activity

                # Limit buffer size
                if len(self.output_buffer) > 2000:
                    self.output_buffer = self.output_buffer[-2000:]

                # Check for prompt patterns
                prompts = self.prompts.get(self.agent_type, ["> "])
                # Strip ANSI codes for cleaner matching (uses compiled module-level regex)
                clean_buffer = strip_ansi(self.output_buffer[-500:])

                prompt_detected = False

                # Robust prompt detection:
                # 1. Must match one of the known agent prompts
                # 2. Must NOT look like a bash prompt (e.g. <user>@the desktop:~$ or just $)
                bash_patterns = [r'[\w-]+@[\w-]+:.*\$', r'\$ $', r'# $']
                is_bash = any(re.search(p, clean_buffer.strip()) for p in bash_patterns)

                if not is_bash:
                    for prompt in prompts:
                        if prompt in clean_buffer:
                            prompt_detected = True
                            break

                if prompt_detected:
                    with self.inject_lock:
                        state = self.inject_state

                        if state in (INJECT_TEXT_INJECTED, INJECT_AWAITING_PROMPT):
                            # Prompt appeared - send Enter to submit the buffered text
                            elapsed = time.time() - self.inject_state_time
                            debug(f"Prompt detected in {state} after {elapsed:.1f}s, sending Enter")
                            try:
                                self.child.send('\r')
                                self._set_inject_state(INJECT_ENTER_SENT)
                                self.enter_retry_count = 0
                                self.output_buffer = ""  # Clear to avoid double detection
                            except Exception as e:
                                debug(f"Error sending Enter: {e}")

                        elif state == INJECT_ENTER_SENT:
                            # Prompt still showing after Enter was sent - might need retry
                            elapsed = time.time() - self.inject_state_time
                            if elapsed > 2.0 and self.enter_retry_count < self.max_enter_retries:
                                self.enter_retry_count += 1
                                debug(f"Enter retry #{self.enter_retry_count} after {elapsed:.1f}s")
                                try:
                                    self.child.send('\r')
                                    self.inject_state_time = time.time()  # Reset timer
                                except Exception as e:
                                    debug(f"Error retrying Enter: {e}")

                        elif state == INJECT_PROCESSING:
                            # Agent finished processing, back to idle
                            self._set_inject_state(INJECT_IDLE)

                    if self.is_busy:
                        self.is_busy = False
                        debug(f"Detected prompt, marking as idle")
                else:
                    # Non-prompt output while in ENTER_SENT means agent started working
                    with self.inject_lock:
                        if self.inject_state == INJECT_ENTER_SENT:
                            self._set_inject_state(INJECT_PROCESSING)

                return data

            try:
                self.child.interact(input_filter=input_filter, output_filter=output_filter)
            except OSError as e:
                if e.errno == 25:  # Inappropriate ioctl for device
                    print(f"\033[31m[Collab] Error: Terminal ioctl failed (errno 25).\033[0m", file=sys.stderr)
                    print(f"\033[33m[Collab] This usually means the terminal doesn't support required features.\033[0m", file=sys.stderr)
                    print(f"\033[33m[Collab] Try running claude directly: {os.path.expanduser('~/.local/bin/claude')}\033[0m", file=sys.stderr)
                    debug(f"interact() OSError: {e}")
                else:
                    raise

        except pexpect.exceptions.ExceptionPexpect as e:
            print(f"\033[31mError: {e}\033[0m", file=sys.stderr)
            debug(f"Pexpect error: {e}")
            return 1
        except KeyboardInterrupt:
            pass
        finally:
            self.running = False
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
    parser = argparse.ArgumentParser(
        description="AI Agent wrapper with collab support (Claude, Gemini)",
        usage="%(prog)s [options] <agent> [agent_args...]"
    )
    parser.add_argument("--channel", "-c", help="Channel ID to join")
    parser.add_argument("--name", "-n", help="Display name for this session")
    parser.add_argument("--list", "-l", action="store_true", help="List channels")
    parser.add_argument("--auto-join", "-a", action="store_true",
                        help="Auto-join the most recent channel on startup")
    parser.add_argument("agent", nargs="?", choices=["claude", "gemini"],
                        help="Agent to run (claude or gemini)")

    # Parse known args, rest goes to agent
    args, agent_args = parser.parse_known_args()

    if args.list:
        list_channels()
        return 0

    if not args.agent:
        parser.print_help()
        print("\nSupported agents: claude, gemini")
        return 1

    wrapper = CollabAgentWrapper(
        agent_type=args.agent,
        channel_id=args.channel,
        participant_name=args.name,
        agent_args=agent_args,
        auto_join=args.auto_join
    )
    return wrapper.run()


if __name__ == "__main__":
    sys.exit(main())
