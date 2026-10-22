#!/usr/bin/env python3
"""agent-hostd: the "caretaker" on a machine that hosts agent terminal sessions.

Dials OUT to DevFlow; never listens. Long-polls for commands, runs an allowlisted
set against local tmux, posts results. DevFlow never needs a route into this machine.

Config (env or ~/.config/devflow-hostd.json): DEVFLOW_URL, HOSTD_HOST_ID, HOSTD_TOKEN.
"""
import base64, json, os, re, shutil, socket, subprocess, sys, time, urllib.request, urllib.error

HOME = os.path.expanduser("~")
CFG = {}
try:
    CFG = json.load(open(os.environ.get("HOSTD_CONFIG") or os.path.join(HOME, ".config", "devflow-hostd.json")))
except Exception:
    pass
URL = (os.environ.get("DEVFLOW_URL") or CFG.get("url") or "http://localhost:3000").rstrip("/")
HOST_ID = os.environ.get("HOSTD_HOST_ID") or CFG.get("hostId") or socket.gethostname()
TOKEN = os.environ.get("HOSTD_TOKEN") or CFG.get("token") or ""
ROOTS = [os.path.realpath(p) for p in CFG.get("allowedRoots", [])]
HOME_REAL = os.path.realpath(HOME)
_DF = HOME + "/DevFlow/scripts/"
LAUNCHERS = {os.path.basename(p): p for p in (CFG.get("launchers") or [
    HOME + "/bin/collab-claude", HOME + "/bin/collab-codex", HOME + "/bin/collab-grok",
    HOME + "/bin/collab-antigravity",
    _DF + "collab-codex.py", _DF + "collab-grok.py", _DF + "collab-grok-acp.py",
    _DF + "collab-agent.py", _DF + "agy-launch.sh"])}
INTERP = {".py": "python3", ".sh": "bash"}
API_TOKEN = CFG.get("apiToken") or os.environ.get("HOSTD_API_TOKEN") or TOKEN
SESSION_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
ENV_RE = re.compile(r"^(COLLAB_|DEVFLOW_)[A-Z0-9_]*$")
SECRET_RE = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)", re.I)
PREFIXES = tuple(CFG.get("sessionPrefixes") or ["collab-agent-"])
NICE = int(CFG.get("nice", 10))
VERSION = 1


def api(method, path, body=None, timeout=40):
    req = urllib.request.Request(URL + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json",
                                          "authorization": "Bearer " + API_TOKEN, "x-host-id": HOST_ID,
                                          "x-host-token": TOKEN})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def tmux(*args, timeout=20):
    # new-session may start the tmux server. Start it in its own systemd scope so it is not in this service's
    # cgroup: otherwise restarting hostd kills the server and every agent with it (4 Oct 2026 22:54 fleet loss).
    scope = ["systemd-run", "--user", "--scope", "--quiet", "--collect"] if args[0] == "new-session" and shutil.which("systemd-run") else []
    r = subprocess.run([*scope, "tmux", *args], capture_output=True, text=True, errors="replace", timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def need_session(a):
    s = a.get("session", "")
    if not SESSION_RE.match(s) or not s.startswith(PREFIXES):
        raise ValueError("session not managed by hostd")
    return s


def under_roots(path):
    p = os.path.realpath(path)
    if any(p == r or p.startswith(r + os.sep) for r in ROOTS):
        return True
    return p.startswith(HOME_REAL + os.sep) and "Team" in p[len(HOME_REAL):].split(os.sep)


def arg_value(args, flag):
    """The value after FLAG in an argv list ("--name Jack" or "--name=Jack"), else ''."""
    for i, x in enumerate(args):
        if x == flag and i + 1 < len(args):
            return args[i + 1]
        if x.startswith(flag + "="):
            return x[len(flag) + 1:]
    return ""


def session_of(pid):
    """The tmux session a process runs in (its pane's process is an ancestor of it), else ''."""
    rc, out, _ = tmux("list-panes", "-a", "-F", "#{session_name} #{pane_pid}")
    panes = {}
    for line in out.splitlines():
        name, _, p = line.rpartition(" ")
        if p.isdigit():
            panes[int(p)] = name
    while pid > 1:
        if pid in panes:
            return panes[pid]
        try:
            pid = int(open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return ""


def live_wrappers(args):
    """Find every same-user wrapper for this channel/name, including untracked sessions."""
    name, channel = arg_value(args, "--name"), arg_value(args, "--channel")
    if not name or not channel:
        return []
    found = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        try:
            if os.stat(f"/proc/{pid}").st_uid != os.getuid():
                continue
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                argv = [x.decode(errors="replace") for x in f.read().split(b"\0") if x]
        except OSError:
            continue
        if any(os.path.basename(x) in LAUNCHERS for x in argv[:3]) and arg_value(argv, "--name") == name and arg_value(argv, "--channel") == channel:
            found.append({"pid": int(pid), "name": name, "session": session_of(int(pid))})
    return found


def guard_agent_spawn(args, replace=False):
    twins = live_wrappers(args)
    # Validate every match before stopping anything. Unknown sessions fail closed.
    for twin in twins:
        managed = bool(SESSION_RE.fullmatch(twin["session"])) and twin["session"].startswith(PREFIXES)
        if replace is not True or not managed:
            raise ValueError(f"agent already running: {twin['name']} (pid {twin['pid']}, session {twin['session'] or 'none'})"
                             + ("; pass replace to stop it and start this one" if managed else ""))
    for session in sorted({t["session"] for t in twins}):
        rc, _, err = tmux("kill-session", "-t", "=" + session)
        if rc:
            raise RuntimeError("could not stop existing agent: " + err.strip()[:200])
    if twins:
        deadline = time.monotonic() + 5
        while live_wrappers(args):
            if time.monotonic() >= deadline:
                raise RuntimeError("existing agent wrapper did not exit; replacement refused")
            time.sleep(0.1)


def op_spawn(a):
    s = need_session(a)
    cwd = a.get("cwd", "")
    if not os.path.isdir(cwd) or not under_roots(cwd):
        raise ValueError("cwd not allowed")
    launcher = LAUNCHERS.get(a.get("launcher", ""))
    if not launcher or not os.path.exists(launcher):
        raise ValueError("launcher not allowed")
    args = [str(x) for x in a.get("args", [])]
    for k in (a.get("env") or {}):
        if SECRET_RE.search(k) or not ENV_RE.match(k):
            raise ValueError("env var not allowed in command: " + k)
    env = {k: str(v) for k, v in (a.get("env") or {}).items()}
    guard_agent_spawn(args, a.get("replace", False))
    if tmux("has-session", "-t", "=" + s)[0] == 0:
        raise ValueError("session already exists")
    env.setdefault("DEVFLOW_URL", URL)
    envargs = [f"{k}={v}" for k, v in env.items()]
    interp = INTERP.get(os.path.splitext(launcher)[1], "")
    argv = ([interp] if interp else []) + [launcher] + args
    if a.get("selfSession"):
        # launcher (agy-launch.sh) creates its own tmux session with that name
        r = subprocess.run(["env", *envargs, *argv], cwd=cwd, capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise RuntimeError((r.stderr or r.stdout).strip()[:300])
        time.sleep(2)
        return {"alive": tmux("has-session", "-t", "=" + s)[0] == 0}
    log = f"/tmp/collab-pipe-{s}.log"
    scrub = "unset ANTHROPIC_API_KEY CLAUDECODE CLAUDE_CODE_ENTRYPOINT; " if os.path.basename(launcher) == "collab-claude" else ""
    script = f'renice {NICE} -p $$ >/dev/null 2>&1; set -a; [ -f "$HOME/.secrets" ] && . "$HOME/.secrets"; set +a; {scrub}exec "$@"'
    rc, _, err = tmux("new-session", "-d", "-s", s, "-c", cwd, "env", *envargs, "bash", "-c", script, "hostd-launch", *argv,
                      ";", "set-option", "-t", s, "history-limit", "50000",
                      ";", "set-option", "-t", s, "mouse", "on",
                      ";", "pipe-pane", "-t", s, "-o", f"cat >> {log}")
    if rc:
        raise RuntimeError(err.strip()[:300])
    time.sleep(2)
    return {"alive": tmux("has-session", "-t", "=" + s)[0] == 0}


def op_kill(a):
    s = need_session(a)
    rc, _, err = tmux("kill-session", "-t", "=" + s)
    return {"killed": rc == 0}


def op_has(a):
    return {"alive": tmux("has-session", "-t", "=" + need_session(a))[0] == 0}


def op_capture(a):
    s = need_session(a)
    n = max(1, min(int(a.get("lines", 40)), 2000))
    rc, out, err = tmux("capture-pane", "-p", "-t", s, "-S", f"-{n}")
    if rc:
        raise RuntimeError(err.strip()[:200])
    return {"text": out}


def op_inject(a):
    s = need_session(a)
    text = str(a.get("text", ""))[:20000]
    rc, _, err = tmux("send-keys", "-t", s, "-l", text)
    if rc:
        raise RuntimeError(err.strip()[:200])
    if a.get("enter", True):
        time.sleep(0.3)
        tmux("send-keys", "-t", s, "Enter")
    return {"sent": True}


def op_interrupt(a):
    s = need_session(a)
    rc, _, err = tmux("send-keys", "-t", s, "C-c")
    if rc:
        raise RuntimeError(err.strip()[:200])
    return {"interrupted": True}


TMUX_SUBS = {"send-keys", "capture-pane", "has-session", "list-sessions", "list-panes", "kill-session",
             "set-option", "display-message"}


def op_tmux(a):
    """Allowlisted tmux subcommands only, and only against managed sessions."""
    args = [str(x) for x in a.get("args", [])]
    if not args or args[0] not in TMUX_SUBS:
        raise ValueError("tmux subcommand not allowed")
    if args[0] not in ("list-sessions", "list-panes") or (args[0] == "list-panes" and "-a" not in args):
        if "-t" not in args:
            raise ValueError("tmux target required")
        tgt = args[args.index("-t") + 1].lstrip("=").split(":")[0]
        if not SESSION_RE.match(tgt) or not tgt.startswith(PREFIXES):
            raise ValueError("session not managed by hostd")
    rc, out, err = tmux(*args)
    return {"rc": rc, "stdout": out[-200000:], "stderr": err[-2000:]}


def op_codex_profile(a):
    """Guard only the shared profile belonging to this managed session's process tree."""
    import codex_profile_guard
    session = need_session(a)
    if a.get("action") == "begin":
        rc, out, err = tmux("display-message", "-p", "-t", "=" + session + ":", "#{pane_pid}")
        if rc:
            raise RuntimeError(err.strip()[:200])
        return codex_profile_guard.begin(session, int(out.strip()))
    if a.get("action") == "finish":
        return codex_profile_guard.finish(session, str(a.get("token", "")))
    raise ValueError("unknown Codex profile action")


def op_paste(a):
    s = need_session(a)
    text = str(a.get("text", ""))[:200000]
    buf = "hostd-" + s
    r = subprocess.run(["tmux", "load-buffer", "-b", buf, "-"], input=text, text=True, capture_output=True, timeout=20)
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[:200])
    rc, _, err = tmux("paste-buffer", "-b", buf, "-d", "-t", s)
    if rc:
        raise RuntimeError(err.strip()[:200])
    if a.get("enter", True):
        time.sleep(0.3)
        tmux("send-keys", "-t", s, "Enter")
    return {"pasted": True}


def op_write_file(a):
    """Write a small file under an agent folder (or /tmp/devflow-remote); realpath-checked."""
    path = str(a.get("path", ""))
    data = str(a.get("content", ""))
    if len(data) > 500000:
        raise ValueError("file too large")
    tmpdir = os.path.realpath("/tmp/devflow-remote")
    os.makedirs(tmpdir, mode=0o700, exist_ok=True)
    parent = os.path.realpath(os.path.dirname(path) or ".")
    if not (under_roots(parent) or parent == tmpdir or parent.startswith(tmpdir + os.sep)):
        raise ValueError("path not allowed")
    full = os.path.join(parent, os.path.basename(path))
    if os.path.islink(full):
        raise ValueError("refusing symlink")
    with open(full, "w") as f:
        f.write(data)
    if a.get("mode"):
        os.chmod(full, int(a["mode"]) & 0o777)
    return {"path": full, "bytes": len(data)}


def _scaffolding_agents_path():
    return os.path.join(HOME, "DevFlow", ".AppData", "scaffolding", "agents.json")


def ensure_scaffolding_entry(name, agent_dir, agent_type):
    """sync.py renders only agents it has a registry entry for, and says "not found" for any other. An agent added to a project the
    server knows but this machine's registry does not (22 Oct 2026: three agents added to a new project got no rules or files) needs
    its entry here first. Adds one when none exists (same fields DevFlow writes itself); an existing entry is never touched.
    Returns True when an entry was added."""
    path = _scaffolding_agents_path()
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        data = {"version": 1, "agents": []}
    agents = data.get("agents")
    if not isinstance(agents, list):
        raise ValueError("the scaffolding agent list is not a list; not touching it")
    if any(isinstance(x, dict) and str(x.get("name", "")).casefold() == name.casefold() for x in agents):
        return False
    kind = agent_type if re.match(r"^[a-z0-9_-]{1,20}$", str(agent_type or "")) else "claude"
    agents.append({"name": name, "teamId": "sg1", "role": "Agent", "domain": "", "models": [kind], "agentType": kind,
                   "agentDir": agent_dir, "teamDir": agent_dir, "projectDir": os.path.dirname(os.path.dirname(agent_dir))})
    data["agents"] = agents
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
    os.replace(tmp, path)
    return True


def op_sync(a):
    """Scaffolding sync (+hook patch) for one agent on this machine; it writes that agent's .claude/."""
    name = str(a.get("agent", ""))
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,60}$", name):
        raise ValueError("bad agent name")
    cmd = ["python3", os.path.join(HOME, "DevFlow", "data", "scaffolding", "sync.py"), "--agent", name]
    d = a.get("dir")
    if d:
        if not under_roots(os.path.dirname(os.path.realpath(d))):
            raise ValueError("dir not allowed")
        os.makedirs(os.path.join(d, ".claude", "rules"), exist_ok=True)
        cmd += ["--target-dir", d]
        ensure_scaffolding_entry(name, os.path.realpath(d), a.get("agentType"))
    if a.get("agentType") and re.match(r"^[a-z0-9_-]{1,20}$", str(a["agentType"])):
        cmd += ["--agent-type", a["agentType"]]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    out = {"rc": r.returncode, "tail": (r.stdout + r.stderr)[-1200:]}
    if d:
        ph = os.path.join(HOME, "DevFlow", "scripts", "patch-hooks.py")
        r2 = subprocess.run(["python3", ph, "--workspace", d, "--agent", name], capture_output=True, text=True, timeout=60)
        out["hooksRc"] = r2.returncode
    return out


def _share_module():
    """devflow_share.py sits beside this file. It is imported when first needed, so a fault in the share tool cannot stop the daemon starting."""
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    import devflow_share
    return devflow_share


def op_share_agent(a):
    """The server asks for an agent's working folder and its Claude memory folder to be shared with it (writable, no expiry), so an agent set to
    run on the server starts without anyone typing `devflow-share agent` here. The gate is the one spawn and write-file already use (a Team folder
    under HOME, or a configured root) plus: the real folder (no link anywhere in the path), an existing directory, not the Team folder itself, and
    nothing devflow-share would refuse to share (secrets, system folders). Idempotent: folders already shared for good change nothing, the server
    is just told about them again. The share ids carry a short hash of the folder, so one agent name in two projects keeps both shares."""
    name = a.get("agent")
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _.-]{0,60}", name):      # fullmatch: "$" would let a trailing newline through
        raise ValueError("bad agent name")
    cwd = a.get("cwd")
    if not isinstance(cwd, str) or "\0" in cwd or not os.path.isabs(cwd):
        raise ValueError("cwd must be an absolute path")
    real = os.path.realpath(cwd)
    if real != os.path.normpath(cwd):
        raise ValueError("cwd goes through a link; use the real folder " + real)
    if not os.path.isdir(real) or not under_roots(real) or os.path.basename(real) == "Team":
        raise ValueError("cwd not allowed")
    share = _share_module()
    problem = share.root_path_problem(real)
    if problem:
        raise ValueError("cwd cannot be shared: " + problem)
    try:
        result = share.share_agent(name, real, by="hostd")
    except share.ShareError as e:
        raise ValueError(str(e))
    except share.PolicyError as e:
        raise ValueError("the share policy refused it: " + str(e))
    if result["failedRegistration"]:
        raise RuntimeError("shared here, but the server did not accept the registration of " + ", ".join(result["failedRegistration"]) + "; ask again")
    return result


def op_status(_a):
    mem = {}
    try:
        for line in open("/proc/meminfo"):
            k, v = line.split(":", 1)
            if k in ("MemTotal", "MemAvailable"):
                mem[k] = int(v.split()[0]) // 1024
    except Exception:
        pass
    rc, out, _ = tmux("list-sessions", "-F", "#S")
    return {"sessions": [x for x in out.split() if x.startswith(PREFIXES)] if rc == 0 else [], "memMB": mem}


def _interop_env():
    env = dict(os.environ)
    try:
        socks = sorted((f for f in os.listdir("/run/WSL") if re.match(r"^\d+_interop$", f)),
                       key=lambda f: int(f.split("_")[0]), reverse=True)
    except OSError:
        socks = []
    for f in [env.get("WSL_INTEROP")] + ["/run/WSL/" + x for x in socks]:
        if not f:
            continue
        env["WSL_INTEROP"] = f
        if subprocess.run(["/mnt/c/Windows/System32/cmd.exe", "/d", "/c", "exit", "0"], cwd="/mnt/c", env=env,
                          capture_output=True, timeout=5).returncode == 0:
            return env
    raise RuntimeError("no working WSL interop endpoint")


SERVER_SSH = str(CFG.get("serverSsh") or os.environ.get("DEVFLOW_SERVER_SSH") or "devflow-host")                       # ssh alias of the DevFlow server, from this PC (key-only)
ATTACH_SERVER = HOME + "/DevFlow/scripts/devflow-attach-server"


def terminal_attach_command(session, via):
    """What the terminal tab runs, as an argv list. `via` is "local" (a session on this PC) or "server" (a session on the DevFlow server, reached
    over ssh: the PC dials out, so nothing on the server holds a key that opens this PC)."""
    if via == "local":
        return ["tmux", "attach", "-t", session]
    if via == "server":
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", SERVER_SSH):
            raise ValueError("serverSsh in the hostd config is not a valid ssh alias")
        return [ATTACH_SERVER, session, SERVER_SSH]
    raise ValueError("bad via")


def op_open_terminal(a):
    """Open a Windows Terminal tab attached to a managed tmux session: one on this PC, or (via "server") one on the DevFlow server."""
    s = need_session(a)
    via = a.get("via") or "local"
    title = re.sub(r'["\r\n]', "", str(a.get("title") or s))[:120]
    parts = ["-w", "0", "new-tab", "-p", "Ubuntu", "--title", title, "--",
             "C:\\Windows\\System32\\wsl.exe", "-d", "Ubuntu", "--", *terminal_attach_command(s, via)]
    wt_args = ", ".join("'" + x.replace("'", "''") + "'" for x in parts)
    ps = "; ".join([
        "$ErrorActionPreference = 'Stop'",
        "$package = Get-AppxPackage Microsoft.WindowsTerminal | Select-Object -First 1",
        "if ($null -eq $package) { throw 'Windows Terminal is not installed' }",
        "$wt = Join-Path $package.InstallLocation 'wt.exe'",
        "Set-Location 'C:\\'",
        "$wtArgs = @(" + wt_args + ")",
        "& $wt @wtArgs",
        "Start-Sleep -Milliseconds 1500",
        "if ($null -eq (Get-Process -Name 'WindowsTerminal' -ErrorAction SilentlyContinue)) { throw 'Windows Terminal process did not start' }",
    ])
    r = subprocess.run(["/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
                       cwd="/mnt/c", env=_interop_env(), capture_output=True, text=True, timeout=15)
    if r.returncode:
        raise RuntimeError((r.stderr or r.stdout).strip()[:300])
    return {"opened": s, "via": via}


# .wslconfig lives on the Windows side of this PC. DevFlow runs on the server,
# so its WSL Resources settings read and write the file through these ops.
WSLCONFIG_LINE_RE = re.compile(r"^(\s*|\s*[#;].*|\s*\[[A-Za-z0-9_.-]{1,40}\]\s*|\s*[A-Za-z][A-Za-z0-9_.]{0,63}\s*=[^\r\n]{0,200})$")
_wslconfig_path = None


def _wslconfig():
    global _wslconfig_path
    if _wslconfig_path:
        return _wslconfig_path
    r = subprocess.run(["/mnt/c/Windows/System32/cmd.exe", "/d", "/c", "echo %USERPROFILE%"], cwd="/mnt/c",
                       env=_interop_env(), capture_output=True, text=True, timeout=10)
    m = re.match(r"^([A-Za-z]):\\(.+)$", r.stdout.strip())
    if not m:
        raise RuntimeError("could not resolve the Windows user profile")
    _wslconfig_path = "/mnt/" + m.group(1).lower() + "/" + m.group(2).replace("\\", "/") + "/.wslconfig"
    return _wslconfig_path


def op_wsl_config(_a):
    """Read .wslconfig plus the PC's total RAM and logical processors."""
    path = _wslconfig()
    content = open(path, encoding="utf-8-sig").read() if os.path.exists(path) else ""
    ps = ("$m = (Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum; "
          "$c = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum; "
          "'{0} {1}' -f [math]::Round($m / 1GB), $c")
    r = subprocess.run(["/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
                       cwd="/mnt/c", env=_interop_env(), capture_output=True, text=True, timeout=20)
    parts = r.stdout.split()
    if r.returncode or len(parts) != 2 or not all(x.isdigit() for x in parts):
        raise RuntimeError("could not read system resources: " + (r.stderr or r.stdout).strip()[:200])
    return {"path": path, "exists": bool(content), "content": content,
            "system": {"totalRamGB": int(parts[0]), "totalProcessors": int(parts[1])}}


MEMINFO_PATH = "/proc/meminfo"
MEMINFO_KEYS = ("MemTotal", "MemFree", "MemAvailable", "Buffers", "Cached", "SReclaimable", "SwapTotal", "SwapFree")
PRESSURE_FILES = ("/proc/pressure/{}", "/sys/fs/cgroup/{}.pressure")      # the system-wide file first; the root cgroup has none on a plain Linux box
WSLCONFIG_KEY_RE = re.compile(r"^\s*(memory|swap|processors)\s*=", re.I)


def op_memory_facts(_a):
    """Read-only: this WSL's memory facts for the Overview, as raw text (the server turns them into figures with the same code it uses for itself).
    A few /proc/meminfo lines, the pressure-stall files, and only the memory/swap/processors lines of .wslconfig. Takes no arguments."""
    errors = []
    meminfo = ""
    try:
        with open(MEMINFO_PATH) as f:
            meminfo = "".join(l for l in f if l.split(":", 1)[0] in MEMINFO_KEYS)
    except OSError as e:
        errors.append("%s: %s" % (MEMINFO_PATH, type(e).__name__))
    pressure = {}
    for name in ("memory", "cpu", "io"):
        for pattern in PRESSURE_FILES:
            try:
                with open(pattern.format(name)) as f:
                    pressure[name] = f.read(600)
                break
            except OSError:
                continue
    wslconfig = None                                      # None: could not be read. "": there is no .wslconfig, so WSL uses its defaults
    try:
        with open(_wslconfig(), encoding="utf-8-sig", errors="replace") as f:
            wslconfig = "".join(l if l.endswith("\n") else l + "\n" for l in f if WSLCONFIG_KEY_RE.match(l))
    except FileNotFoundError:
        wslconfig = ""
    except Exception as e:                                # the Windows user profile could not be found
        errors.append(".wslconfig: " + str(e)[:120])
    return {"meminfo": meminfo, "pressure": pressure, "wslconfig": wslconfig, "errors": errors}


def op_wsl_config_write(a):
    """Replace .wslconfig. Only INI sections, key=value lines and comments are accepted."""
    content = str(a.get("content", ""))
    if len(content) > 8192:
        raise ValueError("content too large")
    bad = next((l for l in content.splitlines() if not WSLCONFIG_LINE_RE.match(l)), None)
    if bad is not None:
        raise ValueError("not a .wslconfig line: " + bad[:80])
    path = _wslconfig()
    tmp = path + ".devflow-tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    os.replace(tmp, path)
    return {"path": path, "bytes": len(content)}


def op_wsl_restart(_a):
    """Shut WSL down from the Windows side after 2 s, so this reply reaches DevFlow first.
    Ends every WSL process on this PC, hostd included; systemd starts hostd again with WSL."""
    subprocess.Popen(["/mnt/c/Windows/System32/cmd.exe", "/d", "/c", "timeout /t 2 /nobreak >nul && wsl.exe --shutdown"],
                     cwd="/mnt/c", env=_interop_env(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    return {"scheduled": True}


# Computer Use desktop bridge. DevFlow runs on the server, so it cannot find Windows Python or
# start a Windows process itself; it asks this PC to start the bridge and reaches it over the
# devflow-desktop-tunnel leg (server 127.0.0.1:2150 -> this PC's Windows host:2150).
CU_BRIDGE_PORT = 2150
CU_BRIDGE_SCRIPT = HOME + "/DevFlow/scripts/computer_use_bridge.py"
CU_BRIDGE_LOG = "C:\\Temp\\devflow-bridge-error.log"
# Python 3.12 carries the bridge deps (pywinauto, mss, pyautogui); 3.13 is first on PATH and lacks them.
CU_PYTHONS = [*sorted(__import__("glob").glob("/mnt/c/Users/*/AppData/Local/Programs/Python/Python312/python.exe")),
              "/mnt/c/Python312/python.exe", "/mnt/c/Python311/python.exe", "/mnt/c/Python310/python.exe"]


def op_cu_bridge_start(_a):
    """Start the Windows bridge detached and return at once; DevFlow polls /health through the tunnel."""
    python = next((p for p in CU_PYTHONS if os.path.isfile(p)), None)
    if not python:
        raise RuntimeError("Windows Python not found on this PC: " + ", ".join(CU_PYTHONS))
    if not os.path.isfile(CU_BRIDGE_SCRIPT):
        raise RuntimeError("bridge script missing: " + CU_BRIDGE_SCRIPT)
    env = _interop_env()
    win = lambda p: subprocess.run(["wslpath", "-w", p], capture_output=True, text=True, check=True).stdout.strip()
    py_win, script_win = win(python), win(CU_BRIDGE_SCRIPT)
    # 0.0.0.0: the tunnel reaches Windows from WSL (NAT mode) through the vEthernet gateway, not loopback.
    cmd_args = f'/C ""{py_win}" "{script_win}" --port {CU_BRIDGE_PORT} --host 0.0.0.0 >> {CU_BRIDGE_LOG} 2>&1"'
    ps = "; ".join([
        "$ErrorActionPreference = 'Stop'",
        "if (!(Test-Path C:\\Temp)) { New-Item -ItemType Directory -Path C:\\Temp | Out-Null }",
        f"if (Get-NetTCPConnection -LocalPort {CU_BRIDGE_PORT} -State Listen -ErrorAction SilentlyContinue) {{ 'running'; exit 0 }}",
        "Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList '" + cmd_args.replace("'", "''") + "'",
        "'started'",
    ])
    r = subprocess.run(["/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "-NoProfile", "-NonInteractive",
                        "-ExecutionPolicy", "Bypass", "-Command", ps],
                       cwd="/mnt/c", env=env, capture_output=True, text=True, timeout=20)
    if r.returncode:
        raise RuntimeError((r.stderr or r.stdout).strip()[:300])
    return {"state": r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "started", "python": py_win,
            "port": CU_BRIDGE_PORT}


def op_cu_bridge_log(_a):
    """Last lines of the bridge's own log, for startup-timeout diagnostics."""
    path = "/mnt/c/Temp/devflow-bridge-error.log"
    if not os.path.exists(path):
        return {"tail": ""}
    raw = open(path, "rb").read()[-16384:]
    text = raw.decode("utf-16-le", "replace") if raw.count(b"\x00") > len(raw) // 4 else raw.decode("utf-8", "replace")
    return {"tail": "\n".join(l for l in text.replace("\x00", "").splitlines() if l.strip())[-2000:]}


# Channel project folders. DevFlow (on the server) creates a channel's project folder, but agents work on
# this PC, so the folder must exist here too; deleting a channel may remove it again. Only folders directly
# under home qualify: nested or shared trees (SG-1, DevFlow, Games/...) are never touched by these ops.
PROJECT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}$")
PROTECTED_PROJECTS = {"SG-1", "DevFlow", "bin", "Games", "Team", "snap", "go"}


def _project_dir(a):
    path = str(a.get("path", ""))
    name = os.path.basename(path.rstrip("/"))
    if not os.path.isabs(path) or os.path.dirname(os.path.normpath(path)) != HOME_REAL:
        raise ValueError("project folder must sit directly in home")
    if not PROJECT_NAME_RE.match(name) or name in PROTECTED_PROJECTS:
        raise ValueError("project folder name not allowed")
    return os.path.join(HOME_REAL, name)


def _git_state(root):
    """Uncommitted or unpushed work in any git repo up to 3 levels down (node_modules skipped)."""
    issues = []
    for dirpath, dirnames, _ in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != "node_modules"]
        if dirpath[len(root):].count(os.sep) >= 3:
            dirnames[:] = []
        if ".git" in dirnames:
            dirnames.remove(".git")
            rel = os.path.relpath(dirpath, root)
            st = subprocess.run(["git", "-C", dirpath, "status", "--porcelain"], capture_output=True, text=True, timeout=30)
            if st.stdout.strip():
                issues.append(f"{rel}: uncommitted changes")
            up = subprocess.run(["git", "-C", dirpath, "log", "--branches", "--not", "--remotes", "--oneline"],
                                capture_output=True, text=True, timeout=30)
            if up.stdout.strip():
                issues.append(f"{rel}: commits not pushed")
    return issues


def _processes_inside(root):
    busy = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            cwd = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            continue
        if cwd == root or cwd.startswith(root + os.sep):
            busy.append(pid)
    return busy


def op_project_mkdir(a):
    d = _project_dir(a)
    created = not os.path.isdir(d)
    os.makedirs(d, exist_ok=True)
    return {"path": d, "created": created}


def op_project_info(a):
    d = _project_dir(a)
    if not os.path.isdir(d) or os.path.islink(d):
        return {"path": d, "exists": False}
    du = subprocess.run(["du", "-sb", d], capture_output=True, text=True, timeout=120)
    files = sum(len(f) for _, _, f in os.walk(d))
    return {"path": d, "exists": True, "bytes": int((du.stdout.split() or ["0"])[0]), "files": files,
            "gitIssues": _git_state(d), "busy": len(_processes_inside(d))}


def op_project_remove(a):
    d = _project_dir(a)
    if os.path.islink(d):
        raise ValueError("refusing symlink")
    if not os.path.isdir(d):
        return {"path": d, "removed": False, "missing": True}
    issues = _git_state(d)
    discarded = []
    if issues:
        # the owner can choose to delete a folder whose unsaved git work the dialog showed him (18 Oct 2026). Only a literal
        # JSON true from the caller counts; protected names, symlinks and running programs are never overridden.
        if a.get("discardUnsavedGit") is not True:
            raise RuntimeError("folder kept, it has unsaved git work: " + "; ".join(issues[:5]))
        discarded = issues
    if _processes_inside(d):
        raise RuntimeError("folder kept, programs are still running inside it (stop the channel's agents first)")
    shutil.rmtree(d)
    return {"path": d, "removed": True, **({"discarded": discarded} if discarded else {})}


# Channel tools: a channel's project folder holds `channel-tools/<tool>/tool.json` (+ files) that the owner opens from
# the AgentChat launcher. DevFlow runs on the server, so it reads that folder through these two read-only ops.
# The folder must be named channel-tools and sit under home (or an allowed root); a tool is a real sub-folder
# (never a symlink); served paths stay inside it and never include dot-files.
CT_TOOL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
CT_MAX_MANIFEST = 64 * 1024
CT_MAX_FILE = 5 * 1024 * 1024
CT_MAX_TOOLS = 100


def _ct_allowed_base(p):
    return p == HOME_REAL or p.startswith(HOME_REAL + os.sep) or any(p == r or p.startswith(r + os.sep) for r in ROOTS)


def _ct_root(a):
    d = str(a.get("dir", "")).rstrip("/")
    if not os.path.isabs(d) or os.path.basename(d) != "channel-tools" or "\0" in d:
        raise ValueError("not a channel-tools folder")
    parent = os.path.realpath(os.path.dirname(d))
    real = os.path.realpath(os.path.join(parent, "channel-tools"))
    if not (_ct_allowed_base(parent) and _ct_allowed_base(real)):
        raise ValueError("folder not allowed")
    return real


def op_channel_tools_list(a):
    root = _ct_root(a)
    if not os.path.isdir(root):
        return {"exists": False, "tools": []}
    tools = []
    for name in sorted(os.listdir(root)):
        if name.startswith("."):
            continue
        full = os.path.join(root, name)
        if os.path.islink(full) or not os.path.isdir(full):
            continue
        if len(tools) >= CT_MAX_TOOLS:
            break
        item = {"id": name, "manifest": None, "error": None}
        mf = os.path.join(full, "tool.json")
        try:
            if not CT_TOOL_RE.match(name):
                item["error"] = "folder name may only use letters, numbers, dot, dash and underscore"
            elif os.path.islink(mf) or not os.path.isfile(mf):
                item["error"] = "missing tool.json"
            elif os.path.getsize(mf) > CT_MAX_MANIFEST:
                item["error"] = "tool.json is too large"
            else:
                with open(mf, "r", encoding="utf-8", errors="replace") as f:
                    item["manifest"] = f.read()
        except OSError as e:
            item["error"] = "cannot read tool.json: " + e.__class__.__name__
        tools.append(item)
    return {"exists": True, "tools": tools}


def op_channel_tools_read(a):
    import base64
    root = _ct_root(a)
    tool = str(a.get("tool", ""))
    if not CT_TOOL_RE.match(tool):
        raise ValueError("bad tool name")
    tool_dir = os.path.join(root, tool)
    if os.path.islink(tool_dir) or not os.path.isdir(tool_dir):
        raise FileNotFoundError("no such tool")
    tool_real = os.path.realpath(tool_dir)
    segs = str(a.get("path", "")).split("/")
    if not segs or any(not s or s in (".", "..") or s.startswith(".") or "\\" in s or "\0" in s for s in segs):
        raise ValueError("bad file path")
    real = os.path.realpath(os.path.join(tool_real, *segs))
    if not real.startswith(tool_real + os.sep) or not os.path.isfile(real):
        raise FileNotFoundError("no such file")
    size = os.path.getsize(real)
    if size > CT_MAX_FILE:
        raise ValueError("file too large")
    with open(real, "rb") as f:
        data = f.read(CT_MAX_FILE + 1)
    return {"b64": base64.b64encode(data).decode("ascii"), "size": len(data), "mtime": int(os.path.getmtime(real))}


# Project docs: the Project Docs panel shows a channel's PROJECT.md. DevFlow runs on the server and the project folder is on
# this PC, so the server reads that one file through this read-only op. Same limits as channel tools: an absolute folder under
# home or an allowed root, and the file must be a real file named PROJECT.md (never a symlink, never any other name).
PD_MAX = 1024 * 1024


def op_harness_signin(a):
    """Terminal-free sign-in for Claude Code / Codex on this machine, and the status probe (scripts/harness_signin.py).
    Arguments: action (probe | start | status | code | cancel | list), harness, id, code. hostd runs one command at a time, so start and code wait
    only a few seconds and the server polls status for the rest. Returns plain {"error", "code"} for expected refusals; the pasted code is never
    logged (hostd prints only the op name) and never appears in a message."""
    import harness_signin
    action = str(a.get("action", ""))
    try:
        if action == "probe":
            return harness_signin.probe(str(a.get("harness", "")))
        if action == "start":
            return harness_signin.start(str(a.get("harness", "")), settle=6.0)
        if action == "status":
            return harness_signin.status(str(a.get("id", "")))
        if action == "code":
            return harness_signin.submit_code(str(a.get("id", "")), str(a.get("code", "")), settle=6.0)
        if action == "cancel":
            return harness_signin.cancel(str(a.get("id", "")))
        if action == "list":
            return harness_signin.listing()
    except harness_signin.SignInError as e:
        return {"error": e.message, "code": e.code}
    raise ValueError("unknown action")


def op_project_doc_read(a):
    d = str(a.get("dir", "")).rstrip("/")
    if not os.path.isabs(d) or "\0" in d:
        raise ValueError("not a project folder")
    real = os.path.realpath(d)
    if not _ct_allowed_base(real):
        raise ValueError("folder not allowed")
    if not os.path.isdir(real):
        return {"exists": False, "folderExists": False}
    doc = os.path.join(real, "PROJECT.md")
    if os.path.islink(doc) or not os.path.isfile(doc):
        return {"exists": False, "folderExists": True}
    if os.path.getsize(doc) > PD_MAX:
        raise ValueError("file too large")
    with open(doc, "r", encoding="utf-8", errors="replace") as f:
        content = f.read(PD_MAX + 1)
    return {"exists": True, "folderExists": True, "content": content, "mtime": int(os.path.getmtime(doc))}


# Live Feed: DevFlow runs on the server but the agents' transcripts are written on this PC, so the server reads them through this op
# (/api/agent-stream, lib/agent-stream-fs.ts). Read-only and narrow on purpose: only transcript data under the harnesses' session
# folders (never ~/.gemini's login files), plus the few small files an agent folder holds for the stream (its scratch pointers and
# the Grok / Antigravity stream files). Every path is resolved first, so a link cannot lead out of the allowed folders.
SF_MAX_READ = 1 << 20
SF_MAX_ENTRIES = 5000
SF_MAX_DEPTH = 6
SF_DATA_SUBDIRS = (".claude/projects", ".codex/sessions", ".gemini/tmp", ".grok/sessions")
SF_DATA_FILES = {".project_root", "transcript-path", "session-id"}
SF_FOLDER_FILES = {"transcript-path", "session-id", ".grok-stream.jsonl", ".antigravity-stream.jsonl"}


def _sf_data_roots():
    return [os.path.join(HOME_REAL, d) for d in SF_DATA_SUBDIRS]


def _sf_in(real, roots):
    return any(real == r or real.startswith(r + os.sep) for r in roots)


def _sf_file_ok(real):
    name = os.path.basename(real)
    if _sf_in(real, _sf_data_roots()):
        return name.endswith(".jsonl") or name in SF_DATA_FILES
    return name in SF_FOLDER_FILES and under_roots(real)


def _sf_dir_ok(real):
    return _sf_in(real, _sf_data_roots())


def _sf_path(a, key="path"):
    raw = str(a.get(key, ""))
    if not os.path.isabs(raw) or "\0" in raw:
        raise ValueError("path must be absolute")
    return os.path.realpath(raw)


def _sf_stat_entry(path, name):
    st = os.stat(path)
    return {"name": name, "isDir": os.path.isdir(path), "isFile": os.path.isfile(path), "size": st.st_size, "mtimeMs": st.st_mtime * 1000}


def op_stream_fs(a):
    action = str(a.get("action", ""))
    if action == "home":
        return {"home": HOME_REAL}
    if action == "files":
        root = _sf_path(a, "root")
        if not _sf_dir_ok(root):
            raise ValueError("folder not allowed")
        prefix, suffix, exact = str(a.get("prefix", "")), str(a.get("suffix", "")), str(a.get("name", ""))
        depth_max = max(0, min(int(a.get("maxDepth", 4)), SF_MAX_DEPTH))
        found = []
        if os.path.isdir(root):
            base_depth = root.count(os.sep)
            for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
                if dirpath.count(os.sep) - base_depth >= depth_max:
                    dirnames[:] = []
                for name in filenames:
                    if exact and name != exact:
                        continue
                    if prefix and not name.startswith(prefix):
                        continue
                    if suffix and not name.endswith(suffix):
                        continue
                    full = os.path.join(dirpath, name)
                    try:
                        if os.path.islink(full):
                            continue
                        st = os.stat(full)
                    except OSError:
                        continue
                    found.append({"path": full, "size": st.st_size, "mtimeMs": st.st_mtime * 1000})
                    if len(found) >= SF_MAX_ENTRIES:
                        return {"files": found, "truncated": True}
        return {"files": found, "truncated": False}
    path = _sf_path(a)
    if action == "list":
        if not _sf_dir_ok(path):
            raise ValueError("folder not allowed")
        if not os.path.isdir(path):
            return {"exists": False, "entries": []}
        entries = []
        for name in sorted(os.listdir(path))[:SF_MAX_ENTRIES]:
            try:
                entries.append(_sf_stat_entry(os.path.join(path, name), name))
            except OSError:
                continue
        return {"exists": True, "entries": entries}
    if not (_sf_file_ok(path) or (action == "stat" and _sf_dir_ok(path))):
        raise ValueError("file not allowed")
    if action == "stat":
        if not os.path.exists(path):
            return {"exists": False}
        return dict(_sf_stat_entry(path, os.path.basename(path)), exists=True)
    if not os.path.isfile(path):
        return {"exists": False}
    size = os.path.getsize(path)
    if action == "text":
        limit = max(1, min(int(a.get("max", 65536)), SF_MAX_READ))
        with open(path, "rb") as f:
            data = f.read(limit)
        return {"exists": True, "size": size, "text": data.decode("utf-8", errors="replace")}
    if action == "read":
        start = max(0, int(a.get("offset", 0)))
        length = max(0, min(int(a.get("length", SF_MAX_READ)), SF_MAX_READ))
        with open(path, "rb") as f:
            f.seek(start)
            data = f.read(length)
        return {"exists": True, "size": size, "offset": start, "data": base64.b64encode(data).decode("ascii")}
    if action == "tail":
        limit = max(1, min(int(a.get("max", SF_MAX_READ)), SF_MAX_READ))
        start = max(0, size - limit)
        with open(path, "rb") as f:
            f.seek(start)
            data = f.read(limit)
        return {"exists": True, "size": size, "offset": start, "data": base64.b64encode(data).decode("ascii")}
    raise ValueError("unknown action")


def op_usage_facts(a):
    """Token totals of this machine's Claude sessions for DevFlow's usage panel (scripts/hostd_usage.py). Answers from a background index."""
    import hostd_usage
    return hostd_usage.op_usage_facts(a, HOME_REAL)


def op_transcript_mtimes(a):
    """Modified time of each agent's active transcript, for DevFlow's frozen-agent check (scripts/hostd_usage.py)."""
    import hostd_usage
    return hostd_usage.op_transcript_mtimes(a, HOME_REAL, under_roots)


def op_save_mtimes(a):
    """When the files an agent writes while saving its notes were last modified, for DevFlow's restart grace window (scripts/hostd_usage.py)."""
    import hostd_usage
    return hostd_usage.op_save_mtimes(a, HOME_REAL, under_roots)


# Inbox delivery for agents running on this PC. DevFlow (on the server) writes `.claude/inbox-<id>.json`
# on its own disk, which a wrapper here never reads; the server asks this host to append instead.
# Locked with the same flock the wrapper uses, and de-duplicated by message id so a retried
# delivery stays one message.
INBOX_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")


def op_inbox_append(a):
    import fcntl
    d = os.path.realpath(str(a.get("dir", "")))
    if not os.path.isdir(d) or os.path.islink(str(a.get("dir", ""))) or not under_roots(d):
        raise ValueError("inbox dir not allowed")
    pid = str(a.get("participantId", ""))
    entry = a.get("entry")
    if not INBOX_ID_RE.match(pid) or not isinstance(entry, dict) or not INBOX_ID_RE.match(str(entry.get("id", ""))):
        raise ValueError("bad inbox entry")
    if len(json.dumps(entry)) > 200000:
        raise ValueError("inbox entry too large")
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", pid)[:50]
    os.makedirs(os.path.join(d, ".claude"), exist_ok=True)
    path = os.path.join(d, ".claude", f"inbox-{safe}.json")
    if os.path.islink(path):
        raise ValueError("refusing symlink")
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    with os.fdopen(fd, "r+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        raw = f.read()
        try:
            inbox = json.loads(raw) if raw.strip() else None
        except ValueError:
            inbox = None
        if not isinstance(inbox, dict) or not isinstance(inbox.get("messages"), list):
            inbox = {"sessionId": pid, "messages": [], "lastUpdated": ""}
        if any(m.get("id") == entry["id"] for m in inbox["messages"] if isinstance(m, dict)):
            print("inbox-append", entry["id"], "duplicate", flush=True)
            return {"path": path, "appended": False, "duplicate": True}
        inbox["messages"] = (inbox["messages"] + [dict(entry, read=False)])[-50:]
        inbox["lastUpdated"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        f.seek(0)
        f.truncate()
        f.write(json.dumps(inbox, indent=2))
        f.flush()
    # Content-free commit stamp on this host's clock, keyed by message id (hearing delivery correlation).
    committed_ms = int(time.time() * 1000)
    print("inbox-append", entry["id"], "appended", committed_ms, flush=True)
    return {"path": path, "appended": True, "committed_ms": committed_ms}



# --- hearing-source-verify v1 (verified desktop source access, 8 Oct 2026) ---
# Hashes whole case sources under an allowlisted case_id -> exact canonical root binding and returns identities
# only: no bytes, text or listings. Every failure is "SOURCE_<UNAVAILABLE|CHANGED|INVALID>:<reason>" with no path.
SRC_MAX_BYTES = 100 * 1024 * 1024
SRC_BATCH = 128
SRC_DEADLINE_S = 18.0  # inside the server's 20 s call deadline
SRC_HEX = re.compile(r"^[a-f0-9]{64}$")
SRC_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
SRC_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def _src_fail(kind, reason):
    raise ValueError(f"SOURCE_{kind}:{reason}")


def hearing_sources():
    """case_id -> exact canonical root, re-read per call so commissioning needs no restart."""
    try:
        cfg = json.load(open(os.environ.get("HOSTD_CONFIG") or os.path.join(HOME, ".config", "devflow-hostd.json")))
    except Exception:
        return {}
    m = cfg.get("hearingSources")
    return m if isinstance(m, dict) else {}


def _src_rel_ok(p):
    return (isinstance(p, str) and 0 < len(p) <= 2000 and not p.startswith("/") and "\\" not in p
            and not SRC_CONTROL.search(p) and all(seg not in ("", ".", "..") for seg in p.split("/")))


def _src_identity(st):
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)


def op_hearing_source_verify(a):
    """Every failure leaves as a content-free SOURCE code: raw OS errors carry paths, so none escape."""
    try:
        return _hearing_source_verify(a)
    except ValueError as e:
        if str(e).startswith("SOURCE_"):
            raise
        raise ValueError("SOURCE_INVALID:request") from None
    except FileNotFoundError:
        raise ValueError("SOURCE_UNAVAILABLE:missing") from None
    except OSError:
        raise ValueError("SOURCE_UNAVAILABLE:unreadable") from None
    except Exception:
        raise ValueError("SOURCE_INVALID:internal") from None


def _hearing_source_verify(a):
    import hashlib
    import stat as statmod
    started = time.monotonic()
    if a.get("version") != 1:
        _src_fail("INVALID", "version")
    case_id, version, root, files = a.get("case_id"), a.get("evidence_version"), a.get("root"), a.get("files")
    if not isinstance(case_id, str) or not SRC_ID.match(case_id) or not isinstance(version, str) or not SRC_ID.match(version):
        _src_fail("INVALID", "identity")
    bound = hearing_sources().get(case_id)
    if not isinstance(bound, str):
        _src_fail("UNAVAILABLE", "case_not_bound")
    if root != bound:
        _src_fail("INVALID", "root_mismatch")
    if not os.path.isdir(root):
        _src_fail("UNAVAILABLE", "root_missing")
    if os.path.realpath(root) != root:
        _src_fail("INVALID", "root_not_canonical")
    root_id = _src_identity(os.stat(root))
    if not isinstance(files, list) or not 0 < len(files) <= SRC_BATCH:
        _src_fail("INVALID", "batch_size")
    seen = set()
    for f in files:
        if not isinstance(f, dict) or not _src_rel_ok(f.get("relative_path")) or not SRC_HEX.match(str(f.get("expected_sha256", ""))):
            _src_fail("INVALID", "request_path")
        if f["relative_path"] in seen:
            _src_fail("INVALID", "request_duplicate")
        seen.add(f["relative_path"])
    out = []
    for f in files:
        rel = f["relative_path"]
        full = os.path.join(root, rel)
        try:
            canon = os.path.realpath(full, strict=True)
        except FileNotFoundError:
            _src_fail("UNAVAILABLE", "missing")
        except OSError:
            _src_fail("UNAVAILABLE", "unreadable")
        if not canon.startswith(root + os.sep):
            _src_fail("INVALID", "escape")
        if canon != full:
            _src_fail("INVALID", "symlink")
        before = os.lstat(canon)
        if not statmod.S_ISREG(before.st_mode):
            _src_fail("INVALID", "not_regular")
        if before.st_size > SRC_MAX_BYTES:
            _src_fail("INVALID", "too_large")
        try:
            fd = os.open(canon, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
        except OSError:
            _src_fail("UNAVAILABLE", "unreadable")
        h, total = hashlib.sha256(), 0
        try:
            if _src_identity(os.fstat(fd)) != _src_identity(before):
                _src_fail("CHANGED", "during_hash")
            while True:
                if time.monotonic() - started > SRC_DEADLINE_S:
                    _src_fail("UNAVAILABLE", "timeout")
                chunk = os.read(fd, 1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > before.st_size:  # growing while hashed (size already capped above)
                    _src_fail("CHANGED", "during_hash")
                h.update(chunk)
            after_fd = _src_identity(os.fstat(fd))
        finally:
            os.close(fd)
        try:
            after_path = _src_identity(os.lstat(canon))
        except OSError:
            _src_fail("CHANGED", "during_hash")
        if (total != before.st_size or after_fd != _src_identity(before) or after_path != _src_identity(before)
                or os.path.realpath(full) != canon):
            _src_fail("CHANGED", "during_hash")
        digest = h.hexdigest()
        if digest != f["expected_sha256"]:
            _src_fail("CHANGED", "digest")
        out.append({"relative_path": rel, "canonical_path": canon, "sha256": digest, "size": total})
    if _src_identity(os.stat(root)) != root_id or os.path.realpath(root) != root:
        _src_fail("CHANGED", "root")
    return {"version": 1, "case_id": case_id, "evidence_version": version, "root": root, "files": out}

FIREWALL_FACTS_PS1 = HOME + "/DevFlow/scripts/windows/firewall-facts.ps1"
POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"


def op_firewall_facts(_a):
    """Read-only: the PC's Windows Firewall rules and what listens on Windows (one PowerShell run, no administrator rights), plus what listens inside WSL.
    DevFlow's Firewall panel turns these facts into the desktop's half of the report."""
    with open(FIREWALL_FACTS_PS1, encoding="utf-8") as f:
        script = f.read()
    encoded = base64.b64encode(script.encode("utf-16-le")).decode()
    if len(encoded) > 30000:   # a Windows command line holds about 32 000 characters
        raise RuntimeError("firewall-facts.ps1 is too long to pass as an encoded command")
    r = subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
                       cwd="/mnt/c", env=_interop_env(), capture_output=True, timeout=60)
    out = r.stdout.decode("utf-8-sig", errors="replace").strip()
    if r.returncode or not out:
        raise RuntimeError((r.stderr.decode("utf-8", errors="replace").strip() or out or "PowerShell printed nothing")[:300])
    try:
        windows = json.loads(out)
    except ValueError:
        raise RuntimeError("PowerShell did not print JSON: " + out[:120])
    ss = subprocess.run(["ss", "-H", "-ltnup"], capture_output=True, text=True, errors="replace", timeout=10).stdout
    addr = subprocess.run(["ip", "-j", "addr"], capture_output=True, text=True, errors="replace", timeout=10).stdout
    return {"windows": windows, "wsl": {"ss": ss, "ipAddr": addr}}


OPS = {"firewall-facts": op_firewall_facts, "memory-facts": op_memory_facts, "cu-bridge-start": op_cu_bridge_start, "cu-bridge-log": op_cu_bridge_log, "spawn": op_spawn, "kill": op_kill, "has": op_has, "capture": op_capture,
       "inject": op_inject, "interrupt": op_interrupt, "status": op_status,
       "codex-profile": op_codex_profile, "tmux": op_tmux, "paste": op_paste, "write-file": op_write_file, "open-terminal": op_open_terminal, "sync": op_sync,
       "wsl-config": op_wsl_config, "wsl-config-write": op_wsl_config_write, "wsl-restart": op_wsl_restart,
       "project-mkdir": op_project_mkdir, "project-info": op_project_info, "project-remove": op_project_remove,
       "inbox-append": op_inbox_append, "hearing-source-verify": op_hearing_source_verify,
       "channel-tools-list": op_channel_tools_list, "channel-tools-read": op_channel_tools_read,
       "project-doc-read": op_project_doc_read, "harness-signin": op_harness_signin, "stream-fs": op_stream_fs, "usage-facts": op_usage_facts, "save-mtimes": op_save_mtimes, "transcript-mtimes": op_transcript_mtimes,
       "share-agent": op_share_agent}


def run_command(cmd):
    fn = OPS.get(cmd.get("op"))
    if not fn:
        return {"ok": False, "error": "unknown op"}
    try:
        return {"ok": True, "result": fn(cmd.get("args") or {})}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"[:400]}


def main():
    if not shutil.which("tmux"):
        sys.exit("tmux not found")
    print(f"hostd {HOST_ID} -> {URL}", flush=True)
    backoff = 1
    while True:
        try:
            resp = api("POST", f"/api/hosts/{HOST_ID}/poll",
                       {"version": VERSION, "status": op_status({}), "wait": 25}, timeout=40)
            backoff = 1
            for cmd in resp.get("commands", []):
                res = run_command(cmd)
                print(cmd.get("op"), "ok" if res["ok"] else res["error"], flush=True)
                api("POST", f"/api/hosts/{HOST_ID}/result", {"id": cmd.get("id"), **res})
        except (urllib.error.URLError, OSError, ValueError) as e:
            print("link down:", e, flush=True)
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)


if __name__ == "__main__":
    main()
