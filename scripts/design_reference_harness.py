#!/usr/bin/env python3
"""Native harness wiring for the Design Reference execution gate.

Claude owns its own ``PreToolUse`` configuration.  Codex and Antigravity are
launched by DevFlow wrappers, so those wrappers use this module to install the
same server-backed gate at each harness's native pre-tool boundary.
"""

from __future__ import annotations

import json
import os
import hashlib
import re
import shlex
import tempfile
from pathlib import Path


DEVFLOW_DIR = Path(os.environ.get("DEVFLOW_HOME") or str(Path.home() / "DevFlow"))
DESIGN_GATE_SCRIPT = (
    DEVFLOW_DIR / "scripts" / "hooks" / "design_reference_gate_codex.py"
)
ANTIGRAVITY_GATE_SCRIPT = (
    DEVFLOW_DIR / "scripts" / "hooks" / "design_reference_gate_antigravity.py"
)
ANTIGRAVITY_HOOK_NAME = "devflow-design-reference-gate"
CODEX_MANAGED_RELEASE_RE = re.compile(
    r"^/etc/codex/devflow-hooks/releases/([a-f0-9]{20})$"
)
CODEX_MANAGED_PYTHON = "/usr/bin/python3"
DEVFLOW_URL = __import__("os").environ.get("DEVFLOW_URL", "http://127.0.0.1:3000").rstrip("/")
CODEX_MANAGED_API_BASE = f"{DEVFLOW_URL}"
CODEX_MANAGED_GATE_MODE_ENV = "DEVFLOW_CODEX_MANAGED_GATE_MODE"
CODEX_MANAGED_GATE_MODES = frozenset({"disabled", "required"})


def codex_managed_gate_required(environ: object | None = None) -> bool:
    """Return whether the root-owned gate is an active host requirement.

    Provisioning and activation are deliberately separate.  A host that has
    never installed ``/etc/codex`` defaults to ``disabled`` and can still
    launch Codex agents.  Once an operator sets the mode to ``required``, all
    wrappers fail closed if the protected policy is absent or invalid.

    Unknown values are rejected so a typo cannot silently weaken an activated
    deployment.
    """
    source = os.environ if environ is None else environ
    if not hasattr(source, "get"):
        raise TypeError("environ must provide a get() method")
    raw_mode = source.get(CODEX_MANAGED_GATE_MODE_ENV, "disabled")
    mode = str(raw_mode).strip().lower()
    if mode not in CODEX_MANAGED_GATE_MODES:
        expected = ", ".join(sorted(CODEX_MANAGED_GATE_MODES))
        raise RuntimeError(
            f"{CODEX_MANAGED_GATE_MODE_ENV} must be one of: {expected}; got {raw_mode!r}"
        )
    return mode == "required"


def _gate_command(script: Path, agent_dir: str | os.PathLike[str]) -> str:
    return " ".join(
        (
            "python3",
            shlex.quote(str(script)),
            "--agent-dir",
            shlex.quote(str(Path(agent_dir).resolve())),
        )
    )


def codex_design_gate_args(agent_dir: str | os.PathLike[str]) -> list[str]:
    """Return config that cannot recreate the rejected session-hook lane.

    The root-owned requirements policy pins hooks on.  Keeping this one benign
    feature request is useful for pre-install diagnostics, but no hook
    definition or trust bypass is accepted from wrapper/session flags.
    """
    del agent_dir
    return ["-c", "features.hooks=true"]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_protected_path(
    path: Path,
    *,
    expected_owner_uid: int,
    directory: bool,
) -> None:
    try:
        stat_result = path.lstat()
    except OSError as error:
        raise RuntimeError(f"Codex managed protected path is unavailable: {path}") from error
    if path.is_symlink() or stat_result.st_uid != expected_owner_uid:
        raise RuntimeError(f"Codex managed protected path has unsafe ownership: {path}")
    if stat_result.st_mode & 0o022:
        raise RuntimeError(f"Codex managed protected path is group/world writable: {path}")
    if directory != path.is_dir():
        raise RuntimeError(f"Codex managed protected path has the wrong type: {path}")


def _validate_protected_directory_chain(
    root: Path,
    target: Path,
    *,
    expected_owner_uid: int,
) -> None:
    try:
        relative = target.absolute().relative_to(root)
    except ValueError as error:
        raise RuntimeError("Codex managed path escapes the protected filesystem root") from error
    current = root
    _validate_protected_path(
        current,
        expected_owner_uid=expected_owner_uid,
        directory=True,
    )
    for part in relative.parts:
        current = current / part
        _validate_protected_path(
            current,
            expected_owner_uid=expected_owner_uid,
            directory=True,
        )


def _validate_codex_managed_release(
    managed_dir: str,
    expected_command: str,
    *,
    filesystem_root: str | os.PathLike[str],
    expected_owner_uid: int,
) -> None:
    release_match = CODEX_MANAGED_RELEASE_RE.fullmatch(managed_dir)
    if not release_match:
        raise RuntimeError("Codex managed hook directory is outside the protected release root")
    release_id = release_match.group(1)
    root = Path(filesystem_root).resolve()
    release = root / managed_dir.lstrip("/")
    manifest_path = release / "manifest.json"
    _validate_protected_directory_chain(
        root,
        release,
        expected_owner_uid=expected_owner_uid,
    )
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as error:
        raise RuntimeError(f"Codex managed hook manifest is unreadable: {error}") from error
    if manifest.get("releaseId") != release_id or manifest.get("command") != expected_command:
        raise RuntimeError("Codex managed hook manifest identity does not match policy")
    files = manifest.get("files")
    if not isinstance(files, dict) or set(files) != {
        "design_reference_gate.py",
        "design_reference_gate_wrapper.py",
        "design_reference_gate_codex.py",
    }:
        raise RuntimeError("Codex managed hook manifest file set is invalid")
    for current in [manifest_path, *(release / name for name in files)]:
        _validate_protected_path(
            current,
            expected_owner_uid=expected_owner_uid,
            directory=False,
        )
    for name, expected_hash in files.items():
        if (
            not isinstance(expected_hash, str)
            or re.fullmatch(r"[a-f0-9]{64}", expected_hash) is None
            or _sha256_file(release / name) != expected_hash
        ):
            raise RuntimeError(f"Codex managed hook payload hash mismatch: {name}")


def validate_codex_managed_gate_policy(
    *,
    filesystem_root: str | os.PathLike[str] = "/",
    expected_owner_uid: int = 0,
) -> str:
    """Validate the protected on-disk policy used by the PTY launch path."""
    import tomllib

    root = Path(filesystem_root).resolve()
    policy_path = root / "etc/codex/requirements.toml"
    _validate_protected_directory_chain(
        root,
        policy_path.parent,
        expected_owner_uid=expected_owner_uid,
    )
    try:
        policy = tomllib.loads(policy_path.read_text(encoding="utf-8"))
    except Exception as error:
        raise RuntimeError(f"Codex managed requirements are unreadable: {error}") from error
    _validate_protected_path(
        policy_path,
        expected_owner_uid=expected_owner_uid,
        directory=False,
    )
    if policy.get("allow_managed_hooks_only") is True:
        raise RuntimeError("Codex managed policy unexpectedly disables unrelated hooks")
    if not isinstance(policy.get("features"), dict) or policy["features"].get("hooks") is not True:
        raise RuntimeError("Codex managed requirements do not pin hooks=true")
    hooks = policy.get("hooks")
    if not isinstance(hooks, dict) or not isinstance(hooks.get("managed_dir"), str):
        raise RuntimeError("Codex managed hook requirements are absent")
    managed_dir = hooks["managed_dir"]
    expected_command = (
        f"{CODEX_MANAGED_PYTHON} {managed_dir}/design_reference_gate_codex.py "
        f"--api-base {CODEX_MANAGED_API_BASE}"
    )
    matches = []
    for block in hooks.get("PreToolUse", []):
        if not isinstance(block, dict) or block.get("matcher") != "*":
            continue
        for hook in block.get("hooks", []):
            if (
                isinstance(hook, dict)
                and hook.get("type") == "command"
                and hook.get("command") == expected_command
                and hook.get("timeout") == 10
                and hook.get("async", False) is False
            ):
                matches.append(hook)
    if len(matches) != 1:
        raise RuntimeError("Codex requirements do not contain exactly one managed DevFlow gate")
    _validate_codex_managed_release(
        managed_dir,
        expected_command,
        filesystem_root=root,
        expected_owner_uid=expected_owner_uid,
    )
    return expected_command


def validate_codex_managed_gate_if_required(
    *,
    filesystem_root: str | os.PathLike[str] = "/",
    expected_owner_uid: int = 0,
    environ: object | None = None,
) -> str | None:
    """Validate activated policy while leaving unprovisioned hosts runnable."""
    if not codex_managed_gate_required(environ):
        return None
    return validate_codex_managed_gate_policy(
        filesystem_root=filesystem_root,
        expected_owner_uid=expected_owner_uid,
    )


def validate_codex_managed_gate_preflight(
    requirements_result: object,
    hooks_result: object,
    cwd: str | os.PathLike[str],
    *,
    filesystem_root: str | os.PathLike[str] = "/",
    expected_owner_uid: int = 0,
) -> str:
    """Validate the exact protected managed hook and return its command."""
    if not isinstance(requirements_result, dict):
        raise RuntimeError("Codex managed requirements response is malformed")
    requirements = requirements_result.get("requirements")
    if not isinstance(requirements, dict):
        raise RuntimeError("Codex managed requirements are absent")
    features = requirements.get("featureRequirements")
    if not isinstance(features, dict) or features.get("hooks") is not True:
        raise RuntimeError("Codex managed requirements do not pin hooks=true")
    if requirements.get("allowManagedHooksOnly") is True:
        raise RuntimeError("Codex managed policy unexpectedly disables unrelated hooks")
    managed_hooks = requirements.get("hooks")
    if not isinstance(managed_hooks, dict):
        raise RuntimeError("Codex managed hook requirements are absent")
    managed_dir = managed_hooks.get("managedDir")
    if not isinstance(managed_dir, str):
        raise RuntimeError("Codex managed hook directory is missing")
    if not CODEX_MANAGED_RELEASE_RE.fullmatch(managed_dir):
        raise RuntimeError("Codex managed hook directory is outside the protected release root")
    expected_command = (
        f"{CODEX_MANAGED_PYTHON} {managed_dir}/design_reference_gate_codex.py "
        f"--api-base {CODEX_MANAGED_API_BASE}"
    )

    disk_command = validate_codex_managed_gate_policy(
        filesystem_root=filesystem_root,
        expected_owner_uid=expected_owner_uid,
    )
    if disk_command != expected_command:
        raise RuntimeError("Codex effective managed gate differs from protected disk policy")

    requirement_matches = []
    for block in managed_hooks.get("PreToolUse", []):
        if not isinstance(block, dict) or block.get("matcher") != "*":
            continue
        for hook in block.get("hooks", []):
            if (
                isinstance(hook, dict)
                and hook.get("type") == "command"
                and hook.get("command") == expected_command
                and hook.get("timeoutSec") == 10
                and hook.get("async") is False
            ):
                requirement_matches.append(hook)
    if len(requirement_matches) != 1:
        raise RuntimeError("Codex requirements do not contain exactly one managed DevFlow gate")

    if not isinstance(hooks_result, dict):
        raise RuntimeError("Codex hooks discovery response is malformed")
    canonical_cwd = os.path.realpath(cwd)
    discovered = []
    for row in hooks_result.get("data", []):
        if not isinstance(row, dict) or os.path.realpath(str(row.get("cwd", ""))) != canonical_cwd:
            continue
        for hook in row.get("hooks", []):
            if (
                isinstance(hook, dict)
                and hook.get("eventName") == "preToolUse"
                and hook.get("matcher") == "*"
                and hook.get("command") == expected_command
                and hook.get("source") == "system"
                and hook.get("sourcePath") == managed_dir
                and hook.get("enabled") is True
                and hook.get("isManaged") is True
                and hook.get("trustStatus") == "managed"
            ):
                discovered.append(hook)
    if len(discovered) != 1:
        raise RuntimeError("Codex did not discover exactly one managed and trusted DevFlow gate")

    _validate_codex_managed_release(
        managed_dir,
        expected_command,
        filesystem_root=filesystem_root,
        expected_owner_uid=expected_owner_uid,
    )
    return expected_command


def antigravity_design_gate_definition(
    agent_dir: str | os.PathLike[str],
) -> dict:
    """Return Antigravity's namespaced native hook definition."""
    return {
        "enabled": True,
        "PreToolUse": [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": _gate_command(
                            ANTIGRAVITY_GATE_SCRIPT,
                            agent_dir,
                        ),
                        "timeout": 10,
                    }
                ],
            }
        ],
    }


def ensure_antigravity_design_gate_hook(
    agent_dir: str | os.PathLike[str],
) -> Path:
    """Atomically merge the DevFlow gate into ``.agents/hooks.json``.

    Existing named hooks are preserved byte-for-byte at the data level.  A
    malformed existing file is a hard error: launching Antigravity without a
    known-good native mutation gate would be a fail-open condition.
    """
    root = Path(agent_dir).resolve()
    target = root / ".agents" / "hooks.json"
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists():
        try:
            value = json.loads(target.read_text(encoding="utf-8"))
        except Exception as error:
            raise RuntimeError(
                f"cannot install Antigravity design gate: {target} is invalid: {error}"
            ) from error
        if not isinstance(value, dict):
            raise RuntimeError(
                f"cannot install Antigravity design gate: {target} must contain an object"
            )
    else:
        value = {}

    expected = antigravity_design_gate_definition(root)
    if value.get(ANTIGRAVITY_HOOK_NAME) == expected:
        return target
    value[ANTIGRAVITY_HOOK_NAME] = expected

    fd, temporary = tempfile.mkstemp(prefix=".hooks.json.", dir=target.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
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
