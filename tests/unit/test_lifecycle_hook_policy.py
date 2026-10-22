#!/usr/bin/env python3
"""Regression tests for lifecycle hook configuration and wrapper parity."""

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


def load_patch_hooks():
    path = ROOT / "scripts" / "patch-hooks.py"
    spec = importlib.util.spec_from_file_location("devflow_patch_hooks", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class LifecycleHookConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.patch_hooks = load_patch_hooks()

    def test_canonical_stop_flushes_only_and_precompact_owns_ordering(self):
        hooks = self.patch_hooks.build_hooks("Test", Path("/tmp/Team/Test"))
        stop_commands = [
            hook["command"]
            for block in hooks["Stop"]
            for hook in block["hooks"]
        ]
        precompact_commands = [
            hook["command"]
            for block in hooks["PreCompact"]
            for hook in block["hooks"]
        ]

        self.assertEqual(len(stop_commands), 1)
        self.assertIn("/hooks/flush.sh Test /tmp/Team/Test all", stop_commands[0])
        self.assertNotIn("write-session-end.sh", stop_commands[0])
        self.assertEqual(len(precompact_commands), 1)
        self.assertIn("pre-compact-write.sh", precompact_commands[0])

    def test_migration_removes_legacy_writers_but_preserves_safety_hooks(self):
        current = {
            "PreToolUse": [{
                "matcher": "Bash",
                "hooks": [{"type": "command", "command": "safety-gate --check"}],
            }],
            "PreCompact": [{"hooks": [
                {"type": "command", "command": "bash /old/hooks/flush.sh Test /tmp/Team/Test all"},
                {"type": "command", "command": "bash /old/hooks/pre-compact-write.sh Test /tmp/Team/Test"},
            ]}],
            "Stop": [{"hooks": [
                {"type": "command", "command": "bash /old/write-session-end.sh Test /tmp/Team/Test"},
                {"type": "command", "command": "safety-stop --preserve"},
                {"type": "prompt", "prompt": "Write a mandatory log before stopping"},
            ]}],
        }
        required = self.patch_hooks.build_hooks("Test", Path("/tmp/Team/Test"))

        merged = self.patch_hooks.merge_session_hooks(current, required)
        all_commands = [
            hook["command"]
            for blocks in merged.values()
            for block in blocks
            for hook in block.get("hooks", [])
        ]

        self.assertIn("safety-gate --check", all_commands)
        self.assertIn("safety-stop --preserve", all_commands)
        self.assertFalse(any("write-session-end.sh" in cmd for cmd in all_commands))
        self.assertEqual(sum("/hooks/flush.sh" in cmd for cmd in all_commands), 1)
        self.assertFalse(any(
            hook.get("type") == "prompt"
            for blocks in merged.values()
            for block in blocks
            for hook in block.get("hooks", [])
        ))

    def test_migration_removes_known_behaviour_only_and_keeps_unknown_submit_completion_safety(self):
        current = {
            "UserPromptSubmit": [{"hooks": [
                {"type": "command", "command": "bash /old/check-rotate.sh Test /tmp/Team/Test"},
                {"type": "command", "command": "submit-safety --validate"},
            ]}],
            "TaskCompleted": [{"hooks": [
                {"type": "command", "command": "bash /old/verify-task-complete.sh Test /tmp/Team/Test"},
                {"type": "command", "command": "completion-safety --validate"},
            ]}],
        }

        cleaned = self.patch_hooks.remove_behavioural_hooks(current)
        commands = [
            hook["command"]
            for blocks in cleaned.values()
            for block in blocks
            for hook in block["hooks"]
        ]

        self.assertNotIn("bash /old/check-rotate.sh Test /tmp/Team/Test", commands)
        self.assertNotIn("bash /old/verify-task-complete.sh Test /tmp/Team/Test", commands)
        self.assertIn("submit-safety --validate", commands)
        self.assertIn("completion-safety --validate", commands)

    def test_filesystem_discovery_includes_dormant_team_workspace(self):
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as temp:
            root = Path(temp)
            dormant = root / "Project" / "Team" / "Dormant"
            settings = dormant / ".claude" / "settings.json"
            settings.parent.mkdir(parents=True)
            settings.write_text("{}")

            discovered = self.patch_hooks.discover_filesystem_dirs(root)

            self.assertIn(("Dormant", dormant), discovered)

    def test_workspace_mode_creates_canonical_settings_for_spawn(self):
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as temp:
            workspace = Path(temp) / "Team" / "Dormant"
            result = self.patch_hooks.patch_agent(
                "Dormant", workspace, create_if_missing=True,
            )

            settings = workspace / ".claude" / "settings.json"
            self.assertTrue(result.startswith("PATCH"))
            self.assertTrue(settings.is_file())
            self.assertIn("PreCompact", settings.read_text())

    def test_symlink_alias_converges_on_physical_workspace_hooks(self):
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as temp:
            team = Path(temp) / "Team"
            physical = team / "Riley"
            physical.mkdir(parents=True)
            alias = team / "CJack"
            alias.symlink_to(physical, target_is_directory=True)

            first = self.patch_hooks.patch_agent(
                "CJack", alias, create_if_missing=True,
            )
            second = self.patch_hooks.patch_agent("Riley", physical)
            content = (physical / ".claude" / "settings.json").read_text()

            self.assertTrue(first.startswith("PATCH"))
            self.assertTrue(second.startswith("NOOP"))
            self.assertIn(str(physical), content)
            self.assertNotIn(str(alias), content)

    def test_gemini_and_grok_wrappers_use_flush_without_session_markers(self):
        for relative in (
            "scripts/collab-gemini.py",
            "scripts/collab-grok.py",
            "scripts/collab-grok-acp.py",
        ):
            source = (ROOT / relative).read_text(encoding="utf-8")
            self.assertNotIn("write-session-end.sh", source, relative)
            self.assertNotIn("Grok ACP session ended", source, relative)
            self.assertNotIn("Grok session ended", source, relative)
            self.assertNotIn("Gemini session ended", source, relative)
            self.assertIn('"flush.sh"', source, relative)
            self.assertIn('hook_name="Stop-flush"', source, relative)

        acp_source = (ROOT / "scripts/collab-grok-acp.py").read_text(encoding="utf-8")
        self.assertNotIn('os.path.join(hooks_dir, "session-end.sh")', acp_source)


if __name__ == "__main__":
    unittest.main()
