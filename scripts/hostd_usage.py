"""Token usage and transcript liveness of the Claude sessions on THIS machine, served to DevFlow through agent-hostd.

DevFlow runs on the server, the agents' transcripts are written here (21 Oct 2026: every usage figure read 0 and the liveness signal
was blank for desktop agents). The server asks this machine for the numbers instead of for the files: a transcript is megabytes,
the totals are a few hundred bytes. The same rules as lib/token-usage.ts (assistant records with a `usage` block; totals per file
and per model; per-message times for the rolling window), so a figure means the same wherever it was computed.

hostd runs its ops one at a time, so nothing here may take long inside an op. A background thread keeps the index up to date
(incrementally: it only reads bytes added since the last pass) and an op only reads the index and asks for a refresh.
"""
import json
import os
import re
import threading
import time
from datetime import datetime, timezone

REFRESH_MIN_SECONDS = 5
INDEX_DAYS = 8            # files untouched for longer than this are not indexed (the weekly window is 7 days)
EMPTY = {"inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheCreationTokens": 0}


def projects_root(home):
    return os.path.join(home, ".claude", "projects")


def under_projects(home, path):
    """True for a .jsonl file inside the projects folder, after resolving links."""
    real = os.path.realpath(path)
    root = os.path.realpath(projects_root(home))
    return real.startswith(root + os.sep) and real.endswith(".jsonl")


def _ms(timestamp):
    """Milliseconds since the epoch for an ISO time (Claude writes UTC with a trailing Z), or None."""
    try:
        moment = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp() * 1000


class FileState:
    """What has been read of one session file: totals, per-model totals, and the per-message timeline."""

    def __init__(self, ino):
        self.ino = ino
        self.offset = 0
        self.size = 0
        self.mtime_ms = 0.0
        self.tokens = dict(EMPTY)
        self.models = {}
        self.messages = 0
        self.last_activity = None
        self.times = []
        self.window_tokens = []

    def add(self, line):
        if '"usage"' not in line:
            return
        try:
            record = json.loads(line)
        except ValueError:
            return
        message = record.get("message") if isinstance(record, dict) else None
        if not isinstance(record, dict) or record.get("type") != "assistant" or not isinstance(message, dict) or not isinstance(message.get("usage"), dict):
            return
        usage = message["usage"]
        counts = {
            "inputTokens": int(usage.get("input_tokens") or 0),
            "outputTokens": int(usage.get("output_tokens") or 0),
            "cacheReadTokens": int(usage.get("cache_read_input_tokens") or 0),
            "cacheCreationTokens": int(usage.get("cache_creation_input_tokens") or 0),
        }
        model = self.models.setdefault(message.get("model") or "unknown", dict(EMPTY))
        for key, value in counts.items():
            self.tokens[key] += value
            model[key] += value
        self.messages += 1
        stamp = record.get("timestamp")
        if stamp:
            self.last_activity = stamp
            at = _ms(stamp)
            if at is not None:
                self.times.append(at)
                self.window_tokens.append(sum(counts.values()))

    def read_new(self, path, lock):
        """Read the whole lines added since the last pass; a partly written last line waits for the next pass.
        The lock is taken per line, so an answer never waits for a whole big file."""
        with open(path, "rb") as f:
            f.seek(self.offset)
            data = f.read()
        end = data.rfind(b"\n")
        if end < 0:
            return
        for line in data[:end].decode("utf-8", errors="replace").split("\n"):
            if line.strip():
                with lock:
                    self.add(line)
        self.offset += end + 1

    def facts(self, path):
        return {"path": path, "size": self.size, "mtimeMs": self.mtime_ms, "tokens": dict(self.tokens),
                "modelTokens": {k: dict(v) for k, v in self.models.items()}, "messageCount": self.messages, "lastActivity": self.last_activity}


class UsageIndex:
    def __init__(self, home):
        self.home = home
        self.files = {}
        self.lock = threading.Lock()
        self.running = False
        self.refreshed_at = 0.0
        self.ready = False

    # -- scanning -------------------------------------------------------------------------
    def _candidates(self, now_ms):
        root = projects_root(self.home)
        floor = now_ms - INDEX_DAYS * 86_400_000
        try:
            dirs = os.listdir(root)
        except OSError:
            return
        for d in dirs:
            folder = os.path.join(root, d)
            try:
                names = os.listdir(folder)
            except OSError:
                continue
            for name in names:
                if not name.endswith(".jsonl"):
                    continue
                path = os.path.join(folder, name)
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                if st.st_mtime * 1000 >= floor:
                    yield path, st

    def scan(self, now_ms=None):
        now_ms = now_ms if now_ms is not None else time.time() * 1000
        seen = set()
        for path, st in self._candidates(now_ms):
            seen.add(path)
            with self.lock:
                state = self.files.get(path)
                if state is None or state.ino != st.st_ino or st.st_size < state.offset:
                    state = FileState(st.st_ino)
                    self.files[path] = state
            if st.st_size != state.offset:
                try:
                    state.read_new(path, self.lock)
                except OSError:
                    continue
            state.size = st.st_size
            state.mtime_ms = st.st_mtime * 1000
        with self.lock:
            for path in list(self.files):
                if path not in seen:
                    del self.files[path]
        self.refreshed_at = time.time()
        self.ready = True

    def _run(self):
        try:
            self.scan()
        finally:
            self.running = False

    def refresh_async(self):
        """Start a pass in the background unless one is running or the last one is recent. Returns at once."""
        if self.running or time.time() - self.refreshed_at < REFRESH_MIN_SECONDS:
            return
        self.running = True
        threading.Thread(target=self._run, daemon=True).start()

    # -- answers (from the index only) ----------------------------------------------------
    def files_since(self, since_ms):
        with self.lock:
            return [s.facts(p) for p, s in self.files.items() if s.mtime_ms >= since_ms]

    def window(self, start_ms):
        total, first = 0, None
        with self.lock:
            for s in self.files.values():
                if s.mtime_ms < start_ms:
                    continue
                for at, tokens in zip(s.times, s.window_tokens):
                    if at < start_ms:
                        continue
                    total += tokens
                    if first is None or at < first:
                        first = at
        return {"tokens": total, "sessionStartMs": first}

    def one(self, path):
        real = os.path.realpath(path)
        with self.lock:
            state = self.files.get(real)
            return state.facts(real) if state else None


_index = None
_index_home = None


def index_for(home):
    global _index, _index_home
    if _index is None or _index_home != home:
        _index, _index_home = UsageIndex(home), home
    return _index


def op_usage_facts(args, home):
    """The hostd op: action files {sinceMs} | window {windowStartMs} | file {path}. Answers from the index and starts a refresh;
    `ready` is false until the first pass has finished (the numbers are then partial)."""
    index = index_for(home)
    index.refresh_async()
    action = str(args.get("action", ""))
    base = {"ready": index.ready, "refreshedAt": index.refreshed_at}
    if action == "files":
        return dict(base, files=index.files_since(float(args.get("sinceMs", 0))))
    if action == "window":
        return dict(base, **index.window(float(args.get("windowStartMs", 0))))
    if action == "file":
        path = str(args.get("path", ""))
        if not os.path.isabs(path) or "\0" in path or not under_projects(home, path):
            raise ValueError("path not allowed")
        return dict(base, file=index.one(path))
    raise ValueError("unknown action")


# -- transcript liveness (lib/frozen-detection-jsonl.ts, for agents whose transcript is on this machine) ---------------------------

def _scratch(agent_dir, name):
    try:
        with open(os.path.join(agent_dir, ".session-scratch", name), encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def _newest_jsonl_mtime(folder):
    latest = None
    try:
        names = os.listdir(folder)
    except OSError:
        return None
    for name in names:
        if name.endswith(".jsonl"):
            try:
                m = os.stat(os.path.join(folder, name)).st_mtime * 1000
            except OSError:
                continue
            latest = m if latest is None or m > latest else latest
    return latest


def transcript_mtime(home, agent_dir, session_id=None):
    """Modified time (ms) of the agent's active transcript: its scratch pointer, else its session id, else the newest in its project folder."""
    key = re.sub(r"[^a-zA-Z0-9]", "-", agent_dir)
    folder = os.path.join(projects_root(home), key)
    pointer = _scratch(agent_dir, "transcript-path")
    if pointer and os.path.isabs(pointer) and under_projects(home, pointer) and os.path.isfile(pointer):
        return os.stat(pointer).st_mtime * 1000
    sid = session_id or _scratch(agent_dir, "session-id")
    if sid and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", sid):
        candidate = os.path.join(folder, sid + ".jsonl")
        if os.path.isfile(candidate) and under_projects(home, candidate):
            return os.stat(candidate).st_mtime * 1000
    return _newest_jsonl_mtime(folder)


def op_transcript_mtimes(args, home, allowed):
    """{dirs: [{dir, sessionId?}]} -> {mtimes: {dir: ms|null}}. `allowed(dir)` limits it to agent folders."""
    out = {}
    for item in list(args.get("dirs") or [])[:200]:
        d = str(item.get("dir", ""))
        if not os.path.isabs(d) or "\0" in d or not allowed(d):
            out[d] = None
            continue
        out[d] = transcript_mtime(home, d, item.get("sessionId") or None)
    return {"mtimes": out}


# -- restart grace (app/api/collab/pty/_handlers/message-inject.ts): did the agent save its notes? -------------------------------------

SAVE_FILES = ("logs/today.md", "logs/handoff.md", "handoff.md", "MEMORY.md", "Expertise.md", ".session-scratch/journal.md")


def op_save_mtimes(args, home, allowed):
    """{dir} -> {mtimes: {path: ms}} for the few files an agent writes when it saves its notes before a restart (0 when missing).
    Only these fixed names in an agent folder, plus the agent's own auto-memory MEMORY.md; nothing else can be asked for."""
    d = str(args.get("dir", ""))
    if not os.path.isabs(d) or "\0" in d or not allowed(d):
        raise ValueError("folder not allowed")
    paths = [os.path.join(d, name) for name in SAVE_FILES]
    paths.append(os.path.join(projects_root(home), d.replace("/", "-"), "memory", "MEMORY.md"))
    out = {}
    for path in paths:
        try:
            out[path] = os.stat(path).st_mtime * 1000
        except OSError:
            out[path] = 0
    return {"mtimes": out}
