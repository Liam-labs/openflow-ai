#!/usr/bin/env python3
"""First-time setup: check the machine, create the settings file and an access token, install and build.

    ./scripts/setup              check, configure, install packages, build
    ./scripts/setup --check      only check this machine; change nothing
    ./scripts/setup --no-build   configure and install, skip the (slow) build
    ./scripts/setup --no-install configure only

Safe to run again: an existing settings file, values and token are kept. Nothing is installed on your machine outside this
folder; anything missing is reported with the exact command for your system. Supported: Linux, macOS and WSL2.
The access token is stored in .env (mode 0600) and its hash in the data folder; the token itself is never printed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MIN_NODE = (20, 0)
MIN_PYTHON = (3, 10)
BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


# ---- what machine is this -------------------------------------------------------------------------------------------------

def detect_platform(system: str | None = None, release: str = "", os_release: str = "") -> dict:
    """{"os": linux|macos|wsl2|windows|other, "manager": apt|dnf|pacman|zypper|brew|None}."""
    system = system or platform.system()
    if system == "Darwin":
        return {"os": "macos", "manager": "brew"}
    if system == "Windows":
        return {"os": "windows", "manager": None}
    if system == "Linux":
        kernel = (release or platform.release()).lower()
        text = os_release
        if not text:
            try:
                text = Path("/etc/os-release").read_text()
            except OSError:
                text = ""
        ids = " ".join(re.findall(r'^(?:ID|ID_LIKE)="?([^"\n]+)', text, re.M)).lower().split()
        manager = next((m for key, m in (("debian", "apt"), ("ubuntu", "apt"), ("fedora", "dnf"), ("rhel", "dnf"), ("arch", "pacman"), ("suse", "zypper")) if key in ids), None)
        return {"os": "wsl2" if "microsoft" in kernel or "wsl" in kernel else "linux", "manager": manager}
    return {"os": "other", "manager": None}


INSTALL_HINTS = {
    "apt": {"tmux": "sudo apt install -y tmux", "git": "sudo apt install -y git", "pexpect": "sudo apt install -y python3-pexpect",
            "node": "install Node 20 or newer, for example with nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 20",
            "python": "sudo apt install -y python3"},
    "dnf": {"tmux": "sudo dnf install -y tmux", "git": "sudo dnf install -y git", "pexpect": "sudo dnf install -y python3-pexpect",
            "node": "sudo dnf module install -y nodejs:20   (or use nvm: https://github.com/nvm-sh/nvm)", "python": "sudo dnf install -y python3"},
    "pacman": {"tmux": "sudo pacman -S --needed tmux", "git": "sudo pacman -S --needed git", "pexpect": "sudo pacman -S --needed python-pexpect",
               "node": "sudo pacman -S --needed nodejs npm", "python": "sudo pacman -S --needed python"},
    "zypper": {"tmux": "sudo zypper install tmux", "git": "sudo zypper install git", "pexpect": "sudo zypper install python3-pexpect",
               "node": "sudo zypper install nodejs20", "python": "sudo zypper install python3"},
    "brew": {"tmux": "brew install tmux", "git": "brew install git", "pexpect": "python3 -m pip install --user pexpect",
             "node": "brew install node@20", "python": "brew install python"},
    None: {"tmux": "install tmux with your system's package manager", "git": "install git with your system's package manager",
           "pexpect": "python3 -m pip install --user pexpect", "node": "install Node 20 or newer from https://nodejs.org", "python": "install Python 3.10 or newer"},
}


def parse_version(text: str) -> tuple[int, ...] | None:
    match = re.search(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", text or "")
    return tuple(int(g or 0) for g in match.groups()) if match else None


def run_text(cmd: list[str]) -> str:
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return ""
    return (done.stdout or done.stderr or "").strip()


def check_prerequisites(manager: str | None, which=shutil.which, version_of=run_text, python_version=None, has_pexpect=None) -> list[dict]:
    """One row per requirement: {name, ok, found, need, fix}. `fix` is empty when ok."""
    hints = INSTALL_HINTS.get(manager, INSTALL_HINTS[None])
    rows = []
    real_which = which

    def which(command):                       # noqa: F811 - a program under /mnt/ is Windows' (WSL puts it on PATH); it cannot build this app
        found = real_which(command)
        return None if found and str(found).startswith("/mnt/") else found

    pyv = python_version or sys.version_info[:2]
    rows.append({"name": "python", "ok": tuple(pyv[:2]) >= MIN_PYTHON, "found": "%d.%d" % tuple(pyv[:2]), "need": "%d.%d or newer" % MIN_PYTHON,
                 "fix": hints["python"]})
    if has_pexpect is None:
        try:
            __import__("pexpect")
            has_pexpect = True
        except ImportError:
            has_pexpect = False
    rows.append({"name": "pexpect (Python module)", "ok": has_pexpect, "found": "installed" if has_pexpect else "missing", "need": "installed", "fix": hints["pexpect"]})
    node_path = which("node")
    node_v = parse_version(version_of(["node", "--version"])) if node_path else None
    rows.append({"name": "node", "ok": bool(node_v and node_v[:2] >= MIN_NODE), "found": ".".join(map(str, node_v)) if node_v else "missing",
                 "need": "%d or newer" % MIN_NODE[0], "fix": hints["node"]})
    rows.append({"name": "npm", "ok": bool(which("npm")), "found": "installed" if which("npm") else "missing", "need": "installed (comes with Node)", "fix": hints["node"]})
    for tool in ("tmux", "git"):
        rows.append({"name": tool, "ok": bool(which(tool)), "found": "installed" if which(tool) else "missing", "need": "installed", "fix": hints[tool]})
    for row in rows:
        if row["ok"]:
            row["fix"] = ""
    return rows


# ---- the settings file and the token ---------------------------------------------------------------------------------------

def parse_env(text: str) -> dict[str, str]:
    values = {}
    for line in text.splitlines():
        match = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if match:
            values[match.group(1)] = match.group(2).strip()
    return values


def set_env_value(text: str, name: str, value: str) -> str:
    """Set NAME=value in env-file text: replace an existing line (even an empty one) or append one."""
    line = "%s=%s" % (name, value)
    pattern = re.compile(r"^\s*%s=.*$" % re.escape(name), re.M)
    if pattern.search(text):
        return pattern.sub(lambda _m: line, text, count=1)
    return text.rstrip("\n") + "\n" + line + "\n"


def comment_out_env_value(text: str, name: str) -> str:
    """Turn the line NAME=... into a comment (the value stays visible), so the setting is off but easy to bring back."""
    return re.sub(r"^(\s*)(%s=.*)$" % re.escape(name), r"\1# \2", text, count=1, flags=re.M)


# Early copies of .env.example switched the host-bridge helper on with this address although nothing starts it. With it set, the app sends
# every PM2 and process request to a helper that does not exist, so Services, Processes and Overview showed nothing.
OLD_BRIDGE_DEFAULT = "http://localhost:3001"


def make_token() -> str:
    number = int.from_bytes(secrets.token_bytes(32), "big")
    body = ""
    while number:
        number, rest = divmod(number, 62)
        body = BASE62[rest] + body
    return "dvf_live_" + body.rjust(43, "0")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def default_tokens_data() -> dict:
    return {"tokens": [], "config": {"maxTokensPerUser": 10, "defaultExpiration": 0, "requireExpiration": False, "rateLimitWindow": 60, "rateLimitMax": 100},
            "rateLimits": {}, "failedAttempts": {}, "lastUpdated": ""}


def write_private(path: Path, text: str) -> None:
    """Write a file that is private from its first byte: a new file made with mode 0600 (never an existing one, never through a link),
    then renamed over the target, so an old world-readable copy never holds the new contents and a half-written file never replaces it."""
    tmp = path.with_name("%s.setup-%s.tmp" % (path.name, secrets.token_hex(6)))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def read_token_store(store: Path, reset: bool = False) -> dict:
    """The token file as data. A file that exists but is not valid JSON is never treated as empty (the next write would silently destroy every token):
    a copy is kept beside it and setup stops, unless --reset-token-store was given, which starts a new store and keeps the copy."""
    if not store.exists():
        return default_tokens_data()
    text = store.read_text()
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
        raise ValueError("not a JSON object")
    except ValueError as error:
        backup = store.with_name("%s.corrupt-%s" % (store.name, time.strftime("%Y%m%dT%H%M%S", time.gmtime())))
        if not backup.exists():
            fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as handle:
                handle.write(text)
        if reset:
            print("  The token file was not valid JSON (%s). A copy is kept as %s; starting a new token file." % (error, backup))
            return default_tokens_data()
        raise SystemExit("setup: %s is not valid JSON (%s), so setup will not touch it.\n  A copy was kept as %s.\n"
                         "  Repair the file by hand and run setup again, or run ./scripts/setup --reset-token-store to start a new token file (the copy stays)." % (store, error, backup))


def register_token(store: Path, token: str, name: str = "setup", reset: bool = False) -> bool:
    """Make sure the app accepts this token. Returns True when a record was added."""
    if not store.parent.exists():
        store.parent.mkdir(parents=True, mode=0o700)         # only a folder we made is ours to restrict
    data = read_token_store(store, reset)
    digest = hash_token(token)
    if any(t.get("tokenHash") == digest and not t.get("revokedAt") for t in data.get("tokens", [])):
        return False
    data.setdefault("tokens", []).append({
        "id": "%032x" % secrets.randbits(128), "name": name, "tokenHash": digest, "tokenPrefix": token[:8], "scope": "admin",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "createdBy": "setup", "expiresAt": None, "lastUsedAt": None,
        "lastUsedIp": None, "revokedAt": None, "revokedBy": None, "usageCount": 0, "metadata": {"description": "Created by the setup script"}})
    data["lastUpdated"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    write_private(store, json.dumps(data, indent=2))
    return True


def configure(repo: Path, port: int | None = None, reset_tokens: bool = False, server: bool = False, host: str | None = None) -> dict:
    """Create/complete .env. Returns what changed, by name only (never a value)."""
    if host and (not server or not re.fullmatch(r"(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", host) or any(not label or len(label) > 63 or label.startswith("-") or label.endswith("-") for label in host.split("."))):
        raise SystemExit("setup: --host needs --server and a hostname without a scheme, path or port")
    example, env_path = repo / ".env.example", repo / ".env"
    changes: list[str] = []
    if not env_path.exists():
        if not example.exists():
            raise SystemExit("setup: .env.example is missing from %s" % repo)
        text = example.read_text()
        changes.append("created .env from .env.example")
    else:
        text = env_path.read_text()
    values = parse_env(text)
    wanted = {"DEVFLOW_HOME": str(repo), "NEXT_TELEMETRY_DISABLED": "1"}     # Next.js reports usage to Vercel unless told not to
    explicit = {}
    if port:                                    # asked for on the command line, so it wins over what is in the file
        explicit = {"PORT": str(port), "DEVFLOW_URL": "http://localhost:%d" % port}
    if server:                                  # a server behind a proxy: every request needs the token, even one that looks like it comes from this machine
        wanted_server = {"DEVFLOW_SERVER_MODE": "1", "DEVFLOW_REQUIRE_TOKEN": "1"}
        if host:
            wanted_server.update({"DEVFLOW_ALLOWED_HOSTS": "localhost,127.0.0.1," + host, "DEVFLOW_ALLOWED_ORIGINS": "https://" + host, "DEVFLOW_URL": "https://" + host, "OPENFLOW_HOST": host})
            explicit.pop("DEVFLOW_URL", None)
        for name, value in wanted_server.items():
            if values.get(name) != value:
                text = set_env_value(text, name, value)
                changes.append("set %s" % name)
        values = parse_env(text)
    for name, value in {**wanted, **explicit}.items():
        if name in explicit and values.get(name) != value or not values.get(name):
            text = set_env_value(text, name, value)
            changes.append("set %s" % name)
    values = parse_env(text)
    if values.get("HOST_BRIDGE_URL") == OLD_BRIDGE_DEFAULT and not values.get("HOST_BRIDGE_TOKEN"):
        text = comment_out_env_value(text, "HOST_BRIDGE_URL")
        changes.append("turned off HOST_BRIDGE_URL (no host-bridge is running, so it only broke the Services and Overview pages)")
        values = parse_env(text)
    app_data = Path(values.get("DEVFLOW_APP_DATA_DIR") or ".AppData")
    store = (app_data if app_data.is_absolute() else repo / app_data) / "api-tokens.json"
    token = values.get("DEVFLOW_API_TOKEN", "")
    if not token:
        token = make_token()
        text = set_env_value(text, "DEVFLOW_API_TOKEN", token)
        changes.append("created an access token (stored in .env, mode 0600)")
    elif not token.startswith("dvf_"):
        raise SystemExit("setup: DEVFLOW_API_TOKEN in .env does not look like an OpenFlow token (it should start with dvf_); remove it to get a new one")
    write_private(env_path, text)
    if register_token(store, token, reset=reset_tokens):
        changes.append("registered the token with the app")
    return {"changes": changes, "env": str(env_path), "tokenStore": str(store)}


# ---- install and build -------------------------------------------------------------------------------------------------------

def run_step(label: str, cmd: list[str], cwd: Path) -> None:
    print("  %s ..." % label, flush=True)
    done = subprocess.run(cmd, cwd=cwd)
    if done.returncode != 0:
        raise SystemExit("setup: '%s' failed (exit %d). Fix the error above and run ./scripts/setup again." % (" ".join(cmd), done.returncode))


def install_command(repo: Path) -> list[str]:
    """--include=dev: a shell with NODE_ENV=production makes npm skip devDependencies, and the build needs them (Tailwind, TypeScript)."""
    return ["npm", "ci" if (repo / "package-lock.json").exists() else "install", "--include=dev"]


def clear_old_build(repo: Path) -> bool:
    """A build that failed half-way leaves a .next folder the next build trips over. Setup always builds from scratch.
    Only a real folder inside the app is removed; a link (someone's own layout) is left alone."""
    build = repo / ".next"
    if build.is_symlink() or not build.is_dir():
        return False
    shutil.rmtree(build)
    return True


def root_refusal(euid: int | None) -> str | None:
    """Claude Code refuses to run its agents as root, so an install made as root builds fine and then no agent ever starts."""
    if euid != 0:
        return None
    return ("setup: you are running as root (the administrator account). The AI tools will not start agents as root, so OpenFlow would build and then\n"
            "  the example agents would never start. Run setup as a normal user instead. On a fresh Linux machine or container, make one first:\n"
            "    adduser --disabled-password --gecos '' openflow && su - openflow\n"
            "  then clone OpenFlow again as that user and run ./scripts/setup.")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="only check this machine")
    ap.add_argument("--no-install", action="store_true")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--port", type=int)
    ap.add_argument("--server", action="store_true", help="run this if anything sits in front of the app (a proxy, a tunnel, a VPS web address) or the app is reachable from the internet: every request then needs the access token, even one that looks like it comes from this machine")
    ap.add_argument("--host", help="public HTTPS hostname for --server, without a scheme or path")
    ap.add_argument("--reset-token-store", action="store_true", help="if the token file is damaged, keep a copy and start a new one")
    ap.add_argument("--repo", type=Path, default=REPO, help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    refusal = root_refusal(os.geteuid() if hasattr(os, "geteuid") else None)
    if refusal:
        print(refusal, file=sys.stderr)
        return 1
    here = detect_platform()
    if here["os"] in ("windows", "other"):
        print("setup: this system is not supported yet. Use Linux, macOS or WSL2 (Windows Subsystem for Linux).", file=sys.stderr)
        return 1
    print("System: %s%s" % (here["os"], " (%s)" % here["manager"] if here["manager"] else ""))
    rows = check_prerequisites(here["manager"])
    for row in rows:
        print("  [%s] %-24s found %-10s need %s" % ("ok" if row["ok"] else "!!", row["name"], row["found"], row["need"]))
    missing = [r for r in rows if not r["ok"]]
    if missing:
        print("\nBefore setup can continue, install what is missing:")
        for row in missing:
            print("  - %s: %s" % (row["name"], row["fix"]))
        print("Then run ./scripts/setup again.")
        return 1
    if args.check:
        print("\nThis machine is ready.")
        return 0
    print("\nSettings:")
    result = configure(args.repo, args.port, args.reset_token_store, args.server, args.host)
    for line in result["changes"] or ["nothing to change: settings and token were already in place"]:
        print("  - %s" % line)
    if not args.no_install:
        print("\nInstalling packages (this can take a few minutes):")
        run_step("npm install", install_command(args.repo), args.repo)
    if not args.no_build and not args.no_install:
        print("\nBuilding:")
        clear_old_build(args.repo)
        run_step("npm run build:local", ["npm", "run", "build:local"], args.repo)
    if args.server:
        print("\nCreate your login using this one-time code (expires in 60 minutes):", flush=True)
        run_step("issue setup code", ["python3", "scripts/setup-code.py", "--repo", str(args.repo)], args.repo)
    address = "https://" + args.host if args.host else "http://localhost:" + (parse_env((args.repo / ".env").read_text()).get("PORT") or "3000")
    print("\nDone. Start it with:  npm start\nThen open %s in your browser. Your access token is in .env (do not share or commit it)." % address)
    return 0


if __name__ == "__main__":
    sys.exit(main())
