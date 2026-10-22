#!/usr/bin/env python3
"""
POC v2: keystroke submit protocol for claude.exe 2.1.117 via pywinpty.

Sprint 60 / Phase A0 — iteration 2.

v1 FAILED at the write path itself (echo never appeared in buffer, Sam's run).
v2 incorporates Sam's three diagnostic hypotheses:
  H1: bootstrap heuristic fired too early (200-byte threshold met before
      Ink's input field was actually accepting chars) --> fixed 5s wait
      plus sentinel detection on prompt glyph.
  H2: pywinpty 3.x ConPTY buffering requires atomic text+\\r write
      instead of text then \\r with a sleep in between.
  H3: Ink may need bracketed-paste to deliver text atomically.

v2 tries three submit strategies in a single run so Sam gets the full
diagnostic in one shot, with fresh test messages so echoes don't
cross-contaminate between strategies.

Also fixes the cp1252 UnicodeEncodeError from v1 (arrow glyphs replaced
with ASCII '->' so Windows default console encoding doesn't crash the
output path).

Invocation (PowerShell 7, real console, NOT -NoNewWindow):
    python3 collab-claude-win-submit-poc.py

Reports [PASS] on the first strategy that submits; [FAIL] + diagnostic
for each strategy that doesn't.

Exits 0 if ANY strategy passes, 1 if all three fail.
"""

import os
import sys
import time
import threading

try:
    from winpty import PtyProcess
except ImportError:
    print("ERROR: pywinpty not installed. Run: pip install pywinpty", file=sys.stderr)
    sys.exit(2)


PRIMARY = os.path.expandvars(r"%LOCALAPPDATA%\Programs\claude-code\claude.exe")
FALLBACKS = [
    os.path.expandvars(r"%APPDATA%\npm\claude.cmd"),
    os.path.expandvars(r"%USERPROFILE%\.local\bin\claude.exe"),
    r"C:\Program Files\Claude\claude.exe",
]


def find_claude():
    if os.path.exists(PRIMARY):
        return PRIMARY
    for p in FALLBACKS:
        if os.path.exists(p):
            return p
    import shutil
    return shutil.which("claude")


class PtySession:
    """Manages a single claude.exe PtyProcess + its reader thread + shared buffer."""

    def __init__(self, claude_path):
        self.proc = PtyProcess.spawn([claude_path], dimensions=(40, 120))
        self.captured = []
        self.lock = threading.Lock()
        self.stop_flag = threading.Event()
        self.thread = threading.Thread(target=self._reader, daemon=True)
        self.thread.start()

    def _reader(self):
        while not self.stop_flag.is_set() and self.proc.isalive():
            try:
                data = self.proc.read(4096)
                if data:
                    with self.lock:
                        self.captured.append(data)
            except Exception:
                break
            time.sleep(0.01)

    def buffer(self):
        with self.lock:
            return "".join(self.captured)

    def buffer_bytes(self):
        with self.lock:
            return sum(len(c) for c in self.captured)

    def wait_for_sentinel(self, timeout_s, min_wait_s=5.0, sentinels=(">", "│", "?", "How can I help")):
        """Wait for Ink's input prompt to be ready.

        H1 fix: enforce a minimum flat wait (default 5s) before checking
        sentinels. Even if a sentinel glyph appears early in banner/logo
        output, Ink may still not be accepting keystrokes until after its
        full render settles.
        """
        start = time.time()
        while time.time() - start < timeout_s:
            if time.time() - start >= min_wait_s:
                buf = self.buffer()
                if any(s in buf for s in sentinels):
                    return True
            time.sleep(0.2)
        return False

    def close(self):
        self.stop_flag.set()
        try:
            self.proc.terminate()
        except Exception:
            pass


def strategy_separate(session, msg):
    """v1 strategy: write text, sleep, write bare \\r."""
    print(f"[S1] separate writes: text ({len(msg)} chars) + sleep(0.5) + '\\r'", flush=True)
    session.proc.write(msg)
    time.sleep(0.5)
    session.proc.write("\r")


def strategy_atomic(session, msg):
    """H2 fix: atomic single write of text+\\r."""
    combined = msg + "\r"
    print(f"[S2] atomic single write: {len(combined)} chars incl. trailing '\\r'", flush=True)
    session.proc.write(combined)


def strategy_bracketed_paste(session, msg):
    """H3 fix: wrap text in bracketed paste markers, then \\r."""
    wrapped = "\x1b[200~" + msg + "\x1b[201~" + "\r"
    print(f"[S3] bracketed paste: ESC[200~ + text + ESC[201~ + '\\r'", flush=True)
    session.proc.write(wrapped)


def test_strategy(session, strategy_fn, strategy_name, msg, ack_token, timeout_s=25):
    """Run one strategy. Returns (echo_seen, ack_seen)."""
    buf_before = session.buffer_bytes()
    strategy_fn(session, msg)

    submit_t = time.time()
    echo_seen = False
    ack_seen = False
    echo_t = None
    ack_t = None

    while time.time() - submit_t < timeout_s:
        buf = session.buffer()
        if (not echo_seen) and msg[:20] in buf[buf_before:]:
            echo_seen = True
            echo_t = time.time() - submit_t
            print(f"[{strategy_name}] +{echo_t:.1f}s  echo seen (buffer grew by {session.buffer_bytes() - buf_before} bytes)", flush=True)
        if (not ack_seen) and ack_token.upper() in buf.upper():
            ack_seen = True
            ack_t = time.time() - submit_t
            print(f"[{strategy_name}] +{ack_t:.1f}s  '{ack_token}' token present -> SUBMIT WORKED", flush=True)
            return True, True
        time.sleep(0.3)

    if echo_seen and not ack_seen:
        print(f"[{strategy_name}] echo yes, no ack within {timeout_s}s -> text buffered but not submitted", flush=True)
    elif not echo_seen:
        print(f"[{strategy_name}] no echo within {timeout_s}s -> write path not reaching input field", flush=True)
    return echo_seen, ack_seen


def main():
    claude = find_claude()
    if not claude:
        print("ERROR: claude.exe not found. Checked PRIMARY +", FALLBACKS, file=sys.stderr)
        return 2

    print(f"[POC v2] Claude binary: {claude}", flush=True)
    os.environ.setdefault("DISABLE_AUTOUPDATER", "1")

    session = PtySession(claude)
    print(f"[POC v2] Spawned claude.exe PID={session.proc.pid}", flush=True)

    print("[POC v2] Waiting up to 20s for Ink input field (min 5s flat + sentinel)...", flush=True)
    ready = session.wait_for_sentinel(timeout_s=20, min_wait_s=5.0)
    tail_preview = session.buffer()[-200:].replace("\x1b", "\\x1b")
    print(f"[POC v2] Bootstrap complete: {session.buffer_bytes()} bytes, input-field-ready={ready}", flush=True)
    print(f"[POC v2] Last 200 bytes of bootstrap (esc escaped): {tail_preview!r}", flush=True)

    strategies = [
        ("S1", strategy_separate, "Respond with ALPHA and nothing else.", "ALPHA"),
        ("S2", strategy_atomic,   "Respond with BRAVO and nothing else.", "BRAVO"),
        ("S3", strategy_bracketed_paste, "Respond with CHARLIE and nothing else.", "CHARLIE"),
    ]

    passed = None
    for name, fn, msg, tok in strategies:
        print(f"\n---------- testing {name} ----------", flush=True)
        echo, ack = test_strategy(session, fn, name, msg, tok, timeout_s=25)
        if ack:
            passed = name
            break
        time.sleep(1.0)

    session.close()

    print("\n================ RESULT ================", flush=True)
    if passed:
        print(f"[PASS] submit_protocol: strategy {passed} submits cleanly on claude.exe 2.1.117")
        print(f"       -> use this strategy in the modernised wrapper's inject path")
        return 0
    print("[FAIL] submit_protocol: all three strategies failed")
    print("       -> next step: pivot to hypothesis 3 (--output-format stream-json, no TUI)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
