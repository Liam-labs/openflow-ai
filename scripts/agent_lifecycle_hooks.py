"""One canonical lifecycle-hook policy for provisioning and fleet rollout."""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path


DEVFLOW_DIR = Path(os.environ.get("DEVFLOW_HOME") or os.path.join(os.path.expanduser("~"), "DevFlow"))
DESIGN_GATE_MATCHER = (
    "Bash|Write|Edit|NotebookEdit|Task|Agent|.*write.*|.*edit.*|.*patch.*|"
    ".*delete.*|.*move.*|.*copy.*|.*create.*|.*rename.*|.*mkdir.*|"
    ".*install.*|.*deploy.*|.*delegate.*|.*spawn.*|.*shell.*|.*exec.*"
)


def portable(command: str, hooks_dir: Path) -> str:
    """Run a hook command from WSL or Windows Claude Code alike.

    Windows (PowerShell) agents run hooks through Git Bash, which cannot see
    /home/..., so there the command is handed to WSL via hook-env.sh, which
    loads the secrets an agent session has. MSYS_NO_PATHCONV stops Git Bash
    rewriting /home/... arguments into C:/Program Files/Git/home/...
    """
    launcher = hooks_dir / "hook-env.sh"
    return (
        f"bash -c 'if [ -e {launcher} ]; then exec \"$@\"; "
        f"else MSYS_NO_PATHCONV=1 exec wsl.exe -e {launcher} \"$@\"; fi' _ {command}"
    )


def build_hooks(agent_name: str, agent_dir: str | Path) -> dict:
    """Return the current safety and lifecycle hooks for one Claude workspace."""
    directory = str(agent_dir)
    quoted_dir = shlex.quote(directory)
    quoted_name = shlex.quote(agent_name)
    hooks_dir = DEVFLOW_DIR / "scripts" / "hooks"
    return _portable_hooks(hooks_dir, {
        "PreToolUse": [{
            "matcher": DESIGN_GATE_MATCHER,
            "hooks": [{
                "type": "command",
                "command": f"python3 {hooks_dir}/design_reference_gate.py --agent-dir {quoted_dir}",
            }],
        }, {
            # Pre-empts Claude Code's bypass-immune dangerous-rm prompt, which
            # otherwise leaves an unattended agent waiting on a dialog.
            "matcher": "Bash",
            "hooks": [{
                "type": "command",
                "command": f"python3 {hooks_dir}/rm_guard.py",
            }],
        }],
        "SessionStart": [
            {
                "matcher": "compact",
                "hooks": [{
                    "type": "command",
                    "command": f"bash {hooks_dir}/post-compact-reinject.sh {quoted_dir}",
                }],
            },
            {"hooks": [{
                "type": "command",
                "command": f"bash {hooks_dir}/session-scratch-init.sh {quoted_name} {quoted_dir}",
            }]},
        ],
        # pre-compact-write owns flush-before-atomic-snapshot ordering.
        "PreCompact": [{"hooks": [{
            "type": "command",
            "command": f"bash {hooks_dir}/pre-compact-write.sh {quoted_name} {quoted_dir}",
        }]}],
        # An ordinary Stop event may flush selective buffers, but never writes
        # a session marker or replaces handoff state.
        "Stop": [{"hooks": [{
            "type": "command",
            "command": f"bash {hooks_dir}/flush.sh {quoted_name} {quoted_dir} all",
        }]}],
    })


def _portable_hooks(hooks_dir: Path, hooks: dict) -> dict:
    for blocks in hooks.values():
        for block in blocks:
            for hook in block["hooks"]:
                hook["command"] = portable(hook["command"], hooks_dir)
    return hooks


def keep_lifecycle_command(event: str, command: str) -> bool:
    """Drop obsolete writers while preserving unrelated command hooks."""
    command_parts = shlex.split(command)
    command_paths = {part.rsplit("/", 1)[-1] for part in command_parts}
    if event == "Stop" and {"write-session-end.sh", "session-end.sh"} & command_paths:
        return False
    if event == "PreCompact" and "flush.sh" in command_paths:
        return False
    return True


OBSOLETE_BEHAVIOURAL_COMMANDS = {
    "check-rotate.sh",
    "context-inject.py",
    "context-health-sample.py",
    "scratch-flush-counter.sh",
    "frontend-design-reminder.sh",
    "verify-task-complete.sh",
}

MANAGED_LIFECYCLE_COMMANDS = {
    "PreToolUse": {"design_reference_gate.py", "rm_guard.py"},
    "SessionStart": {"post-compact-reinject.sh", "session-scratch-init.sh"},
    "PreCompact": {"pre-compact-write.sh"},
    "Stop": {"flush.sh"},
}


def is_obsolete_behavioural_hook(event: str, hook: dict) -> bool:
    """Identify the specific historical hooks this migration is allowed to remove."""
    hook_type = hook.get("type")
    command = hook.get("command", "")
    if hook_type == "command":
        command_paths = {part.rsplit("/", 1)[-1] for part in shlex.split(command)}
        if event in {"UserPromptSubmit", "TaskCompleted"}:
            return bool(command_paths & OBSOLETE_BEHAVIOURAL_COMMANDS)
        return event in {"Stop", "PreCompact"} and not keep_lifecycle_command(event, command)
    if hook_type != "prompt" or event != "Stop":
        return False
    prompt = hook.get("prompt", "").casefold()
    return (
        "append a log entry" in prompt
        or "mandatory log" in prompt
        or "missing log" in prompt
        or ".session-scratch/journal.md" in prompt
    )


def is_managed_lifecycle_hook(event: str, hook: dict) -> bool:
    """Identify canonical hook families whose arguments must match this workspace."""
    if hook.get("type") != "command":
        return False
    command_paths = {
        part.rsplit("/", 1)[-1]
        for part in shlex.split(hook.get("command", ""))
    }
    return bool(command_paths & MANAGED_LIFECYCLE_COMMANDS.get(event, set()))


def remove_behavioural_hooks(current: dict) -> dict:
    """Remove only known obsolete hooks; retain unknown safety hooks verbatim."""
    cleaned: dict[str, list[dict]] = {}
    for event, blocks in current.items():
        clean_blocks = []
        for block in blocks:
            kept = [
                hook for hook in block.get("hooks", [])
                if not is_obsolete_behavioural_hook(event, hook)
            ]
            if kept:
                clean_blocks.append({**block, "hooks": kept})
        if clean_blocks:
            cleaned[event] = clean_blocks
    return cleaned


def merge_session_hooks(current: dict, required: dict) -> dict:
    """Merge canonical lifecycle hooks without deleting unrelated safety hooks."""
    cleaned = remove_behavioural_hooks(current)
    merged: dict[str, list[dict]] = {
        event: blocks
        for event, blocks in cleaned.items()
        if event not in {"PreToolUse", "SessionStart", "PreCompact", "Stop"}
    }
    for event in ("PreToolUse", "SessionStart", "PreCompact", "Stop"):
        blocks: list[dict] = []
        seen_hooks: set[str] = set()
        for source, replace_managed in (
            (cleaned.get(event, []), True),
            (required.get(event, []), False),
        ):
            for block in source:
                kept = []
                for hook in block.get("hooks", []):
                    if replace_managed and is_managed_lifecycle_hook(event, hook):
                        continue
                    fingerprint = json.dumps(hook, sort_keys=True, ensure_ascii=False)
                    if fingerprint in seen_hooks:
                        continue
                    seen_hooks.add(fingerprint)
                    kept.append(hook)
                if kept:
                    blocks.append({**block, "hooks": kept})
        if blocks:
            merged[event] = blocks
    return merged
