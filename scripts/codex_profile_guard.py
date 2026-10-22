"""Host-local preservation of the shared Codex profile during live TUI changes."""
import os
import re
import secrets
import stat
import time
from pathlib import Path

KEYS = ('model', 'model_reasoning_effort', 'service_tier')
_pending = {}


def active_profile(pid, proc_root='/proc'):
    queue, seen = [pid], set()
    while queue and len(seen) < 64:
        current = queue.pop(0)
        if current in seen or current <= 0:
            continue
        seen.add(current)
        root = Path(proc_root) / str(current)
        try:
            args = (root / 'cmdline').read_bytes().decode().split('\0')
            if '--profile' in args:
                profile = args[args.index('--profile') + 1]
                env = (root / 'environ').read_bytes().decode().split('\0')
                home = next((v.partition('=')[2] for v in env if v.startswith('CODEX_HOME=')), os.path.expanduser('~/.codex'))
                return profile, Path(home)
        except (OSError, ValueError, IndexError):
            pass
        try:
            queue.extend(int(v) for v in (root / 'task' / str(current) / 'children').read_text().split())
        except (OSError, ValueError):
            pass
    return None, None


def managed_lines(content):
    root = re.split(r'^\s*\[', content, maxsplit=1, flags=re.M)[0]
    return {key: next((line for line in root.splitlines() if re.match(r'^\s*' + key + r'\s*=', line)), None) for key in KEYS}


def restore_lines(before, after):
    current = managed_lines(after)
    for key in KEYS:
        if current[key] is not None:
            after = after.replace(current[key], before[key] or '', 1)
        elif before[key] is not None:
            after = before[key] + '\n' + after
    return after


def begin(session, pid):
    profile, home = active_profile(pid)
    if profile != 'agentchat':
        return {'token': None}
    path = home / 'agentchat.config.toml'
    before = managed_lines(path.read_text())
    token = secrets.token_hex(24)
    _pending[token] = (session, path, before)
    return {'token': token}


def finish(session, token, window=2.0, poll=0.1):
    saved = _pending.get(token)
    if saved is None or saved[0] != session:
        raise ValueError('Unknown Codex profile restoration token for session')
    _, path, before = saved
    deadline = time.monotonic() + window
    try:
        while True:
            after = path.read_text()
            restored = restore_lines(before, after)
            if restored != after:
                temp = path.with_name(path.name + '.hostd-restore-' + token)
                try:
                    temp.write_text(restored)
                    temp.chmod(stat.S_IMODE(path.stat().st_mode))
                    temp.replace(path)
                finally:
                    temp.unlink(missing_ok=True)
            if time.monotonic() >= deadline:
                break
            time.sleep(min(poll, max(0, deadline - time.monotonic())))
    finally:
        _pending.pop(token, None)
    return {'restored': True}
