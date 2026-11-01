"""Executable discovery for container and native Codex installations."""
import importlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
wrapper = importlib.import_module('collab-codex')


class CodexBinaryTests(unittest.TestCase):
    def test_resolves_executable_in_container_style_path_without_nvm(self):
        with tempfile.TemporaryDirectory() as root:
            binary = Path(root) / 'codex'
            binary.write_text('#!/bin/sh\nexit 0\n')
            binary.chmod(0o755)
            with patch.object(wrapper, 'search_path', return_value=root):
                self.assertEqual(wrapper.find_codex_binary(), str(binary))

    def test_ignores_non_executable_and_uses_next_installation(self):
        with tempfile.TemporaryDirectory() as root:
            first, second = Path(root) / 'first', Path(root) / 'second'
            first.mkdir(); second.mkdir()
            (first / 'codex').write_text('not executable')
            binary = second / 'codex'
            binary.write_text('#!/bin/sh\nexit 0\n'); binary.chmod(0o755)
            with patch.object(wrapper, 'search_path', return_value=os.pathsep.join([str(first), str(second)])):
                self.assertEqual(wrapper.find_codex_binary(), str(binary))

    def test_missing_binary_returns_none(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(wrapper, 'search_path', return_value=root):
                self.assertIsNone(wrapper.find_codex_binary())


if __name__ == '__main__':
    unittest.main()
