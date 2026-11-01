#!/usr/bin/env python3
"""
Global Scaffolding Sync Engine

Single source of truth for SG-1 agent scaffolding files.
Reads manifest.json + agents.json, renders templates, and deploys files.

Usage:
    python3 sync.py                           # Full sync — all agents, all files
    python3 sync.py --dry-run                 # Show what would change, no writes
    python3 sync.py --check                   # Report drift only (no fixes)
    python3 sync.py --agent Daniel            # Sync one agent
    python3 sync.py --file user-profile       # Sync one manifest entry
    python3 sync.py --new-agent "Name" --role "Role" --models "claude,gemini"
"""

import argparse
import hashlib
import json
import socket
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Adapter layer — per-model scaffolding strategy + auto-import injection.
# See docs/scaffolding-audit-matrix.md §6 for the design.
# Import is at module level (no I/O) so the import cost is paid once.
sys.path.insert(0, str(Path(__file__).parent))
from adapters import (  # noqa: E402
    adapter_for_entry_template,
    ensure_imports,
    select_adapters_for,
    ADAPTER_REGISTRY,
)

SCAFFOLDING_DIR = Path(__file__).parent
MASTERS_DIR = SCAFFOLDING_DIR / "masters"
MANIFEST_PATH = SCAFFOLDING_DIR / "manifest.json"
AGENTS_PATH = Path(os.environ.get('DEVFLOW_HOME') or str(Path.home() / 'DevFlow')) / ".AppData" / "scaffolding" / "agents.json"
MODELS_PATH = Path(os.environ.get('DEVFLOW_HOME') or str(Path.home() / 'DevFlow')) / "data" / "models.json"
TEAMS_PATH = SCAFFOLDING_DIR / "teams.json"
if not TEAMS_PATH.exists():
    # A fresh install has no shipped team list; scripts/rollout-agent-dirs.py creates this one on first use.
    TEAMS_PATH = Path(os.environ.get('DEVFLOW_HOME') or str(Path.home() / 'DevFlow')) / ".AppData" / "scaffolding" / "teams.json"
CONFIG_PATH = SCAFFOLDING_DIR / "scaffolding-config.json"
DRIFT_COOLDOWN_FILE = Path("/tmp/drift-alert-cooldown.json")
DRIFT_COOLDOWN_SECONDS = 300  # 5-minute cooldown for repeat drift alerts

#: Central sync run log — one JSONL line per sync.py invocation. Tail-read
#: by /api/scaffolding/manifest to populate the X-Ray syncLog field. Bounded
#: rotation at SYNC_EVENTS_MAX_BYTES; older events get moved to .1 atomically.
SYNC_EVENTS_PATH = Path(
    os.environ.get('SCAFFOLDING_SYNC_EVENTS_PATH',
                    os.path.expanduser('~/DevFlow/.AppData/scaffolding-sync-events.jsonl'))
)
SYNC_EVENTS_MAX_BYTES = int(os.environ.get('SCAFFOLDING_SYNC_EVENTS_MAX_BYTES', str(5 * 1024 * 1024)))


def load_machine_config() -> dict:
    """Load machine-level scaffolding config. Falls back to hardcoded defaults."""
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text()).get("machine", {})
        except Exception:
            pass
    _home = str(Path.home())
    _devflow = os.environ.get('DEVFLOW_HOME', f'{_home}/DevFlow')
    return {
        "homeDir": _home,
        "devflowDir": _devflow,
        "claudeProjectsDir": f"{_home}/.claude/projects",
        "collabHelper": f"{_devflow}/scripts/collab_helper.py",
        "checkRotateScript": f"{_devflow}/scripts/check-rotate.sh",
    }


_MACHINE_CONFIG = load_machine_config()
COLLAB_HELPER = _MACHINE_CONFIG["collabHelper"]
_DEVFLOW_DATA = Path(_MACHINE_CONFIG["devflowDir"]) / "data"
# AppData base mirrors lib/data-paths.ts:20 (DEVFLOW_APP_DATA_DIR override,
# default '.AppData'). Pre-AppData-refactor code put collab-channels.json
# under data/, but the live file lives in .AppData/. Without honouring the
# env var, _CHANNELS_PATH was permanently stale → check_model_drift()
# silently returned [] and Fix 3 (presence discovery) couldn't find any
# roster entries. Reynolds 2026-05-27.
_APP_DATA_DIR = os.environ.get('DEVFLOW_APP_DATA_DIR') or os.environ.get('DEVFLOW_DATA_DIR') or '.AppData'
_DEVFLOW_APPDATA = Path(_MACHINE_CONFIG["devflowDir"]) / _APP_DATA_DIR
_CHANNELS_PATH = _DEVFLOW_APPDATA / "collab-channels.json"
_CONFIGURED_MODELS_PATH = _DEVFLOW_APPDATA / "configuredModels.json"
_ROLES_PATH = _DEVFLOW_DATA / "roles" / "roles.json"
_ROLES_DIR = _DEVFLOW_DATA / "roles"
_PERSONALITIES_DIR = _ROLES_DIR / "personalities"

# Exact hashes of canonical identity files that this migration superseded.
# A deployed frozen copy with one of these hashes is safe to replace with a
# live pointer; arbitrary project prose is not.  Keys name the *current*
# canonical source, even where the historical personality lived under the
# former ``personalities/examples`` directory.
def _load_legacy_identity_hashes() -> dict[str, frozenset[str]]:
    """Hashes from legacy-identity-hashes.json beside this file; absent on an installation that never had those copies."""
    try:
        raw = json.loads((Path(__file__).resolve().parent / "legacy-identity-hashes.json").read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return {key: frozenset(values) for key, values in raw.items()}


_LEGACY_IDENTITY_SHA256: dict[str, frozenset[str]] = _load_legacy_identity_hashes()


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_teams() -> dict:
    """Return map of teamId -> team info."""
    if not TEAMS_PATH.exists():
        raise FileNotFoundError(f"teams.json not found at {TEAMS_PATH}. Cannot render templates without team configuration.")
    try:
        data = json.loads(TEAMS_PATH.read_text())
        return {t["id"]: t for t in data.get("teams", [])}
    except Exception as e:
        raise RuntimeError(f"Failed to parse {TEAMS_PATH}: {e}")

def load_manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text())


def load_agents() -> list[dict]:
    return json.loads(AGENTS_PATH.read_text())["agents"]


def load_models() -> set[str]:
    """Return set of model provider names known to the scaffolding system.

    Three sources are merged (so `model:<name>` conditions don't false-warn):
      1. `agentTypes` entries in models.json — captures wrapper-classified
         names (claude, gemini, grok, codex, antigravity, ollama).
      2. `provider` field on each models.json entry — captures providers
         whose agents run via someone else's wrapper, e.g. deepseek which
         has provider='deepseek' but agentTypes=['claude','claude-terminal'].
      3. Every distinct entry in `agent.models[]` across agents.json —
         catches model names declared on agent records but absent from the
         central registry (e.g. gpt-5.4 today). Keeps the validation honest
         while we wait for a model registry entry to land.
    """
    providers: set[str] = set()
    if MODELS_PATH.exists():
        try:
            data = json.loads(MODELS_PATH.read_text())
            for m in data.get("models", []):
                for agent_type in m.get("agentTypes", []):
                    providers.add(agent_type.split("-")[0].lower())
                if m.get("provider"):
                    providers.add(str(m["provider"]).lower())
        except Exception:
            providers.update({"claude", "gemini", "grok"})
    else:
        providers.update({"claude", "gemini", "grok"})

    # Source 3 — agents.json declared models. Best-effort, non-fatal.
    try:
        agent_data = json.loads(AGENTS_PATH.read_text()) if AGENTS_PATH.exists() else {}
        for a in agent_data.get("agents", []):
            for mname in a.get("models", []) or []:
                if mname:
                    providers.add(str(mname).lower())
    except Exception:
        pass

    return providers


# ---------------------------------------------------------------------------
# Template rendering
# ---------------------------------------------------------------------------

def _devflow_env_value(name: str) -> str:
    """A non-secret DevFlow setting: the process environment first, then ~/.config/devflow/env (KEY=VALUE lines)."""
    value = os.environ.get(name, "").strip()
    if value:
        return value
    try:
        for line in (Path.home() / ".config" / "devflow" / "env").read_text().splitlines():
            key, sep, val = line.strip().removeprefix("export ").partition("=")
            if sep and key.strip() == name:
                return val.strip().strip("'\"")
    except OSError:
        pass
    return ""


def _is_global_owner(agent: dict) -> bool:
    """Global ~ targets are deployed once, by the team lead named in DEVFLOW_LEAD_NAME; with none set every agent may."""
    lead = _devflow_env_value("DEVFLOW_LEAD_NAME")
    return not lead or agent.get("name") == lead


def _people_vars() -> dict[str, str]:
    """Who the owner, architect and team lead are. Unset, the rules use neutral role wording instead of names."""
    owner = _devflow_env_value("DEVFLOW_OWNER_NAME")
    architect = _devflow_env_value("DEVFLOW_ARCHITECT_NAME")
    lead = _devflow_env_value("DEVFLOW_LEAD_NAME")
    return {
        "OWNER_NAME": owner or "the owner",
        "ARCHITECT_NAME": architect or "the Architect",
        "LEAD_NAME": lead or "the Team Lead",
        "ARCHITECT_LABEL": f"{architect} (Architect)" if architect else "the Architect",
        "LEAD_LABEL": f"{lead} (Team Lead)" if lead else "the Team Lead",
    }


PLAIN_MASTER_VARS = ("OWNER_NAME", "ARCHITECT_NAME", "LEAD_NAME", "ARCHITECT_LABEL", "LEAD_LABEL", "COLLAB_HELPER")


def build_vars(agent: dict, teams: dict) -> dict[str, str]:
    """Build {{VAR}} substitution map for an agent."""
    team_id = agent.get("teamId", "sg1")
    team = teams.get(team_id)
    if not team:
        raise ValueError(f"Agent '{agent['name']}' has unknown teamId '{team_id}'. Check teams.json.")
    
    project_dir = agent.get("projectDir", team["projectDir"])
    # If agent paths are not in dict, derive them from team base
    agent_dir = agent.get("agentDir")
    if not agent_dir:
        agent_dir = str(Path(project_dir) / agent["name"])

    team_dir = agent.get("teamDir")
    if not team_dir:
        team_dir = str(Path(team["teamDir"]) / agent["name"])

    # Use the same memory lookup order as the Codex startup loader. Never seed
    # a blank canonical record over an existing workspace-local memory fallback.
    canonical_memory = (Path(_MACHINE_CONFIG["homeDir"]) / ".claude" / "projects"
                        / team_dir.replace("/", "-") / "memory" / "MEMORY.md")
    local_memory = Path(team_dir) / "MEMORY.md"
    memory_path = local_memory if not canonical_memory.exists() and local_memory.exists() else canonical_memory

    return {
        **_people_vars(),
        "AGENT_MEMORY_PATH": str(memory_path),
        "AGENT_NAME": agent["name"],
        "AGENT_ROLE": agent.get("role", ""),
        "AGENT_DOMAIN": agent.get("domain", ""),
        # AGENT_DIR = agent's actual working directory (team_dir/name, not projectDir/name)
        "AGENT_DIR": team_dir,
        "TEAM_DIR": team_dir,
        "PROJECT_DIR": project_dir,
        "LOG_PATH": f"{team_dir}/logs",
        "AGENT_LOGS_PATH": f"{team_dir}/logs",
        # Project key derived from actual working dir so MEMORY.md path resolves correctly
        "AGENT_PROJECT_KEY": team_dir.replace("/", "-"),
        "COLLAB_HELPER": _MACHINE_CONFIG["collabHelper"],
        "CHECK_ROTATE_SCRIPT": _MACHINE_CONFIG["checkRotateScript"],
        "DEVFLOW_DIR": _MACHINE_CONFIG["devflowDir"],
        "HOME_DIR": _MACHINE_CONFIG["homeDir"],
    }


def drop_roster_aliases(agents: list[dict], teams: dict) -> list[dict]:
    """Drop roster entries whose home dir is a symlink to another agent's home.

    A renamed agent can leave its old name in the roster with the old dir
    symlinked to the new one (SG-1/Team/CJack -> Riley). Syncing the old name
    then writes its own identity (CJack paths, hooks, Workspace.md) into the
    live agent's files. The entry that owns the real directory wins.
    """
    homes: dict[str, str] = {}
    for agent in agents:
        try:
            homes[agent["name"]] = build_vars(agent, teams)["AGENT_DIR"]
        except Exception:
            continue
    owners = {
        os.path.realpath(home): name
        for name, home in homes.items()
        if not Path(home).is_symlink()
    }
    kept = []
    for agent in agents:
        home = homes.get(agent["name"])
        owner = owners.get(os.path.realpath(home)) if home and Path(home).is_symlink() else None
        if owner and owner != agent["name"]:
            print(f"  · skipping {agent['name']}: {home} is an alias of {owner}'s directory")
            continue
        kept.append(agent)
    return kept


def agent_home_dirs(agents: list[dict], teams: dict) -> list[str]:
    homes = []
    for agent in agents:
        try:
            homes.append(build_vars(agent, teams)["AGENT_DIR"])
        except Exception:
            continue
    return homes


def render_template(content: str, vars_: dict[str, str]) -> str:
    """Replace {{VAR}} placeholders in content."""
    for key, value in vars_.items():
        content = content.replace(f"{{{{{key}}}}}", value)
    return content


def render_master(master_rel: str, content: str, vars_: dict[str, str]) -> str:
    """What a master looks like once deployed. One place for deploy, verify and the manifest, so they cannot disagree.

    .tmpl masters get the full variable set. Plain masters name people and the send command through PLAIN_MASTER_VARS only
    (who plays which part is configuration); any other {{...}} text in a plain master stays literal.
    """
    if master_rel.endswith(".tmpl"):
        return render_template(content, vars_)
    return render_template(content, {k: vars_[k] for k in PLAIN_MASTER_VARS if k in vars_})


USER_PROFILE_ENTRY = "user-profile"
USER_PROFILE_NAME_MAX = 40
USER_PROFILE_EMAIL_MAX = 254
USER_PROFILE_ABOUT_MAX = 4000
_USER_PROFILE_TOKENS = re.compile(r"\{\{(USER_NAME|USER_EMAIL_BLOCK|USER_ABOUT)\}\}")
_PROFILE_CACHE: list = []


class ProfileUnavailable(Exception):
    """The account profile could not be read or failed validation."""


def _validated_profile(payload: object) -> dict[str, str]:
    """Pick the profile out of a /api/account response and check its limits."""
    node = payload if isinstance(payload, dict) else {}
    profile = node.get("profile") or (node.get("data") or {}).get("profile")
    if not isinstance(profile, dict):
        raise ProfileUnavailable("response has no profile")
    name = profile.get("displayName")
    email = profile.get("email") or ""
    about = profile.get("about") or ""
    if not isinstance(name, str) or not name.strip():
        raise ProfileUnavailable("profile has no displayName")
    if not isinstance(email, str) or not isinstance(about, str):
        raise ProfileUnavailable("profile email/about must be text")
    name, email, about = name.strip(), email.strip(), about.strip()
    if len(name) > USER_PROFILE_NAME_MAX or len(email) > USER_PROFILE_EMAIL_MAX \
            or len(about) > USER_PROFILE_ABOUT_MAX:
        raise ProfileUnavailable("profile field exceeds its length limit")
    if any(ord(c) < 32 and c not in "\n\t" for c in name + email + about):
        raise ProfileUnavailable("profile contains control characters")
    if "\n" in name or "\n" in email:
        raise ProfileUnavailable("name and email must be one line")
    return {"displayName": name, "email": email, "about": about}


def load_user_profile() -> dict[str, str]:
    """The account profile from the DevFlow that owns it (GET /api/account).

    Read once per run. Any failure raises ProfileUnavailable: callers keep the
    existing user-profile.md rather than writing a blank or stale profile.
    """
    if _PROFILE_CACHE:
        outcome = _PROFILE_CACHE[0]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome
    url = (os.environ.get("DEVFLOW_URL") or "http://localhost:3000").rstrip("/")
    request = urllib.request.Request(f"{url}/api/account")
    token = os.environ.get("DEVFLOW_API_TOKEN")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=15) as resp:
            outcome: object = _validated_profile(json.loads(resp.read()))
    except ProfileUnavailable as error:
        outcome = error
    except Exception as error:  # noqa: BLE001 - network, HTTP and JSON failures alike
        outcome = ProfileUnavailable(f"{url}/api/account: {error}")
    _PROFILE_CACHE.append(outcome)
    if isinstance(outcome, Exception):
        print(f"  ! Account profile unavailable: {outcome}; user-profile.md left untouched",
              file=sys.stderr)
        raise outcome
    return outcome


def render_user_profile(rendered: str, profile: dict[str, str]) -> str:
    """Fill the profile tokens in one pass, so the user's own text is never re-expanded."""
    values = {
        "USER_NAME": profile["displayName"],
        "USER_EMAIL_BLOCK": f"Account email: {profile['email']}\n\n" if profile["email"] else "",
        "USER_ABOUT": profile["about"],
    }
    return _USER_PROFILE_TOKENS.sub(lambda match: values[match.group(1)], rendered)


def apply_adapter_postprocess(entry: dict, rendered: str, agent: dict | None = None) -> str:
    """Per-model entry-point templates need their @-import block augmented
    so every required global is actually loaded by the target model. The
    adapter layer (data/scaffolding/adapters.py) declares what each
    family needs; this helper looks up the adapter by the manifest entry
    id and runs its idempotent injection.

    For non-entry-point entries (alignment files, globals, per-agent
    files, config files) this is a no-op. Called from both
    `sync_file_entry` (when writing) and `verify_agent_files` (when
    hashing) so the two paths produce byte-identical output.

    Fixes audit findings §2.1 (Gemini alignment never imported) and §2.2
    (Grok/Codex globals never imported).
    """
    entry_id = entry.get("id") if isinstance(entry, dict) else None
    if not entry_id:
        return rendered
    adapter = adapter_for_entry_template(entry_id)
    if adapter is None:
        return rendered
    rendered = adapter.inject_imports(rendered)
    channel_names = (agent or {}).get("_channelNames", set())
    if {"SG-1", "Commander"} & set(channel_names):
        rendered = ensure_imports(rendered, ["@./.claude/rules/Mission.md"])
    return rendered


# ---------------------------------------------------------------------------
# Target path resolution
# ---------------------------------------------------------------------------

def resolve_target(raw_target: str, agent: dict, teams: dict) -> Path:
    """Expand {agent_dir}, {team_dir}, ~ in target path string."""
    vars_ = build_vars(agent, teams)
    path = raw_target
    path = path.replace("{agent_dir}", vars_["AGENT_DIR"])
    path = path.replace("{team_dir}", vars_["TEAM_DIR"])
    path = path.replace("{agent_memory_path}", vars_["AGENT_MEMORY_PATH"])
    path = path.replace("~", vars_["HOME_DIR"])
    return Path(path)


# ---------------------------------------------------------------------------
# Condition evaluation
# ---------------------------------------------------------------------------

def agent_matches_condition(agent: dict, condition: str,
                            known_models: set[str] | None = None) -> bool:
    if condition == "always":
        return True
    if condition.startswith("model:"):
        required_model = condition.split(":", 1)[1].lower()
        # Validate against models.json — warn if condition references an unknown model
        if known_models is not None and required_model not in known_models:
            print(f"  ! WARNING: manifest condition 'model:{required_model}' not found in models.json")

        # Provisioning Hardening (Worf): If the agent has an explicit agentType,
        # it should only match model conditions corresponding to that agentType.
        # E.g. required_model 'gemini' should not match if agentType is 'antigravity'.
        agent_type = (agent.get("agentType") or "").lower()
        if agent_type and required_model in ("gemini", "grok", "codex", "claude", "deepseek"):
            if agent_type != required_model:
                return False

        agent_models = [m.lower() for m in agent.get("models", [])]
        return required_model in agent_models
    if condition.startswith("agentType:"):
        required_type = condition.split(":", 1)[1].lower()
        agent_type = (agent.get("agentType") or "").lower()
        # An explicit agentType is authoritative.  models[] is capability /
        # history data and intentionally accumulates values across harness
        # switches; consulting it here caused multiple runtime adapters to
        # match and the later Hermes entry to overwrite Codex's AGENTS.md.
        if agent_type:
            return agent_type == required_type
        # Fix 2 (Reynolds, Hermes-postmortem): legacy agents.json entries
        # don't have an `agentType` field — roster-ops only wrote it for
        # NEW agents pre-fix. Fall back to checking models[] so the
        # `agentType:X` condition still matches when the type is declared
        # there. Pairs with Edit 1 (roster-ops fix) but works without it.
        return required_type in [m.lower() for m in agent.get("models", [])]
    if condition.startswith("channel:"):
        # channel:SG-1,Commander — matches agents whose _channelNames
        # intersect the comma-separated list. _channelNames is a
        # pre-computed set attached by run_sync() from collab-channels.json.
        required_names = set(n.strip() for n in condition.split(":", 1)[1].split(","))
        agent_channels = agent.get("_channelNames", set())
        return bool(required_names & agent_channels)
    return True


# ---------------------------------------------------------------------------
# File sync logic
# ---------------------------------------------------------------------------

_TOML_TABLE_HEADER_RE = re.compile(r"^\s*\[\[?.*?\]\]?\s*(?:#.*)?(?:\r?\n)?$")
_LEGACY_CODEX_PROFILE_HEADER_RE = re.compile(
    r"^\s*\[\s*profiles\s*\.\s*agentchat\s*\]\s*(?:#.*)?(?:\r?\n)?$"
)
_LEGACY_CODEX_PROFILE_SELECTOR_RE = re.compile(
    r'''^\s*profile\s*=\s*(?:"agentchat"|'agentchat')\s*(?:#.*)?(?:\r?\n)?$'''
)
_LEGACY_CODEX_PROFILE_PREAMBLE_HEADER = "# Codex Profile — agentchat"


def strip_legacy_codex_agentchat_profile(content: str) -> str:
    """Remove only Codex's obsolete AgentChat profile syntax from base TOML.

    Codex CLI 0.144 moved named profiles from ``[profiles.<name>]`` tables in
    ``config.toml`` to separate ``<name>.config.toml`` files.  This line-based
    migration deliberately avoids reserializing TOML, so comments, ordering,
    formatting, and unrelated tables remain byte-for-byte unchanged.
    """
    lines = content.splitlines(keepends=True)
    legacy_preamble_indexes: set[int] = set()

    # Older scaffolding appended a long master-owned comment preamble directly
    # before [profiles.agentchat]. Remove it only when the exact header anchors
    # a contiguous comment/blank block whose next line is that legacy table.
    # The same header anywhere else is ordinary user content and survives.
    for index, line in enumerate(lines):
        if line.strip() != _LEGACY_CODEX_PROFILE_PREAMBLE_HEADER:
            continue
        cursor = index + 1
        while cursor < len(lines):
            stripped = lines[cursor].strip()
            if not stripped or stripped.startswith("#"):
                cursor += 1
                continue
            break
        if cursor < len(lines) and _LEGACY_CODEX_PROFILE_HEADER_RE.match(lines[cursor]):
            legacy_preamble_indexes.update(range(index, cursor))

    output: list[str] = []
    inside_legacy_table = False
    seen_table = False

    for index, line in enumerate(lines):
        if index in legacy_preamble_indexes:
            continue
        if inside_legacy_table:
            if _TOML_TABLE_HEADER_RE.match(line):
                inside_legacy_table = False
                seen_table = True
            else:
                continue

        if _LEGACY_CODEX_PROFILE_HEADER_RE.match(line):
            inside_legacy_table = True
            seen_table = True
            continue

        if not seen_table and _LEGACY_CODEX_PROFILE_SELECTOR_RE.match(line):
            continue

        if _TOML_TABLE_HEADER_RE.match(line):
            seen_table = True
        output.append(line)

    return "".join(output)


def migrate_legacy_codex_agentchat_profile(base_config: Path, *, write: bool = True) -> bool:
    """Migrate the obsolete AgentChat profile out of Codex's base config.

    Returns True when legacy syntax was found. Writes atomically in the same
    directory and preserves the original file mode. Missing files are a no-op.
    """
    if not base_config.exists():
        return False

    existing = base_config.read_text(encoding="utf-8")
    migrated = strip_legacy_codex_agentchat_profile(existing)
    if migrated == existing:
        return False
    if not write:
        return True

    original_mode = base_config.stat().st_mode
    base_config.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{base_config.name}.", dir=base_config.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(migrated)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, original_mode)
        os.replace(temp_path, base_config)
    finally:
        if temp_path.exists():
            temp_path.unlink()
    return True


def merge_managed_outlook_config(existing: str, master: str) -> str:
    """Replace only the scaffold-managed Outlook MCP entry.

    Agent `.mcp.json` files often contain project-specific servers. Replacing the
    whole file would be a regression, while `overwrite=false` left the retired
    per-agent Node process in place forever. This merge keeps every unrelated
    top-level key and server, and updates only `mcpServers.outlook`.
    """
    existing_data = json.loads(existing)
    master_data = json.loads(master)
    if not isinstance(existing_data, dict) or not isinstance(master_data, dict):
        raise ValueError("MCP configuration root must be a JSON object")
    managed_servers = master_data.get("mcpServers")
    if not isinstance(managed_servers, dict) or "outlook" not in managed_servers:
        raise ValueError("Outlook MCP master is missing mcpServers.outlook")
    servers = existing_data.get("mcpServers")
    if servers is None:
        servers = {}
        existing_data["mcpServers"] = servers
    if not isinstance(servers, dict):
        raise ValueError("Existing mcpServers value must be a JSON object")
    servers["outlook"] = managed_servers["outlook"]
    return json.dumps(existing_data, indent=2, ensure_ascii=False) + "\n"


def write_managed_text(target: Path, content: str) -> None:
    """Atomically replace a managed file without following a legacy symlink.

    Older provisioning linked ``Team/<agent>/CLAUDE.md`` to the shared project
    root. A normal ``Path.write_text`` follows that link and lets one agent's
    rendered entry point overwrite project-owned instructions. Replacing a
    same-directory temporary file at the path removes the link itself while
    leaving its former target untouched.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
    finally:
        if temp_path.exists():
            temp_path.unlink()

def _first_line(text: str) -> str:
    return next((line.strip() for line in text.splitlines() if line.strip()), "")


def retire_unmatched_entry(teams: dict, entry: dict, agent: dict,
                           dry_run: bool = False) -> list[str]:
    """Remove a sync-written file once the agent no longer meets its condition.

    Only for entries marked ``retireWhenUnmatched``. Otherwise a file such as
    Mission.md keeps loading natively from ``.claude/rules`` after the agent
    leaves the channels it is scoped to. A file whose heading no longer matches
    the master was edited by hand and is left alone.
    """
    if not entry.get("retireWhenUnmatched"):
        return []
    master_path = MASTERS_DIR / entry["master"]
    if not master_path.exists():
        return []
    heading = _first_line(master_path.read_text(encoding="utf-8"))
    removed = []
    for raw_target in entry.get("targets", []):
        target = resolve_target(raw_target, agent, teams)
        if not target.is_file():
            continue
        try:
            if _first_line(target.read_text(encoding="utf-8", errors="replace")) != heading:
                continue
            if not dry_run:
                target.unlink()
        except OSError:
            continue
        removed.append(str(target))
    return removed


def sync_file_entry(teams: dict,
    entry: dict,
    agent: dict,
    dry_run: bool = False,
    check_only: bool = False,
    verbose: bool = False,
) -> dict:
    """
    Sync one manifest entry for one agent.
    Returns a result dict with keys: target, action, skipped, reason
    """
    master_path = MASTERS_DIR / entry["master"]
    if not master_path.exists():
        return {"target": entry["master"], "action": "ERROR",
                "skipped": True, "reason": f"Master file missing: {master_path}"}

    master_content = master_path.read_text(encoding="utf-8")
    is_template = entry["master"].endswith(".tmpl")
    vars_ = build_vars(agent, teams)

    rendered = render_master(entry["master"], master_content, vars_)

    if entry.get("id") == USER_PROFILE_ENTRY:
        try:
            rendered = render_user_profile(rendered, load_user_profile())
        except ProfileUnavailable as exc:
            return {"target": entry["master"], "action": "ERROR", "skipped": True,
                    "reason": f"account profile unavailable ({exc}); existing file left untouched"}

    # Adapter post-process: per-model entry-point templates get their
    # @-import block augmented to load all required globals. Idempotent.
    rendered = apply_adapter_postprocess(entry, rendered, agent)

    # Codex CLI 0.144+ loads named profiles from ~/.codex/<name>.config.toml
    # and rejects the old base-config profile syntax when --profile is used.
    # The global target is owned by the team lead, matching the existing ~/ deployment
    # convention below, so targeted syncs for other agents do not mutate it.
    if entry.get("id") == "codex-config-toml" and _is_global_owner(agent):
        base_config = Path(_MACHINE_CONFIG["homeDir"]) / ".codex" / "config.toml"
        migrated = migrate_legacy_codex_agentchat_profile(
            base_config,
            write=not dry_run and not check_only,
        )
        if migrated and verbose:
            mode = "would migrate" if dry_run or check_only else "migrated"
            print(f"    ↻ {base_config.name} — {mode} legacy AgentChat profile")

    results = []
    for raw_target in entry["targets"]:
        # Skip per-agent targets that are literally for the global rag-memory rule
        # (they use ~ not {agent_dir}/{team_dir})
        target = resolve_target(raw_target, agent, teams)

        # For global files targeting ~, only deploy once (not per-agent)
        if raw_target.startswith("~") and not _is_global_owner(agent):
            results.append({"target": str(target), "action": "SKIP",
                            "skipped": True, "reason": "global target, deployed by first agent"})
            continue

        desired = rendered
        managed_existing = False
        if target.exists():
            existing = target.read_text(encoding="utf-8")
            if entry.get("id") == "mcp-outlook":
                try:
                    desired = merge_managed_outlook_config(existing, rendered)
                    managed_existing = True
                except (json.JSONDecodeError, ValueError) as exc:
                    results.append({"target": str(target), "action": "ERROR",
                                    "skipped": True,
                                    "reason": f"Cannot safely merge Outlook MCP entry: {exc}"})
                    continue
            if existing == desired:
                results.append({"target": str(target), "action": "OK",
                                "skipped": False, "reason": "up to date"})
                continue
            else:
                if not entry.get("overwrite", True) and not managed_existing:
                    results.append({"target": str(target), "action": "SKIP",
                                   "skipped": True, "reason": "overwrite=false, file exists"})
                    continue
                action = "UPDATE"
        else:
            action = "CREATE"

        if check_only:
            results.append({"target": str(target), "action": "DRIFT",
                            "skipped": False, "reason": action})
            continue

        if not dry_run:
            write_managed_text(target, desired)

        results.append({"target": str(target), "action": action,
                        "skipped": False, "reason": ""})

    return results


# ---------------------------------------------------------------------------
# Context Broker decision function — `compute_agent_manifest(...)`
#
# Pure: NO file I/O. Returns the structured manifest a Context Broker (or
# the seed-scaffold loader, P4) would use to decide what scaffolding an
# agent needs. Inputs are already-loaded `teams`, `agent`, `manifest`, and
# (optionally) `known_models` — caller is responsible for loading those.
#
# This is the foundational decision: "given this agent record, what files
# should it have, where, and from which master?" Reading the master content
# and writing the targets are separate concerns (sync_file_entry / verifier).
#
# Decision row schema:
#   {
#     entryId:        manifest entry id
#     source:         category — global / per-model / per-agent / skill
#     masterRel:      master path relative to MASTERS_DIR
#     masterAbsHint:  absolute master path (path-string only, NOT file-existence)
#     targets:        [resolved target path string] — one per entry target
#     condition:      original condition string
#     conditionMatch: bool — true iff agent_matches_condition(...)
#     isTemplate:     bool — master ends with .tmpl
#     overwrite:      bool — defaults to True
#     description:    manifest entry description
#     reason:         when conditionMatch is false, the human-readable why
#     templateVars:   the {{VAR}} substitution map a renderer would apply
#                     (non-templates carry only the people/send-command names, PLAIN_MASTER_VARS)
#   }
#
# Notes for the Broker pilot (P4):
#   - The renderer to call: `render_template(open(masterAbsHint).read(), templateVars)`
#     for is_template entries, or just read the master for non-templates.
#   - Filter `conditionMatch == True` for the live "needs this file" set.
#   - The unfiltered list is the FULL audit (lets the Broker explain why
#     it's NOT injecting something — useful for X-Ray UI tooltips).
# ---------------------------------------------------------------------------


def compute_agent_manifest(teams: dict, agent: dict, manifest: dict,
                           known_models: set[str] | None = None,
                           include_skipped: bool = True) -> list[dict]:
    """Return the decision-only manifest for one agent. Pure: no file I/O.

    Args:
        teams:           parsed teams.json (load_teams())
        agent:           one agent record (from agents.json)
        manifest:        parsed manifest.json (load_manifest())
        known_models:    optional set of known model providers — pass when
                         the caller already has it, otherwise we skip the
                         model-condition validation noise (NO load_models()
                         call from inside this function — that would be I/O)
        include_skipped: when False, rows with conditionMatch=False are
                         omitted. Default True so the full audit is visible.

    Returns:
        list[dict] of decision rows (see header comment for schema).
    """
    # build_vars() is pure (operates on already-loaded dicts) so it's safe
    # to call here without doing any file I/O.
    try:
        template_vars = build_vars(agent, teams)
    except Exception as exc:
        # Caller mis-supplied data — surface a single error row instead of
        # raising, so the Broker can degrade gracefully.
        return [{
            "entryId": None,
            "source": None,
            "masterRel": None,
            "masterAbsHint": None,
            "targets": [],
            "condition": None,
            "conditionMatch": False,
            "isTemplate": False,
            "overwrite": False,
            "description": None,
            "reason": f"build_vars failed: {exc}",
            "templateVars": {},
        }]

    rows: list[dict] = []

    for entry in manifest.get("files", []):
        entry_id = entry.get("id")
        source = entry.get("category", "global")
        master_rel = entry.get("master", "")
        is_template = master_rel.endswith(".tmpl")
        overwrite = entry.get("overwrite", True)
        description = entry.get("description")
        condition = entry.get("condition", "always")

        # Pure check — no I/O. agent_matches_condition only reads the agent
        # dict + known_models set; known_models is optional/may be empty.
        cond_match = agent_matches_condition(
            agent, condition, known_models if known_models is not None else set()
        )

        resolved_targets: list[str] = []
        reason: str | None = None

        if not cond_match:
            reason = f"condition '{condition}' did not match agent"
            if not include_skipped:
                continue
            # For skipped rows, still resolve targets so the Broker can show
            # "would have been at X if you matched" — useful for X-Ray.
            for raw_target in entry.get("targets", []):
                try:
                    resolved_targets.append(str(resolve_target(raw_target, agent, teams)))
                except Exception:
                    resolved_targets.append(raw_target)
        else:
            for raw_target in entry.get("targets", []):
                try:
                    resolved_targets.append(str(resolve_target(raw_target, agent, teams)))
                except Exception as exc:
                    # Don't drop the row — surface the resolve failure as a reason
                    resolved_targets.append(raw_target)
                    reason = f"target-unresolvable: {exc}"

        rows.append({
            "entryId": entry_id,
            "source": source,
            "masterRel": master_rel,
            "masterAbsHint": str(MASTERS_DIR / master_rel) if master_rel else None,
            "targets": resolved_targets,
            "condition": condition,
            "conditionMatch": cond_match,
            "isTemplate": is_template,
            "overwrite": overwrite,
            "description": description,
            "reason": reason,
            "templateVars": (template_vars if is_template else {k: template_vars[k] for k in PLAIN_MASTER_VARS if k in template_vars}) if cond_match else {},
        })

    return rows


# ---------------------------------------------------------------------------
# Post-deploy verifier — confirms each expected file landed with the expected
# hash. Powers both the standalone `--verify-only` CLI flag (idempotent, safe
# to re-run) and the auto-verify pass that runs after every non-dry-run sync.
#
# Pure-ish: computes hashes from disk + renders master content in memory, no
# writes. Returns a list of per-file dicts the API (/api/scaffolding/manifest)
# can consume directly. Status semantics follow docs/spec-scaffolding-xray.md:
#   synced    — local sha == master sha
#   drift     — local exists, sha differs from master
#   missing   — master exists, no local file
#   skipped   — condition didn't match (entry doesn't apply to this agent)
# `unsupported` is not produced here — that's an upstream adapter concern.
# ---------------------------------------------------------------------------

def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_text(text: str) -> str:
    return _sha256_bytes(text.encode("utf-8"))


def _sha256_file(path: Path) -> str | None:
    """Hash a file's bytes. Returns None if the file is missing/unreadable."""
    try:
        with open(path, "rb") as fh:
            h = hashlib.sha256()
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
            return h.hexdigest()
    except OSError:
        return None


def _iso_mtime(path: Path) -> str | None:
    try:
        ts = path.stat().st_mtime
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except OSError:
        return None


def verify_agent_files(teams: dict, agent: dict, manifest: dict,
                       known_models: set[str] | None = None,
                       category_whitelist: set[str] | None = None) -> list[dict]:
    """Walk an agent's expected scaffolding files and report status per file.

    For each manifest entry that matches the agent's condition, render the
    rendered master content + compute its sha256 + compare against the local
    file at each target path.

    Returns one dict per (entry × target) combination. Skipped entries
    (condition mismatch, or global ~ targets owned by another agent) emit a
    `status: 'skipped'` row so callers see the full audit, not just deltas.

    No file I/O writes — strictly read + hash. Idempotent.
    """
    if known_models is None:
        try:
            known_models = load_models()
        except Exception:
            known_models = set()

    results: list[dict] = []

    for entry in manifest.get("files", []):
        source_category = entry.get("category", "global")  # global / per-model / per-agent
        if category_whitelist is not None and source_category not in category_whitelist:
            continue
        master_rel = entry["master"]
        master_path = MASTERS_DIR / master_rel

        # If the master file is missing entirely, every target for this entry
        # is in a degenerate state — surface that loudly.
        if not master_path.exists():
            for raw_target in entry.get("targets", []):
                results.append({
                    "entryId": entry.get("id"),
                    "source": source_category,
                    "masterPath": str(master_path),
                    "target": raw_target,
                    "path": raw_target,
                    "status": "master-missing",
                    "drift": False,
                    "localSha256": None,
                    "masterSha256": None,
                    "mtime": None,
                    "reason": f"Master file missing: {master_path}",
                })
            continue

        if not agent_matches_condition(agent, entry.get("condition", "always"), known_models):
            # Don't emit per-target skipped rows here — that would blow up the
            # output for big manifests. Emit one summary row per entry.
            #
            # Sprint Q2 T3 (Reynolds, 2026-05-27): resolve the first target's
            # `{agent_dir}`/`{team_dir}` placeholders against THIS agent's
            # build_vars so X-Ray consumers see a concrete path (or the raw
            # template if resolution fails). Pre-fix emitted the literal
            # `{agent_dir}/alignment-grok.md` etc. for non-applicable adapter
            # entries — useless for the UI and misleading in the audit.
            raw_first = entry.get("targets", [None])[0]
            resolved_first = raw_first
            if raw_first:
                try:
                    resolved_first = str(resolve_target(raw_first, agent, teams))
                except Exception:
                    resolved_first = raw_first  # fall back to template if vars can't render
            results.append({
                "entryId": entry.get("id"),
                "source": source_category,
                "masterPath": str(master_path),
                "target": resolved_first,
                "path": resolved_first,
                "status": "skipped",
                "drift": False,
                "localSha256": None,
                "masterSha256": None,
                "mtime": None,
                "reason": f"condition '{entry.get('condition')}' did not match agent",
            })
            continue

        is_template = master_rel.endswith(".tmpl")
        try:
            master_content = master_path.read_text(encoding="utf-8")
        except OSError as exc:
            for raw_target in entry.get("targets", []):
                results.append({
                    "entryId": entry.get("id"),
                    "source": source_category,
                    "masterPath": str(master_path),
                    "target": raw_target,
                    "path": raw_target,
                    "status": "master-unreadable",
                    "drift": False,
                    "localSha256": None,
                    "masterSha256": None,
                    "mtime": None,
                    "reason": f"Master read failed: {exc}",
                })
            continue

        try:
            rendered = render_master(master_rel, master_content, build_vars(agent, teams))
            if is_template and entry.get("id") == USER_PROFILE_ENTRY:
                rendered = render_user_profile(rendered, load_user_profile())
        except Exception as exc:
            rendered = master_content
            # render failure shouldn't break verification — fall back to
            # raw content + note. Per-agent rendering errors are usually
            # caused by missing vars and indicate a manifest bug.
            _render_note = f"template render error: {exc}"
        else:
            _render_note = None

        # Adapter post-process — MUST mirror sync_file_entry so the verifier
        # sees the same bytes a fresh deploy would write. Otherwise we'd
        # report eternal drift on every per-model entry-point file.
        rendered = apply_adapter_postprocess(entry, rendered, agent)

        master_sha = _sha256_text(rendered)

        # Sprint Q2 T2 (Reynolds, 2026-05-27): dedup targets by resolved
        # filesystem path within an entry. Many manifest entries declare
        # two targets — `{agent_dir}/X` AND `{team_dir}/X` — that resolve
        # to the SAME concrete path for SG-1 agents (where AGENT_DIR ==
        # TEAM_DIR per build_vars). Pre-fix output had ~8 dupes per agent
        # because the verifier loop emitted one row per raw target without
        # resolved-path coalescing. The deploy loop (sync_file_entry) does
        # naturally dedup via the `existing == rendered` skip path, but
        # verify_only is read-only and needs explicit dedup. Tracks
        # resolved-string keys; unresolvable targets (the try/except below)
        # still emit one row each since they have no resolved key to dedup.
        _emitted_resolved: set[str] = set()
        for raw_target in entry.get("targets", []):
            try:
                target = resolve_target(raw_target, agent, teams)
            except Exception as exc:
                results.append({
                    "entryId": entry.get("id"),
                    "source": source_category,
                    "masterPath": str(master_path),
                    "target": raw_target,
                    "path": raw_target,
                    "status": "target-unresolvable",
                    "drift": False,
                    "localSha256": None,
                    "masterSha256": master_sha,
                    "mtime": None,
                    "reason": f"Could not resolve target path: {exc}",
                })
                continue
            target_str = str(target)
            if target_str in _emitted_resolved:
                continue
            _emitted_resolved.add(target_str)

            # Global ~ targets are deployed once by the team lead;
            # for other agents they're informational, not a missing file.
            if raw_target.startswith("~") and not _is_global_owner(agent):
                results.append({
                    "entryId": entry.get("id"),
                    "source": source_category,
                    "masterPath": str(master_path),
                    "target": str(target),
                    "path": str(target),
                    "status": "skipped",
                    "drift": False,
                    "localSha256": None,
                    "masterSha256": master_sha,
                    "mtime": None,
                    "reason": "global ~ target, owned by Jack",
                })
                continue

            local_sha = _sha256_file(target)
            mtime = _iso_mtime(target)

            expected_sha = master_sha
            managed_entry = entry.get("id") == "mcp-outlook"
            if managed_entry and local_sha is not None:
                try:
                    existing_text = target.read_text(encoding="utf-8")
                    expected_text = merge_managed_outlook_config(existing_text, rendered)
                    expected_sha = _sha256_text(expected_text)
                except (OSError, json.JSONDecodeError, ValueError) as exc:
                    results.append({
                        "entryId": entry.get("id"),
                        "source": source_category,
                        "masterPath": str(master_path),
                        "target": str(target),
                        "path": str(target),
                        "status": "managed-merge-error",
                        "drift": False,
                        "localSha256": local_sha,
                        "masterSha256": None,
                        "mtime": mtime,
                        "reason": f"Cannot safely verify Outlook MCP entry: {exc}",
                    })
                    continue

            # Manifest entries with `overwrite: false` are seed-only —
            # sync deploys them once but never overwrites. The file is
            # expected to evolve (agent learning log, hook-written state,
            # per-machine config). Surface as 'agent-owned' rather than
            # 'drift' so the alarm signal stays meaningful. P3 follow-up
            # `Mark agent-evolving files as seed-only`.
            seed_only = entry.get("overwrite", True) is False and not managed_entry

            if local_sha is None:
                status = "missing"
                drift = False
            elif local_sha == expected_sha:
                status = "synced"
                drift = False
            elif seed_only:
                status = "agent-owned"
                drift = False
            else:
                status = "drift"
                drift = True

            row = {
                "entryId": entry.get("id"),
                "source": source_category,
                "masterPath": str(master_path),
                "target": str(target),
                "path": str(target),
                "status": status,
                "drift": drift,
                "localSha256": local_sha,
                "masterSha256": expected_sha,
                "mtime": mtime,
            }
            if _render_note:
                row["reason"] = _render_note
            results.append(row)

    return results


def verify_summary(rows: list[dict]) -> dict:
    """Aggregate counters used by `--verify-only` exit code + JSON summary."""
    summary = {
        "total": len(rows),
        "synced": 0,
        "drift": 0,
        "missing": 0,
        "skipped": 0,
        "agent_owned": 0,
        "errors": 0,
    }
    for r in rows:
        st = r.get("status", "")
        if st == "synced":
            summary["synced"] += 1
        elif st == "drift":
            summary["drift"] += 1
        elif st == "missing":
            summary["missing"] += 1
        elif st == "skipped":
            summary["skipped"] += 1
        elif st == "agent-owned":
            summary["agent_owned"] += 1
        else:
            summary["errors"] += 1
    return summary


_IMPORT_LINE_RE = re.compile(r"^\s*@(?P<path>(?:\.{1,2}/|/)[^\s]+)\s*$")


def verify_resolved_entrypoint_imports(rows: list[dict]) -> list[dict]:
    """Return failures for dangling imports in managed entry-point files.

    The manifest hashes entry points and their rule files independently, but
    an import added outside the manifest could otherwise look healthy while
    resolving to nothing at startup. Shared-root presences never reach this
    function because they are reported as externally managed and receive no
    agent-specific entry point.
    """
    explained_missing_paths = {
        str(row.get("path"))
        for row in rows
        if row.get("path") and row.get("status") == "missing"
    }
    failures: list[dict] = []
    emitted: set[str] = set()
    for row in rows:
        if row.get("source") != "per-model" or row.get("status") not in {"synced", "drift", "agent-owned"}:
            continue
        target = Path(str(row.get("path") or ""))
        if not target.is_file() or target.suffix.lower() != ".md":
            continue
        try:
            content = target.read_text(encoding="utf-8")
        except OSError:
            continue
        for line in content.splitlines():
            match = _IMPORT_LINE_RE.match(line)
            if not match:
                continue
            imported = match.group("path")
            resolved = Path(imported) if imported.startswith("/") else target.parent / imported
            resolved = Path(os.path.normpath(str(resolved)))
            resolved_str = str(resolved)
            if resolved.exists() or resolved_str in emitted:
                continue
            # A normal missing manifest/identity row already explains this
            # path. Avoid double-counting the same load failure.
            if resolved_str in explained_missing_paths:
                continue
            emitted.add(resolved_str)
            failures.append({
                "entryId": f"{row.get('entryId')}-import",
                "source": "entrypoint-import",
                "masterPath": row.get("masterPath"),
                "target": resolved_str,
                "path": resolved_str,
                "status": "missing",
                "drift": False,
                "localSha256": None,
                "masterSha256": None,
                "mtime": None,
                "reason": f"unresolved import from {target}",
            })
    return failures


def run_verify(teams: dict, agents: list[dict], manifest: dict,
               agent_filter: str | None = None,
               as_json: bool = False) -> int:
    """Run `verify_agent_files()` for one or all agents. Returns exit code:
    0 = clean (synced + skipped only), N>0 = drift + missing + error count.

    --json mode prints a single JSON document to stdout (consumed by the
    /api/scaffolding/manifest API) and suppresses the human-readable header.
    """
    filtered_agents = agents
    if agent_filter:
        filtered_agents = [a for a in agents if a["name"].lower() == agent_filter.lower()]
        if not filtered_agents:
            msg = f"ERROR: Agent '{agent_filter}' not found in agents.json"
            if as_json:
                print(json.dumps({"error": msg, "exit": 2}))
            else:
                print(msg, file=sys.stderr)
            return 2

    known_models = load_models()

    # Match run_sync's channel-scoped conditions. Standalone verification used
    # to skip Mission while the deploy/check path included it.
    agent_channels: dict[str, set[str]] = {}
    channels_data = load_channels_data() or {}
    channel_list = channels_data if isinstance(channels_data, list) else channels_data.get("channels", [])
    for channel in channel_list:
        if not isinstance(channel, dict):
            continue
        channel_name = channel.get("name", "")
        roster = channel.get("roster") or {}
        roster_agents = roster.get("agents", []) if isinstance(roster, dict) else []
        for roster_agent in roster_agents:
            if isinstance(roster_agent, dict) and roster_agent.get("name"):
                agent_channels.setdefault(roster_agent["name"], set()).add(channel_name)

    fleet_payload = []
    bad_total = 0

    for agent in filtered_agents:
        agent["_channelNames"] = agent_channels.get(agent["name"], set())
        target_specs: list[tuple[str, dict, set[str] | None, dict | None]] = [("default", agent, None, None)]
        default_dirs: set[str] = set()
        try:
            default_vars = build_vars(agent, teams)
            default_dirs.update((default_vars["AGENT_DIR"], default_vars["TEAM_DIR"]))
        except Exception:
            pass

        verify_presences = discover_agent_presences(agent["name"])
        for presence in verify_presences:
            working_directory = presence.get("workingDirectory") or ""
            presence_type = presence.get("agentType")
            if not working_directory or working_directory in default_dirs or not presence_type:
                continue
            synth = _agent_with_dir_override(agent, working_directory, presence_type)
            synth["models"] = [presence_type]
            synth["_channelNames"] = _presence_channel_names(verify_presences, working_directory)
            # Empty category set is a sentinel for a shared root. It is
            # reported but never verified as an agent-owned entry point.
            categories = None if is_agent_owned_presence(agent["name"], working_directory) else set()
            label = presence.get("channelName") or presence.get("channelId") or working_directory
            target_specs.append((str(label), synth, categories, presence))

        rows = []
        emitted: set[tuple[str | None, str | None]] = set()
        for presence_label, target_agent, categories, presence_meta in target_specs:
            target_directory = build_vars(target_agent, teams)["TEAM_DIR"]
            if categories == set():
                presence_rows = [{
                    "entryId": "shared-root-presence",
                    "source": "presence",
                    "masterPath": None,
                    "target": target_directory,
                    "path": target_directory,
                    "status": "skipped",
                    "drift": False,
                    "localSha256": None,
                    "masterSha256": None,
                    "mtime": None,
                    "reason": "externally managed shared root; no agent-specific entry point deployed",
                }]
            else:
                presence_rows = verify_agent_files(
                    teams,
                    target_agent,
                    manifest,
                    known_models=known_models,
                    category_whitelist=categories,
                )
            if categories is None and is_agent_owned_presence(agent["name"], target_directory):
                identity_presence, identity_state = _matching_identity_presence(agent, target_directory)
                if identity_state in {"ambiguous", "unresolved"}:
                    reason = (
                        "multiple channel identities share this cwd; spawn-time pointer is authoritative"
                        if identity_state == "ambiguous"
                        else "roster identity has no canonical source; existing spawn-time pointer is preserved"
                    )
                    presence_rows.append({
                        "entryId": "identity-channel-managed",
                        "source": "identity",
                        "masterPath": None,
                        "target": target_directory,
                        "path": target_directory,
                        "status": "skipped",
                        "drift": False,
                        "localSha256": None,
                        "masterSha256": None,
                        "mtime": None,
                        "reason": reason,
                    })
                else:
                    presence_rows.extend(verify_identity_files(
                        agent,
                        target_directory,
                        identity_presence if identity_state == "matched" else presence_meta,
                    ))
            presence_rows.extend(verify_resolved_entrypoint_imports(presence_rows))
            for row in presence_rows:
                key = (row.get("entryId"), row.get("path"))
                if key in emitted:
                    continue
                emitted.add(key)
                row["presence"] = presence_label
                rows.append(row)
        summary = verify_summary(rows)
        bad_total += summary["drift"] + summary["missing"] + summary["errors"]
        fleet_payload.append({
            "agent": agent["name"],
            "agentDir": agent.get("agentDir"),
            "teamDir": agent.get("teamDir"),
            "models": agent.get("models", []),
            "presenceCount": len(target_specs),
            "summary": summary,
            "files": rows,
        })

    if as_json:
        # API-friendly: single JSON doc, one agent or many
        out = {
            "verifiedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "agents": fleet_payload,
            "totalDriftOrMissing": bad_total,
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return min(bad_total, 255)

    # Human-readable output — mirrors the sync output style
    print(f"\nScaffolding Verify — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 50)
    for entry in fleet_payload:
        s = entry["summary"]
        bad = s["drift"] + s["missing"] + s["errors"]
        marker = "✓" if bad == 0 else "✗"
        print(f"  {marker} {entry['agent']}:  "
              f"synced={s['synced']}  drift={s['drift']}  "
              f"missing={s['missing']}  skipped={s['skipped']}  errors={s['errors']}")
        if bad > 0:
            for row in entry["files"]:
                st = row.get("status")
                if st in ("drift", "missing") or (st not in ("synced", "skipped")):
                    short = Path(row.get("path") or "").name
                    extra = ""
                    if st == "drift":
                        extra = f" local={(row.get('localSha256') or '?')[:8]} master={(row.get('masterSha256') or '?')[:8]}"
                    elif row.get("reason"):
                        extra = f" — {row['reason']}"
                    print(f"      [{st:7s}] {short}  {row.get('path')}{extra}")
    print("=" * 50)
    if bad_total == 0:
        print(f"VERIFY OK — all expected files match their masters.")
    else:
        print(f"!! VERIFY FAILED — {bad_total} files in drift/missing/error state.")
        print(f"   Run `sync.py` (no args) to fix, or `sync.py --dry-run` to preview.")
    return min(bad_total, 255)


# ---------------------------------------------------------------------------
# New agent scaffolding
# ---------------------------------------------------------------------------

def scaffold_new_agent(name: str, role: str, domain: str, models: list[str],
                       team_id: str = "sg1", agent_type: str | None = None,
                       dry_run: bool = False) -> None:
    """Create directory structure and deploy all scaffolding for a new agent."""
    teams = load_teams()
    team = teams.get(team_id)
    if not team:
        raise ValueError(f"Team '{team_id}' not found in teams.json. Available teams: {list(teams.keys())}")
    project_dir = team["projectDir"]
    team_dir_base = team["teamDir"]

    agent_dir = str(Path(project_dir) / name)
    team_dir = str(Path(team_dir_base) / name)

    agent = {
        "name": name,
        "teamId": team_id,
        "role": role,
        "domain": domain,
        "models": models,
        "agentDir": agent_dir,
        "teamDir": team_dir,
        "projectDir": project_dir,
    }
    if agent_type:
        agent["agentType"] = agent_type

    print(f"\nScaffolding new agent: {name}")
    print(f"  Role: {role}")
    print(f"  Models: {', '.join(models)}")
    print(f"  Agent dir: {agent_dir}")
    print(f"  Team dir:  {team_dir}")
    print()

    if not dry_run:
        for path in [
            Path(agent_dir) / ".claude" / "rules",
            Path(agent_dir) / "logs",
            Path(team_dir) / ".claude" / "rules",
            Path(team_dir) / "logs",
        ]:
            path.mkdir(parents=True, exist_ok=True)

    manifest = load_manifest()
    for entry in manifest["files"]:
        if agent_matches_condition(agent, entry["condition"], load_models()):
            results = sync_file_entry(teams, entry, agent, dry_run=dry_run, verbose=True)
            if isinstance(results, dict):
                results = [results]
            for r in results:
                icon = "★" if r["action"] in ("CREATE", "UPDATE") else ("✓" if r["action"] == "OK" else "·")
                print(f"  {icon} {Path(r['target']).name} — {r['action']}")

    if not dry_run:
        # Add to agents.json
        agents = json.loads(AGENTS_PATH.read_text())
        existing_names = [a["name"] for a in agents["agents"]]
        if name not in existing_names:
            agents["agents"].append(agent)
            AGENTS_PATH.write_text(json.dumps(agents, indent=2), encoding="utf-8")
            print(f"\n  Added {name} to agents.json")

    print(f"\n{'DRY RUN — ' if dry_run else ''}New agent {name} scaffolded.")


# ---------------------------------------------------------------------------
# Skills deployment
# ---------------------------------------------------------------------------

SKILLS_MASTER_DIR = Path(_MACHINE_CONFIG["devflowDir"]) / "data" / "skills"
SKILLS_MATRIX_PATH = SKILLS_MASTER_DIR / "matrix.json"
HOST_SKILLS_DIR = Path(_MACHINE_CONFIG["homeDir"]) / ".claude" / "skills"


def _windows_skills_dir() -> Path | None:
    """Windows Claude Code's own skills folder, for PowerShell agents.

    Windows claude.exe cannot follow the WSL host's skill symlinks, so the
    catalogue is copied there too. Configure machine.windowsClaudeDir, or it is
    found as the one Windows user with Claude Code installed.
    """
    configured = _MACHINE_CONFIG.get("windowsClaudeDir") or os.environ.get("WINDOWS_CLAUDE_DIR")
    if configured:
        return Path(configured) / "skills"
    try:
        homes = [p.parents[2] for p in Path("/mnt/c/Users").glob("*/.local/bin/claude.exe")]
    except OSError:
        return None
    return homes[0] / ".claude" / "skills" if len(homes) == 1 else None


WINDOWS_SKILLS_DIR = _windows_skills_dir()

# Files under the catalogue that every sync regenerates. They can never be a
# reason to refuse, or the gate would fail on its own output.
SKILLS_GENERATED_FILES = frozenset({"matrix.json"})


# ---------------------------------------------------------------------------
# Skill packs
# ---------------------------------------------------------------------------
# A pack is a named group of niche skills (games, video, ...) that only the
# agents of opted-in projects receive. Every other skill stays global. Keeping
# membership and opt-in in one catalogue file, rather than in each SKILL.md,
# means a skill mirrored from GitHub (which overwrites its SKILL.md) can still
# belong to a pack. Format of data/skills/packs.json:
#
#   {"games": {"description": "...",
#              "skills": ["unreal-engine", ...],
#              "projects": ["/mnt/e/GameDev/Costa-Vida", ...]}}
#
# A pack skill is deployed only to agent workspaces inside a listed project,
# removed from every other agent workspace, and kept out of the machine-wide
# ~/.claude/skills and ~/.agents/skills so it no longer appears in every
# session's skill list.

class SkillPackError(ValueError):
    """packs.json is unreadable or inconsistent; deployment must not guess."""


def load_skill_packs(catalogue_dir: Path | None = None) -> dict:
    catalogue_dir = Path(catalogue_dir or SKILLS_MASTER_DIR)
    packs_file = catalogue_dir / "packs.json"
    if not packs_file.exists():
        return {}
    try:
        raw = json.loads(packs_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SkillPackError(f"{packs_file} is unreadable: {error}") from error
    if not isinstance(raw, dict):
        raise SkillPackError(f"{packs_file} must be an object of packs")
    packs: dict = {}
    owner: dict[str, str] = {}
    for name, pack in raw.items():
        if not isinstance(pack, dict):
            raise SkillPackError(f"pack '{name}' must be an object")
        skills = pack.get("skills") or []
        projects = pack.get("projects") or []
        if not all(isinstance(s, str) and s for s in skills):
            raise SkillPackError(f"pack '{name}': skills must be skill names")
        if not all(isinstance(p, str) and os.path.isabs(p) for p in projects):
            raise SkillPackError(f"pack '{name}': projects must be absolute paths")
        for skill in skills:
            if skill in owner:
                raise SkillPackError(
                    f"skill '{skill}' is in both pack '{owner[skill]}' and pack '{name}'")
            owner[skill] = name
        packs[name] = {
            "description": str(pack.get("description") or ""),
            "skills": list(skills),
            "projects": list(projects),
        }
    return packs


def skill_pack_index(packs: dict) -> dict[str, str]:
    """skill name -> pack name, for pack members only."""
    return {skill: name for name, pack in packs.items() for skill in pack["skills"]}


def _within_projects(target: Path, projects: list[str]) -> bool:
    real = os.path.realpath(str(target))
    for project in projects:
        root = os.path.realpath(project)
        if real == root or real.startswith(root.rstrip(os.sep) + os.sep):
            return True
    return False


def _remove_deployed_skill(skill_path: Path, dry_run: bool) -> str:
    """Remove a sync-deployed skill copy or link. Returns 'REMOVE', 'OK' or 'ERROR'."""
    try:
        if skill_path.is_symlink():
            if not dry_run:
                skill_path.unlink()
            return "REMOVE"
        if skill_path.is_dir():
            if not dry_run:
                shutil.rmtree(skill_path)
            return "REMOVE"
        return "OK"
    except OSError as e:
        print(f"  ERROR removing {skill_path}: {e}")
        return "ERROR"


def _remove_global_pack_skill(link_path: Path, skill_dir: Path, master_content: str,
                              dry_run: bool) -> str:
    """Take a pack skill out of a machine-wide skills directory.

    Only removes what the catalogue put there: a symlink resolving to the
    catalogue skill, or a copied directory whose SKILL.md matches the master.
    Anything else is left alone and reported.
    """
    try:
        if link_path.is_symlink():
            if os.path.realpath(str(link_path)) == os.path.realpath(str(skill_dir)):
                if not dry_run:
                    link_path.unlink()
                return "REMOVE"
            return "FOREIGN"
        if link_path.is_dir():
            copied = link_path / "SKILL.md"
            if copied.is_file() and copied.read_text(encoding="utf-8") == master_content:
                if not dry_run:
                    shutil.rmtree(link_path)
                return "REMOVE"
            return "FOREIGN"
        return "OK"
    except OSError as e:
        print(f"  ERROR removing {link_path}: {e}")
        return "ERROR"


def skills_catalogue_dirty_paths(catalogue_dir: Path | None = None) -> list[str] | None:
    """Path-scoped dirty check for the skill catalogue.

    Returns ``[]`` when every file under the catalogue matches its committed
    bytes, the offending ``git status --porcelain`` entries (untracked files
    included) when it does not, and ``None`` when git cannot answer: not a
    repository, git missing, or the command failed. The gate treats ``None``
    as dirty. Only proven cleanliness deploys.

    The check is scoped to the catalogue on purpose. The DevFlow worktree
    carries ~1,800 unrelated dirty entries; a repo-wide check would never pass.
    """
    catalogue_dir = Path(catalogue_dir or SKILLS_MASTER_DIR)
    try:
        prefix = subprocess.run(
            ["git", "-C", str(catalogue_dir), "rev-parse", "--show-prefix"],
            capture_output=True, text=True, timeout=30,
        )
        status = subprocess.run(
            ["git", "-C", str(catalogue_dir), "status", "--porcelain",
             "--untracked-files=all", "--", "."],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if prefix.returncode != 0 or status.returncode != 0:
        return None
    root_prefix = prefix.stdout.strip()
    dirty: list[str] = []
    for line in status.stdout.splitlines():
        if len(line) < 4:
            continue
        path = line[3:]
        if " -> " in path:  # rename "old -> new": the new path is what is live
            path = path.split(" -> ", 1)[1]
        if len(path) >= 2 and path[0] == '"' and path[-1] == '"':
            path = path[1:-1]
        # porcelain v1 paths are repo-root relative; make them catalogue relative
        relative = path[len(root_prefix):] if root_prefix and path.startswith(root_prefix) else path
        if relative in SKILLS_GENERATED_FILES:
            continue
        dirty.append(line)
    return dirty


def skills_catalogue_gate(allow_dirty: bool, *, dry_run: bool = False) -> bool:
    """Refuse to deploy an uncommitted catalogue unless explicitly overridden.

    Fail-closed: a modified skill, an untracked skill, or an unanswerable git
    query all refuse. The override and the diagnostic ship together so a
    refusal is never a dead end (the design_reference_gate fleet-mute
    regression came from a gate that shipped without its escape hatch).
    Returns True when deployment may proceed.
    """
    dirty = skills_catalogue_dirty_paths()
    if dirty == []:
        return True
    catalogue = SKILLS_MASTER_DIR
    if dirty is None:
        reason = (f"git could not report the catalogue's status "
                  f"(is {catalogue} inside a git repository?)")
    else:
        reason = f"{len(dirty)} path(s) differ from the committed catalogue"
    if allow_dirty:
        print(f"  ! Deploying an UNCOMMITTED skill catalogue on explicit override "
              f"(--skills-allow-dirty): {reason}")
        for entry in (dirty or [])[:20]:
            print(f"      {entry}")
        return True
    print(f"SKILLS DEPLOYMENT REFUSED{' (dry run)' if dry_run else ''}: {reason}.")
    print("  Sync deploys the committed catalogue only, so an unreviewed edit cannot")
    print("  reach every agent directory. No skill files were written.")
    for entry in (dirty or [])[:50]:
        print(f"      {entry}")
    print(f"  Commit it:      git -C '{catalogue}' add . && "
          f"git -C '{catalogue}' commit -m 'skills: <what changed>'")
    print("  Deploy anyway:  sync.py --skills-only --skills-allow-dirty")
    return False


def deploy_skills(teams: dict,
                  agents: list[dict],
                  agent_filter: str | None = None,
                  dry_run: bool = False,
                  verbose: bool = False,
                  symlink_host: bool = False,
                  allow_dirty: bool = False,
                  skill_filter: str | None = None,
                  ) -> dict:
    """Deploy skill SKILL.md files to agent directories and host ~/.claude/skills/.

    Refuses (fail-closed) when the catalogue has uncommitted changes unless
    ``allow_dirty`` is set; see ``skills_catalogue_gate``.

    For each skill directory under ~/DevFlow/data/skills/ (excluding matrix.json):
    1. Copy SKILL.md to each agent's <teamDir>/.claude/skills/<name>/SKILL.md
    2. If symlink_host: symlink ~/.claude/skills/<name> -> ~/DevFlow/data/skills/<name>/
       Otherwise: copy SKILL.md to ~/.claude/skills/<name>/SKILL.md (host-level)
    3. Regenerate matrix.json with current skill list
    """
    stats = {"created": 0, "updated": 0, "removed": 0, "ok": 0, "errors": 0, "refused": False}

    if not SKILLS_MASTER_DIR.exists():
        print("No skills directory found at", str(SKILLS_MASTER_DIR))
        return stats

    skill_dirs = sorted([
        d for d in SKILLS_MASTER_DIR.iterdir()
        if d.is_dir() or (d.is_symlink() and d.is_dir())
    ])

    all_skill_dirs = skill_dirs
    if skill_filter:
        skill_dirs = [d for d in skill_dirs if d.name == skill_filter]
    if not skill_dirs:
        print("No matching skill directories found.")
        stats["errors"] += 1
        return stats

    print(f"\nSkills Deployment — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 50)
    print(f"Skills: {len(skill_dirs)} | Agents: {len(agents)}")
    if dry_run:
        print("DRY RUN — no files will be written")
    print()

    if not skills_catalogue_gate(allow_dirty, dry_run=dry_run):
        stats["refused"] = True
        return stats

    try:
        packs = load_skill_packs()
    except SkillPackError as error:
        print(f"SKILLS DEPLOYMENT REFUSED: {error}. No skill files were written.")
        stats["refused"] = True
        return stats
    pack_of = skill_pack_index(packs)
    catalogue_names = {d.name for d in all_skill_dirs}
    for skill in sorted(set(pack_of) - catalogue_names):
        print(f"  ! WARNING: packs.json lists '{skill}' (pack '{pack_of[skill]}'), "
              f"which is not in the catalogue.")

    filtered_agents = agents
    if agent_filter:
        filtered_agents = [a for a in agents if a["name"].lower() == agent_filter.lower()]
        if not filtered_agents:
            print(f"ERROR: Agent '{agent_filter}' not found in agents.json")
            return stats

    for skill_dir in skill_dirs:
        skill_name = skill_dir.name
        master_skill = skill_dir / "SKILL.md"

        if not master_skill.exists():
            # A catalog directory with no SKILL.md is a defect, not a no-op. The
            # skill silently leaves matrix.json while agent copies keep the old
            # body, so agents hold a skill their own catalog no longer lists.
            # Warn unconditionally; deployed copies can restore the master.
            deployed = sorted(Path(_MACHINE_CONFIG["homeDir"]).glob(f"*/Team/*/.claude/skills/{skill_name}/SKILL.md"))
            print(f"  ! WARNING: skill '{skill_name}' has no SKILL.md in "
                  f"{skill_dir} — it will be absent from matrix.json.")
            if deployed:
                print(f"    {len(deployed)} deployed copies still exist, e.g. {deployed[0]}")
                print(f"    Restore with: cp '{deployed[0]}' '{master_skill}'")
            else:
                print("    No deployed copies found to restore from.")
            continue

        master_content = master_skill.read_text(encoding="utf-8")
        pack = pack_of.get(skill_name)
        pack_projects = packs[pack]["projects"] if pack else []

        # Deploy to each canonical agent home and every dedicated project
        # presence. A role can run from several Project/Team/Agent workspaces;
        # copying only to the name's canonical roster path makes slash skills
        # silently unavailable in the other live sessions.
        for agent in filtered_agents:
            for agent_team_dir in skill_target_dirs(teams, agent):
                agent_skill_path = agent_team_dir / ".claude" / "skills" / skill_name / "SKILL.md"

                if pack and not _within_projects(agent_team_dir, pack_projects):
                    # Pack skill, agent outside every opted-in project: make sure
                    # an earlier global deployment does not linger here.
                    action = _remove_deployed_skill(agent_skill_path.parent, dry_run)
                    if action == "REMOVE":
                        print(f"  {agent['name']} [{agent_team_dir}]: REMOVE "
                              f".claude/skills/{skill_name} (pack '{pack}', not opted in)")
                        stats["removed"] += 1
                    elif action == "ERROR":
                        stats["errors"] += 1
                    continue

                action = _copy_skill_file(master_content, agent_skill_path, dry_run)

                # A SKILL.md may reference sibling files — design-reference-discovery
                # tells the agent to read references/source-library.md before it
                # searches. Copying only SKILL.md leaves that a dead link in every
                # agent's local copy, so the skill cannot complete its own workflow.
                for extra in sorted(skill_dir.rglob("*")):
                    if not extra.is_file() or extra == master_skill:
                        continue
                    rel = extra.relative_to(skill_dir)
                    extra_target = agent_skill_path.parent / rel
                    try:
                        extra_action = _copy_skill_file(
                            extra.read_text(encoding="utf-8"), extra_target, dry_run
                        )
                    except (UnicodeDecodeError, OSError):
                        continue
                    if extra_action in ("CREATE", "UPDATE"):
                        print(
                            f"  {agent['name']} [{agent_team_dir}]: {extra_action} "
                            f".claude/skills/{skill_name}/{rel}"
                        )
                        stats["created" if extra_action == "CREATE" else "updated"] += 1
                if action in ("CREATE", "UPDATE"):
                    print(
                        f"  {agent['name']} [{agent_team_dir}]: {action} "
                        f".claude/skills/{skill_name}/SKILL.md"
                    )
                    stats["created" if action == "CREATE" else "updated"] += 1
                elif action == "OK":
                    stats["ok"] += 1
                elif action == "ERROR":
                    stats["errors"] += 1

        if pack:
            # Pack skills stay out of the machine-wide lists, which every
            # session on every project loads.
            shared_agents = Path(_MACHINE_CONFIG["homeDir"]) / ".agents" / "skills"
            global_dirs = [("~/.claude/skills", HOST_SKILLS_DIR / skill_name),
                           ("~/.agents/skills", shared_agents / skill_name)]
            if WINDOWS_SKILLS_DIR:
                global_dirs.append(("Windows ~/.claude/skills", WINDOWS_SKILLS_DIR / skill_name))
            for label, link in global_dirs:
                action = _remove_global_pack_skill(link, skill_dir, master_content, dry_run)
                if action == "REMOVE":
                    print(f"  host: REMOVE {label}/{skill_name} (pack '{pack}')")
                    stats["removed"] += 1
                elif action == "FOREIGN":
                    print(f"  ! host: {label}/{skill_name} is not a catalogue copy; left in place")
                elif action == "ERROR":
                    stats["errors"] += 1
            continue

        # Deploy to host ~/.claude/skills/
        if symlink_host:
            host_link_path = HOST_SKILLS_DIR / skill_name
            action = _symlink_skill_dir(skill_dir, host_link_path, dry_run)
            if action in ("CREATE", "UPDATE"):
                print(f"  host: {action} ~/.claude/skills/{skill_name} -> {skill_dir}")
                stats["created" if action == "CREATE" else "updated"] += 1
            elif action == "OK":
                stats["ok"] += 1
            elif action == "ERROR":
                stats["errors"] += 1
        else:
            host_skill_path = HOST_SKILLS_DIR / skill_name / "SKILL.md"
            action = _copy_skill_file(master_content, host_skill_path, dry_run)
            if action in ("CREATE", "UPDATE"):
                print(f"  host: {action} ~/.claude/skills/{skill_name}/SKILL.md")
                stats["created" if action == "CREATE" else "updated"] += 1
            elif action == "OK":
                stats["ok"] += 1
            elif action == "ERROR":
                stats["errors"] += 1

        # Windows host copy for PowerShell agents (symlinks into WSL don't resolve there).
        if WINDOWS_SKILLS_DIR:
            for source in sorted(skill_dir.rglob("*")):
                if not source.is_file():
                    continue
                rel = source.relative_to(skill_dir)
                try:
                    content = master_content if rel.as_posix() == "SKILL.md" else source.read_text(encoding="utf-8")
                except (UnicodeDecodeError, OSError):
                    continue
                action = _copy_skill_file(content, WINDOWS_SKILLS_DIR / skill_name / rel, dry_run)
                if action in ("CREATE", "UPDATE"):
                    stats["created" if action == "CREATE" else "updated"] += 1
                elif action == "OK":
                    stats["ok"] += 1
                elif action == "ERROR":
                    stats["errors"] += 1

    # Regenerate matrix.json
    _regenerate_matrix(all_skill_dirs, dry_run, packs)

    print(f"\n{'=' * 50}")
    print(f"Summary: {stats['created']} created, {stats['updated']} updated, "
          f"{stats['ok']} unchanged, {stats['removed']} removed"
          + (f", {stats['errors']} errors" if stats["errors"] else ""))

    return stats


def _copy_skill_file(content: str, target: Path, dry_run: bool) -> str:
    """Copy skill content to target path. Returns 'CREATE', 'UPDATE', 'OK', or 'ERROR'."""
    try:
        existed = target.exists()
        if existed:
            existing = target.read_text(encoding="utf-8")
            if existing == content:
                return "OK"
            if dry_run:
                return "UPDATE"
        else:
            if dry_run:
                return "CREATE"

        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return "CREATE" if not existed else "UPDATE"
    except OSError as e:
        print(f"  ERROR writing {target}: {e}")
        return "ERROR"


def _symlink_skill_dir(src_dir: Path, link_path: Path, dry_run: bool) -> str:
    """Create or update a symlink at link_path pointing to src_dir.
    If link_path exists as a regular directory, replace it with the symlink.
    Returns 'CREATE', 'UPDATE', 'OK', or 'ERROR'."""
    try:
        if link_path.is_symlink():
            current_target = link_path.readlink()
            if current_target == src_dir:
                return "OK"
            # Symlink exists but points wrong — update it (if not dry_run)
            if not dry_run:
                link_path.unlink()
                link_path.symlink_to(src_dir)
            return "UPDATE"
        elif link_path.is_dir():
            # Regular directory from old copy-based deploy — replace with symlink
            if not dry_run:
                shutil.rmtree(link_path)
                link_path.symlink_to(src_dir)
            return "UPDATE"
        elif link_path.exists():
            # Unusual: exists as file or broken symlink — remove and replace
            if not dry_run:
                link_path.unlink()
                link_path.symlink_to(src_dir)
            return "UPDATE"
        else:
            if not dry_run:
                link_path.parent.mkdir(parents=True, exist_ok=True)
                link_path.symlink_to(src_dir)
            return "CREATE"
    except OSError as e:
        print(f"  ERROR symlinking {link_path}: {e}")
        return "ERROR"


def _skill_description(skill_md: Path) -> str:
    """Return a SKILL.md's frontmatter description as a single line.

    The catalog is how an agent decides whether a skill is relevant without
    opening every file. A name alone ("web-3d", "harness") does not carry the
    trigger conditions the author wrote, so the description has to travel with
    it. Parsed by hand rather than adding a YAML dependency: frontmatter is the
    block between the first two `---` lines, and `description` is either an
    inline value or a folded block whose continuation lines are indented.
    """
    try:
        text = skill_md.read_text(encoding="utf-8")
    except Exception:
        return ""
    if not text.startswith("---"):
        return ""
    end = text.find("\n---", 3)
    if end == -1:
        return ""
    lines = text[3:end].splitlines()

    collected: list[str] = []
    capturing = False
    for line in lines:
        if capturing:
            # A new top-level key ends the block; anything indented continues it.
            if line and not line[0].isspace():
                break
            collected.append(line.strip())
            continue
        stripped = line.strip()
        if stripped.startswith("description:"):
            inline = stripped[len("description:"):].strip()
            if inline and inline not in (">", "|", ">-", "|-"):
                collected.append(inline)
                break
            capturing = True
    return " ".join(part for part in collected if part).strip()


def _regenerate_matrix(skill_dirs: list[Path], dry_run: bool, packs: dict | None = None) -> None:
    """Regenerate matrix.json with current skill directory listing.

    Pack members carry ``pack``; the ``packs`` map says which projects opted in,
    so a runtime that reads this catalogue can skip packs its project lacks.
    """
    packs = packs or {}
    pack_of = skill_pack_index(packs)
    skills = []
    for d in skill_dirs:
        skill_md = d / "SKILL.md"
        if not skill_md.exists():
            continue
        entry = {
            "name": d.name,
            "description": _skill_description(skill_md),
            "path": str(d),
            "skillFile": str(skill_md),
        }
        if d.name in pack_of:
            entry["pack"] = pack_of[d.name]
        skills.append(entry)

    matrix = {
        "updated": datetime.now().isoformat(),
        "skillCount": len(skills),
        "skills": skills,
        "packs": packs,
    }

    if not dry_run:
        SKILLS_MATRIX_PATH.write_text(json.dumps(matrix, indent=2), encoding="utf-8")
        print(f"\n  matrix.json regenerated: {len(skills)} skills")
    else:
        print(f"\n  [DRY RUN] matrix.json would be regenerated: {len(skills)} skills")


# ---------------------------------------------------------------------------
# Model drift detection
# ---------------------------------------------------------------------------

def _load_json_safe(path: Path) -> dict | list | None:
    """Load JSON file, return None on any error."""
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


_CHANNELS_CACHE: list = []


def _devflow_runs_elsewhere() -> bool:
    """True when the service registry places DevFlow on another machine.

    Then localhost:3000 is only a forwarder and the local .AppData copy is the
    stale rollback, so the roster must come from the API even on localhost.
    """
    try:
        registry = json.loads(RUNTIME_REGISTRY.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    services = registry.get("services", [])
    # Hostnames come from the registry; the environment is ignored so this stays a statement about this machine.
    here = "server" if (_rl_detect_location(registry, environ={}) or "").startswith("server") else "desktop"
    return any(s.get("env") == "DEVFLOW_URL" and s.get("runsOn") not in (None, here) for s in services)


def load_channels_data() -> dict | list | None:
    """The channel list (with rosters) from the DevFlow that owns it.

    When DEVFLOW_URL names another machine (agents on the desktop, DevFlow on
    the server), the local .AppData copy is stale or absent, so read the live
    list from that server's API. Unreachable then means None, never a silent
    fallback to the stale local file. Fetched once per run.
    """
    if _CHANNELS_CACHE:
        return _CHANNELS_CACHE[0]
    url = (os.environ.get("DEVFLOW_URL") or "http://localhost:3000").rstrip("/")
    host = urllib.parse.urlparse(url).hostname
    if host not in ("localhost", "127.0.0.1", "::1") or _devflow_runs_elsewhere():
        try:
            with urllib.request.urlopen(f"{url}/api/collab?action=channels", timeout=15) as resp:
                data = json.loads(resp.read())
        except Exception as error:  # noqa: BLE001 - report and continue
            print(f"  ! Channels unavailable from {url}: {error}", file=sys.stderr)
            data = None
    else:
        data = _load_json_safe(_CHANNELS_PATH)
    _CHANNELS_CACHE.append(data)
    return data


def _resolve_model(agent_name: str, role_slug: str, agent_type: str,
                   configured: dict, models_data: dict) -> str | None:
    """
    Mirror of TypeScript resolveModelFromRegistry() — three-layer lookup:
      1. configuredModels.json overrides  (per-agent)
      2. models.json roleDefaults         (role + agentType)
      3. models.json isDefault:true       (global provider default)
    """
    # Layer 1: per-agent override
    override = (configured.get("overrides") or {}).get(agent_name)
    if override and override.get("model"):
        return override["model"]

    # Layer 2: roleDefaults
    role_defaults = models_data.get("roleDefaults") or {}
    role_entry = role_defaults.get(role_slug) or role_defaults.get("_default")
    if role_entry and agent_type in role_entry:
        return role_entry[agent_type]

    # Layer 3: isDefault for agentType
    for m in models_data.get("models") or []:
        if agent_type in (m.get("agentTypes") or []) and m.get("isDefault"):
            return m["id"]

    return None


def check_model_drift() -> list[str]:
    """
    Compare each roster agent's actual model against the central registry.
    Returns list of warning strings (empty = no drift).

    Data sources:
      - collab-channels.json  → actual model per roster agent
      - roles.json            → roleId → slug mapping
      - configuredModels.json → overrides (layer 1 of resolution)
      - models.json           → roleDefaults + isDefault (layers 2-3)
    """
    warnings: list[str] = []

    channels_data = load_channels_data()
    configured = _load_json_safe(_CONFIGURED_MODELS_PATH) or {}
    models_data = _load_json_safe(MODELS_PATH) or {}
    roles_raw = _load_json_safe(_ROLES_PATH)

    if not channels_data:
        return []  # Can't check without roster data

    # Build roleId → slug map
    roles_list = roles_raw if isinstance(roles_raw, list) else (roles_raw or {}).get("roles", [])
    role_slug_map: dict[str, str] = {r["id"]: r["slug"] for r in roles_list if r.get("id") and r.get("slug")}

    channels = channels_data if isinstance(channels_data, list) else channels_data.get("channels", [])
    seen: set[str] = set()  # deduplicate agents appearing in multiple channels

    for channel in channels:
        if not isinstance(channel, dict):
            continue
        roster = channel.get("roster") or {}
        agents = roster.get("agents", []) if isinstance(roster, dict) else []
        for agent in agents:
            if not isinstance(agent, dict):
                continue
            name = agent.get("name", "")
            actual = agent.get("model")
            if not name or not actual or name in seen:
                continue
            seen.add(name)

            role_id = agent.get("roleId", "")
            role_slug = role_slug_map.get(role_id, "")
            agent_type = agent.get("agentType") or "claude"

            expected = _resolve_model(name, role_slug, agent_type, configured, models_data)
            if expected and actual != expected:
                warnings.append(
                    f"[MODEL DRIFT] {name}: expected={expected} actual={actual}"
                    f" (role={role_slug or 'unknown'}, type={agent_type})"
                )

    return warnings


# ---------------------------------------------------------------------------
# Multi-presence discovery — Sprint Hermes-postmortem Fix 3 (Reynolds, 2026-05-27)
#
# Agents can have several dedicated ``<project>/Team/<agent>`` workspaces via
# channel rosters while agents.json has one home record. Each dedicated
# workspace needs one complete scaffold. Bare project roots are shared and
# therefore externally managed; an agent-specific entry point there would be
# ambiguous and its relative rule imports would be incomplete.
#
# After the default pass, discover distinct roster presences, deploy complete
# scaffolds only to dedicated workspaces, and report shared roots without
# writing them.
# ---------------------------------------------------------------------------


def _derived_agent_dir(agent_name: str, working_directory: str) -> str:
    """The agent dir DevFlow spawns into, for a roster entry that has no effectiveWorkingDirectory yet.

    DevFlow records effectiveWorkingDirectory only after a spawn finishes, but runs this sync during
    the first spawn. Mirror its rule (message-inject agentWorkDir) so a brand-new agent's identity
    files are written on that first spawn instead of being skipped as "absent".
    """
    if not working_directory:
        return ""
    safe = re.sub(r"-+", "-", re.sub(r"[^a-zA-Z0-9_-]", "-", agent_name)).strip("-") or "agent"
    base = working_directory.rstrip("/")
    if base.endswith(f"/Team/{safe}") or base.endswith(f"/{safe}"):
        return base
    return os.path.join(working_directory, "Team", safe)


def discover_agent_presences(agent_name: str) -> list[dict]:
    """Return distinct (workingDirectory, agentType) tuples for an agent
    across every channel roster in collab-channels.json.

    Each dict has keys: workingDirectory, agentType (lowercased str or None),
    roleId, personality, channelId, and channelName. Exact duplicate identity
    assignments are coalesced, but two channels that assign different roles or
    personalities to the same cwd remain visible so identity sync can refuse
    to guess.

    Prefers `effectiveWorkingDirectory` over `workingDirectory` (CJack note
    2026-05-27): DevFlow computes effective at provision time as
    `<wd>/Team/<name>` — the correct per-agent subdir. Without honouring
    it, presence deploys land at the project root (Sam's roster wd is
    `~/DevFlow`, polluting the DevFlow repo). Falls back to
    workingDirectory only when effective is null/missing.
    """
    data = load_channels_data()
    if not data:
        return []
    channels = data if isinstance(data, list) else data.get("channels", [])
    out: list[dict] = []
    seen: set[tuple[str, str | None, str | None, str | None]] = set()
    for ch in channels:
        if not isinstance(ch, dict):
            continue
        roster = ch.get("roster") or {}
        agents = roster.get("agents", []) if isinstance(roster, dict) else []
        for a in agents:
            if not isinstance(a, dict):
                continue
            if (a.get("name") or "").lower() != agent_name.lower():
                continue
            wd = a.get("effectiveWorkingDirectory") or _derived_agent_dir(a.get("name") or "", a.get("workingDirectory") or "")
            at = (a.get("agentType") or "").lower() or None
            if not wd:
                continue
            role_id = str(a.get("roleId")) if a.get("roleId") else None
            personality = str(a.get("personality")) if a.get("personality") else None
            key = (wd, at, role_id, personality)
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "workingDirectory": wd,
                "agentType": at,
                "roleId": role_id,
                "personality": personality,
                "channelId": ch.get("id"),
                "channelName": ch.get("name"),
            })
    return out


def _presence_channel_names(presences: list[dict], working_directory: str) -> set[str]:
    """Channel names whose roster puts this agent in `working_directory`.

    Presence passes judge `channel:` conditions by the channels that use
    that cwd, not every channel the agent belongs to. Otherwise a client
    project presence of an SG-1 agent receives SG-1-only files (Mission.md).
    """
    target = os.path.normpath(working_directory)
    return {
        str(p.get("channelName"))
        for p in presences
        if p.get("channelName") and os.path.normpath(p.get("workingDirectory") or "") == target
    }


def _agent_with_dir_override(agent: dict, override_dir: str,
                             override_agent_type: str | None = None) -> dict:
    """Synthesize an agent record whose AGENT_DIR/TEAM_DIR resolve to
    `override_dir` instead of the team-derived path. Used by the
    presence pass (Fix 3) and the `--target-dir` CLI flag.

    Sets `agentDir` + `teamDir` directly — build_vars()'s lines 162-167
    prefer those over the team-derived defaults, so no other call sites
    need to change. When the override is a canonical
    ``<project>/Team/<agent>`` workspace, also derive ``projectDir`` from it;
    otherwise a project presence inherits the agent's SG-1 home project and
    renders a misleading Workspace.md on every respawn.
    """
    synth = dict(agent)
    synth["agentDir"] = override_dir
    synth["teamDir"] = override_dir
    override_path = Path(override_dir)
    if (
        override_path.parent.name == "Team"
        and override_path.name.casefold() == str(agent.get("name", "")).casefold()
    ):
        synth["projectDir"] = str(override_path.parent.parent)
    if override_agent_type:
        synth["agentType"] = override_agent_type
    return synth


def is_agent_owned_presence(agent_name: str, working_directory: str) -> bool:
    """Return True when a roster cwd is the agent's dedicated workspace.

    DevFlow's provisioner uses ``<project>/Team/<agent>`` for these directories.
    They should receive the complete scaffold, while a shared project root must
    receive only runtime entry files so we do not pollute the application repo.
    """
    path = Path(working_directory)
    return (
        path.name.casefold() == agent_name.casefold()
        and path.parent.name.casefold() == "team"
    )


def _role_registry() -> tuple[dict[str, dict], dict[str, dict]]:
    raw = _load_json_safe(_ROLES_PATH) or {}
    roles = raw if isinstance(raw, list) else raw.get("roles", [])
    by_id = {r["id"]: r for r in roles if isinstance(r, dict) and r.get("id")}
    by_name: dict[str, dict] = {}
    for role in roles:
        if not isinstance(role, dict):
            continue
        for value in (role.get("name"), role.get("slug")):
            if value:
                by_name[str(value).casefold()] = role
    return by_id, by_name


def _find_personality_path(name: str | None) -> Path | None:
    if not name or not _PERSONALITIES_DIR.is_dir():
        return None
    wanted = name.casefold()
    for candidate in _PERSONALITIES_DIR.glob("*.md"):
        if candidate.stem.casefold() == wanted:
            return candidate
    return None


def resolve_identity_sources(agent: dict, presence: dict | None = None) -> tuple[Path | None, Path | None]:
    """Return canonical (personality, role) paths for one presence."""
    by_id, by_name = _role_registry()
    presence = presence or {}
    explicit_role_id = presence.get("roleId")
    role = by_id.get(str(explicit_role_id)) if explicit_role_id else None
    if role is None and not explicit_role_id:
        for value in (agent.get("roleSlug"), agent.get("role")):
            if value and str(value).casefold() in by_name:
                role = by_name[str(value).casefold()]
                break
    role_path = None
    if role:
        candidate = _ROLES_DIR / str(role.get("slug", ""))
        candidate = candidate.with_suffix(".md")
        if candidate.is_file():
            role_path = candidate

    personality_name = presence.get("personality") or agent.get("personality") or agent.get("name")
    return _find_personality_path(str(personality_name) if personality_name else None), role_path


def _is_legacy_canonical_copy(existing: str, canonical: Path | None) -> bool:
    """Recognise only exact, explicitly registered pre-migration masters."""
    if canonical is None:
        return False
    try:
        canonical_key = canonical.relative_to(_DEVFLOW_DATA).as_posix()
    except ValueError:
        return False
    known_hashes = _LEGACY_IDENTITY_SHA256.get(canonical_key, frozenset())
    return hashlib.sha256(existing.encode("utf-8")).hexdigest() in known_hashes


def _matching_identity_presence(agent: dict, working_directory: str) -> tuple[dict | None, str]:
    """Resolve one target cwd to a single roster identity assignment.

    Returns ``(presence, 'matched')`` when all matching roster records resolve
    to the same role/personality, ``(None, 'absent')`` when the cwd is not in
    the roster, ``(None, 'ambiguous')`` when channels deliberately assign
    different identities to the same cwd, and ``(None, 'unresolved')`` when
    an explicit roster role/personality has no canonical source. The latter
    states must preserve the spawn-time pointer rather than guessing.
    """
    wanted = os.path.normpath(working_directory)
    matches = [
        presence
        for presence in discover_agent_presences(str(agent.get("name", "")))
        if os.path.normpath(str(presence.get("workingDirectory") or "")) == wanted
    ]
    if not matches:
        return None, "absent"

    resolved: dict[tuple[str | None, str | None], dict] = {}
    for presence in matches:
        personality, role = resolve_identity_sources(agent, presence)
        if (presence.get("roleId") and role is None) or (presence.get("personality") and personality is None):
            return None, "unresolved"
        key = (
            str(personality) if personality is not None else None,
            str(role) if role is not None else None,
        )
        resolved.setdefault(key, presence)
    if len(resolved) != 1:
        return None, "ambiguous"
    return next(iter(resolved.values())), "matched"


def _identity_result(target: Path, canonical: Path | None, kind: str,
                     dry_run: bool, check_only: bool) -> dict:
    fallback = (
        "# Personality\n\nNo personality configured. Be professional, plain-spoken and helpful.\n"
        if kind == "personality"
        else "# Directives\n\nNo role-specific directives configured. Follow the shared operating agreement.\n"
    )
    desired = f"@{canonical}\n" if canonical else fallback
    canonical_content = canonical.read_text(encoding="utf-8") if canonical else None
    if not target.exists():
        if check_only:
            return {"target": str(target), "action": "DRIFT", "skipped": False, "reason": "CREATE"}
        if not dry_run:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(desired, encoding="utf-8")
        return {"target": str(target), "action": "CREATE", "skipped": False, "reason": "missing identity"}

    existing = target.read_text(encoding="utf-8")
    trimmed = existing.strip()
    managed_pointer = trimmed.startswith(f"@{_ROLES_DIR}")
    placeholder = bool(re.search(r"No (?:role-specific directives|directives|personality) configured", trimmed, re.I))
    exact_frozen_copy = canonical_content is not None and trimmed == canonical_content.strip()
    legacy_frozen_copy = _is_legacy_canonical_copy(existing, canonical)
    if existing == desired:
        return {"target": str(target), "action": "OK", "skipped": False, "reason": "up to date"}
    if not (managed_pointer or placeholder or exact_frozen_copy or legacy_frozen_copy):
        return {"target": str(target), "action": "SKIP", "skipped": True,
                "reason": "project-owned identity override preserved"}
    if check_only:
        return {"target": str(target), "action": "DRIFT", "skipped": False, "reason": "UPDATE"}
    if not dry_run:
        target.write_text(desired, encoding="utf-8")
    return {"target": str(target), "action": "UPDATE", "skipped": False, "reason": "canonical identity pointer"}


def sync_identity_files(agent: dict, working_directory: str,
                        presence: dict | None = None,
                        dry_run: bool = False, check_only: bool = False) -> list[dict]:
    """Safely manage role/personality pointers for a dedicated agent home."""
    personality_path, role_path = resolve_identity_sources(agent, presence)
    rules_dir = Path(working_directory) / ".claude" / "rules"
    return [
        _identity_result(rules_dir / "Personality.md", personality_path, "personality", dry_run, check_only),
        _identity_result(rules_dir / "Directives.md", role_path, "directives", dry_run, check_only),
    ]


def verify_identity_files(agent: dict, working_directory: str,
                          presence: dict | None = None) -> list[dict]:
    rows = []
    for result in sync_identity_files(agent, working_directory, presence, check_only=True):
        filename = Path(result["target"]).name
        status = {
            "OK": "synced",
            "DRIFT": "missing" if result["reason"] == "CREATE" else "drift",
            "SKIP": "agent-owned",
        }.get(result["action"], "identity-error")
        rows.append({
            "entryId": "identity-personality" if filename == "Personality.md" else "identity-directives",
            "source": "identity",
            "masterPath": None,
            "target": result["target"],
            "path": result["target"],
            "status": status,
            "drift": status == "drift",
            "localSha256": _sha256_file(Path(result["target"])),
            "masterSha256": None,
            "mtime": _iso_mtime(Path(result["target"])),
            "reason": result["reason"],
        })
    return rows


def skill_target_dirs(teams: dict, agent: dict) -> list[Path]:
    """Return every dedicated workspace that must receive local skills.

    The default team-derived home remains the baseline. Multi-channel agents
    also receive skills in each roster presence whose cwd is a dedicated
    ``Project/Team/Agent`` directory. Shared project roots are excluded so skill
    deployment never pollutes application repositories.
    """
    targets = {Path(build_vars(agent, teams)["TEAM_DIR"])}
    for presence in discover_agent_presences(agent["name"]):
        working_directory = presence.get("workingDirectory") or ""
        if not working_directory:
            continue
        if os.name != "nt" and re.match(r"^[A-Za-z]:[\\/]", working_directory):
            # A Windows-native cwd is not a usable absolute path in WSL/POSIX;
            # Path() would treat it as relative and create a literal ``C:\``
            # directory under DevFlow. Windows scaffolding uses its own bridge.
            continue
        if is_agent_owned_presence(agent["name"], working_directory):
            targets.add(Path(working_directory))
            continue

        # Legacy stopped roster entries may retain only the project root even
        # though their provisioned Team/<agent> workspace still exists. Resolve
        # that dedicated child without ever writing skills into the shared root.
        inferred = Path(working_directory) / "Team" / agent["name"]
        if inferred.is_dir() and is_agent_owned_presence(agent["name"], str(inferred)):
            targets.add(inferred)
    return sorted(targets, key=str)


# ---------------------------------------------------------------------------
# Main sync loop
# ---------------------------------------------------------------------------

def run_sync(teams: dict,
    agents: list[dict],
    manifest: dict,
    agent_filter: str | None = None,
    file_filter: str | None = None,
    dry_run: bool = False,
    check_only: bool = False,
    verbose: bool = False,
    symlink_host: bool = False,
    target_dir_override: str | None = None,
    target_agent_type_override: str | None = None,
    skip_presences: bool = False,
    skills_allow_dirty: bool = False,
) -> dict:
    """Run sync across all agents and manifest entries. Returns summary stats.

    target_dir_override: when set, the default per-agent pass deploys to this
        dedicated ``<project>/Team/<agent>`` directory (AGENT_DIR + TEAM_DIR
        overridden). Shared roots are externally managed because an
        agent-specific entry point there would be ambiguous and could contain
        unresolved local imports. Suppresses the auto presence pass.

    target_agent_type_override: runtime for the targeted workspace. This is
        optional because an exact roster presence is used when available.
        It remains useful for callers preparing a target before that presence
        has been persisted.

    skip_presences: when True, skip the automatic per-presence pass that
        discovers additional cwd's from collab-channels.json roster. Useful
        for legacy crons that don't want surprise extra writes.
    """
    stats = {"created": 0, "updated": 0, "removed": 0, "ok": 0, "skipped": 0, "errors": 0, "drift": 0}
    drift_items = []
    known_models = load_models()  # Derived from models.json — used for condition validation

    print(f"\nScaffolding {'Drift Check' if check_only else 'Sync'} — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 50)
    print(f"Agents: {len(agents)} | Files: {len(manifest['files'])} manifested")
    if dry_run:
        print("DRY RUN — no files will be written")

    # Alignment coverage is a harness concern, not a provider/model concern.
    # Only adapters which declare an alignment file are required to have one;
    # providers that run through another harness do not need duplicate policy.
    if check_only:
        missing_alignment = []
        covered_alignment = []
        for adapter in ADAPTER_REGISTRY:
            if not adapter.alignment_filename:
                continue
            alignment_file = MASTERS_DIR / "per-model" / adapter.family / adapter.alignment_filename
            if not alignment_file.exists():
                missing_alignment.append(adapter.family)
            else:
                covered_alignment.append(adapter.family)
        if missing_alignment:
            print(f"  ! ALIGNMENT GAP: harness adapters without alignment masters: {', '.join(sorted(missing_alignment))}")
        else:
            print(f"  ✓ Alignment coverage: {len(covered_alignment)} harness adapters with declared alignments are covered")

        # Model drift check: compare roster agents against central registry
        model_drift = check_model_drift()
        if model_drift:
            for w in model_drift:
                print(f"  ! {w}")
            print("  i Model warnings are advisory; scaffolding drift counts only file/load-path defects.")
        else:
            print(f"  ✓ Model registry: no drift detected")
    print()

    filtered_entries = manifest["files"]
    if file_filter:
        filtered_entries = [e for e in filtered_entries if file_filter in e["id"]]

    filtered_agents = agents
    if agent_filter:
        filtered_agents = [a for a in agents if a["name"].lower() == agent_filter.lower()]

    # Pre-compute _channelNames for each agent from collab-channels.json so
    # manifest entries can use channel:SG-1,Commander scoping conditions.
    # Each agent dict gets a set of channel names it belongs to.
    _agent_channels: dict[str, set[str]] = {}
    try:
        channels_data = load_channels_data() or {}
        ch_list = channels_data if isinstance(channels_data, list) else channels_data.get("channels", [])
        for ch in ch_list:
            if not isinstance(ch, dict):
                continue
            ch_name = ch.get("name", "")
            roster = ch.get("roster") or {}
            roster_agents = roster.get("agents", []) if isinstance(roster, dict) else []
            for ra in roster_agents:
                if not isinstance(ra, dict):
                    continue
                ra_name = ra.get("name", "")
                if ra_name:
                    _agent_channels.setdefault(ra_name, set()).add(ch_name)
    except Exception:
        pass
    for agent in filtered_agents:
        agent["_channelNames"] = _agent_channels.get(agent["name"], set())

    def _run_entry_pass(target_agent: dict,
                        category_whitelist: set[str] | None = None) -> bool:
        """Run sync for one (agent | synthesized presence-agent) across all
        matching manifest entries. Mutates `stats` / `drift_items` in the
        enclosing scope. Returns True if any visible output was produced.

        category_whitelist: when set, only manifest entries with
            entry['category'] in this set run.
        """
        had_output = False
        for entry in filtered_entries:
            if category_whitelist is not None and entry.get("category") not in category_whitelist:
                continue
            if not agent_matches_condition(target_agent, entry["condition"], known_models):
                if check_only:
                    continue
                for removed in retire_unmatched_entry(teams, entry, target_agent, dry_run=dry_run):
                    stats["removed"] += 1
                    print(f"    ✗ {Path(removed).name} — REMOVE (no longer matches {entry['condition']})")
                    had_output = True
                continue

            results = sync_file_entry(teams, entry, target_agent, dry_run=dry_run,
                                      check_only=check_only, verbose=verbose)
            if isinstance(results, dict):
                results = [results]

            for r in results:
                action = r["action"]
                target_short = Path(r["target"]).name

                if action == "OK":
                    stats["ok"] += 1
                    if verbose:
                        print(f"    ✓ {target_short} — up to date")
                elif action in ("CREATE", "UPDATE"):
                    stats["created" if action == "CREATE" else "updated"] += 1
                    print(f"    {'★' if action == 'CREATE' else '↻'} {target_short} — {action}")
                    had_output = True
                elif action == "DRIFT":
                    stats["drift"] += 1
                    full_path = r["target"]
                    drift_items.append(f"  DRIFT: {full_path} — {r['reason']}")
                    print(f"    ✗ {target_short} — DRIFT ({r['reason']})")
                    had_output = True
                elif action == "SKIP":
                    stats["skipped"] += 1
                    if verbose:
                        print(f"    · {target_short} — skipped ({r['reason']})")
                elif action == "ERROR":
                    stats["errors"] += 1
                    print(f"    ! {target_short} — ERROR: {r['reason']}")
                    had_output = True
        return had_output

    for agent in filtered_agents:
        print(f"  {agent['name']}:")
        agent_has_output = False
        identity_dirs: set[str] = set()

        def _run_identity_pass(directory: str, presence: dict | None = None) -> None:
            nonlocal agent_has_output
            if directory in identity_dirs or not is_agent_owned_presence(agent["name"], directory):
                return
            identity_dirs.add(directory)
            for result in sync_identity_files(
                agent, directory, presence, dry_run=dry_run, check_only=check_only,
            ):
                action = result["action"]
                short = Path(result["target"]).name
                if action == "OK":
                    stats["ok"] += 1
                elif action in ("CREATE", "UPDATE"):
                    stats["created" if action == "CREATE" else "updated"] += 1
                    print(f"    {'★' if action == 'CREATE' else '↻'} {short} — {action}")
                    agent_has_output = True
                elif action == "DRIFT":
                    stats["drift"] += 1
                    drift_items.append(f"  DRIFT: {result['target']} — {result['reason']}")
                    print(f"    ✗ {short} — DRIFT ({result['reason']})")
                    agent_has_output = True
                else:
                    stats["skipped"] += 1
                    if verbose:
                        print(f"    · {short} — skipped ({result['reason']})")

        # Default pass — honour target_dir_override when set, else use the
        # agent's team-derived path (build_vars resolves it from teamId).
        if target_dir_override:
            resolved_target_agent_type = target_agent_type_override
            if not resolved_target_agent_type:
                target_presence, target_match_state = _matching_identity_presence(
                    agent, target_dir_override,
                )
                if target_match_state == "matched":
                    resolved_target_agent_type = str(
                        target_presence.get("agentType") or ""
                    ) or None
            default_target = _agent_with_dir_override(
                agent, target_dir_override, resolved_target_agent_type,
            )
            if resolved_target_agent_type:
                # The target presence is one selected harness, not the union
                # of every model family recorded on the home agent.
                default_target["models"] = [resolved_target_agent_type]
            if is_agent_owned_presence(agent["name"], target_dir_override):
                agent_has_output |= _run_entry_pass(default_target)
                target_presence, match_state = _matching_identity_presence(agent, target_dir_override)
                if match_state == "matched":
                    _run_identity_pass(target_dir_override, target_presence)
                else:
                    # --target-dir has no channel identity argument.  On an
                    # absent/ambiguous roster match, preserving the pointer
                    # written by message-inject is safer than applying the
                    # agent's home/default role to a different channel.
                    stats["skipped"] += 1
                    if verbose:
                        print(f"    · identity — skipped ({match_state} roster assignment)")
            else:
                stats["skipped"] += 1
                print(f"    · {target_dir_override} — externally managed shared root")
                agent_has_output = True
        else:
            agent_has_output |= _run_entry_pass(agent)
            try:
                default_directory = build_vars(agent, teams)["TEAM_DIR"]
                default_presence, match_state = _matching_identity_presence(agent, default_directory)
                if match_state in {"ambiguous", "unresolved"}:
                    stats["skipped"] += 1
                    if verbose:
                        print(f"    · identity — skipped ({match_state} roster assignment)")
                else:
                    _run_identity_pass(default_directory, default_presence)
            except Exception:
                pass

        # Discover every distinct roster cwd. Dedicated agent workspaces get a
        # complete pass; shared roots are reported but not written. Skipped
        # when --target-dir names the one desired cwd or --skip-presences is set.
        if not skip_presences and not target_dir_override:
            presences = discover_agent_presences(agent["name"])
            if presences:
                # Compute the default pass's deploy dirs so we don't redundantly
                # re-write to the same paths the first pass already touched.
                default_dirs: set[str] = set()
                try:
                    dv = build_vars(agent, teams)
                    default_dirs.add(dv["AGENT_DIR"])
                    default_dirs.add(dv["TEAM_DIR"])
                except Exception:
                    pass
                deployed_runtime_presences: set[tuple[str, str]] = set()
                for presence in presences:
                    wd = presence["workingDirectory"]
                    if wd in default_dirs:
                        continue  # already deployed by the default pass
                    synth = _agent_with_dir_override(agent, wd, presence.get("agentType"))
                    # Narrow synth.models[] to ONLY the presence's agentType
                    # so per-model entries gated by `model:X` only fire for
                    # the runtime actually used in that channel. Without this,
                    # an agent with models=['claude','gemini','grok','hermes']
                    # would deploy GEMINI.md / GROK.md / alignment-* into
                    # every cwd, polluting client repos with files unrelated
                    # to that channel's runtime. Skip presences with no
                    # explicit agentType (roster didn't set one) — there's
                    # no signal for what to deploy.
                    presence_at = presence.get("agentType")
                    if not presence_at:
                        continue
                    runtime_key = (os.path.normpath(wd), str(presence_at))
                    if runtime_key in deployed_runtime_presences:
                        continue
                    deployed_runtime_presences.add(runtime_key)
                    synth["models"] = [presence_at]
                    synth["_channelNames"] = _presence_channel_names(presences, wd)
                    label = presence.get("channelName") or presence.get("channelId") or "?"
                    print(f"    ── presence: {wd}  (channel='{label}', agentType={presence_at})")
                    # Dedicated <project>/Team/<agent> workspaces are real
                    # agent homes and receive one coherent scaffold. A shared
                    # project root is externally managed: writing an
                    # agent-specific AGENTS.md/GEMINI.md there lets agents
                    # clobber one another and leaves relative rule imports
                    # unresolved because the full rule tree is intentionally
                    # absent.
                    if not is_agent_owned_presence(agent["name"], wd):
                        stats["skipped"] += 1
                        print(f"    · {wd} — externally managed shared root")
                        agent_has_output = True
                        continue
                    if _run_entry_pass(synth):
                        agent_has_output = True
                    identity_presence, identity_state = _matching_identity_presence(agent, wd)
                    if identity_state == "matched":
                        _run_identity_pass(wd, identity_presence)
                    elif identity_state in {"ambiguous", "unresolved"} and wd not in identity_dirs:
                        identity_dirs.add(wd)
                        stats["skipped"] += 1
                        if verbose:
                            print(f"    · identity — skipped ({identity_state} channel assignment)")

        if not agent_has_output and not verbose:
            print(f"    ✓ all files up to date")
        print()

    print(f"{'=' * 50}")
    if check_only:
        if stats["drift"] == 0:
            print(f"No drift detected. All {stats['ok']} files in sync.")
        else:
            print(f"DRIFT: {stats['drift']} files out of sync")
            print(f"OK: {stats['ok']} files in sync")
            print(f"\nRun `sync.py --dry-run` to preview fixes.")
    else:
        print(f"Summary: {stats['created']} created, {stats['updated']} updated, "
              f"{stats['ok']} unchanged, {stats['skipped']} skipped"
              + (f", {stats['removed']} removed" if stats["removed"] else "")
              + (f", {stats['errors']} errors" if stats["errors"] else ""))
        if not dry_run:
            _deploy_skills_silent(teams, agents, agent_filter, symlink_host=symlink_host,
                                  allow_dirty=skills_allow_dirty)

    return stats


def _deploy_skills_silent(teams: dict, agents: list[dict],
                          agent_filter: str | None = None,
                          symlink_host: bool = False,
                          allow_dirty: bool = False) -> None:
    """Silent skills deploy after scaffolding sync — no per-agent output.

    Honours the same committed-source gate as ``deploy_skills``; the refusal
    diagnostic is the one thing this path is never silent about.
    """
    if not SKILLS_MASTER_DIR.exists():
        return
    skill_dirs = sorted([d for d in SKILLS_MASTER_DIR.iterdir()
                         if d.is_dir() and (d / "SKILL.md").exists()])
    if not skill_dirs:
        return
    if not skills_catalogue_gate(allow_dirty):
        return
    try:
        packs = load_skill_packs()
    except SkillPackError as error:
        print(f"Skills not deployed: {error}")
        return
    pack_of = skill_pack_index(packs)
    filtered_agents = agents
    if agent_filter:
        filtered_agents = [a for a in agents if a["name"].lower() == agent_filter.lower()]
    created, updated = 0, 0
    for skill_dir in skill_dirs:
        skill_name = skill_dir.name
        master_content = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
        pack = pack_of.get(skill_name)
        for agent in filtered_agents:
            for agent_team_dir in skill_target_dirs(teams, agent):
                target = agent_team_dir / ".claude" / "skills" / skill_name / "SKILL.md"
                if pack and not _within_projects(agent_team_dir, packs[pack]["projects"]):
                    _remove_deployed_skill(target.parent, dry_run=False)
                    continue
                action = _copy_skill_file(master_content, target, dry_run=False)
                if action == "CREATE":
                    created += 1
                elif action == "UPDATE":
                    updated += 1
        if pack:
            shared_agents = Path(_MACHINE_CONFIG["homeDir"]) / ".agents" / "skills"
            for link in (HOST_SKILLS_DIR / skill_name, shared_agents / skill_name):
                _remove_global_pack_skill(link, skill_dir, master_content, dry_run=False)
        elif symlink_host:
            _symlink_skill_dir(skill_dir, HOST_SKILLS_DIR / skill_name, dry_run=False)
        else:
            host_target = HOST_SKILLS_DIR / skill_name / "SKILL.md"
            _copy_skill_file(master_content, host_target, dry_run=False)
    _regenerate_matrix(skill_dirs, dry_run=False, packs=packs)
    if created or updated:
        print(f"\nSkills: {created} created, {updated} updated ({len(skill_dirs)} total)")


# ---------------------------------------------------------------------------
# Collab notification (for cron drift reports)
# ---------------------------------------------------------------------------

def post_drift_alert(drift_count: int) -> None:
    """Post to SG-1 collab channel when drift is detected (used by cron).

    Suppresses repeat alerts for the same drift count within a cooldown window
    to prevent channel flooding from repeated cron invocations.

    **Opt-in gate**: by default this function is a no-op even if stdout is
    non-TTY (the historical only-gate). Test runs, CI, the Bash tool, and
    the manifest API's own internal verifier subprocess all run non-TTY but
    SHOULDN'T fire alerts — the dedicated drift-alarm cron is the ONLY thing
    that should. Set `SCAFFOLDING_ALARM_ENABLE=1` in the cron job's env to
    enable. Per CJack's P3.3 design note (2026-05-25).
    """
    if os.environ.get("SCAFFOLDING_ALARM_ENABLE", "").strip() != "1":
        return
    if not Path(COLLAB_HELPER).exists():
        return

    # Suppress if same drift count was already reported within the cooldown window
    now = datetime.now().timestamp()
    if DRIFT_COOLDOWN_FILE.exists():
        try:
            state = json.loads(DRIFT_COOLDOWN_FILE.read_text())
            if (state.get("drift_count") == drift_count and
                    (now - state.get("timestamp", 0)) < DRIFT_COOLDOWN_SECONDS):
                return
        except Exception:
            pass

    msg = (f"Scaffolding drift detected: {drift_count} files out of sync. "
           f"Run `sync.py --check` for details.")
    try:
        subprocess.run(
            ["python3", COLLAB_HELPER, msg],
            env={**os.environ, "CLAUDE_PID": str(os.getppid())},
            timeout=10,
            capture_output=True,
        )
        DRIFT_COOLDOWN_FILE.write_text(json.dumps({
            "drift_count": drift_count,
            "timestamp": now,
        }))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _record_sync_event(*, mode: str, agent_filter: str | None,
                       file_filter: str | None, files_affected: int,
                       exit_code: int, duration_ms: int,
                       command: str, extras: dict | None = None) -> None:
    """Append one JSONL line summarising this sync.py invocation.

    Powers /api/scaffolding/manifest's syncLog field — the X-Ray UI can show
    a tail of recent sync runs per agent. Bounded rotation: when the file
    exceeds SYNC_EVENTS_MAX_BYTES, atomically rename to .1 and start fresh
    (worst-case loses one event window during the rename, acceptable).

    Never throws — sync logging must not break a sync run. All failures are
    silently swallowed.
    """
    try:
        SYNC_EVENTS_PATH.parent.mkdir(parents=True, exist_ok=True)
        # Bounded rotation
        try:
            if SYNC_EVENTS_PATH.exists() and SYNC_EVENTS_PATH.stat().st_size > SYNC_EVENTS_MAX_BYTES:
                backup = SYNC_EVENTS_PATH.with_suffix(SYNC_EVENTS_PATH.suffix + '.1')
                os.replace(SYNC_EVENTS_PATH, backup)
        except Exception:
            pass

        record = {
            "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") +
                   f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z",
            "mode": mode,
            "agent_filter": agent_filter,
            "file_filter": file_filter,
            "files_affected": int(files_affected),
            "exit_code": int(exit_code),
            "duration_ms": int(duration_ms),
            "command": command,
        }
        if extras:
            for k, v in extras.items():
                if k not in record:
                    try:
                        json.dumps(v)
                        record[k] = v
                    except Exception:
                        record[k] = str(v)

        line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        # O_APPEND atomic for <PIPE_BUF lines (our lines are well under 4KiB)
        with open(SYNC_EVENTS_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        # NEVER let logging crash a sync run.
        pass


def _detect_mode(args: argparse.Namespace) -> str:
    """Map argparse Namespace to a single short mode label for the event log."""
    if args.new_agent:    return "new-agent"
    if args.adapters:     return "adapters"
    if args.manifest:     return "manifest"
    if args.verify_only:  return "verify-only"
    if args.skills_only:  return "skills-only"
    if args.runtime_location_only: return "runtime-location-only"
    if args.hooks_only:   return "hooks-only"
    if args.check:        return "check"
    if args.dry_run:      return "dry-run"
    return "sync"


RUNTIME_REGISTRY = SCAFFOLDING_DIR / "service-locations.json"
RUNTIME_NOTE = Path(".claude") / "rules" / "Runtime-Location.md"


def presence_location(roster_entry: dict) -> str:
    """'server', 'desktop-windows' or 'desktop-wsl' for one roster presence."""
    if (roster_entry.get("runLocation") or "").lower() == "server":
        return "server"
    return "desktop-windows" if roster_entry.get("spawnMode") == "powershell" else "desktop-wsl"


# The notes themselves live in runtime_location.py so the session-start hooks and
# the Codex wrapper can print the per-session note from the same registry.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_location import active_services, render_permanent_note  # noqa: E402
from runtime_location import detect_location as _rl_detect_location  # noqa: E402


def render_runtime_location(location: str, registry: dict) -> str:
    """The permanent Runtime-Location.md. Location-neutral: the same text for every
    agent, because the same agent can run on the desktop or the laptop. Where a
    session runs is stated in its session-start note instead (runtime_location.py)."""
    return render_permanent_note(registry)


def deploy_runtime_location(dry_run: bool = False, only_dir: str | None = None,
                            home_dirs: list[str] | None = None) -> dict:
    """Write each roster presence's Runtime-Location.md (migration tasks 7.5-7.7).

    only_dir limits the pass to one folder (a --target-dir run). A folder with
    no roster entry, such as an agent launched by hand, is treated as a
    desktop WSL presence, which is where every hand launch runs. home_dirs
    are the agents' own folders: their entry files import the note even when
    no channel roster currently runs the agent there.
    """
    stats = {"created": 0, "updated": 0, "ok": 0, "errors": 0}
    try:
        registry = json.loads(RUNTIME_REGISTRY.read_text())
        # The permanent note is location-neutral. An explicit workspace needs
        # only this installation's registry, not a channel API lookup (which
        # can be unavailable or require authentication during first spawn).
        if only_dir:
            content = render_runtime_location(presence_location({}), registry)
            action = _copy_skill_file(content, Path(only_dir) / RUNTIME_NOTE, dry_run)
            key = {"CREATE": "created", "UPDATE": "updated", "OK": "ok"}.get(action, "errors")
            stats[key] += 1
            return stats
        data = load_channels_data()
        if data is None:
            raise OSError("channel list unavailable")
        channels = data if isinstance(data, list) else data.get("channels", [])
    except (OSError, json.JSONDecodeError) as error:
        print(f"  ! Runtime location skipped: {error}")
        stats["errors"] += 1
        return stats
    seen: set[str] = set()
    for ch in channels:
        for entry in ((ch.get("roster") or {}).get("agents") or []):
            directory = entry.get("effectiveWorkingDirectory") or ""
            if not directory or re.match(r"^[A-Za-z]:[\\/]", directory):
                continue
            real = os.path.realpath(directory)
            if real in seen or not is_agent_owned_presence(entry.get("name", ""), directory):
                continue
            seen.add(real)
            if only_dir and real != os.path.realpath(only_dir):
                continue
            content = render_runtime_location(presence_location(entry), registry)
            action = _copy_skill_file(content, Path(directory) / RUNTIME_NOTE, dry_run)
            key = {"CREATE": "created", "UPDATE": "updated", "OK": "ok"}.get(action, "errors")
            stats[key] += 1
    fallback_dirs = [only_dir] if only_dir else [d for d in (home_dirs or []) if Path(d).is_dir()]
    for directory in fallback_dirs:
        real = os.path.realpath(directory)
        if real in seen:
            continue
        seen.add(real)
        content = render_runtime_location(presence_location({}), registry)
        action = _copy_skill_file(content, Path(directory) / RUNTIME_NOTE, dry_run)
        key = {"CREATE": "created", "UPDATE": "updated", "OK": "ok"}.get(action, "errors")
        stats[key] += 1
    return stats


def deploy_hooks(teams: dict,
                 agents: list[dict],
                 agent_filter: str | None = None,
                 dry_run: bool = False,
                 verbose: bool = False,
                 known_models: set | None = None,
                 ) -> dict:
    """Deploy canonical session hooks into each native-settings agent dir.

    Rules files sync from masters, but the hooks that RE-READ them after a
    compaction were only ever deployed by hand-run rollout scripts
    (scripts/hooks/rollout-hooks.py, scripts/patch-hooks.py) over two hardcoded
    team roots. An agent could therefore hold a current rule set and no
    mechanism to reload it after its context was summarised — and a newly
    provisioned agent got neither until someone remembered to run the script.
    Maintaining both from the same command over the same agent set is what stops
    a rule and its re-reader drifting apart.

    Only adapters that own a native ``.claude/settings.json`` are touched.
    Wrapper-managed runtimes (Codex, Gemini, Grok, Antigravity) have
    their lifecycle hooks fired by the wrapper process; writing a hooks block
    into their agent dir would be inert at best and misleading at worst.

    Hooks are MERGED, never overwritten: an agent's own settings (a PreToolUse
    gate, env, permissions) are preserved untouched.
    """
    stats = {"created": 0, "updated": 0, "ok": 0, "skipped": 0, "errors": 0}

    try:
        sys.path.insert(0, str(Path(os.environ.get('DEVFLOW_HOME') or str(Path.home() / 'DevFlow')) / "scripts"))
        from agent_lifecycle_hooks import build_hooks, merge_session_hooks
    except Exception as error:
        print(f"ERROR: cannot load agent_lifecycle_hooks: {error}", file=sys.stderr)
        stats["errors"] += 1
        return stats

    filtered = agents
    if agent_filter:
        filtered = [a for a in agents if a["name"].lower() == agent_filter.lower()]

    for agent in filtered:
        matched = select_adapters_for(agent, agent_matches_condition, known_models or set())
        may_create = any(
            not getattr(a, "settings_managed_by_wrapper", False) for a in matched
        )

        # Deduplicate by real path. Some team roots hold both a capitalised
        # symlink and the real lowercase directory (Emails-and-Marketing has
        # Agent -> agent). Processing both would write the same file twice,
        # each pass stamping its own spelling into the hook commands, so the
        # entry would never settle.
        seen_real: set[str] = set()
        target_dirs = []
        for candidate in skill_target_dirs(teams, agent):
            real = os.path.realpath(candidate)
            if real in seen_real:
                continue
            seen_real.add(real)
            target_dirs.append(candidate)

        for agent_dir in target_dirs:
            settings_path = agent_dir / ".claude" / "settings.json"
            try:
                if settings_path.exists():
                    # An existing settings.json is itself proof this is a
                    # native-settings agent dir, whatever the roster says the
                    # agent's model is. Agents run on more than one runtime
                    # (a Claude presence in one channel, Codex in another), so
                    # the roster entry alone must not strip hook maintenance
                    # from a live native dir.
                    with open(settings_path, encoding="utf-8") as handle:
                        settings = json.load(handle)
                    existed = True
                else:
                    # Creating one is only correct where an adapter actually
                    # owns native settings. Wrapper-managed runtimes fire their
                    # lifecycle hooks from the wrapper process; a hooks block in
                    # their dir would be inert and misleading.
                    if not may_create:
                        stats["skipped"] += 1
                        if verbose:
                            families = ",".join(getattr(a, "family", "?") for a in matched) or "(none)"
                            print(f"  {agent['name']} [{agent_dir}]: skip — wrapper-managed ({families})")
                        continue
                    settings = {}
                    existed = False

                expected = merge_session_hooks(
                    settings.get("hooks", {}),
                    build_hooks(agent["name"], str(agent_dir)),
                )
                if existed and settings.get("hooks") == expected:
                    stats["ok"] += 1
                    continue

                action = "UPDATE" if existed else "CREATE"
                print(f"  {agent['name']} [{agent_dir}]: {action} .claude/settings.json hooks")
                if not dry_run:
                    settings["hooks"] = expected
                    settings_path.parent.mkdir(parents=True, exist_ok=True)
                    temp_path = str(settings_path) + ".tmp"
                    with open(temp_path, "w", encoding="utf-8") as handle:
                        json.dump(settings, handle, indent=2)
                        handle.write("\n")
                    os.replace(temp_path, settings_path)
                stats["created" if action == "CREATE" else "updated"] += 1
            except Exception as error:
                print(f"  {agent['name']} [{agent_dir}]: ERROR {error}", file=sys.stderr)
                stats["errors"] += 1

    return stats


def main() -> None:
    parser = argparse.ArgumentParser(
        description="SG-1 Global Scaffolding Sync Engine",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would change without writing")
    parser.add_argument("--check", action="store_true",
                        help="Report drift only — no fixes applied")
    parser.add_argument("--agent", metavar="NAME",
                        help="Sync one specific agent")
    parser.add_argument("--file", metavar="ID",
                        help="Sync one manifest entry by ID")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Show all files including up-to-date ones")
    parser.add_argument("--hooks-only", action="store_true",
                        help="Only deploy session hooks into native-settings agent dirs")
    parser.add_argument("--runtime-location-only", action="store_true",
                        help="Only regenerate each agent's Runtime-Location.md from service-locations.json")
    parser.add_argument("--skills-only", action="store_true",
                        help="Only deploy skills (skip scaffolding manifest files)")
    parser.add_argument("--skill", metavar="NAME",
                        help="With --skills-only, deploy only this skill; regenerate the full catalogue")
    parser.add_argument("--skills-symlink", action="store_true",
                        help="Symlink ~/.claude/skills/<name> -> ~/DevFlow/data/skills/<name>/ "
                             "(live link to masters, no stale copies)")
    parser.add_argument("--skills-allow-dirty", action="store_true",
                        help="Deploy the skill catalogue even though it has uncommitted "
                             "changes. By default the catalogue gate refuses and names the "
                             "dirty paths, so an unreviewed edit cannot reach the fleet.")
    parser.add_argument("--new-agent", metavar="NAME",
                        help="Scaffold a new agent")
    parser.add_argument("--role", metavar="ROLE",
                        help="Role for --new-agent")
    parser.add_argument("--domain", metavar="DOMAIN", default="",
                        help="Domain description for --new-agent")
    parser.add_argument("--models", metavar="LIST",
                        help="Comma-separated models for --new-agent (e.g. claude,gemini)")
    parser.add_argument("--team-id", metavar="ID", default="sg1",
                        help="Team ID for --new-agent (from teams.json, default: sg1)")
    parser.add_argument("--agent-type", metavar="TYPE",
                        help="Agent type for --new-agent, or the selected runtime "
                             "for --target-dir (e.g. antigravity, claude)")
    parser.add_argument("--adapters", action="store_true",
                        help="Print the adapter registry (diagnostic). Pair "
                             "with --json for machine-readable output. Also "
                             "honours --agent NAME — shows which adapters "
                             "match that agent.")
    parser.add_argument("--manifest", action="store_true",
                        help="Print the pure decision manifest for an agent "
                             "(--agent NAME required). Returns the list of "
                             "files that agent would have, with target paths "
                             "+ condition reasoning + template vars. NO file "
                             "I/O against the masters or targets. Pair with "
                             "--json for machine-readable output. Powers the "
                             "Context Broker.")
    parser.add_argument("--verify-only", action="store_true",
                        help="Post-deploy verifier: hash-check every expected file "
                             "against its master + warn loudly + exit non-zero on "
                             "drift/missing. Idempotent. Read-only (no writes).")
    parser.add_argument("--no-verify", action="store_true",
                        help="Skip the automatic post-deploy verify pass (sync still runs)")
    parser.add_argument("--json", action="store_true",
                        help="Machine-readable JSON output (currently only honoured "
                             "by --verify-only; consumed by /api/scaffolding/manifest)")
    parser.add_argument("--target-dir", metavar="PATH", default=None,
                        help="Override AGENT_DIR/TEAM_DIR for this run. Use to "
                             "deploy scaffolding into one dedicated "
                             "<project>/Team/<agent> cwd. Shared roots are "
                             "externally managed; identity is updated only "
                             "when the roster assignment is unambiguous. "
                             "Suppresses the automatic per-presence pass.")
    parser.add_argument("--skip-presences", action="store_true",
                        help="Skip the per-presence pass. Default behaviour "
                             "(Fix 3, 2026-05-27): after the team-derived "
                             "deploy, re-run sync for each additional cwd "
                             "discovered via collab-channels.json so dedicated "
                             "agent workspaces receive the full scaffold; "
                             "shared roots are reported as externally managed.")
    args = parser.parse_args()

    # ----- sync-event logging setup -----
    # Capture invocation metadata up front so the `finally` clause at the
    # end of main() always has the full picture, regardless of which branch
    # we take (or which sys.exit() fires). `files_affected` and `exit_code`
    # are mutable via the dict so inner code paths can update them.
    _event_state: dict[str, int | str | None] = {
        "files_affected": 0,
        "exit_code": 0,
    }
    _event_mode = _detect_mode(args)
    _event_start = int(time.time() * 1000)
    _event_command = "sync.py " + " ".join(sys.argv[1:])

    try:
        _main_body(args, _event_state)
    except SystemExit as exc:
        _event_state["exit_code"] = exc.code if isinstance(exc.code, int) else 0
        raise
    except Exception:
        _event_state["exit_code"] = 1
        raise
    finally:
        _record_sync_event(
            mode=_event_mode,
            agent_filter=getattr(args, "agent", None),
            file_filter=getattr(args, "file", None),
            files_affected=int(_event_state.get("files_affected") or 0),
            exit_code=int(_event_state.get("exit_code") or 0),
            duration_ms=int(time.time() * 1000) - _event_start,
            command=_event_command,
        )


def _main_body(args: argparse.Namespace, state: dict) -> None:
    """The actual sync logic, factored out so main() can wrap it with
    consistent sync-event logging. Updates `state['files_affected']` from
    inside whichever path executes so the finally-clause in main() reports
    accurate numbers."""
    if args.new_agent:
        if not args.role or not args.models:
            print("ERROR: --new-agent requires --role and --models")
            sys.exit(1)
        models = [m.strip() for m in args.models.split(",")]
        scaffold_new_agent(args.new_agent, args.role, args.domain, models,
                           team_id=args.team_id, agent_type=args.agent_type,
                           dry_run=args.dry_run)
        return

    teams = load_teams()
    agents = drop_roster_aliases(load_agents(), teams)

    # --adapters short-circuits — diagnostic view of adapter registry +
    # optional agent matching. Pure read on in-memory class data, no I/O.
    if args.adapters:
        known_models = load_models()
        infos = [a.info() for a in ADAPTER_REGISTRY]
        result: dict = {"adapters": infos}
        if args.agent:
            match = [a for a in agents if a["name"].lower() == args.agent.lower()]
            if not match:
                print(f"ERROR: Agent '{args.agent}' not found", file=sys.stderr)
                sys.exit(2)
            matched = select_adapters_for(match[0], agent_matches_condition, known_models)
            result["agent"] = match[0]["name"]
            result["matched_families"] = [a.family for a in matched]
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(f"\nAdapter Registry — {len(infos)} adapters")
            print("=" * 50)
            for a in infos:
                wrapper = "wrapper" if a["settings_managed_by_wrapper"] else "native"
                print(f"  {a['family']:13s} conds={','.join(a['matches_conditions']):28s} "
                      f"entry={a['entry_template_id'] or '-':22s} hooks={a['hook_coverage_level']:9s} "
                      f"imports={a['required_import_count']}  ({wrapper} settings)")
            if "matched_families" in result:
                print(f"\nAgent '{result['agent']}' matches: {', '.join(result['matched_families']) or '(none)'}")
        sys.exit(0)

    # --manifest short-circuits before deploy logic — strictly the pure
    # decision function. Useful for Broker integration testing.
    if args.manifest:
        if not args.agent:
            print("ERROR: --manifest requires --agent NAME", file=sys.stderr)
            sys.exit(2)
        match = [a for a in agents if a["name"].lower() == args.agent.lower()]
        if not match:
            print(f"ERROR: Agent '{args.agent}' not found in agents.json", file=sys.stderr)
            sys.exit(2)
        manifest = load_manifest()
        rows = compute_agent_manifest(teams, match[0], manifest,
                                      known_models=load_models())
        if args.json:
            print(json.dumps({
                "agent": match[0]["name"],
                "rowCount": len(rows),
                "matched": sum(1 for r in rows if r.get("conditionMatch")),
                "skipped": sum(1 for r in rows if not r.get("conditionMatch")),
                "rows": rows,
            }, ensure_ascii=False, indent=2))
        else:
            print(f"\nDecision manifest for agent: {match[0]['name']}")
            print("=" * 50)
            matched = sum(1 for r in rows if r.get("conditionMatch"))
            print(f"  matched={matched} skipped={len(rows)-matched} total={len(rows)}")
            print()
            for r in rows:
                marker = "✓" if r.get("conditionMatch") else "·"
                tag = "tmpl" if r.get("isTemplate") else "file"
                src = r.get("source","?")
                tgt = r.get("targets",["?"])[0] if r.get("targets") else "?"
                line = f"  {marker} [{src:9s} {tag}] {r.get('entryId','?'):20s} → {tgt}"
                if r.get("reason"):
                    line += f"  ({r['reason']})"
                print(line)
        sys.exit(0)

    # --verify-only short-circuits before any deploy logic — strictly read+hash
    if args.verify_only:
        manifest = load_manifest()
        exit_code = run_verify(
            teams, agents, manifest,
            agent_filter=args.agent,
            as_json=args.json,
        )
        sys.exit(exit_code)

    if args.runtime_location_only:
        stats = deploy_runtime_location(dry_run=args.dry_run or args.check,
                                        home_dirs=agent_home_dirs(agents, teams))
        print(f"\nRuntime location: {stats['created']} created, {stats['updated']} updated, "
              f"{stats['ok']} ok, {stats['errors']} errors")
        return

    if args.hooks_only:
        stats = deploy_hooks(teams,
            agents=agents,
            agent_filter=args.agent,
            dry_run=args.dry_run or args.check,
            verbose=args.verbose,
            known_models=load_models(),
        )
        print(f"\nHooks: {stats['created']} created, {stats['updated']} updated, "
              f"{stats['ok']} ok, {stats['skipped']} wrapper-managed, {stats['errors']} errors")
        return

    if args.skills_only:
        deploy_skills(teams,
            agents=agents,
            agent_filter=args.agent,
            dry_run=args.dry_run or args.check,
            verbose=args.verbose,
            symlink_host=args.skills_symlink,
            allow_dirty=args.skills_allow_dirty,
            skill_filter=args.skill,
        )
        return

    manifest = load_manifest()

    stats = run_sync(teams,
        agents=agents,
        manifest=manifest,
        agent_filter=args.agent,
        file_filter=args.file,
        dry_run=args.dry_run,
        check_only=args.check,
        verbose=args.verbose,
        symlink_host=args.skills_symlink,
        target_dir_override=args.target_dir,
        target_agent_type_override=args.agent_type if args.target_dir else None,
        skip_presences=args.skip_presences,
        skills_allow_dirty=args.skills_allow_dirty,
    )

    # Surface files_affected to the sync-event log. For deploys we count
    # created+updated; for --check mode the drift count is the meaningful
    # signal of "files that diverged".
    if args.check:
        state["files_affected"] = stats.get("drift", 0)
    else:
        state["files_affected"] = stats.get("created", 0) + stats.get("updated", 0)

    # Session hooks ride along with every real sync. A rule file and the hook
    # that re-reads it after a compaction are useless apart: rules synced here
    # would otherwise be reloaded only by a hand-run rollout script, so a newly
    # provisioned agent could carry current rules with no way to reload them.
    # Merge-based and idempotent, so a repeat sync is a no-op.
    if not args.file:
        hook_stats = deploy_hooks(teams,
            agents=agents,
            agent_filter=args.agent,
            dry_run=args.dry_run or args.check,   # --check reports drift only: it must not rewrite hooks
            verbose=args.verbose,
            known_models=load_models(),
        )
        if hook_stats["created"] or hook_stats["updated"] or hook_stats["errors"]:
            print(f"  Hooks: {hook_stats['created']} created, "
                  f"{hook_stats['updated']} updated, {hook_stats['errors']} errors")
        if args.target_dir or not args.agent:
            loc_stats = deploy_runtime_location(dry_run=args.dry_run or args.check, only_dir=args.target_dir,
                                                home_dirs=agent_home_dirs(agents, teams))
            if loc_stats["created"] or loc_stats["updated"] or loc_stats["errors"]:
                print(f"  Runtime location: {loc_stats['created']} created, "
                      f"{loc_stats['updated']} updated, {loc_stats['errors']} errors")

    # Alert collab channel if drift detected in cron mode (--check, no terminal)
    if args.check and stats["drift"] > 0 and not sys.stdout.isatty():
        post_drift_alert(stats["drift"])

    # Auto post-deploy verifier — runs after every real deploy (not dry-run,
    # not check-only) unless explicitly suppressed. Loud warning + non-zero
    # exit on any drift/missing so a wrapping cron or CI run notices.
    if not args.dry_run and not args.check and not args.no_verify:
        verify_exit = run_verify(
            teams, agents, manifest,
            agent_filter=args.agent,
            as_json=False,
        )
        if verify_exit != 0:
            print(f"\n!! Post-deploy verify reported {verify_exit} drift/missing file(s).",
                  file=sys.stderr)
            print(f"   Re-run `sync.py --verify-only` for the structured report.",
                  file=sys.stderr)
            sys.exit(verify_exit)


if __name__ == "__main__":
    main()
