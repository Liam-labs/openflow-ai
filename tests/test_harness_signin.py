"""Tests for scripts/harness_signin.py: terminal-free sign-in for Claude Code and Codex.

The programs are replaced by small fakes that behave like the real ones observed on 18 Oct 2026 (Claude prints a link and waits for a pasted
code, a wrong code makes it fail and exit; Codex prints a link and a one-time code and polls). They run inside real tmux sessions on a private
socket, so the pane reading, key sending and state handling are the real thing. No real login is touched.
"""
import base64
import json
import os
import stat
import subprocess
import sys
import textwrap
import time
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import harness_signin as hs  # noqa: E402

pytestmark = pytest.mark.skipif(subprocess.run(["which", "tmux"], capture_output=True).returncode != 0, reason="tmux needed")

CLAUDE_LOGIN = textwrap.dedent('''\
    import os, sys
    print("Opening browser to sign in...")
    print("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=TEST&state=abc")
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("DEVFLOW_API_TOKEN"):
        print("LEAKED-SECRET-IN-ENV")
    sys.stdout.write("Paste code here if prompted > "); sys.stdout.flush()
    line = sys.stdin.readline().strip()
    if line == "good-code#state-123":
        open(os.path.join(os.environ["FAKE_DIR"], "loggedin"), "w").write("1")
        print("Login successful.")
        sys.exit(0)
    print("Login failed: Request failed with status code 400")
    sys.exit(1)
''')

CODEX_LOGIN = textwrap.dedent('''\
    import os, sys, time
    d = os.environ["FAKE_DIR"]
    print("Welcome to Codex [v0.0]")
    print("Follow these steps to sign in with ChatGPT using device code authorization:")
    print("1. Open this link in your browser and sign in to your account")
    print("   https://auth.openai.com/codex/device")
    print("2. Enter this one-time code (expires in 15 minutes)")
    print("   ABCD-12345")
    sys.stdout.flush()
    for _ in range(300):
        if os.path.exists(os.path.join(d, "device-approved")):
            open(os.path.join(d, "loggedin"), "w").write("1")
            print("Successfully logged in")
            sys.exit(0)
        if os.path.exists(os.path.join(d, "device-denied")):
            print("Device authorization was denied")
            sys.exit(1)
        time.sleep(0.2)
    sys.exit(1)
''')

CLAUDE_STATUS = textwrap.dedent('''\
    import json, os, sys
    ok = os.path.exists(os.path.join(os.environ["FAKE_DIR"], "loggedin"))
    print(json.dumps({"loggedIn": ok, "authMethod": "claude.ai" if ok else "none", "subscriptionType": "max" if ok else None,
                      "email": "user@example.com" if ok else None}))
    sys.exit(0 if ok else 1)
''')

CODEX_STATUS = textwrap.dedent('''\
    import os, sys
    ok = os.path.exists(os.path.join(os.environ["FAKE_DIR"], "loggedin"))
    print("Logged in using ChatGPT" if ok else "Not logged in")
    sys.exit(0 if ok else 1)
''')


@pytest.fixture
def env(tmp_path, monkeypatch):
    fake = tmp_path / "fake"
    fake.mkdir()
    for name, body in (("claude_login", CLAUDE_LOGIN), ("codex_login", CODEX_LOGIN), ("claude_status", CLAUDE_STATUS), ("codex_status", CODEX_STATUS)):
        (fake / (name + ".py")).write_text(body)
    py = sys.executable
    cmds = {
        "claude": {"login": [py, str(fake / "claude_login.py")], "status": [py, str(fake / "claude_status.py")]},
        "codex": {"login": [py, str(fake / "codex_login.py")], "status": [py, str(fake / "codex_status.py")]},
    }
    monkeypatch.setenv("DEVFLOW_SIGNIN_COMMANDS", json.dumps(cmds))
    monkeypatch.setenv("FAKE_DIR", str(fake))
    monkeypatch.setattr(hs, "STATE_DIR", str(tmp_path / "state"))
    socket = "hs-test-" + uuid.uuid4().hex[:8]
    monkeypatch.setattr(hs, "TMUX_SOCKET", socket)
    # ENV_KEEP decides what reaches the program; FAKE_DIR is test plumbing, so let it through for the fakes only.
    monkeypatch.setattr(hs, "ENV_KEEP", hs.ENV_KEEP + ("FAKE_DIR",))
    yield {"fake": fake, "socket": socket, "state": tmp_path / "state"}
    subprocess.run(["tmux", "-L", socket, "kill-server"], capture_output=True)


def wait_state(sid, wanted, seconds=15):
    end = time.time() + seconds
    last = None
    while time.time() < end:
        last = hs.status(sid)
        if last["state"] in wanted:
            return last
        time.sleep(0.3)
    raise AssertionError("state %r never reached %r; last=%r" % (last and last["state"], wanted, last))


# ── probe ──────────────────────────────────────────────────────────────────────

def test_probe_reads_signed_out_and_signed_in_for_both_programs(env):
    assert hs.probe("claude")["state"] == "needs_login"
    assert hs.probe("codex")["state"] == "needs_login"
    (env["fake"] / "loggedin").write_text("1")
    claude, codex = hs.probe("claude"), hs.probe("codex")
    assert (claude["state"], claude["plan"]) == ("ok", "max")
    assert (codex["state"], codex["plan"]) == ("ok", "ChatGPT")


def fake_codex_auth(tmp_path, claims=None, id_token=None):
    """A Codex auth.json shaped like the real one, with token values that must never come back out."""
    def b64(raw):
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    claims = {"email": "other@example.com", "sub": "user-1", "https://api.openai.com/auth": {"chatgpt_plan_type": "prolite"}} if claims is None else claims
    token = id_token if id_token is not None else ".".join([b64(b'{"alg":"RS256"}'), b64(json.dumps(claims).encode()), "SIGNATURE-SECRET"])
    path = tmp_path / "auth.json"
    path.write_text(json.dumps({"auth_mode": "chatgpt", "tokens": {"id_token": token, "access_token": "ACCESS-SECRET",
                                                                    "refresh_token": "REFRESH-SECRET", "account_id": "acct-1"}}))
    return path


def test_probe_names_the_account_a_signed_in_login_belongs_to(env, tmp_path, monkeypatch):
    monkeypatch.setenv("DEVFLOW_CODEX_AUTH_FILE", str(fake_codex_auth(tmp_path)))
    (env["fake"] / "loggedin").write_text("1")
    assert hs.probe("claude")["account"] == "user@example.com"
    assert hs.probe("codex")["account"] == "other@example.com"


def test_probe_names_no_account_when_signed_out_even_if_an_old_login_file_is_left_behind(env, tmp_path, monkeypatch):
    monkeypatch.setenv("DEVFLOW_CODEX_AUTH_FILE", str(fake_codex_auth(tmp_path)))
    for harness in ("claude", "codex"):
        result = hs.probe(harness)
        assert (result["state"], result["account"]) == ("needs_login", None)


def test_the_probe_result_never_carries_a_token_or_any_other_claim(env, tmp_path, monkeypatch):
    monkeypatch.setenv("DEVFLOW_CODEX_AUTH_FILE", str(fake_codex_auth(tmp_path)))
    (env["fake"] / "loggedin").write_text("1")
    blob = json.dumps([hs.probe("claude"), hs.probe("codex")])
    for secret in ("SECRET", "user-1", "prolite", "acct-1", "RS256"):
        assert secret not in blob


@pytest.mark.parametrize("make", [
    lambda tmp: tmp / "does-not-exist.json",                                                         # no file at all
    lambda tmp: (tmp / "x.json").write_text("{not json") or tmp / "x.json",                          # broken file
    lambda tmp: fake_codex_auth(tmp, id_token=""),                                                   # no id token
    lambda tmp: fake_codex_auth(tmp, id_token="only-one-part"),                                      # not a token
    lambda tmp: fake_codex_auth(tmp, claims={"email": "not an email"}),                              # not an address
    lambda tmp: fake_codex_auth(tmp, claims={"email": 12345}),                                       # wrong type
    lambda tmp: fake_codex_auth(tmp, claims={"email": "a@b" + "c" * 300}),                           # absurdly long
    lambda tmp: fake_codex_auth(tmp, claims={}),                                                     # no email claim
])
def test_codex_account_is_none_for_missing_or_broken_data_and_never_raises(tmp_path, monkeypatch, make):
    monkeypatch.setenv("DEVFLOW_CODEX_AUTH_FILE", str(make(tmp_path)))
    assert hs.codex_account() is None


def test_probe_says_unknown_when_the_program_is_not_installed(monkeypatch):
    monkeypatch.delenv("DEVFLOW_SIGNIN_COMMANDS", raising=False)
    monkeypatch.setitem(hs.HARNESSES["claude"], "bin", "definitely-not-installed-xyz")
    result = hs.probe("claude")
    assert result["state"] == "unknown" and "not installed" in result["detail"]


def make_nvm_home(tmp_path, versions):
    home = tmp_path / "home"
    for v in versions:
        bin_dir = home / ".nvm" / "versions" / "node" / v / "bin"
        bin_dir.mkdir(parents=True)
    return home


def test_nvm_bin_dirs_lists_the_newest_node_first_and_ignores_other_entries(tmp_path):
    home = make_nvm_home(tmp_path, ["v18.20.1", "v20.9.0", "v20.19.5", "v9.0.0"])
    root = home / ".nvm" / "versions" / "node"
    (root / "not-a-version" / "bin").mkdir(parents=True)     # has a bin folder, but is not a node version
    (root / "v22.1.0").mkdir()                       # a version folder with no bin inside
    (root / "v21.0.0").write_text("a file, not a folder")
    got = hs.nvm_bin_dirs(str(home))
    assert [os.path.basename(os.path.dirname(p)) for p in got] == ["v20.19.5", "v20.9.0", "v18.20.1", "v9.0.0"]
    assert hs.nvm_bin_dirs(str(tmp_path / "nowhere")) == []


def test_codex_installed_under_nvm_is_found_when_the_callers_path_does_not_list_it(tmp_path, monkeypatch):
    home = make_nvm_home(tmp_path, ["v20.19.5"])
    codex = home / ".nvm" / "versions" / "node" / "v20.19.5" / "bin" / "codex"
    codex.write_text("#!/bin/sh\nexit 0\n")
    codex.chmod(0o755)
    monkeypatch.delenv("DEVFLOW_SIGNIN_COMMANDS", raising=False)
    monkeypatch.setattr(hs, "HOME", str(home))
    monkeypatch.setattr(hs, "EXTRA_PATH", [])
    monkeypatch.setenv("PATH", "/usr/bin:/bin")        # what a systemd service gets
    assert hs.argv_for("codex", "status")[0] == str(codex)
    assert str(codex.parent) in hs.clean_env()["PATH"].split(":")   # node sits beside it, so the script can start


def test_a_program_in_the_callers_own_path_still_wins_over_nvm(tmp_path, monkeypatch):
    home = make_nvm_home(tmp_path, ["v20.19.5"])
    nvm_codex = home / ".nvm" / "versions" / "node" / "v20.19.5" / "bin" / "codex"
    own_dir = tmp_path / "own"
    own_dir.mkdir()
    own_codex = own_dir / "codex"
    for f in (nvm_codex, own_codex):
        f.write_text("#!/bin/sh\nexit 0\n")
        f.chmod(0o755)
    monkeypatch.delenv("DEVFLOW_SIGNIN_COMMANDS", raising=False)
    monkeypatch.setattr(hs, "HOME", str(home))
    monkeypatch.setattr(hs, "EXTRA_PATH", [])
    monkeypatch.setenv("PATH", str(own_dir))
    assert hs.argv_for("codex", "status")[0] == str(own_codex)


def test_probe_never_reports_signed_in_for_a_status_that_exits_non_zero(env):
    (env["fake"] / "claude_status.py").write_text("import sys; print('{\"loggedIn\": true}'); sys.exit(1)")
    assert hs.probe("claude")["state"] == "needs_login"


def tmux_has_sessions(socket):
    return subprocess.run(["tmux", "-L", socket, "ls"], capture_output=True).returncode == 0


def test_a_sign_in_is_refused_on_a_login_that_already_works_and_nothing_is_started(env):
    """Starting a Codex sign-in deletes its saved login at once, so a working login must never be restarted."""
    (env["fake"] / "loggedin").write_text("1")
    for harness in ("claude", "codex"):
        with pytest.raises(hs.SignInError) as caught:
            hs.start(harness)
        assert caught.value.code == "ALREADY_SIGNED_IN"
        assert "replace" in caught.value.message
    assert hs.listing() == []
    assert not tmux_has_sessions(env["socket"])
    assert (env["fake"] / "loggedin").exists()


def test_a_signed_out_login_can_still_start_a_sign_in(env):
    assert not (env["fake"] / "loggedin").exists()
    assert hs.start("codex")["state"] in ("starting", "waiting")


def test_an_unsure_status_check_does_not_stop_a_sign_in_from_starting(env, monkeypatch):
    (env["fake"] / "claude_status.py").write_text("import time; time.sleep(5)")
    monkeypatch.setattr(hs, "PROBE_TIMEOUT", 1)
    assert hs.probe("claude")["state"] == "unknown"
    assert hs.start("claude")["state"] in ("starting", "waiting")


def test_the_refusal_is_reported_as_a_plain_error_by_the_command_line(env, capsys):
    (env["fake"] / "loggedin").write_text("1")
    hs.main(["start", "--harness", "codex"])
    out = json.loads(capsys.readouterr().out)
    assert out["code"] == "ALREADY_SIGNED_IN" and "replace" in out["error"]


# ── claude: link then pasted code ──────────────────────────────────────────────

def test_claude_start_shows_the_link_and_waits_for_a_code(env):
    out = hs.start("claude")
    assert out["state"] == "waiting" and out["kind"] == "paste-code"
    assert out["url"].startswith("https://claude.com/cai/oauth/authorize?")
    assert out["userCode"] is None


def test_claude_good_code_signs_in_and_verifies(env):
    sid = hs.start("claude")["id"]
    result = hs.submit_code(sid, "good-code#state-123")
    assert result["state"] == "done"
    assert hs.probe("claude")["state"] == "ok"


def test_claude_wrong_code_fails_with_a_plain_message_and_the_link_is_dropped(env):
    sid = hs.start("claude")["id"]
    result = hs.submit_code(sid, "wrong-code#whatever")
    assert result["state"] == "failed"
    assert "start the sign-in again" in result["message"]
    assert result["url"] is None
    assert hs.probe("claude")["state"] == "needs_login"


def test_a_malformed_code_is_refused_before_anything_is_typed(env):
    sid = hs.start("claude")["id"]
    for bad in ("", "short", "has space inside code", "line\nbreak-code-1234", "x" * 600, "ctrl\x03-code-12345"):
        with pytest.raises(hs.SignInError) as caught:
            hs.submit_code(sid, bad)
        assert caught.value.code == "BAD_CODE"
    assert hs.status(sid)["state"] == "waiting"  # still waiting, nothing was sent


def test_the_pasted_code_is_never_stored_or_returned(env):
    sid = hs.start("claude")["id"]
    result = hs.submit_code(sid, "good-code#state-123")
    blob = json.dumps(result) + "".join(p.read_text() for p in env["state"].glob("*.json"))
    assert "good-code#state-123" not in blob


def test_code_for_a_device_code_sign_in_is_rejected(env):
    sid = hs.start("codex")["id"]
    with pytest.raises(hs.SignInError) as caught:
        hs.submit_code(sid, "good-code#state-123")
    assert caught.value.code == "NO_CODE_NEEDED"


# ── codex: link and one-time code, finishes by itself ──────────────────────────

def test_codex_start_shows_link_and_one_time_code(env):
    out = hs.start("codex")
    assert out["state"] == "waiting" and out["kind"] == "device-code"
    assert out["url"] == "https://auth.openai.com/codex/device"
    assert out["userCode"] == "ABCD-12345"


def test_codex_finishes_when_the_user_approves_on_the_web_page(env):
    sid = hs.start("codex")["id"]
    (env["fake"] / "device-approved").write_text("1")
    assert wait_state(sid, {"done"})["state"] == "done"
    assert hs.probe("codex")["state"] == "ok"


def test_codex_denied_becomes_failed_with_the_programs_own_words(env):
    sid = hs.start("codex")["id"]
    (env["fake"] / "device-denied").write_text("1")
    result = wait_state(sid, {"failed"})
    assert "denied" in result["message"]


# ── lifecycle and safety ───────────────────────────────────────────────────────

def test_only_one_sign_in_per_program_at_a_time(env):
    first = hs.start("claude")
    second = hs.start("claude")
    assert second["id"] == first["id"] and second["alreadyActive"] is True
    assert hs.start("codex")["id"] != first["id"]  # a different program is independent


def test_cancel_ends_the_session_and_forgets_it_so_it_cannot_take_a_code_afterwards(env):
    sid = hs.start("claude")["id"]
    assert hs.cancel(sid) == {"ok": True}
    assert not hs.session_alive("signin-claude-" + sid)
    with pytest.raises(hs.SignInError) as caught:
        hs.submit_code(sid, "good-code#state-123")
    assert caught.value.code == "NOT_FOUND"


def test_a_cancelled_sign_in_is_not_shown_as_a_failure_and_a_new_one_can_start_at_once(env):
    sid = hs.start("codex")["id"]
    hs.cancel(sid)
    assert sid not in [r["id"] for r in hs.listing()]
    with pytest.raises(hs.SignInError) as caught:
        hs.status(sid)
    assert caught.value.code == "NOT_FOUND"
    assert hs.start("codex")["id"] != sid


def test_cancel_dismisses_a_finished_sign_in_and_is_harmless_when_repeated_or_unknown(env):
    sid = hs.start("claude")["id"]
    hs.submit_code(sid, "wrong-code#state-000")              # claude exits on a wrong code, so this one finishes as failed
    assert hs.status(sid)["state"] == "failed"
    assert hs.cancel(sid) == {"ok": True}
    assert sid not in [r["id"] for r in hs.listing()]
    assert hs.cancel(sid) == {"ok": True}                      # already gone
    assert hs.cancel("0123abcd") == {"ok": True}               # never existed
    with pytest.raises(hs.SignInError) as caught:
        hs.cancel("../../etc")                                  # a malformed id is still refused
    assert caught.value.code == "BAD_ID"


def test_a_sign_in_expires_and_its_session_is_killed(env, monkeypatch):
    monkeypatch.setattr(hs, "TTL_SECONDS", 1)
    sid = hs.start("claude")["id"]
    time.sleep(1.5)
    result = hs.status(sid)
    assert result["state"] == "expired" and "expired" in result["message"]
    assert not hs.session_alive("signin-claude-" + sid)


def test_finished_sign_ins_are_forgotten_after_a_while(env, monkeypatch):
    sid = hs.start("claude")["id"]
    hs.submit_code(sid, "wrong-code#state-000")                # the program exits, so this sign-in is finished (failed)
    assert any(r["id"] == sid for r in hs.listing())
    monkeypatch.setattr(hs, "KEEP_FINISHED_SECONDS", -1)
    hs.gc()
    assert not any(r["id"] == sid for r in hs.listing())


def test_secrets_in_the_parent_environment_do_not_reach_the_login(env, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-should-not-leak")
    monkeypatch.setenv("DEVFLOW_API_TOKEN", "token-should-not-leak")
    sid = hs.start("claude")["id"]
    pane = hs.read_pane("signin-claude-" + sid)
    assert "LEAKED-SECRET-IN-ENV" not in pane
    assert hs.status(sid)["state"] == "waiting"


def test_state_files_are_private(env):
    hs.start("claude")
    assert stat.S_IMODE(os.stat(env["state"]).st_mode) == 0o700
    for p in env["state"].glob("*.json"):
        assert stat.S_IMODE(os.stat(p).st_mode) == 0o600


def test_sign_ins_run_on_their_own_tmux_server_not_the_default_one(env):
    sid = hs.start("claude")["id"]
    default = subprocess.run(["tmux", "list-sessions", "-F", "#{session_name}"], capture_output=True, text=True).stdout
    assert ("signin-claude-" + sid) not in default
    ours = subprocess.run(["tmux", "-L", env["socket"], "list-sessions", "-F", "#{session_name}"], capture_output=True, text=True).stdout
    assert ("signin-claude-" + sid) in ours


def test_cli_returns_json_and_plain_errors(env, capsys):
    assert hs.main(["probe", "--harness", "claude"]) == 0
    assert json.loads(capsys.readouterr().out)["state"] == "needs_login"
    assert hs.main(["status", "--id", "deadbeef"]) == 2
    assert json.loads(capsys.readouterr().out)["code"] == "NOT_FOUND"
    assert hs.main(["probe", "--harness", "gemini"]) == 2
    assert json.loads(capsys.readouterr().out)["code"] == "BAD_HARNESS"


# ── Antigravity (Gemini): first-run menu, Google link, pasted authorization code, saved login file ───────────────────────────────────

AGY_FAKE = textwrap.dedent('''\
    import os, sys, time
    print("Welcome to the Antigravity CLI. You are currently not signed in.")
    print("Select login method:")
    print(" > 1. Google OAuth")
    print("   2. Use a Google Cloud project")
    sys.stdout.flush()
    sys.stdin.readline()                     # Enter picks the highlighted method
    print("Your browser should open automatically. If not:")
    print("https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=TEST"
          "&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=abc")
    print("If you aren't automatically redirected, paste the authorization code below:")
    sys.stdout.write("authorization code..."); sys.stdout.flush()
    code = sys.stdin.readline().strip()
    if code == "4/GOOD-code_123":
        time.sleep(float(os.environ.get("FAKE_AGY_DELAY", "0")))
        with open(os.environ["DEVFLOW_AGY_TOKEN_FILE"], "w") as f:
            f.write("TOKEN-CONTENT-NEVER-SHOWN")
        print("Welcome back")
        time.sleep(300)
    print("Error: invalid authorization code")
    time.sleep(300)
''')


@pytest.fixture
def agy(env, monkeypatch, tmp_path):
    fake = env["fake"]
    (fake / "agy_login.py").write_text(AGY_FAKE)
    cmds = json.loads(os.environ["DEVFLOW_SIGNIN_COMMANDS"])
    cmds["antigravity"] = {"login": [sys.executable, str(fake / "agy_login.py")], "status": []}
    monkeypatch.setenv("DEVFLOW_SIGNIN_COMMANDS", json.dumps(cmds))
    token = fake / "agy-token"
    monkeypatch.setenv("DEVFLOW_AGY_TOKEN_FILE", str(token))
    monkeypatch.setenv("DEVFLOW_AGY_ACCOUNTS_FILE", str(fake / "accounts.json"))
    monkeypatch.setattr(hs, "ENV_KEEP", hs.ENV_KEEP + ("DEVFLOW_AGY_TOKEN_FILE",))
    monkeypatch.setattr(hs, "STATE_DIR", str(tmp_path / "agy-state"))
    return {"token": token, "accounts": fake / "accounts.json", **env}


def test_antigravity_probe_reads_the_login_file_and_the_active_account_only(agy):
    assert hs.probe("antigravity")["state"] == "needs_login"
    agy["token"].write_text("")
    assert hs.probe("antigravity")["state"] == "needs_login"                     # an empty file is not a login
    agy["token"].write_text("TOKEN-CONTENT-NEVER-SHOWN")
    agy["accounts"].write_text(json.dumps({"active": "user@example.com", "old": ["other@example.com"]}))
    got = hs.probe("antigravity")
    assert (got["state"], got["account"], got["plan"]) == ("ok", "user@example.com", None)
    assert "TOKEN-CONTENT" not in json.dumps(got)
    agy["accounts"].write_text(json.dumps({"active": "not an email"}))
    assert hs.probe("antigravity")["account"] is None
    agy["accounts"].write_text("{broken")
    assert hs.probe("antigravity")["account"] is None


def test_antigravity_not_installed_is_reported_as_unknown_not_as_needing_a_login(monkeypatch, tmp_path):
    monkeypatch.delenv("DEVFLOW_SIGNIN_COMMANDS", raising=False)
    monkeypatch.setenv("DEVFLOW_AGY_TOKEN_FILE", str(tmp_path / "none"))
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setattr(hs, "EXTRA_PATH", [])
    monkeypatch.setattr(hs, "nvm_bin_dirs", lambda home=None: [])
    got = hs.probe("antigravity")
    assert got["state"] == "unknown" and "not installed" in got["detail"]


def test_antigravity_sign_in_picks_the_method_shows_the_link_takes_the_code_and_finishes_when_the_login_is_saved(agy):
    started = hs.start("antigravity", settle=12)
    sid = started["id"]
    got = wait_state(sid, {"waiting"})
    assert got["kind"] == "paste-code"
    assert got["url"].startswith("https://accounts.google.com/o/oauth2/auth?") and "state=abc" in got["url"]     # the whole link, not a wrapped half
    done = hs.submit_code(sid, "4/GOOD-code_123", settle=15)
    assert done["state"] == "done"
    assert hs.probe("antigravity")["state"] == "ok"
    assert "TOKEN-CONTENT" not in json.dumps(done)
    assert not hs.session_alive("signin-antigravity-" + sid)                       # its terminal is ended once it has signed in


def test_antigravity_wrong_code_fails_with_a_plain_message_and_a_new_link_is_needed(agy):
    sid = hs.start("antigravity", settle=12)["id"]
    wait_state(sid, {"waiting"})
    failed = hs.submit_code(sid, "4/BAD-code_999", settle=15)
    assert failed["state"] == "failed"
    assert "Start the sign-in again" in failed["message"]
    assert not agy["token"].exists()


def test_antigravity_an_old_login_file_does_not_make_a_new_sign_in_succeed(agy):
    sid = hs.start("antigravity", settle=12)["id"]
    wait_state(sid, {"waiting"})
    agy["token"].write_text("OLD")
    os.utime(agy["token"], (time.time() - 3600, time.time() - 3600))
    # the program rejects the code, so the old file (written before the code was submitted) must not count
    failed = hs.submit_code(sid, "4/BAD-code_999", settle=15)
    assert failed["state"] == "failed"


def test_antigravity_a_signed_in_machine_refuses_a_second_sign_in(agy):
    agy["token"].write_text("TOKEN")
    with pytest.raises(hs.SignInError) as e:
        hs.start("antigravity")
    assert e.value.code == "ALREADY_SIGNED_IN"


def test_antigravity_runs_in_its_own_empty_folder(agy):
    sid = hs.start("antigravity", settle=12)["id"]
    wait_state(sid, {"waiting"})
    assert os.path.isdir(os.path.join(hs.STATE_DIR, "agy-work"))
    assert oct(os.stat(os.path.join(hs.STATE_DIR, "agy-work")).st_mode)[-3:] == "700"
    hs.cancel(sid)


def test_unknown_harness_is_refused(env):
    with pytest.raises(hs.SignInError) as e:
        hs.spec("gemini")
    assert e.value.code == "BAD_HARNESS"
