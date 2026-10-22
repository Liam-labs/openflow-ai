import importlib.util
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


gen = load('ctindex', 'scripts/channel-tools-index.py')
hostd = load('hostd', 'scripts/agent-hostd.py')
FIXTURE = json.loads((ROOT / 'tests/fixtures/channel-tools-manifest-cases.json').read_text())


class SharedRules(unittest.TestCase):
    def test_every_shared_case_matches_the_typescript_expectations(self):
        for case in FIXTURE['cases']:
            raw = case['manifest'] if isinstance(case['manifest'], str) else json.dumps(case['manifest'])
            got = gen.parse_tool_manifest('t', raw, FIXTURE['channel'])
            exp = case['expect']
            with self.subTest(case['name']):
                if 'tool' in exp:
                    self.assertIn('tool', got, got)
                    for k, v in exp['tool'].items():
                        self.assertEqual(got['tool'].get(k), v, k)
                elif 'warning' in exp:
                    self.assertIn(exp['warning'], got.get('warning', ''), got)
                else:
                    self.assertEqual(got, {'hidden': True})


class Generator(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = os.path.realpath(self.tmp.name)
        self.root = os.path.join(self.project, 'channel-tools')
        os.makedirs(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def tool(self, name, manifest=None, raw=None):
        os.makedirs(os.path.join(self.root, name), exist_ok=True)
        text = raw if raw is not None else json.dumps(manifest)
        Path(self.root, name, 'tool.json').write_text(text)

    def index(self):
        return json.loads(Path(self.root, 'tools.json').read_text())

    def test_lists_valid_tools_and_errors_without_crashing(self):
        self.tool('b-link', {'name': 'Link', 'type': 'link', 'url': '/backups', 'whenToUse': 'When Owner asks about backups.', 'order': 2})
        self.tool('a-html', {'name': 'App', 'type': 'html', 'order': 1})
        self.tool('script', {'type': 'script', 'run': 'python3 x.py', 'cwd': 'src', 'channels': ['Commander']})
        self.tool('malformed', raw='{oops')
        self.tool('badtype', {'type': 'exe'})
        os.makedirs(os.path.join(self.root, 'empty'))
        os.makedirs(os.path.join(self.root, 'bad name'))
        os.makedirs(os.path.join(self.root, '.hidden'))
        os.symlink(self.project, os.path.join(self.root, 'linked'))
        Path(self.root, 'README.md').write_text('x')
        self.assertEqual(gen.main(['x', self.project]), 0)
        doc = self.index()
        self.assertEqual([t['id'] for t in doc['tools']], ['a-html', 'b-link', 'script'])
        link = doc['tools'][1]
        self.assertEqual((link['whenToUse'], link['url'], link['type']), ('When Owner asks about backups.', '/backups', 'link'))
        self.assertEqual(doc['tools'][0]['whenToUse'], '')
        self.assertEqual(doc['tools'][2]['channels'], ['Commander'])
        self.assertEqual(doc['tools'][2]['cwd'], 'src')
        self.assertEqual(sorted(e['id'] for e in doc['errors']), ['bad name', 'badtype', 'empty', 'malformed'])
        self.assertRegex(doc['generatedAt'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')

    def test_tools_json_and_temp_files_are_never_tools_and_rerun_is_idempotent(self):
        self.tool('one', {'type': 'link', 'url': '/x'})
        t1 = datetime(2026, 1, 1, tzinfo=timezone.utc)
        t2 = datetime(2026, 1, 2, tzinfo=timezone.utc)
        self.assertTrue(gen.write_index(self.root, t1)[0])
        before = Path(self.root, 'tools.json').read_bytes()
        changed, tools, errors = gen.write_index(self.root, t2)
        self.assertFalse(changed)
        self.assertEqual(Path(self.root, 'tools.json').read_bytes(), before)
        self.assertEqual([t['id'] for t in tools], ['one'])
        self.assertEqual(errors, [])
        self.tool('two', {'type': 'link', 'url': '/y'})
        self.assertTrue(gen.write_index(self.root, t2)[0])
        self.assertEqual(self.index()['generatedAt'], '2026-01-02T00:00:00Z')
        self.assertEqual(sorted(os.listdir(self.root)), ['one', 'tools.json', 'two'])

    def test_accepts_the_channel_tools_folder_or_the_project_folder(self):
        self.tool('one', {'type': 'link', 'url': '/x'})
        self.assertEqual(gen.main(['x', self.root]), 0)
        os.remove(os.path.join(self.root, 'tools.json'))
        self.assertEqual(gen.main(['x', self.project + '/']), 0)
        self.assertTrue(Path(self.root, 'tools.json').exists())

    def test_missing_folder_and_bad_usage_fail_cleanly(self):
        self.assertEqual(gen.main(['x', os.path.join(self.project, 'Nope')]), 2)
        self.assertEqual(gen.main(['x']), 2)
        self.assertEqual(gen.main(['x', self.project, '--bogus']), 2)

    def test_check_mode_writes_nothing(self):
        self.tool('one', {'type': 'link', 'url': '/x'})
        self.assertEqual(gen.main(['x', self.project, '--check']), 0)
        self.assertFalse(Path(self.root, 'tools.json').exists())

    def test_scan_agrees_with_hostd_listing(self):
        self.tool('good', {'type': 'link', 'url': '/x'})
        self.tool('malformed', raw='{')
        os.makedirs(os.path.join(self.root, 'empty'))
        os.makedirs(os.path.join(self.root, 'bad name'))
        os.makedirs(os.path.join(self.root, '.hidden'))
        os.symlink(self.project, os.path.join(self.root, 'linked'))
        Path(self.root, 'README.md').write_text('x')
        gen.write_index(self.root)  # tools.json present: must be ignored by both
        with patch.object(hostd, 'HOME_REAL', self.project), patch.object(hostd, 'ROOTS', []):
            listing = hostd.op_channel_tools_list({'dir': self.root})
        theirs = [(t['id'], t['manifest'], t['error']) for t in listing['tools']]
        self.assertEqual(gen.scan(self.root), theirs)
        self.assertNotIn('tools.json', [t['id'] for t in listing['tools']])


if __name__ == '__main__':
    unittest.main()
