#!/usr/bin/env python3
"""Execution gate for an active Design Reference board.

DevFlow owns gate existence and the launcher-bound active tuple. The workspace
artifact is only an untrusted cache seeded by the board producer. Before a
mutation this hook asks the authenticated server for the current participant,
session, and canonical-workspace record and permits implementation only for its
exact selected tuple. Missing or replaced cache state is rehydrated and the
current attempt is denied. Native read/grep/glob tools and the two sanctioned
communication/refinement helpers remain available while the board is locked.
General shell commands do not: shell-level read safety is porous through
executable configuration.

Availability fallback: if no local gate marker exists and DevFlow cannot be
reached at all (exhausted timeout, refused connection, failed name lookup,
unreachable host), the tool is permitted. Any existing/unreadable marker keeps
the gate closed, and any HTTP or malformed response still blocks. Absence is not
proof of server state; the next call always queries again. Refusal joined the
timeout case on 2026-10-04 because DevFlow now runs on another machine, where a
restart would otherwise lock every agent out of editing.
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import re
import shlex
import socket
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


GATE_FILENAME = "design-reference-gate.json"
DEFAULT_API_BASE = os.environ.get("DEVFLOW_URL", "http://localhost:3000")
# Allow a brief server stall and one transport retry before timeout fallback.
GATE_LOOKUP_TIMEOUT_SECONDS = 5
GATE_LOOKUP_ATTEMPTS = 2
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")

FILE_MUTATION_TOOLS = {
    "edit",
    "multiedit",
    "notebookedit",
    "write",
    "write_file",
    "apply_patch",
    "delete_file",
    "move_file",
    "copy_file",
}
SHELL_TOOLS = {
    "bash",
    "bash_exec",
    "exec_command",
    "powershell",
    "shell",
    "terminal",
}
DELEGATION_TOOLS = {
    "agent",
    "delegate_task",
    "spawn_agent",
    "task",
}
# Same default as every other DevFlow script; the sanctioned send command names this exact path.
DEVFLOW_HOME = os.environ.get("DEVFLOW_HOME") or os.path.join(os.path.expanduser("~"), "DevFlow")
DESIGN_BOARD_HELPER = os.path.join(DEVFLOW_HOME, "scripts", "design_reference_board.py")
COLLAB_HELPER = os.path.join(DEVFLOW_HOME, "scripts", "collab_helper.py")
BOARD_HEREDOC_MARKER = "DESIGN_REFERENCE_BOARD"


@dataclass(frozen=True)
class GateDecision:
    allowed: bool
    reason: str


class GateArtifactError(ValueError):
    pass


def gate_path(agent_dir: str | os.PathLike[str]) -> Path:
    return Path(agent_dir) / ".session-scratch" / GATE_FILENAME


def _parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _validate_gate_artifact(value: object) -> dict:
    if not isinstance(value, dict):
        raise GateArtifactError("gate artifact must be an object")
    if value.get("version") != 1:
        raise GateArtifactError("gate artifact version is invalid")
    for field in ("boardId", "channelId", "participantId"):
        if not isinstance(value.get(field), str) or not ID_RE.fullmatch(value[field]):
            raise GateArtifactError(f"gate artifact {field} is invalid")
    if not isinstance(value.get("revision"), int) or isinstance(value.get("revision"), bool) or value["revision"] < 1:
        raise GateArtifactError("gate artifact revision is invalid")
    if not isinstance(value.get("boardFingerprint"), str) or not SHA256_RE.fullmatch(value["boardFingerprint"]):
        raise GateArtifactError("gate artifact boardFingerprint is invalid")
    selection = value.get("selectionFingerprint")
    if selection is not None and (not isinstance(selection, str) or not SHA256_RE.fullmatch(selection)):
        raise GateArtifactError("gate artifact selectionFingerprint is invalid")
    project_path = value.get("projectPath")
    if not isinstance(project_path, str) or not Path(project_path).is_absolute():
        raise GateArtifactError("gate artifact projectPath is invalid")
    created_at = _parse_iso(value.get("createdAt"))
    expires_at = _parse_iso(value.get("expiresAt"))
    if created_at is None or expires_at is None:
        raise GateArtifactError("gate artifact timestamps are invalid")
    if expires_at <= created_at:
        raise GateArtifactError("gate artifact expiry must be after creation")
    return value


def load_gate_artifact(agent_dir: str | os.PathLike[str]) -> dict | None:
    path = gate_path(agent_dir)
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            return _validate_gate_artifact(json.load(handle))
    except GateArtifactError:
        raise
    except Exception as error:
        raise GateArtifactError(f"gate artifact is unreadable: {error}") from error


def write_gate_artifact(agent_dir: str | os.PathLike[str], artifact: dict) -> Path:
    validated = _validate_gate_artifact(dict(artifact))
    target = gate_path(agent_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{GATE_FILENAME}.", dir=target.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(validated, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        os.chmod(target, 0o600)
        return target
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _tool_basename(tool_name: object) -> str:
    if not isinstance(tool_name, str):
        return ""
    return tool_name.rsplit("__", 1)[-1].strip().lower()


def _has_shell_control_syntax(command: str) -> bool:
    return any(
        token in command
        for token in ("\n", "\r", ";", "&", "|", ">", "<", "`", "$(", "(", ")", "{", "}")
    )


def _is_sanctioned_collab_helper(command: str) -> bool:
    marker = "DEVFLOW_MESSAGE"
    heredoc = f"<<'{marker}'"
    if heredoc not in command:
        return False
    lines = command.splitlines()
    if len(lines) < 3 or lines[-1].strip() != marker:
        return False
    if sum(1 for line in lines if line.strip() == marker) != 1:
        return False
    prefix = lines[0].strip()
    if not prefix.endswith(heredoc):
        return False
    prefix = prefix[: -len(heredoc)].strip()
    # `--to` / `--broadcast` became a required recipient on 2026-09-04. Omitting
    # them here silently un-sanctions the exact send command the scaffolding tells
    # every agent to use, so an ordinary reply falls through to the network lookup
    # and is refused whenever DevFlow is unreachable.
    expected = re.compile(
        r"^(?:CLAUDE_PID=\$\{COLLAB_WRAPPER_PID:-\$PPID\}\s+)?"
        r"python3\s+" + re.escape(COLLAB_HELPER) +
        r"(?=\s)(?:"
        r"(?:\s+--stdin)"
        r"|(?:\s+--channel\s+[A-Za-z0-9._:-]+)"
        r"|(?:\s+--to\s+[A-Za-z0-9][A-Za-z0-9,._-]*)"
        r"|(?:\s+--broadcast)"
        r"){1,4}$"
    )
    if not expected.fullmatch(prefix):
        return False
    try:
        tokens = shlex.split(prefix)
    except ValueError:
        return False
    if tokens.count("--to") and tokens.count("--broadcast"):
        return False
    return (
        tokens.count("--stdin") == 1
        and tokens.count("--channel") <= 1
        and tokens.count("--to") <= 1
        and tokens.count("--broadcast") <= 1
    )


def _is_sanctioned_board_helper(command: str) -> bool:
    if f"<<'{BOARD_HEREDOC_MARKER}'" in command:
        lines = command.splitlines()
        if len(lines) < 3 or lines[-1].strip() != BOARD_HEREDOC_MARKER:
            return False
        if sum(1 for line in lines if line.strip() == BOARD_HEREDOC_MARKER) != 1:
            return False
        prefix = lines[0].strip()
        heredoc = f"<<'{BOARD_HEREDOC_MARKER}'"
        if not prefix.endswith(heredoc):
            return False
        prefix = prefix[: -len(heredoc)].strip()
        try:
            tokens = shlex.split(prefix)
        except ValueError:
            return False
        if tokens and tokens[0] in {"python", "python3", "/usr/bin/python3"}:
            tokens = tokens[1:]
        return _valid_board_helper_argv(tokens, required_source="stdin")
    if _has_shell_control_syntax(command):
        return False
    try:
        tokens = shlex.split(command)
    except ValueError:
        return False
    if not tokens:
        return False
    if tokens[0] in {"python", "python3", "/usr/bin/python3"}:
        tokens = tokens[1:]
    return _valid_board_helper_argv(tokens)


def _valid_board_helper_argv(tokens: list[str], required_source: str | None = None) -> bool:
    """Accept only the producer's fixed options; no positional/unknown argv."""
    if not tokens or os.path.abspath(tokens[0]) != DESIGN_BOARD_HELPER:
        return False
    args = tokens[1:]
    source: str | None = None
    saw_channel = False
    saw_dry_run = False
    index = 0
    while index < len(args):
        token = args[index]
        if token == "--stdin" and source is None:
            source = "stdin"
            index += 1
            continue
        if token == "--file" and source is None and index + 1 < len(args):
            file_path = args[index + 1]
            if not os.path.isabs(file_path):
                return False
            source = "file"
            index += 2
            continue
        if token == "--channel" and not saw_channel and index + 1 < len(args):
            if not ID_RE.fullmatch(args[index + 1]):
                return False
            saw_channel = True
            index += 2
            continue
        if token == "--dry-run" and not saw_dry_run:
            saw_dry_run = True
            index += 1
            continue
        return False
    return source is not None and (required_source is None or source == required_source)


def is_mutation_capable(payload: dict) -> bool:
    tool_name = _tool_basename(payload.get("tool_name"))
    tool_input = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    if tool_name in SHELL_TOOLS:
        command_value = tool_input.get("command")
        cmd_value = tool_input.get("cmd")
        if command_value is not None and cmd_value is not None and command_value != cmd_value:
            return True
        command = command_value if command_value is not None else cmd_value
        if not isinstance(command, str):
            return True
        return not (
            _is_sanctioned_collab_helper(command)
            or _is_sanctioned_board_helper(command)
        )
    if tool_name in FILE_MUTATION_TOOLS or tool_name in DELEGATION_TOOLS:
        return True
    mutation_terms = (
        "write", "edit", "patch", "delete", "move", "copy", "create",
        "rename", "mkdir", "install", "deploy", "delegate", "spawn",
        "shell", "exec",
    )
    return any(term in tool_name for term in mutation_terms)


def _ancestor_pids() -> list[int]:
    pending = os.getpid()
    result: list[int] = []
    seen: set[int] = set()
    while pending > 1 and pending not in seen and len(result) < 32:
        seen.add(pending)
        result.append(pending)
        try:
            fields = Path(f"/proc/{pending}/stat").read_text(encoding="utf-8").split()
            pending = int(fields[3])
        except (OSError, ValueError, IndexError):
            break
    return result


def _secrets_file_token() -> str:
    """Read the token from ~/.secrets when a session was launched without it."""
    try:
        text = (Path.home() / ".secrets").read_text(encoding="utf-8")
    except OSError:
        return ""
    for line in text.splitlines():
        m = re.match(r"^\s*(?:export\s+)?DEVFLOW_API_TOKEN=(.*)$", line)
        if m:
            return m.group(1).strip().strip("'\"")
    return ""


def fetch_active_design_reference_gate(
    agent_dir: str | os.PathLike[str],
    payload: dict,
    api_base: str = DEFAULT_API_BASE,
) -> dict:
    api_token = os.environ.get("DEVFLOW_API_TOKEN", "").strip() or _secrets_file_token()
    if not api_token:
        raise RuntimeError("DEVFLOW_API_TOKEN is unavailable")
    query_items: list[tuple[str, object]] = [
        ("workspacePath", str(Path(agent_dir).resolve())),
    ]
    native_session = payload.get("session_id")
    if isinstance(native_session, str) and SESSION_ID_RE.fullmatch(native_session):
        query_items.append(("sessionId", native_session))
    query_items.extend(("launcherPid", pid) for pid in _ancestor_pids())
    request = urllib.request.Request(
        f"{api_base.rstrip('/')}/api/design-references/active?{urllib.parse.urlencode(query_items)}",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {api_token}",
        },
    )
    # DevFlow stalls for 2-4 s under memory pressure (seen 2026-09-24). A 3 s
    # single attempt turned each stall into a fleet-wide refusal of every shell
    # command. Retry once; check_pre_tool_use owns the narrow timeout fallback.
    for attempt in range(GATE_LOOKUP_ATTEMPTS):
        try:
            with urllib.request.urlopen(request, timeout=GATE_LOOKUP_TIMEOUT_SECONDS) as response:
                if response.status != 200:
                    raise RuntimeError(f"active gate endpoint returned HTTP {response.status}")
                value = json.loads(response.read().decode("utf-8"))
            break
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt + 1 >= GATE_LOOKUP_ATTEMPTS:
                raise
    if not isinstance(value, dict) or value.get("status") not in {"none", "active"}:
        raise RuntimeError("active gate endpoint returned no explicit authoritative status")
    return value


def _artifact_from_active_response(agent_dir: str | os.PathLike[str], response: dict) -> dict:
    identity = response.get("identity")
    authorization = response.get("authorization")
    if not isinstance(identity, dict) or not isinstance(authorization, dict):
        raise GateArtifactError("active gate response is missing identity or authorization")
    artifact = {
        "version": 1,
        "boardId": authorization.get("boardId"),
        "channelId": authorization.get("channelId"),
        "revision": authorization.get("revision"),
        "boardFingerprint": authorization.get("boardFingerprint"),
        "selectionFingerprint": authorization.get("selectionFingerprint"),
        "participantId": identity.get("participantId"),
        "projectPath": identity.get("workspacePath"),
        "createdAt": response.get("createdAt"),
        "expiresAt": authorization.get("expiresAt"),
    }
    validated = _validate_gate_artifact(artifact)
    if str(Path(validated["projectPath"]).resolve()) != str(Path(agent_dir).resolve()):
        raise GateArtifactError("active gate response belongs to another workspace")
    return validated


_UNREACHABLE_ERRNOS = {errno.EHOSTUNREACH, errno.ENETUNREACH, errno.EHOSTDOWN}


def _is_transport_unavailable(error: BaseException) -> bool:
    """The server could not be reached at all, so its gate state is unknown.

    Covers a stalled lookup, a refused connection (DevFlow restarting), a failed
    name lookup and an unreachable host (DevFlow on another machine with the
    network down). HTTP errors (including 408/503/504) are server responses and
    never count.
    """
    if isinstance(error, urllib.error.HTTPError):
        return False
    if isinstance(error, urllib.error.URLError):
        reason = error.reason
        if isinstance(reason, str):
            return reason.strip().lower() == "timed out"
        return isinstance(reason, BaseException) and _is_transport_unavailable(reason)
    if isinstance(error, (TimeoutError, ConnectionError, socket.gaierror)):
        return True
    return isinstance(error, OSError) and error.errno in _UNREACHABLE_ERRNOS


def _gate_marker_is_absent(agent_dir: str | os.PathLike[str]) -> bool:
    # lstat retains dangling symlinks as markers. Do not treat malformed,
    # expired, selected, foreign-channel or unreadable artifacts as absence.
    try:
        gate_path(agent_dir).lstat()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return False


def _cache_matches_active(cache: dict, active: dict) -> bool:
    for field in (
        "boardId", "channelId", "revision", "boardFingerprint",
        "participantId", "projectPath", "createdAt", "expiresAt",
    ):
        if cache.get(field) != active.get(field):
            return False
    pinned = cache.get("selectionFingerprint")
    return pinned is None or pinned == active.get("selectionFingerprint")


def _validate_authorization(artifact: dict, authorization: object, now: datetime) -> GateDecision:
    if not isinstance(authorization, dict):
        return GateDecision(False, "design reference authorization response is malformed")
    exact_fields = {
        "boardId": artifact["boardId"],
        "channelId": artifact["channelId"],
        "revision": artifact["revision"],
        "boardFingerprint": artifact["boardFingerprint"],
        "createdByParticipantId": artifact["participantId"],
    }
    for field, expected in exact_fields.items():
        if authorization.get(field) != expected:
            return GateDecision(False, f"design reference authorization {field} does not match the active gate")
    expires_at = _parse_iso(authorization.get("expiresAt"))
    if expires_at is None or now.astimezone(timezone.utc) >= expires_at:
        return GateDecision(False, "design reference authorization is expired or missing expiry")
    state = authorization.get("state")
    if state != "selected" or authorization.get("implementationUnlocked") is not True:
        return GateDecision(False, f"design reference gate is {state or 'unavailable'}, not selected")
    selection = authorization.get("selectionFingerprint")
    if not isinstance(selection, str) or not SHA256_RE.fullmatch(selection):
        return GateDecision(False, "design reference selection fingerprint is missing or invalid")
    pinned = artifact.get("selectionFingerprint")
    if pinned is not None and pinned != selection:
        return GateDecision(False, "design reference selection fingerprint changed after authorization")
    return GateDecision(True, selection)


def check_pre_tool_use(
    agent_dir: str | os.PathLike[str],
    payload: object,
    *,
    fetch_active_gate: Callable[[str | os.PathLike[str], dict], dict] | None = None,
    now: datetime | None = None,
) -> GateDecision:
    payload_is_valid = isinstance(payload, dict) and isinstance(payload.get("tool_name"), str)
    if not isinstance(payload, dict):
        payload = {}
    if not payload_is_valid:
        return GateDecision(False, "design reference hook input is missing the tool identity")
    if not is_mutation_capable(payload):
        return GateDecision(True, "tool is a native inspection tool or sanctioned gate helper")

    active_fetch = fetch_active_gate or fetch_active_design_reference_gate
    try:
        active_response = active_fetch(agent_dir, payload)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError, urllib.error.URLError) as error:
        if _is_transport_unavailable(error) and _gate_marker_is_absent(agent_dir):
            return GateDecision(True, "DevFlow unreachable for the design reference lookup and no local gate marker; retry on next tool")
        return GateDecision(False, f"active design reference gate lookup is unavailable: {error}")
    except Exception as error:
        return GateDecision(False, f"active design reference gate lookup failed: {error}")
    if not isinstance(active_response, dict):
        return GateDecision(False, "active design reference gate response is malformed")
    if active_response.get("status") == "none":
        return GateDecision(True, "authenticated server reports no active design reference gate")
    if active_response.get("status") != "active":
        return GateDecision(False, "active design reference gate response is ambiguous")
    try:
        authoritative = _artifact_from_active_response(agent_dir, active_response)
    except GateArtifactError as error:
        return GateDecision(False, f"active design reference gate identity is invalid: {error}")
    try:
        artifact = load_gate_artifact(agent_dir)
    except GateArtifactError:
        artifact = None
    if artifact is None or not _cache_matches_active(artifact, authoritative):
        try:
            write_gate_artifact(agent_dir, authoritative)
        except (OSError, ValueError) as error:
            return GateDecision(False, f"could not rehydrate the active gate cache: {error}")
        return GateDecision(False, "local gate cache was missing or replaced and has been rehydrated")
    authorization = active_response.get("authorization")

    decision = _validate_authorization(
        artifact,
        authorization,
        now or datetime.now(timezone.utc),
    )
    if not decision.allowed:
        return decision
    selection_fingerprint = decision.reason
    if artifact.get("selectionFingerprint") is None:
        artifact["selectionFingerprint"] = selection_fingerprint
        try:
            write_gate_artifact(agent_dir, artifact)
        except (OSError, ValueError) as error:
            return GateDecision(False, f"could not pin the design reference selection fingerprint: {error}")
    return GateDecision(True, "exact selected design reference tuple is authorized")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Block implementation mutations while a design board awaits selection")
    parser.add_argument("--agent-dir", default=os.getcwd())
    parser.add_argument("--api-base", default=DEFAULT_API_BASE, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    decision = check_pre_tool_use(
        args.agent_dir,
        payload,
        fetch_active_gate=lambda agent_dir, hook_payload: fetch_active_design_reference_gate(
            agent_dir,
            hook_payload,
            api_base=args.api_base,
        ),
    )
    if decision.allowed:
        return 0
    print(
        "DESIGN_REFERENCE_GATE_BLOCKED: "
        f"{decision.reason}. Wait for an exact current use/combine selection, or use the sanctioned "
        "design_reference_board.py helper to post the requested refinement.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
