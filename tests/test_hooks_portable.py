import os
import shutil
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

HOOKS = Path(__file__).resolve().parents[1] / 'scripts' / 'hooks'


def mac_like_bin(root):
    """A PATH that behaves like a Mac's: every system program except flock, timeout and gtimeout; `date` prints a literal N for %N
    and `stat` refuses GNU's -c, as BSD tools do."""
    bin_dir = Path(root) / 'macbin'
    bin_dir.mkdir()
    skip = {'flock', 'timeout', 'gtimeout', 'date', 'stat'}
    for folder in ('/usr/bin', '/bin'):
        for name in os.listdir(folder):
            target = bin_dir / name
            if name not in skip and not target.exists():
                target.symlink_to(os.path.join(folder, name))
    (bin_dir / 'date').write_text('#!/bin/bash\nfor a in "$@"; do case "$a" in +%s%N) echo 1729590000N; exit 0;; +%s) echo 1729590000; exit 0;; esac; done\nexec /usr/bin/date "$@"\n')
    (bin_dir / 'stat').write_text('#!/bin/bash\necho "stat: illegal option -- c" >&2\nexit 1\n')
    for name in ('date', 'stat'):
        (bin_dir / name).chmod((bin_dir / name).stat().st_mode | stat.S_IEXEC)
    return bin_dir


def run(script, path, env_extra=None, timeout=30):
    env = {'PATH': path, 'HOME': tempfile.gettempdir(), **(env_extra or {})}
    return subprocess.run(['/bin/bash', '-c', script], capture_output=True, text=True, env=env, timeout=timeout)


class Portable(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.mac = str(mac_like_bin(self.tmp.name))
        self.src = 'source %s; ' % (HOOKS / '_portable.sh')

    def tearDown(self):
        self.tmp.cleanup()

    # -- timeout ----------------------------------------------------------------------
    def test_without_a_timeout_program_the_command_still_runs_with_its_arguments_and_status(self):
        out = run(self.src + 'portable_timeout 5 sh -c "echo ran \\$1; exit 3" x y', self.mac)
        self.assertEqual((out.stdout.strip(), out.returncode), ('ran y', 3))

    @unittest.skipUnless(shutil.which('timeout', path='/usr/bin:/bin'), 'GNU timeout is not installed')
    def test_with_gnu_timeout_a_slow_command_is_stopped(self):
        started = time.time()
        out = run(self.src + 'portable_timeout 1 sleep 5', '/usr/bin:/bin')
        self.assertEqual(out.returncode, 124)
        self.assertLess(time.time() - started, 4)

    def test_gtimeout_is_used_when_only_that_exists(self):
        Path(self.mac, 'gtimeout').write_text('#!/bin/bash\necho "gtimeout used: $1"\n')
        Path(self.mac, 'gtimeout').chmod(0o755)
        self.assertEqual(run(self.src + 'portable_timeout 7 true', self.mac).stdout.strip(), 'gtimeout used: 7')

    # -- lock -------------------------------------------------------------------------
    def lock_script(self, lock):
        return self.src + 'exec 9>"%s"; portable_try_lock 9' % lock

    def test_the_fallback_lock_excludes_a_second_holder_and_frees_when_the_first_exits(self):
        lock = os.path.join(self.tmp.name, 'flush.lock')
        holder = subprocess.Popen(['/bin/bash', '-c', self.lock_script(lock) + ' && echo held && sleep 3'], stdout=subprocess.PIPE, text=True,
                                  env={'PATH': self.mac, 'HOME': self.tmp.name})
        self.assertEqual(holder.stdout.readline().strip(), 'held')
        self.assertEqual(run(self.lock_script(lock), self.mac).returncode, 1)          # someone holds it: refused, not blocked
        holder.wait()
        self.assertEqual(run(self.lock_script(lock), self.mac).returncode, 0)          # released when the holder ended

    @unittest.skipUnless(shutil.which('flock', path='/usr/bin:/bin'), 'flock is not installed')
    def test_with_flock_the_same_contract_holds(self):
        lock = os.path.join(self.tmp.name, 'gnu.lock')
        holder = subprocess.Popen(['/bin/bash', '-c', self.lock_script(lock) + ' && echo held && sleep 3'], stdout=subprocess.PIPE, text=True,
                                  env={'PATH': '/usr/bin:/bin', 'HOME': self.tmp.name})
        self.assertEqual(holder.stdout.readline().strip(), 'held')
        self.assertEqual(run(self.lock_script(lock), '/usr/bin:/bin').returncode, 1)
        holder.wait()
        self.assertEqual(run(self.lock_script(lock), '/usr/bin:/bin').returncode, 0)

    # -- telemetry --------------------------------------------------------------------
    def telemetry(self, body, path, events=None):
        events = events or os.path.join(self.tmp.name, 'events.jsonl')
        return run('source %s; %s' % (HOOKS / '_telemetry.sh', body), path, {'HOOK_EVENTS_PATH': events, 'HOOK_EVENTS_MAX_BYTES': '100'})

    def test_milliseconds_are_computed_on_a_system_whose_date_has_no_nanoseconds(self):
        out = self.telemetry('_telemetry_now_ms', self.mac)
        self.assertEqual(out.stdout.strip(), '1729590000000')

    def test_milliseconds_on_linux_are_real(self):
        out = self.telemetry('_telemetry_now_ms', '/usr/bin:/bin')
        self.assertAlmostEqual(int(out.stdout.strip()), time.time() * 1000, delta=5000)

    def test_the_event_file_is_rotated_when_too_big_even_without_gnu_stat(self):
        events = os.path.join(self.tmp.name, 'events.jsonl')
        Path(events).write_text('x' * 500)
        self.telemetry('_telemetry_rotate_if_needed', self.mac, events)
        self.assertFalse(os.path.exists(events))
        self.assertEqual(Path(events + '.1').read_text(), 'x' * 500)

    def test_a_small_event_file_is_left_alone(self):
        events = os.path.join(self.tmp.name, 'events.jsonl')
        Path(events).write_text('x' * 10)
        self.telemetry('_telemetry_rotate_if_needed', self.mac, events)
        self.assertEqual(Path(events).read_text(), 'x' * 10)
        self.assertFalse(os.path.exists(events + '.1'))


if __name__ == '__main__':
    unittest.main()
