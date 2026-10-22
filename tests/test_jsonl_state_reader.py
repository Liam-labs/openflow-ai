"""Tests for jsonl_state_reader.resolve_transcript_path — Sprint 56 follow-up.

The original implementation only read .session-scratch/transcript-path. Any
agent whose SessionStart hook hasn't written that file (unscaffolded agent
directory, stopped-and-never-restarted agent) silently gets None back and
Plan Mode auto-accept never runs. Fallback: glob the Claude Code projects
directory for the matching project-key and return the most-recently-modified
JSONL.
"""

import os
import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))

from jsonl_state_reader import resolve_transcript_path


class TestResolveTranscriptPathPrimary(unittest.TestCase):
    """Primary path: .session-scratch/transcript-path exists and is valid."""

    def test_reads_path_from_scratch_file(self):
        with TemporaryDirectory() as cwd:
            scratch = Path(cwd) / '.session-scratch'
            scratch.mkdir()
            transcript = Path(cwd) / 'some.jsonl'
            transcript.write_text('{}\n')
            (scratch / 'transcript-path').write_text(f'{transcript}\n')
            self.assertEqual(resolve_transcript_path(cwd), str(transcript))

    def test_empty_scratch_file_returns_none(self):
        with TemporaryDirectory() as cwd:
            scratch = Path(cwd) / '.session-scratch'
            scratch.mkdir()
            (scratch / 'transcript-path').write_text('')
            # Empty → treat as missing → fall through to fallback → None (no project dir)
            with patch.dict(os.environ, {'HOME': cwd}):
                self.assertIsNone(resolve_transcript_path(cwd))


class TestResolveTranscriptPathFallback(unittest.TestCase):
    """Fallback path: scratch file missing → glob ~/.claude/projects/<key>/*.jsonl."""

    def _project_key_for(self, cwd: str) -> str:
        return '-' + cwd.lstrip('/').replace('/', '-')

    def test_missing_scratch_falls_back_to_newest_jsonl(self):
        with TemporaryDirectory() as home:
            # cwd has no .session-scratch/transcript-path
            cwd = os.path.join(home, 'fake-agent-dir')
            os.makedirs(cwd)
            # Create matching project dir under fake HOME
            project_key = self._project_key_for(cwd)
            project_dir = Path(home) / '.claude' / 'projects' / project_key
            project_dir.mkdir(parents=True)
            # Two JSONLs, newer should win
            old = project_dir / 'old.jsonl'
            new = project_dir / 'new.jsonl'
            old.write_text('{}\n')
            time.sleep(0.02)
            new.write_text('{}\n')
            # Make mtimes explicit (don't rely on tmpfs resolution)
            os.utime(old, (1, 1))
            os.utime(new, (2, 2))
            with patch.dict(os.environ, {'HOME': home}):
                result = resolve_transcript_path(cwd)
            self.assertEqual(result, str(new))

    def test_missing_scratch_and_no_project_dir_returns_none(self):
        with TemporaryDirectory() as home:
            cwd = os.path.join(home, 'unscaffolded-and-unknown')
            os.makedirs(cwd)
            # No project dir anywhere under HOME
            with patch.dict(os.environ, {'HOME': home}):
                self.assertIsNone(resolve_transcript_path(cwd))

    def test_missing_scratch_but_project_dir_empty_returns_none(self):
        with TemporaryDirectory() as home:
            cwd = os.path.join(home, 'empty-project-agent')
            os.makedirs(cwd)
            project_key = self._project_key_for(cwd)
            (Path(home) / '.claude' / 'projects' / project_key).mkdir(parents=True)
            with patch.dict(os.environ, {'HOME': home}):
                self.assertIsNone(resolve_transcript_path(cwd))

    def test_scratch_file_wins_over_fallback_when_both_exist(self):
        """When scratch file is present AND valid, primary path wins — never glob."""
        with TemporaryDirectory() as home:
            cwd = os.path.join(home, 'fully-scaffolded')
            os.makedirs(cwd)
            scratch = Path(cwd) / '.session-scratch'
            scratch.mkdir()
            canonical = Path(cwd) / 'canonical.jsonl'
            canonical.write_text('{}\n')
            (scratch / 'transcript-path').write_text(f'{canonical}\n')
            # Also create a fallback candidate that would "win" if glob ran
            project_key = self._project_key_for(cwd)
            project_dir = Path(home) / '.claude' / 'projects' / project_key
            project_dir.mkdir(parents=True)
            (project_dir / 'would-beat-explicit.jsonl').write_text('{}\n')
            with patch.dict(os.environ, {'HOME': home}):
                self.assertEqual(
                    resolve_transcript_path(cwd),
                    str(canonical),
                )


if __name__ == '__main__':
    unittest.main()
