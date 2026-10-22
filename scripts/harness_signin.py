#!/usr/bin/env python3
"""Terminal-free sign-in for harness programs (Claude Code, Codex), and the cheap status probe behind it.

Why: when a login expires nobody has that agent's terminal open, and agents on the laptop or a VPS have no terminal at all. This runs the
program's own login inside a hidden tmux session, reads the link (and one-time code) the program prints, and lets the dashboard finish the job.

How it behaves (all observed on the real programs, 18 Oct 2026):
  * claude auth login --claudeai  prints an authorize link and waits at "Paste code here if prompted >". A wrong code makes it print
    "Login failed: Request failed with status code 400" and EXIT, so a retry needs a fresh link (a new sign-in), not a second paste.
  * codex login --device-auth     prints a link and a one-time code (valid 15 minutes) and polls; nothing is pasted back.
  * claude auth status / codex login status  exit 0 when signed in and 1 when not, in about 0.1 to 0.3 s.

Safety:
  * The login runs in its own tmux server (socket "devflow-signin"), so it never appears among agent sessions or counts against their limit.
  * It starts with a minimal environment (no API keys, no DevFlow tokens) and BROWSER=true so nothing tries to open a browser.
  * The pasted code arrives on stdin (never argv, so it is not in the process list), is checked against a strict pattern, typed into the
    prompt, and never stored, logged or returned. State files hold only the link and progress, mode 0600 in a 0700 directory.
  * One sign-in per harness at a time; every sign-in dies after 15 minutes.

CLI (JSON on stdout, exit 0; failures are {"error": ..., "code": ...} with exit 2):
  harness_signin.py probe  --harness claude|codex
  harness_signin.py start  --harness claude|codex
  harness_signin.py status --id ID
  harness_signin.py code   --id ID          (the code on stdin)
  harness_signin.py cancel --id ID
  harness_signin.py list
"""
import argparse
import base64
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import uuid

HOME = os.path.expanduser("~")
STATE_DIR = os.environ.get("DEVFLOW_SIGNIN_STATE") or os.path.join(HOME, ".local", "state", "devflow-signin")
TMUX_SOCKET = os.environ.get("DEVFLOW_SIGNIN_TMUX_SOCKET") or "devflow-signin"
TTL_SECONDS = 15 * 60
KEEP_FINISHED_SECONDS = 10 * 60
PROBE_TIMEOUT = 20
EXTRA_PATH = [os.path.join(HOME, ".local", "bin"), os.path.join(HOME, ".npm-global", "bin"), "/usr/local/bin", "/usr/bin", "/bin"]

HARNESSES = {
    "claude": {
        "bin": "claude", "login": ["auth", "login", "--claudeai"], "status": ["auth", "status"], "kind": "paste-code",
        "label": "Claude", "config_env": "CLAUDE_CONFIG_DIR",
    },
    "codex": {
        "bin": "codex", "login": ["login", "--device-auth"], "status": ["login", "status"], "kind": "device-code",
        "label": "Codex", "config_env": "CODEX_HOME",
    },
    # Antigravity (Gemini): no login command and no status command. Its first run asks for a login method, prints a Google link and waits for
    # the authorization code, and the saved login is one file (see antigravity_token_path), so "signed in" is read from that file.
    "antigravity": {
        "bin": "agy", "login": [], "status": None, "kind": "paste-code",
        "label": "Antigravity", "config_env": None,
    },
}
# Environment the login and status programs may see. Nothing else is passed, so no API key or token leaks in.
ENV_KEEP = ("HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SHELL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy",
            "no_proxy", "SSL_CERT_FILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME")
# What a pasted code may look like: the characters Anthropic and OpenAI codes use, nothing that could act as a control key.
CODE_RE = re.compile(r"^[A-Za-z0-9_\-#.~=+/]{8,512}$")
URL_RE = re.compile(r"https://[^\s\x1b\"'<>]+")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
USER_CODE_RE = re.compile(r"\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b")
EXIT_RE = re.compile(r"\[exit:(\d+)\]")


class SignInError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def now():
    return time.time()


def iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def spec(harness):
    if harness not in HARNESSES:
        raise SignInError("BAD_HARNESS", "harness must be claude, codex or antigravity")
    base = dict(HARNESSES[harness])
    override = os.environ.get("DEVFLOW_SIGNIN_COMMANDS")  # tests only: {"claude": {"login": [...], "status": [...]}}, full argv lists
    if override:
        custom = json.loads(override).get(harness)
        if custom:
            base["argv_login"] = custom["login"]
            base["argv_status"] = custom["status"]
    return base


def nvm_bin_dirs(home=None):
    """Programs installed with npm under nvm (Codex) live in a versioned folder that a service's PATH never lists. Newest version first."""
    root = os.path.join(home or HOME, ".nvm", "versions", "node")
    try:
        names = os.listdir(root)
    except OSError:
        return []
    found = [(tuple(int(n) for n in re.findall(r"\d+", name)), os.path.join(root, name, "bin")) for name in names if re.match(r"v\d", name)]
    return [path for _, path in sorted(found, reverse=True) if os.path.isdir(path)]


def search_path():
    seen, parts = set(), []
    for p in os.environ.get("PATH", "").split(":") + EXTRA_PATH + nvm_bin_dirs():
        if p and p not in seen:
            seen.add(p)
            parts.append(p)
    return ":".join(parts)


def argv_for(harness, which):
    s = spec(harness)
    if ("argv_" + which) in s:
        return list(s["argv_" + which])
    exe = shutil.which(s["bin"], path=search_path())
    if not exe:
        raise SignInError("NOT_INSTALLED", "%s is not installed on this machine" % s["label"])
    return [exe] + list(s[which])


def clean_env(extra=None):
    env = {k: os.environ[k] for k in ENV_KEEP if k in os.environ}
    env["PATH"] = search_path()
    env["BROWSER"] = "true"
    env.setdefault("TERM", "xterm-256color")
    env.update(extra or {})
    return env


def strip_ansi(text):
    return ANSI_RE.sub("", text)


# ── tmux plumbing ──────────────────────────────────────────────────────────────

def tmux(*args, check=False):
    cmd = ["tmux", "-L", TMUX_SOCKET] + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    if check and r.returncode:
        raise SignInError("TMUX", "terminal helper failed: " + (r.stderr or r.stdout).strip()[:120])
    return r


def session_alive(name):
    return tmux("has-session", "-t", "=" + name).returncode == 0


def read_pane(name):
    r = tmux("capture-pane", "-p", "-J", "-S", "-300", "-t", "=" + name + ":")
    return strip_ansi(r.stdout) if r.returncode == 0 else ""


# ── state files ────────────────────────────────────────────────────────────────

def state_path(sid):
    if not re.fullmatch(r"[0-9a-f]{8}", sid or ""):
        raise SignInError("BAD_ID", "unknown sign-in")
    return os.path.join(STATE_DIR, sid + ".json")


def save(rec):
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    tmp = state_path(rec["id"]) + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(rec, f)
    os.replace(tmp, state_path(rec["id"]))


def load(sid):
    try:
        with open(state_path(sid)) as f:
            return json.load(f)
    except FileNotFoundError:
        raise SignInError("NOT_FOUND", "that sign-in is gone; start again")


def all_records():
    out = []
    if not os.path.isdir(STATE_DIR):
        return out
    for name in os.listdir(STATE_DIR):
        if name.endswith(".json"):
            try:
                with open(os.path.join(STATE_DIR, name)) as f:
                    out.append(json.load(f))
            except (OSError, ValueError):
                pass
    return out


def gc():
    """Kill sessions past their time limit and forget finished ones after a while."""
    for rec in all_records():
        if rec.get("finishedAt") and now() - rec["finishedAt"] > KEEP_FINISHED_SECONDS:
            try:
                os.remove(state_path(rec["id"]))
            except OSError:
                pass
        elif not rec.get("finishedAt") and now() > rec["expiresAt"]:
            finish(rec, "expired", "The sign-in link expired. Start again.")


def finish(rec, state, message=None):
    rec["state"] = state
    rec["message"] = message
    rec["finishedAt"] = now()
    rec["url"] = rec.get("url") if state in ("done",) else None  # a finished link is useless and single-use
    rec["userCode"] = None
    try:
        tmux("kill-session", "-t", "=" + rec["tmux"])
    except Exception:
        pass
    save(rec)


# ── parsing what the program printed ───────────────────────────────────────────

def parse_pane(harness, text):
    """What the visible output tells us: link, one-time code, whether it is waiting for a paste, and whether it has exited."""
    url = None
    for m in URL_RE.finditer(text):
        u = m.group(0).rstrip(".,)")
        if harness == "claude" and "oauth/authorize" in u:
            url = u
            break
        if harness == "codex" and ("auth.openai.com" in u or "openai.com/codex" in u):
            url = u
            break
        if harness == "antigravity" and "accounts.google.com" in u and "oauth2" in u:
            url = u
            break
    user_code = None
    if harness == "codex" and url:
        after = text[text.find(url):]
        m = USER_CODE_RE.search(after)
        if m:
            user_code = m.group(1)
    exit_m = EXIT_RE.search(text)
    prompt = "Paste code here" in text or (harness == "antigravity" and "authorization code" in text.lower() and url is not None)
    lines = [l.strip() for l in text.splitlines() if l.strip() and not EXIT_RE.fullmatch(l.strip())]
    return {"url": url, "userCode": user_code, "exit": int(exit_m.group(1)) if exit_m else None, "prompt": prompt, "lastLine": lines[-1] if lines else ""}


def friendly_failure(harness, parsed):
    last = URL_RE.sub("", parsed.get("lastLine") or "").strip()
    if harness == "claude" and "400" in last:
        return "That code didn't work. The link is single-use, so start the sign-in again for a new one."
    if harness == "antigravity":
        return "That code didn't work. Start the sign-in again for a new link."
    if last:
        return "Sign-in didn't complete: " + last[:140]
    return "Sign-in didn't complete. Start again."


# ── public operations ──────────────────────────────────────────────────────────

def probe(harness):
    """Is this program signed in on this machine? Cheap and read-only."""
    s = spec(harness)
    started = now()
    base = {"harness": harness, "checkedAt": iso(started)}
    if harness == "antigravity":
        return antigravity_probe(base)
    try:
        argv = argv_for(harness, "status")
    except SignInError as e:
        return dict(base, state="unknown", detail=e.message, plan=None)
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=PROBE_TIMEOUT, env=clean_env())
    except subprocess.TimeoutExpired:
        return dict(base, state="unknown", detail="The status check did not answer in time", plan=None)
    out = (r.stdout or "") + (r.stderr or "")
    plan = None
    account = None
    if harness == "claude":
        try:
            info = json.loads(r.stdout)
        except ValueError:
            info = {}
        logged_in = bool(info.get("loggedIn")) and r.returncode == 0
        plan = info.get("subscriptionType") if logged_in else None
        account = _email(info.get("email")) if logged_in else None
    else:
        logged_in = r.returncode == 0 and "logged in" in out.lower() and "not logged in" not in out.lower()
        m = re.search(r"Logged in using (.+)", out)
        plan = m.group(1).strip() if (logged_in and m) else None
        account = codex_account() if logged_in else None
    if logged_in:
        return dict(base, state="ok", detail="Signed in", plan=plan, account=account)
    return dict(base, state="needs_login", detail="Not signed in", plan=None, account=None)


HARNESS_BINS_OVERRIDE = ()   # tests may list binaries they stand in for


def antigravity_token_path():
    """The login Antigravity saves. DEVFLOW_AGY_TOKEN_FILE exists for tests."""
    return os.environ.get("DEVFLOW_AGY_TOKEN_FILE") or os.path.join(HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token")


def antigravity_probe(base):
    """Signed in when its login file exists and is not empty. Only the file's existence and size are looked at, never its content, and the
    account email comes from the separate accounts list. (It cannot tell an expired login from a working one; the first call that fails does.)"""
    try:
        signed_in = os.path.getsize(antigravity_token_path()) > 0
    except OSError:
        signed_in = False
    if not signed_in:
        if "agy" not in HARNESS_BINS_OVERRIDE and not os.environ.get("DEVFLOW_SIGNIN_COMMANDS") and not shutil.which("agy", path=search_path()):
            return dict(base, state="unknown", detail="Antigravity is not installed on this machine", plan=None, account=None)
        return dict(base, state="needs_login", detail="Not signed in", plan=None, account=None)
    return dict(base, state="ok", detail="Signed in", plan=None, account=antigravity_account())


def antigravity_account():
    """The email of the Google account Antigravity is signed in with (the `active` entry of ~/.gemini/google_accounts.json), or None."""
    try:
        path = os.environ.get("DEVFLOW_AGY_ACCOUNTS_FILE") or os.path.join(HOME, ".gemini", "google_accounts.json")
        with open(path, encoding="utf-8") as f:
            return _email(json.load(f).get("active"))
    except Exception:
        return None


ANTIGRAVITY_VERIFY_SECONDS = 90


def _token_newer_than(epoch):
    """True when the Antigravity login file was written at or after `epoch` (a login that was already there does not count)."""
    try:
        return os.path.getmtime(antigravity_token_path()) >= (epoch or 0) - 1
    except OSError:
        return False


EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}$")


def _email(value):
    return value if isinstance(value, str) and EMAIL_RE.match(value) else None


def codex_account():
    """The email of the ChatGPT account the saved Codex login belongs to, or None.

    Read from the non-secret claims of the login's id token (its middle part is plain base64 JSON); nothing else in the file is touched, and
    no token or other claim ever leaves this function. Never raises. DEVFLOW_CODEX_AUTH_FILE exists for tests."""
    try:
        path = os.environ.get("DEVFLOW_CODEX_AUTH_FILE") or os.path.join(os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex"), "auth.json")
        with open(path, encoding="utf-8") as f:
            id_token = str((json.load(f).get("tokens") or {}).get("id_token") or "")
        payload = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return _email(claims.get("email"))
    except Exception:
        return None


def public(rec):
    """The fields the dashboard may see. Never anything secret."""
    return {k: rec.get(k) for k in ("id", "harness", "kind", "state", "url", "userCode", "message")} | {
        "expiresAt": iso(rec["expiresAt"]), "startedAt": iso(rec["startedAt"])}


def active_for(harness):
    for rec in all_records():
        if rec["harness"] == harness and not rec.get("finishedAt") and session_alive(rec["tmux"]):
            return rec
    return None


def start(harness, settle=10.0):
    """Begin a sign-in. Waits up to `settle` seconds for the link to appear, then returns whatever state it has; callers poll status()."""
    s = spec(harness)
    gc()
    existing = active_for(harness)
    if existing:
        refreshed = refresh(existing)
        return dict(public(refreshed), alreadyActive=True)
    # Starting a Codex sign-in deletes its saved login at once, before anything is approved (seen on 18 Oct 2026, and it signed the owner's desktop
    # Codex out). So a login that works is never restarted. Only a probe that positively says "signed in" blocks; an unsure one does not.
    if probe(harness)["state"] == "ok":
        raise SignInError("ALREADY_SIGNED_IN", "Already signed in. A new sign-in would replace the working login, so DevFlow won't start one.")
    argv = argv_for(harness, "login")
    sid = uuid.uuid4().hex[:8]
    name = "signin-%s-%s" % (harness, sid)
    env = clean_env()
    inner = "env -i " + " ".join("%s=%s" % (k, shlex.quote(v)) for k, v in env.items()) + " " + " ".join(shlex.quote(a) for a in argv)
    script = inner + '; echo "[exit:$?]"; sleep %d' % (TTL_SECONDS + 60)
    cwd = []
    if harness == "antigravity":
        # Antigravity works in the folder it starts in, so give it an empty one of its own, not whatever this helper was started from.
        workdir = os.path.join(STATE_DIR, "agy-work")
        os.makedirs(workdir, mode=0o700, exist_ok=True)
        cwd = ["-c", workdir]
    tmux("new-session", "-d", "-s", name, "-x", "500", "-y", "60", *cwd, "sh", "-c", script, check=True)
    rec = {"id": sid, "harness": harness, "tmux": name, "kind": s["kind"], "state": "starting", "url": None, "userCode": None,
           "message": None, "startedAt": now(), "expiresAt": now() + TTL_SECONDS, "submitted": False, "finishedAt": None}
    save(rec)
    deadline = time.monotonic() + settle  # the link appears within a second or two; a slow network may need longer
    while time.monotonic() < deadline:
        time.sleep(0.5)
        rec = refresh(rec)
        if rec["state"] != "starting":
            break
    return public(rec)


def refresh(rec):
    """Re-read the program's output and move the state forward."""
    if rec.get("finishedAt"):
        return rec
    if now() > rec["expiresAt"]:
        finish(rec, "expired", "The sign-in link expired. Start again.")
        return rec
    alive = session_alive(rec["tmux"])
    text = read_pane(rec["tmux"]) if alive else ""
    parsed = parse_pane(rec["harness"], text)
    if rec["harness"] == "antigravity" and alive and not rec.get("menuDone") and "select login method" in text.lower():
        # Its first screen asks how to sign in; "1. Google OAuth" is the highlighted default.
        tmux("send-keys", "-t", "=" + rec["tmux"] + ":", "Enter")
        rec["menuDone"] = True
    if parsed["url"]:
        rec["url"] = parsed["url"]
    if parsed["userCode"]:
        rec["userCode"] = parsed["userCode"]
    if rec["harness"] == "antigravity" and alive and rec["submitted"]:
        # Antigravity keeps running after it signs in, so the saved login (written after the submission) is what says it worked.
        if antigravity_probe({})["state"] == "ok" and _token_newer_than(rec.get("submittedAt")):
            finish(rec, "done", "Signed in")
            return rec
        if re.search(r"(?i)\b(invalid|failed|denied|expired|error)\b", "\n".join([l for l in text.splitlines() if l.strip()][-6:])) or now() - (rec.get("submittedAt") or now()) > ANTIGRAVITY_VERIFY_SECONDS:
            finish(rec, "failed", friendly_failure("antigravity", parsed))
            return rec
    if parsed["exit"] is not None:
        if parsed["exit"] == 0:
            verdict = probe(rec["harness"])
            if verdict["state"] == "ok":
                finish(rec, "done", "Signed in")
            else:
                finish(rec, "failed", "The program said it finished, but it is still not signed in. Start again.")
        else:
            finish(rec, "failed", friendly_failure(rec["harness"], parsed))
        return rec
    if not alive:
        finish(rec, "failed", "The sign-in stopped unexpectedly. Start again.")
        return rec
    if rec["submitted"]:
        rec["state"] = "verifying"
    elif rec["url"] and (rec["kind"] == "device-code" and rec["userCode"] or rec["kind"] == "paste-code" and parsed["prompt"]):
        rec["state"] = "waiting"
    else:
        rec["state"] = "starting"
    save(rec)
    return rec


def status(sid):
    gc()
    return public(refresh(load(sid)))


def submit_code(sid, code, settle=10.0):
    """Type the pasted code into the waiting prompt and wait up to `settle` seconds for the program's verdict."""
    rec = load(sid)
    if rec.get("finishedAt"):
        raise SignInError("SIGN_IN_ENDED", rec.get("message") or "That sign-in has ended. Start again.")
    if rec["kind"] != "paste-code":
        raise SignInError("NO_CODE_NEEDED", "This sign-in needs no pasted code; enter the one-time code on the web page.")
    code = (code or "").strip()
    if not CODE_RE.fullmatch(code):
        raise SignInError("BAD_CODE", "That doesn't look like a sign-in code. Copy the whole code from the page.")
    rec = refresh(rec)
    if rec["state"] != "waiting":
        raise SignInError("NOT_READY", "The sign-in isn't ready for a code yet; wait a moment.")
    tmux("send-keys", "-t", "=" + rec["tmux"] + ":", "-l", code, check=True)
    tmux("send-keys", "-t", "=" + rec["tmux"] + ":", "Enter", check=True)
    rec["submitted"] = True
    rec["submittedAt"] = now()
    rec["state"] = "verifying"
    save(rec)
    deadline = time.monotonic() + settle  # the program answers within a few seconds either way
    while time.monotonic() < deadline:
        time.sleep(0.5)
        rec = refresh(rec)
        if rec.get("finishedAt"):
            break
    return public(rec)


def cancel(sid):
    """The person chose to stop (or to dismiss a finished one): end the session and forget it, so it never shows as a failure.
    Cancelling one that is already gone is fine."""
    try:
        rec = load(sid)
    except SignInError as e:
        if e.code == "NOT_FOUND":
            return {"ok": True}
        raise
    try:
        tmux("kill-session", "-t", "=" + rec["tmux"])
    except Exception:
        pass
    try:
        os.remove(state_path(sid))
    except OSError:
        pass
    return {"ok": True}


def listing():
    gc()
    return [public(refresh(r)) for r in all_records()]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("probe", "start"):
        p = sub.add_parser(name)
        p.add_argument("--harness", required=True)
    for name in ("status", "code", "cancel"):
        p = sub.add_parser(name)
        p.add_argument("--id", required=True)
    sub.add_parser("list")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "probe":
            out = probe(args.harness)
        elif args.cmd == "start":
            out = start(args.harness)
        elif args.cmd == "status":
            out = status(args.id)
        elif args.cmd == "code":
            out = submit_code(args.id, sys.stdin.read(1024))
        elif args.cmd == "cancel":
            out = cancel(args.id)
        else:
            out = listing()
        print(json.dumps(out))
        return 0
    except SignInError as e:
        print(json.dumps({"error": e.message, "code": e.code}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
