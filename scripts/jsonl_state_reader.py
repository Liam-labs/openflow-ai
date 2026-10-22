"""
JSONL transcript state reader.

Pure functions for reading Claude Code JSONL transcripts to determine
the agent's actual processing state (tool_use vs end_turn) and current tool.

Used by collab-claude.py idle detection to replace silence+CPU heuristics
with ground truth from the transcript.
"""

import json
import os
from typing import NamedTuple


class JsonlState(NamedTuple):
    """Result of check_jsonl_state().

    stop_reason: 'tool_use', 'end_turn', 'max_tokens', or None
    last_tool_name: Name of the last tool_use content block (e.g. 'Read', 'Bash'), or None
    """
    stop_reason: str | None
    last_tool_name: str | None


TAIL_BYTES = 100 * 1024  # 100KB tail — generous for finding last assistant entry

# Tool name → human-readable activity label
TOOL_LABELS: dict[str, str] = {
    'Read': 'Reading file...',
    'Bash': 'Running command...',
    'Edit': 'Editing file...',
    'Write': 'Writing file...',
    'Grep': 'Searching...',
    'Glob': 'Searching...',
    'Agent': 'Delegating...',
}


def tool_to_label(tool_name: str | None) -> str | None:
    """Map a tool name to a human-readable activity label.

    Returns None if tool_name is None or not in the map.
    """
    if tool_name is None:
        return None
    return TOOL_LABELS.get(tool_name)


def verify_message_ingested(jsonl_path: str, search_text: str, after_byte: int = 0) -> bool:
    """Check if a message was ingested by scanning for a queue-operation enqueue entry.

    Args:
        jsonl_path: Absolute path to the JSONL transcript file.
        search_text: Text snippet to search for in the enqueue content field.
        after_byte: Only scan entries after this byte offset in the file.

    Returns:
        True if a matching enqueue entry was found, False otherwise.
    """
    try:
        file_size = os.path.getsize(jsonl_path)
        if file_size <= after_byte:
            return False

        with open(jsonl_path, 'r') as f:
            if after_byte > 0:
                # Check if we're at a line boundary to avoid discarding a valid entry
                f.seek(after_byte - 1)
                if f.read(1) != '\n':
                    f.seek(after_byte)
                    f.readline()  # discard partial line
                else:
                    f.seek(after_byte)

            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue

                etype = entry.get('type')
                # Queued path: a message typed while the agent is mid-generation is logged
                # as a queue-operation/enqueue entry with a top-level `content` string.
                if etype == 'queue-operation':
                    if entry.get('operation') == 'enqueue' and search_text in (entry.get('content') or ''):
                        return True
                    continue
                # Direct path: a message processed immediately by an IDLE agent is logged as
                # a normal `user` turn (message.content — a str, or a list of content blocks)
                # with NO queue-operation entry. Matching ONLY queue-operation false-negatived
                # every idle delivery → verify timeout → re-inject (2026-06-04, CJack+Reynolds:
                # idle is the common case = the real fleet-wide duplicate driver). after_byte
                # still scopes the search to turns written after this inject, so an earlier
                # same-sender turn is not matched.
                if etype == 'user':
                    content = (entry.get('message') or {}).get('content', '')
                    if isinstance(content, list):
                        content = ' '.join(
                            (b.get('text') or '') if isinstance(b, dict) else str(b)
                            for b in content
                        )
                    if search_text in (content or ''):
                        return True
                    continue

        return False
    except (FileNotFoundError, PermissionError, OSError):
        return False


def resolve_transcript_path(cwd: str) -> str | None:
    """Read the transcript JSONL path from .session-scratch/transcript-path.

    Args:
        cwd: The agent's working directory (os.getcwd() in the wrapper).

    Returns:
        Absolute path to the JSONL file, or None if unavailable.

    Primary path: read <cwd>/.session-scratch/transcript-path, written by the
    session-scratch-init.sh SessionStart hook. When present + non-empty, this
    is authoritative.

    Fallback: if the scratch file is missing or empty (agent dir was never
    scaffolded with the hook, or the hook hasn't run this session), derive
    the project-key from cwd and glob ~/.claude/projects/<key>/*.jsonl for
    the most-recently-modified transcript. Keeps Plan Mode auto-accept
    (and any other transcript-dependent features) working on unscaffolded
    agents — same rule Claude Code itself uses to locate a session.
    """
    try:
        tp_file = os.path.join(cwd, '.session-scratch', 'transcript-path')
        with open(tp_file, 'r') as f:
            path = f.read().strip()
        if path:
            # Verify the resolved path actually exists — a stale scratch file
            # pointing to a deleted/rotated transcript causes an infinite
            # re-resolve loop (resolve → check fails → cache cleared → repeat).
            if os.path.exists(path):
                return path
            # Path is stale; fall through to glob fallback below.
    except (FileNotFoundError, PermissionError, OSError):
        pass

    # Fallback: glob the project-key dir under ~/.claude/projects/ and
    # return the newest JSONL by mtime.
    try:
        project_key = '-' + cwd.lstrip('/').replace('/', '-').replace(' ', '-')
        project_dir = os.path.join(
            os.path.expanduser('~'), '.claude', 'projects', project_key,
        )
        if not os.path.isdir(project_dir):
            return None
        candidates = [
            os.path.join(project_dir, f)
            for f in os.listdir(project_dir)
            if f.endswith('.jsonl')
        ]
        if not candidates:
            return None
        return max(candidates, key=os.path.getmtime)
    except (FileNotFoundError, PermissionError, OSError):
        return None


def check_jsonl_state(jsonl_path: str) -> JsonlState | None:
    """Read the last assistant entry from a JSONL transcript.

    Tails the file (last TAIL_BYTES), reverse-scans for the most recent
    line where type == 'assistant' and message.stop_reason exists.

    Args:
        jsonl_path: Absolute path to the JSONL transcript file.

    Returns:
        JsonlState(stop_reason, last_tool_name) — structured result
        None — file unavailable, empty, or no valid assistant entry
    """
    try:
        file_size = os.path.getsize(jsonl_path)
        if file_size == 0:
            return None

        with open(jsonl_path, 'r') as f:
            # Tail: seek to last TAIL_BYTES
            if file_size > TAIL_BYTES:
                f.seek(file_size - TAIL_BYTES)
                f.readline()  # discard partial first line
            content = f.read()

        lines = content.splitlines()

        # Reverse scan for last assistant entry with stop_reason
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue

            if entry.get('type') != 'assistant':
                continue

            message = entry.get('message', {})
            stop_reason = message.get('stop_reason')
            if stop_reason is not None:
                # Extract last tool name from content blocks
                last_tool_name = None
                if stop_reason == 'tool_use':
                    content_blocks = message.get('content', [])
                    for block in content_blocks:
                        if isinstance(block, dict) and block.get('type') == 'tool_use':
                            last_tool_name = block.get('name')
                return JsonlState(stop_reason, last_tool_name)

        return None

    except (FileNotFoundError, PermissionError, OSError):
        return None


# Disposition of a completed turn, used to tell a deliberately silent turn from
# a lost reply. Returned by final_response_disposition().
TURN_EMPTY = 'empty'      # turn completed silent: no text, or the no-reply marker
TURN_TEXT = 'text'        # turn completed and produced text
# None                    # unknown — no completed turn found after the boundary

# An agent that deliberately sends nothing ends its final response with a line
# holding only this marker. An empty final response cannot express that on
# Claude: Claude Code answers a turn with no visible output with a hidden
# "Please continue and produce a user-visible response" prompt, so the turn
# always ends in text (Jack, 26 Sep 2026). Agents that did other work in the
# same turn also end in text. Only an explicit marker separates both from a
# reply written to the terminal by mistake.
NO_REPLY_MARKER = 'NO_REPLY'


def ends_with_no_reply_marker(text) -> bool:
    """True when the last non-blank line of `text` is exactly the marker."""
    if not isinstance(text, str):
        return False
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return bool(lines) and lines[-1] == NO_REPLY_MARKER


def final_response_disposition(jsonl_path: str, after_byte: int = 0):
    """Classify the turn that completed after `after_byte`.

    The wrapper's corrective ("your response was NOT sent") assumes that no
    channel post means the agent replied into the terminal instead. That is only
    one of two possibilities: the agent may have deliberately said nothing. The
    two need opposite handling, and the difference is visible in the transcript
    rather than in terminal text.

    `after_byte` must be the transcript size captured when the message was
    injected, so an older turn cannot classify the current one.

    Returns:
        TURN_TEXT  — a turn completed and its final response contained text
        TURN_EMPTY — a turn completed and its final response contained none, or
                     its text ended with a line holding only NO_REPLY_MARKER
        None       — unknown: file missing, unreadable, truncated below the
                     boundary, or no completed turn after it. Callers must treat
                     unknown as "not proven silent" and keep the warning.
    """
    try:
        file_size = os.path.getsize(jsonl_path)
        if file_size <= after_byte:
            # Nothing new, or the transcript rotated/truncated beneath us.
            return None
        with open(jsonl_path, 'r', errors='replace') as f:
            if after_byte:
                # Only discard a partial line when the boundary actually falls
                # mid-line. When it lands exactly on a newline, an unconditional
                # readline() would swallow the first line of the new turn — the
                # very turn being classified — and report unknown for ever.
                f.seek(after_byte - 1)
                mid_line = f.read(1) != '\n'
                if mid_line:
                    f.readline()
            content = f.read()
    except (FileNotFoundError, PermissionError, OSError):
        return None

    disposition = None
    for line in content.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            # Once the post-boundary stream is unreadable, an earlier empty
            # final no longer proves that the current turn chose silence. The
            # malformed line could be the actual response still being written.
            return None
        if not isinstance(entry, dict):
            return None
        if entry.get('type') == 'user':
            # A user record after a completed candidate begins a newer turn.
            # Retaining an older empty result here would let a still-running or
            # truncated current reply masquerade as deliberate silence.
            disposition = None
            continue
        if entry.get('type') != 'assistant':
            continue
        message = entry.get('message')
        if not isinstance(message, dict):
            return None
        if message.get('stop_reason') != 'end_turn':
            continue  # still working, or a tool-use hop within the turn
        # Completion without a structurally valid content field is not proof of
        # an explicit blank final. Fail safe so transcript corruption cannot
        # suppress a genuinely lost response (or crash the wrapper).
        blocks = message.get('content')
        if not isinstance(blocks, list):
            return None
        text = '\n'.join(
            b.get('text') or '' for b in blocks
            if isinstance(b, dict) and b.get('type') == 'text' and isinstance(b.get('text'), str)
        )
        has_text = bool(text.strip())
        if not has_text and any(not isinstance(b, dict) for b in blocks):
            return None
        # Keep scanning: the last completed turn after the boundary is the one
        # that answers for this delivery.
        if has_text and not ends_with_no_reply_marker(text):
            disposition = TURN_TEXT
        else:
            disposition = TURN_EMPTY
    return disposition
