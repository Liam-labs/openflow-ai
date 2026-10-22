"""Facts about running processes and free memory, the same answers on Linux and macOS (the Python twin of lib/proc-info.ts).

Linux reads /proc, exactly as the wrappers always did. macOS has no /proc, so it asks `ps`, `pgrep` and `vm_stat`.
Anything that cannot be read gives the "nothing" answer (False, None, []), never an exception, so a caller can use it in a polling loop.
"""
import os
import re
import subprocess
import sys

LINUX = sys.platform.startswith("linux")


def _run(argv, run=None):
    """Output of a short command, or None when it fails. `run` is a test hook."""
    if run is not None:
        return run(argv)
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout if out.returncode == 0 else None


def _valid(pid):
    try:
        return int(pid) if int(pid) > 0 else None
    except (TypeError, ValueError):
        return None


def pid_alive(pid, linux=None):
    """True when a process with this id exists (a zombie still counts)."""
    pid = _valid(pid)
    if pid is None:
        return False
    if LINUX if linux is None else linux:
        return os.path.exists(f"/proc/{pid}")
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True            # it exists but belongs to someone else
    except OSError:
        return False


def ppid(pid, linux=None, run=None):
    """The parent process id, or None when unknown."""
    pid = _valid(pid)
    if pid is None:
        return None
    if LINUX if linux is None else linux:
        try:
            with open(f"/proc/{pid}/stat") as handle:
                return int(handle.read().split()[3])
        except (OSError, IndexError, ValueError):
            return None
    out = _run(["ps", "-p", str(pid), "-o", "ppid="], run)
    try:
        return int(out.strip()) if out else None
    except ValueError:
        return None


def children(pid, linux=None, run=None):
    """The direct children of a process, as a list of ints."""
    pid = _valid(pid)
    if pid is None:
        return []
    if LINUX if linux is None else linux:
        try:
            with open(f"/proc/{pid}/task/{pid}/children") as handle:
                return [int(value) for value in handle.read().split()]
        except (OSError, ValueError):
            return []
    out = _run(["pgrep", "-P", str(pid)], run)
    try:
        return [int(value) for value in (out or "").split()]
    except ValueError:
        return []


def _parse_cputime(text):
    """`ps -o cputime=` prints [[dd-]hh:]mm:ss[.cc]; the answer is in hundredths of a second, or None."""
    m = re.fullmatch(r"\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?\s*", text or "")
    if not m:
        return None
    days, hours, minutes, seconds, frac = m.groups()
    total = ((int(days or 0) * 24 + int(hours or 0)) * 60 + int(minutes)) * 60 + int(seconds)
    return total * 100 + (int((frac or "0").ljust(2, "0")[:2]))


def cpu_ticks(pid, linux=None, run=None):
    """CPU time a process has used (user + system) in hundredths of a second, or None when it cannot be read."""
    pid = _valid(pid)
    if pid is None:
        return None
    if LINUX if linux is None else linux:
        try:
            with open(f"/proc/{pid}/stat") as handle:
                fields = handle.read().split()
                return int(fields[13]) + int(fields[14])
        except (OSError, IndexError, ValueError):
            return None
    return _parse_cputime(_run(["ps", "-p", str(pid), "-o", "cputime="], run))


def cmdline(pid, linux=None, run=None):
    """The command line, words separated by a space; '' when the process is gone or cannot be read."""
    pid = _valid(pid)
    if pid is None:
        return ""
    if LINUX if linux is None else linux:
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as handle:
                return handle.read().decode("utf-8", "replace").replace("\0", " ")
        except OSError:
            return ""
    return (_run(["ps", "-p", str(pid), "-o", "command="], run) or "").strip()


def parse_vm_stat_mb(text):
    """Memory a new program could use, in whole MB, from `vm_stat` output (free + inactive + speculative pages); None if unrecognised."""
    size = re.search(r"page size of (\d+) bytes", text or "")
    if not size:
        return None
    pages, seen = 0, 0
    for name in ("Pages free", "Pages inactive", "Pages speculative"):
        m = re.search(name + r":\s+(\d+)", text)
        if m:
            pages += int(m.group(1))
            seen += 1
    return (pages * int(size.group(1))) // (1024 * 1024) if seen else None


def mem_info_kb(linux=None, run=None):
    """{'MemTotal': kB, 'MemFree': kB, 'MemAvailable': kB, ...}: the meminfo figures; only MemAvailable on a Mac. {} when unreadable."""
    if LINUX if linux is None else linux:
        info = {}
        try:
            with open("/proc/meminfo") as handle:
                for line in handle:
                    parts = line.split()
                    if len(parts) >= 2:
                        info[parts[0].rstrip(":")] = int(parts[1])
        except (OSError, ValueError):
            return {}
        return info
    mb = parse_vm_stat_mb(_run(["vm_stat"], run))
    return {"MemAvailable": mb * 1024} if mb is not None else {}


def open_files(pid, linux=None, run=None):
    """The real paths of the files a process has open (regular paths only; sockets and pipes are left out), or [] when unreadable.
    Linux lists /proc/<pid>/fd; macOS asks lsof, which prints one `n<path>` line per file with -Fn."""
    pid = _valid(pid)
    if pid is None:
        return []
    if LINUX if linux is None else linux:
        fd_dir = f"/proc/{pid}/fd"
        try:
            names = os.listdir(fd_dir)
        except OSError:
            return []
        paths = []
        for name in names:
            try:
                paths.append(os.path.realpath(os.path.join(fd_dir, name)))
            except OSError:
                continue
        return paths
    out = _run(["lsof", "-nP", "-p", str(pid), "-Fn"], run)
    return [line[1:] for line in (out or "").splitlines() if line.startswith("n/")]
