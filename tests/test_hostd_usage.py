import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import hostd_usage as u  # noqa: E402

spec = importlib.util.spec_from_file_location('hostd', SCRIPTS / 'agent-hostd.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def rec(inp=0, out=0, cr=0, cc=0, model='claude-x', at='2026-10-21T10:00:00.000Z', kind='assistant'):
    return json.dumps({'type': kind, 'timestamp': at, 'message': {'model': model, 'usage': {
        'input_tokens': inp, 'output_tokens': out, 'cache_read_input_tokens': cr, 'cache_creation_input_tokens': cc}}}) + '\n'


class Usage(unittest.TestCase):
    """DevFlow's usage panel read 0 for every agent after the server move (21 Oct 2026): the server now asks this machine."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.realpath(self.tmp.name)
        self.proj = os.path.join(self.home, '.claude', 'projects', '-a-b')
        os.makedirs(self.proj)
        self.f1 = os.path.join(self.proj, 's1.jsonl')
        u._index = None
        self.idx = u.index_for(self.home)

    def tearDown(self):
        u._index = None
        self.tmp.cleanup()

    def write(self, path, *lines, mode='w'):
        with open(path, mode) as f:
            f.write(''.join(lines))

    def ms(self, stamp):
        return u._ms(stamp)

    def test_totals_per_file_and_per_model_count_only_assistant_usage(self):
        self.write(self.f1, rec(10, 5, 100, 7), rec(1, 2, 3, 4, model='other'), rec(99, 99, kind='user'), '{"type":"assistant","message":{}}\n', 'not json "usage"\n')
        self.idx.scan()
        got = self.idx.one(self.f1)
        self.assertEqual(got['tokens'], {'inputTokens': 11, 'outputTokens': 7, 'cacheReadTokens': 103, 'cacheCreationTokens': 11})
        self.assertEqual(got['modelTokens']['claude-x']['cacheReadTokens'], 100)
        self.assertEqual(got['modelTokens']['other']['outputTokens'], 2)
        self.assertEqual((got['messageCount'], got['lastActivity']), (2, '2026-10-21T10:00:00.000Z'))

    def test_a_later_pass_reads_only_what_was_added_and_waits_for_a_half_written_line(self):
        self.write(self.f1, rec(1, 1))
        self.idx.scan()
        self.write(self.f1, rec(2, 2)[:30], mode='a')
        self.idx.scan()
        self.assertEqual(self.idx.one(self.f1)['tokens']['inputTokens'], 1)       # half a line is not counted yet
        self.write(self.f1, rec(2, 2)[30:], rec(4, 4), mode='a')
        self.idx.scan()
        self.assertEqual(self.idx.one(self.f1)['tokens'], {'inputTokens': 7, 'outputTokens': 7, 'cacheReadTokens': 0, 'cacheCreationTokens': 0})
        self.assertEqual(self.idx.one(self.f1)['messageCount'], 3)

    def test_a_complete_line_followed_by_half_a_line_in_one_read_counts_the_line_and_keeps_the_rest_for_later(self):
        half = rec(5, 5)
        self.write(self.f1, rec(1, 1), half[:25])
        self.idx.scan()
        self.assertEqual(self.idx.one(self.f1)['tokens']['inputTokens'], 1)
        self.write(self.f1, half[25:], mode='a')
        self.idx.scan()
        self.assertEqual(self.idx.one(self.f1)['tokens']['inputTokens'], 6)
        self.assertEqual(self.idx.one(self.f1)['messageCount'], 2)

    def test_a_replaced_or_shrunk_file_is_read_again_from_the_start(self):
        self.write(self.f1, rec(5, 5), rec(5, 5))
        self.idx.scan()
        self.write(self.f1, rec(1, 1))
        self.idx.scan()
        self.assertEqual(self.idx.one(self.f1)['tokens']['inputTokens'], 1)

    def test_files_since_filters_by_modified_time_and_forgets_deleted_files(self):
        old = os.path.join(self.proj, 'old.jsonl')
        self.write(old, rec(1, 1))
        os.utime(old, (time.time() - 3 * 86400,) * 2)
        self.write(self.f1, rec(2, 2))
        self.idx.scan()
        now = time.time() * 1000
        self.assertEqual([os.path.basename(f['path']) for f in self.idx.files_since(now - 86_400_000)], ['s1.jsonl'])
        self.assertEqual(len(self.idx.files_since(now - 5 * 86_400_000)), 2)
        os.remove(old)
        self.idx.scan()
        self.assertEqual(len(self.idx.files_since(0)), 1)

    def test_files_older_than_the_index_window_are_not_indexed(self):
        ancient = os.path.join(self.proj, 'ancient.jsonl')
        self.write(ancient, rec(1, 1))
        os.utime(ancient, (time.time() - 30 * 86400,) * 2)
        self.idx.scan()
        self.assertIsNone(self.idx.one(ancient))

    def test_window_counts_messages_by_their_own_time_and_reports_the_earliest(self):
        a, b, c = '2026-10-21T08:00:00.000Z', '2026-10-21T09:30:00.000Z', '2026-10-21T10:30:00.000Z'
        self.write(self.f1, rec(1, 1, 1, 1, at=a), rec(10, 0, 0, 0, at=b), rec(100, 0, 0, 0, at=c))
        f2 = os.path.join(self.proj, 's2.jsonl')
        self.write(f2, rec(1000, 0, 0, 0, at=c))
        self.idx.scan()
        got = self.idx.window(self.ms(b))
        self.assertEqual(got, {'tokens': 10 + 100 + 1000, 'sessionStartMs': self.ms(b)})
        self.assertEqual(self.idx.window(self.ms('2030-01-01T00:00:00Z')), {'tokens': 0, 'sessionStartMs': None})

    def test_window_ignores_files_not_touched_since_the_window_started(self):
        self.write(self.f1, rec(7, 0, at='2026-10-21T08:00:00.000Z'))
        os.utime(self.f1, (1_000_000_000, 1_000_000_000))                       # modified long ago
        self.idx.scan()
        self.assertEqual(self.idx.window(self.ms('2026-10-21T00:00:00Z'))['tokens'], 0)

    def test_the_op_answers_from_the_index_at_once_and_says_when_it_is_not_ready(self):
        self.write(self.f1, rec(3, 3))
        first = u.op_usage_facts({'action': 'files', 'sinceMs': 0}, self.home)
        self.assertIn('ready', first)
        deadline = time.time() + 5
        while time.time() < deadline:
            got = u.op_usage_facts({'action': 'files', 'sinceMs': 0}, self.home)
            if got['ready'] and got['files']:
                break
            time.sleep(0.05)
        self.assertTrue(got['ready'])
        self.assertEqual(got['files'][0]['tokens']['inputTokens'], 3)

    def test_file_action_only_serves_session_files_inside_the_projects_folder(self):
        self.write(self.f1, rec(3, 3))
        self.idx.scan()
        ok = u.op_usage_facts({'action': 'file', 'path': self.f1}, self.home)
        self.assertEqual(ok['file']['tokens']['outputTokens'], 3)
        secret = os.path.join(self.home, '.secrets')
        self.write(secret, 'K=1')
        outside = os.path.join(self.home, 'x.jsonl')
        self.write(outside, rec(1, 1))
        link = os.path.join(self.proj, 'link.jsonl')
        os.symlink(outside, link)
        for bad in (secret, outside, link, 'relative.jsonl', os.path.join(self.proj, '..', '..', '..', 'x.jsonl'), self.f1 + '\0'):
            with self.assertRaises(ValueError):
                u.op_usage_facts({'action': 'file', 'path': bad}, self.home)
        notes = os.path.join(self.proj, 'notes.txt')            # inside the projects folder, but not a session transcript
        self.write(notes, 'x')
        with self.assertRaises(ValueError):
            u.op_usage_facts({'action': 'file', 'path': notes}, self.home)
        with self.assertRaises(ValueError):
            u.op_usage_facts({'action': 'bogus'}, self.home)

    def test_hostd_registers_the_ops(self):
        self.assertIn('usage-facts', m.OPS)
        self.assertIn('transcript-mtimes', m.OPS)


class TranscriptMtimes(unittest.TestCase):
    """The frozen-agent check's liveness signal for agents whose transcripts live here (lib/frozen-detection-jsonl.ts)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.realpath(self.tmp.name)
        self.agent = os.path.join(self.home, 'SG-1', 'Team', 'Agent')
        os.makedirs(os.path.join(self.agent, '.session-scratch'))
        self.proj = os.path.join(self.home, '.claude', 'projects', u.re.sub(r'[^a-zA-Z0-9]', '-', self.agent))
        os.makedirs(self.proj)

    def tearDown(self):
        self.tmp.cleanup()

    def touch(self, path, age):
        Path(path).write_text('{}\n')
        os.utime(path, (time.time() - age,) * 2)

    def mt(self, **kw):
        return u.transcript_mtime(self.home, self.agent, **kw)

    def test_newest_transcript_of_the_project_folder(self):
        self.touch(os.path.join(self.proj, 'a.jsonl'), 500)
        self.touch(os.path.join(self.proj, 'b.jsonl'), 50)
        self.assertAlmostEqual(self.mt() / 1000, time.time() - 50, delta=3)

    def test_the_scratch_pointer_beats_the_session_id_beats_the_newest(self):
        newest, pinned, pointed = (os.path.join(self.proj, n) for n in ('newest.jsonl', 'pinned.jsonl', 'pointed.jsonl'))
        self.touch(newest, 10)
        self.touch(pinned, 200)
        self.touch(pointed, 400)
        self.assertAlmostEqual(self.mt() / 1000, time.time() - 10, delta=3)
        Path(self.agent, '.session-scratch', 'session-id').write_text('pinned')
        self.assertAlmostEqual(self.mt() / 1000, time.time() - 200, delta=3)
        self.assertAlmostEqual(self.mt(session_id='newest') / 1000, time.time() - 10, delta=3)         # an explicit id wins over the scratch one
        Path(self.agent, '.session-scratch', 'transcript-path').write_text(pointed)
        self.assertAlmostEqual(self.mt() / 1000, time.time() - 400, delta=3)

    def test_a_pointer_outside_the_projects_folder_is_ignored(self):
        outside = os.path.join(self.home, 'elsewhere.jsonl')
        self.touch(outside, 5)
        self.touch(os.path.join(self.proj, 'a.jsonl'), 300)
        Path(self.agent, '.session-scratch', 'transcript-path').write_text(outside)
        self.assertAlmostEqual(self.mt() / 1000, time.time() - 300, delta=3)

    def test_no_transcript_gives_none_and_the_op_limits_it_to_allowed_folders(self):
        self.assertIsNone(self.mt())
        self.touch(os.path.join(self.proj, 'a.jsonl'), 30)
        got = u.op_transcript_mtimes({'dirs': [{'dir': self.agent}, {'dir': '/etc'}, {'dir': 'rel'}]}, self.home, lambda d: d.startswith(self.home))
        other = os.path.join(self.home, 'private', 'Elsewhere')           # has a transcript folder of its own, but is not an agent folder
        os.makedirs(os.path.join(self.home, '.claude', 'projects', u.re.sub(r'[^a-zA-Z0-9]', '-', other)))
        self.touch(os.path.join(self.home, '.claude', 'projects', u.re.sub(r'[^a-zA-Z0-9]', '-', other), 'z.jsonl'), 5)
        refused = u.op_transcript_mtimes({'dirs': [{'dir': other}]}, self.home, lambda d: d.startswith(os.path.join(self.home, 'SG-1')))
        self.assertIsNone(refused['mtimes'][other])
        self.assertIsNotNone(u.transcript_mtime(self.home, other))          # (it would answer if asked directly)
        self.assertIsNotNone(got['mtimes'][self.agent])
        self.assertIsNone(got['mtimes']['/etc'])
        self.assertIsNone(got['mtimes']['rel'])


if __name__ == '__main__':
    unittest.main()


class SaveMtimes(unittest.TestCase):
    """Restart grace: which of the agent's note files changed (app/api/collab/pty/_handlers/message-inject.ts)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.realpath(self.tmp.name)
        self.agent = os.path.join(self.home, 'SG-1', 'Team', 'Agent')
        os.makedirs(os.path.join(self.agent, 'logs'))
        self.allowed = lambda d: d.startswith(os.path.join(self.home, 'SG-1'))

    def tearDown(self):
        self.tmp.cleanup()

    def test_reports_the_fixed_note_files_and_the_auto_memory_file_with_zero_for_missing(self):
        Path(self.agent, 'logs', 'today.md').write_text('x')
        mem = os.path.join(self.home, '.claude', 'projects', self.agent.replace('/', '-'), 'memory')
        os.makedirs(mem)
        Path(mem, 'MEMORY.md').write_text('x')
        got = u.op_save_mtimes({'dir': self.agent}, self.home, self.allowed)['mtimes']
        self.assertGreater(got[os.path.join(self.agent, 'logs', 'today.md')], 0)
        self.assertGreater(got[os.path.join(mem, 'MEMORY.md')], 0)
        self.assertEqual(got[os.path.join(self.agent, 'Expertise.md')], 0)
        self.assertEqual(len(got), len(u.SAVE_FILES) + 1)

    def test_only_agent_folders_and_only_those_names(self):
        for bad in ('/etc', 'relative', self.home, self.agent + '\0'):
            with self.assertRaises(ValueError):
                u.op_save_mtimes({'dir': bad}, self.home, self.allowed)
        Path(self.agent, 'secret.txt').write_text('x')
        self.assertNotIn(os.path.join(self.agent, 'secret.txt'), u.op_save_mtimes({'dir': self.agent}, self.home, self.allowed)['mtimes'])

    def test_registered_as_a_host_op(self):
        self.assertIn('save-mtimes', m.OPS)
