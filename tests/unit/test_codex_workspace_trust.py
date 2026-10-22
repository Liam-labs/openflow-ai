#!/usr/bin/env python3

import importlib
import json
import os
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path


sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'scripts'))
trust = importlib.import_module('codex_workspace_trust')


class TestCodexWorkspaceTrust(unittest.TestCase):
    def test_adds_exact_workspace_without_losing_existing_config(self):
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            config = root / '.codex' / 'config.toml'
            config.parent.mkdir()
            config.write_text('model = "gpt-5.5"\n', encoding='utf-8')
            workspace = root / 'Drone Hub' / 'Team' / 'Jack'

            self.assertTrue(trust.ensure_codex_workspace_trusted(workspace, config))

            parsed = tomllib.loads(config.read_text(encoding='utf-8'))
            self.assertEqual(parsed['model'], 'gpt-5.5')
            self.assertEqual(parsed['projects'][str(workspace)]['trust_level'], 'trusted')

    def test_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            config = root / 'config.toml'
            workspace = root / 'Team' / 'Architect'

            self.assertTrue(trust.ensure_codex_workspace_trusted(workspace, config))
            original = config.read_text(encoding='utf-8')
            self.assertFalse(trust.ensure_codex_workspace_trusted(workspace, config))
            self.assertEqual(config.read_text(encoding='utf-8'), original)

    def test_promotes_existing_untrusted_entry_without_duplicate_table(self):
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            config = root / 'config.toml'
            workspace = root / 'Team' / 'Daniel'
            config.write_text(
                f'[projects.{json.dumps(str(workspace))}]\ntrust_level = "untrusted" # keep\n',
                encoding='utf-8',
            )

            self.assertTrue(trust.ensure_codex_workspace_trusted(workspace, config))

            content = config.read_text(encoding='utf-8')
            self.assertEqual(content.count('[projects.'), 1)
            self.assertIn('trust_level = "trusted" # keep', content)
            self.assertEqual(tomllib.loads(content)['projects'][str(workspace)]['trust_level'], 'trusted')

    def test_extracts_effective_paths_and_falls_back_to_working_directory(self):
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            channels = root / 'channels.json'
            channels.write_text(json.dumps({
                'channels': [{
                    'roster': {'agents': [
                        {'workingDirectory': str(root / 'project'), 'effectiveWorkingDirectory': str(root / 'project' / 'Team' / 'Jack')},
                        {'workingDirectory': str(root / 'legacy')},
                    ]}
                }]
            }), encoding='utf-8')

            self.assertEqual(trust.workspaces_from_channels(channels), sorted([
                str(root / 'legacy'),
                str(root / 'project' / 'Team' / 'Jack'),
            ]))

    def test_rejects_invalid_existing_toml_without_overwriting_it(self):
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            config = root / 'config.toml'
            config.write_text('[broken\n', encoding='utf-8')

            with self.assertRaisesRegex(RuntimeError, 'invalid Codex config'):
                trust.ensure_codex_workspace_trusted(root / 'Team' / 'Jack', config)
            self.assertEqual(config.read_text(encoding='utf-8'), '[broken\n')


if __name__ == '__main__':
    unittest.main()
