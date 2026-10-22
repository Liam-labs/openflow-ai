#!/usr/bin/env python3
"""Regression tests for the rm_guard PreToolUse hook."""

import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "hooks"))
sys.path.insert(0, str(ROOT / "scripts"))

import rm_guard  # noqa: E402
from agent_lifecycle_hooks import build_hooks  # noqa: E402


def rewritten(command):
    result = rm_guard.decide(command)
    if result is None:
        return None
    return result["hookSpecificOutput"].get("updatedInput", {}).get("command")


def denied(command):
    result = rm_guard.decide(command)
    return bool(result) and result["hookSpecificOutput"].get("permissionDecision") == "deny"


class RewriteTests(unittest.TestCase):
    def test_reported_command_gets_the_guard_claude_code_recommends(self):
        command = (
            "cd /x/Mobile; OUT=/home/z/.cache/c; rm -rf $OUT/*; "
            "EXPO_NO_DOTENV=1 npx expo export --output-dir $OUT 2>&1 | tail -1"
        )
        self.assertEqual(
            rewritten(command),
            "cd /x/Mobile; OUT=/home/z/.cache/c; rm -rf \"${OUT:?}\"/*; "
            "EXPO_NO_DOTENV=1 npx expo export --output-dir $OUT 2>&1 | tail -1",
        )

    def test_quoted_and_braced_forms(self):
        self.assertEqual(rewritten('rm -rf "$OUT"/*'), 'rm -rf "${OUT:?}"/*')
        self.assertEqual(rewritten('rm -rf "${OUT}/build"'), 'rm -rf "${OUT:?}/build"')
        self.assertEqual(rewritten("sudo rm -rf $T/a"), 'sudo rm -rf "${T:?}"/a')
        self.assertEqual(rewritten("timeout 60 rm -r $T"), 'timeout 60 rm -r "${T:?}"')

    def test_removal_inside_command_substitution(self):
        self.assertEqual(rewritten("X=$(rm -rf $D/y); echo ok"), 'X=$(rm -rf "${D:?}"/y); echo ok')

    def test_leaves_everything_else_alone(self):
        for command in (
            "rm -rf ${OUT:?}/x",        # already guarded
            "rm -rf $HOME/.cache/foo",  # guard would not help; Claude Code still decides
            "rm -f $1",                 # positional
            "echo $OUT; ls $OUT",       # not a removal
            "git rm --cached $F",       # rm is an argument, not the command
            "rm -rf /tmp/abc",
            "rm -rf dist/*",            # relative glob without a cd resolves statically
            "cd x && rm -rf old-*",     # partial glob resolves statically
        ):
            with self.subTest(command=command):
                self.assertIsNone(rm_guard.decide(command))

    def test_heredoc_body_is_data_not_a_command(self):
        command = "cat > s.sh <<'EOF'\nrm -rf $OUT/*\nEOF\nrm -rf $T"
        self.assertEqual(rewritten(command), "cat > s.sh <<'EOF'\nrm -rf $OUT/*\nEOF\nrm -rf \"${T:?}\"")

    def test_unparseable_input_passes_through(self):
        self.assertIsNone(rm_guard.decide('rm -rf "$OUT'))


class DenyTests(unittest.TestCase):
    def test_relative_star_after_cd_is_denied_with_instructions(self):
        for command in ("cd dist && rm -rf ./*", "cd build; rm -rf *", "cd a && rm -rf b/*"):
            with self.subTest(command=command):
                self.assertTrue(denied(command))
        reason = rm_guard.decide("cd dist && rm -rf ./*")["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn("absolute path", reason)


class HookProtocolTests(unittest.TestCase):
    def run_hook(self, payload):
        proc = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "hooks" / "rm_guard.py")],
            input=json.dumps(payload), capture_output=True, text=True, check=True,
        )
        return json.loads(proc.stdout) if proc.stdout.strip() else None

    def test_updated_input_keeps_other_bash_fields(self):
        out = self.run_hook({
            "tool_name": "Bash",
            "tool_input": {"command": "rm -rf $X/y", "description": "clean", "timeout": 5000},
        })
        self.assertEqual(out["hookSpecificOutput"]["updatedInput"], {
            "command": 'rm -rf "${X:?}"/y', "description": "clean", "timeout": 5000,
        })
        self.assertNotIn("permissionDecision", out["hookSpecificOutput"])

    def test_silent_for_other_tools_and_safe_commands(self):
        self.assertIsNone(self.run_hook({"tool_name": "Edit", "tool_input": {"command": "rm -rf $X"}}))
        self.assertIsNone(self.run_hook({"tool_name": "Bash", "tool_input": {"command": "ls"}}))


class PolicyTests(unittest.TestCase):
    def test_canonical_policy_installs_guard_after_design_gate(self):
        blocks = build_hooks("Test", Path("/tmp/Team/Test"))["PreToolUse"]
        self.assertIn("design_reference_gate.py", blocks[0]["hooks"][0]["command"])
        self.assertEqual(blocks[1]["matcher"], "Bash")
        self.assertTrue(blocks[1]["hooks"][0]["command"].endswith("/hooks/rm_guard.py"))


if __name__ == "__main__":
    unittest.main()
