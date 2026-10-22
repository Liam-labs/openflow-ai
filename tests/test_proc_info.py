import importlib.util
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('proc_info', Path(__file__).resolve().parents[1] / 'scripts/proc_info.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

VM_STAT = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12345.
Pages active:                            200000.
Pages inactive:                           50000.
Pages speculative:                         1000.
"""
GONE = 2 ** 22 + 12345


class Linux(unittest.TestCase):
    """The real /proc: what the wrappers always read."""

    def test_this_process(self):
        self.assertTrue(p.pid_alive(os.getpid(), linux=True))
        self.assertFalse(p.pid_alive(GONE, linux=True))
        self.assertFalse(p.pid_alive(0, linux=True))
        self.assertFalse(p.pid_alive('abc', linux=True))
        self.assertEqual(p.ppid(os.getpid(), linux=True), os.getppid())
        self.assertIsNone(p.ppid(GONE, linux=True))
        self.assertIn('python', p.cmdline(os.getpid(), linux=True).lower())
        self.assertEqual(p.cmdline(GONE, linux=True), '')

    def test_child_and_its_cpu_time(self):
        child = subprocess.Popen(['sleep', '31'])
        try:
            self.assertIn(child.pid, p.children(os.getpid(), linux=True))
            self.assertEqual(p.children(child.pid, linux=True), [])
            for _ in range(100):                       # /proc/<pid>/cmdline is briefly empty while the new program is loaded
                if p.cmdline(child.pid, linux=True):
                    break
                time.sleep(0.02)
            self.assertEqual(p.cmdline(child.pid, linux=True), 'sleep 31 ')
            self.assertIsInstance(p.cpu_ticks(child.pid, linux=True), int)
        finally:
            child.kill()
            child.wait()
        self.assertIsNone(p.cpu_ticks(GONE, linux=True))

    def test_cpu_ticks_adds_user_and_system_time(self):
        from unittest import mock
        stat = '10 (a) S 1 10 10 0 -1 4194304 100 0 0 0 700 25 0 0 20 0 1 0 100 1000 100 18446744073709551615'
        with mock.patch('builtins.open', mock.mock_open(read_data=stat)):
            self.assertEqual(p.cpu_ticks(10, linux=True), 725)

    def test_open_files(self):
        import tempfile
        with tempfile.NamedTemporaryFile() as handle:
            self.assertIn(os.path.realpath(handle.name), p.open_files(os.getpid(), linux=True))
        self.assertEqual(p.open_files(GONE, linux=True), [])

    def test_meminfo(self):
        info = p.mem_info_kb(linux=True)
        self.assertGreater(info['MemTotal'], 0)
        self.assertIn('MemAvailable', info)


class Mac(unittest.TestCase):
    """ps, pgrep and vm_stat, faked: what a Mac prints."""

    def runner(self, answers):
        calls = []

        def run(argv):
            calls.append(argv)
            return answers.get(argv[0])
        run.calls = calls
        return run

    def test_ppid_and_cmdline_ask_ps(self):
        run = self.runner({'ps': '  4242\n'})
        self.assertEqual(p.ppid(10, linux=False, run=run), 4242)
        self.assertEqual(run.calls, [['ps', '-p', '10', '-o', 'ppid=']])
        run = self.runner({'ps': '  /usr/bin/node a b\n'})
        self.assertEqual(p.cmdline(10, linux=False, run=run), '/usr/bin/node a b')
        self.assertEqual(run.calls, [['ps', '-p', '10', '-o', 'command=']])

    def test_nothing_readable_gives_the_empty_answer(self):
        run = self.runner({})
        self.assertIsNone(p.ppid(10, linux=False, run=run))
        self.assertEqual(p.cmdline(10, linux=False, run=run), '')
        self.assertEqual(p.children(10, linux=False, run=run), [])
        self.assertIsNone(p.cpu_ticks(10, linux=False, run=run))
        self.assertEqual(p.mem_info_kb(linux=False, run=run), {})
        self.assertIsNone(p.ppid(10, linux=False, run=self.runner({'ps': 'junk'})))

    def test_ids_that_are_not_processes_never_reach_a_command(self):
        run = self.runner({'ps': '1', 'pgrep': '1'})
        for bad in (0, -1, 'x; rm -rf /', None):
            self.assertEqual(p.cmdline(bad, linux=False, run=run), '')
            self.assertEqual(p.children(bad, linux=False, run=run), [])
            self.assertIsNone(p.ppid(bad, linux=False, run=run))
            self.assertIsNone(p.cpu_ticks(bad, linux=False, run=run))
            self.assertFalse(p.pid_alive(bad, linux=False))
        self.assertEqual(run.calls, [])

    def test_children_from_pgrep(self):
        run = self.runner({'pgrep': '11\n12\n'})
        self.assertEqual(p.children(10, linux=False, run=run), [11, 12])
        self.assertEqual(run.calls, [['pgrep', '-P', '10']])
        self.assertEqual(p.children(10, linux=False, run=self.runner({'pgrep': 'x y'})), [])

    def test_liveness_by_signal_zero(self):
        self.assertTrue(p.pid_alive(os.getpid(), linux=False))
        self.assertFalse(p.pid_alive(GONE, linux=False))
        self.assertTrue(p.pid_alive(1, linux=False))          # another user's process: refused (EPERM) but alive

    def test_cpu_time_is_in_hundredths_of_a_second(self):
        for text, expect in (('0:00.00', 0), ('0:12.34', 1234), ('1:02.50', 6250), ('1:00:00.05', 360005), ('2-01:00:00', 17640000), ('5:07', 30700), ('0:12.5', 1250)):
            self.assertEqual(p._parse_cputime(text), expect, text)
        self.assertIsNone(p._parse_cputime('garbage'))
        self.assertIsNone(p._parse_cputime(''))
        self.assertEqual(p.cpu_ticks(10, linux=False, run=self.runner({'ps': ' 0:12.34\n'})), 1234)

    def test_open_files_from_lsof(self):
        lsof = 'p10\nfcwd\nn/Users/x/project\nf3\nn/Users/x/.codex/sessions/2026/10/22/rollout-a.jsonl\nf4\nnTCP 127.0.0.1:3000->127.0.0.1:5\n'
        run = self.runner({'lsof': lsof})
        self.assertEqual(p.open_files(10, linux=False, run=run), ['/Users/x/project', '/Users/x/.codex/sessions/2026/10/22/rollout-a.jsonl'])
        self.assertEqual(run.calls, [['lsof', '-nP', '-p', '10', '-Fn']])
        self.assertEqual(p.open_files(10, linux=False, run=self.runner({})), [])
        self.assertEqual(p.open_files(0, linux=False, run=run), [])

    def test_memory_from_vm_stat(self):
        want = (12345 + 50000 + 1000) * 16384 // (1024 * 1024)
        self.assertEqual(p.parse_vm_stat_mb(VM_STAT), want)
        self.assertEqual(p.mem_info_kb(linux=False, run=self.runner({'vm_stat': VM_STAT})), {'MemAvailable': want * 1024})
        self.assertIsNone(p.parse_vm_stat_mb('nonsense'))
        self.assertIsNone(p.parse_vm_stat_mb('Mach Virtual Memory Statistics: (page size of 4096 bytes)\n'))


if __name__ == '__main__':
    unittest.main()
