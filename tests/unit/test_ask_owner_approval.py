"""ask_owner.py --approval: the first option becomes a Yes that approves one exact broker step."""
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("ask_owner", SCRIPTS / "ask_owner.py")
ask_owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ask_owner)


class ParseApprovalTests(unittest.TestCase):
    def test_accepts_an_action_with_args_and_key_names(self):
        out = ask_owner.parse_approval('{"action":"test-key","args":{"id":"deepseek"},"secretNames":["DEEPSEEK_API_KEY"]}')
        self.assertEqual(out, {"action": "test-key", "args": {"id": "deepseek"}, "secretNames": ["DEEPSEEK_API_KEY"]})

    def test_refuses_bad_json_a_missing_action_and_anything_that_is_not_a_key_name(self):
        for bad in ["not json", "[]", '{"args":{}}', '{"action":"  "}',
                    '{"action":"x","secretNames":["sk-live-abc123"]}', '{"action":"x","secretNames":"DEEPSEEK_API_KEY"}']:
            with self.assertRaises(ValueError, msg=bad):
                ask_owner.parse_approval(bad)


class MainTests(unittest.TestCase):
    def _run(self, argv):
        session = mock.Mock()
        session.channel_id = "c1"
        session.participant_id = "p-jack"
        session.display_name = "Jack"
        session.post.return_value = (True, {})
        with mock.patch.object(ask_owner.CollabSession, "load", return_value=session):
            code = ask_owner.main(argv)
        return code, session

    def test_attaches_the_approval_to_the_first_option_only(self):
        code, session = self._run(["--question", "Test your key?", "--option", "Yes", "--option", "No",
                                   "--approval", '{"action":"test-key","secretNames":["DEEPSEEK_API_KEY"]}'])
        self.assertEqual(code, 0)
        content = session.post.call_args[0][0]
        payload = session.post.call_args[1]["metadata"]["client"]["payload"]
        self.assertEqual(payload["options"][0]["approval"], {"action": "test-key", "secretNames": ["DEEPSEEK_API_KEY"]})
        self.assertNotIn("approval", payload["options"][1])
        self.assertIn("approves one step: test-key", content)

    def test_without_the_flag_nothing_changes(self):
        code, session = self._run(["--question", "Ok?", "--option", "Yes", "--option", "No"])
        self.assertEqual(code, 0)
        payload = session.post.call_args[1]["metadata"]["client"]["payload"]
        self.assertTrue(all("approval" not in o for o in payload["options"]))

    def test_a_bad_approval_posts_nothing(self):
        code, session = self._run(["--question", "Ok?", "--option", "Yes", "--approval", '{"action":"x","secretNames":["lowercase"]}'])
        self.assertEqual(code, 2)
        session.post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
