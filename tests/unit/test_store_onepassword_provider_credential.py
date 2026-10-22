import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "store_onepassword_provider_credential.py"
SPEC = importlib.util.spec_from_file_location("store_onepassword_provider_credential", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProviderCredentialScriptTests(unittest.TestCase):
    def test_template_marks_every_secret_field_concealed(self):
        template = MODULE.build_template(
            ["access token", "app secret"],
            ["synthetic-token", "synthetic-app-secret"],
            "user@example.com",
            "WhatsApp API credential for Acme Media.",
            "https://developers.facebook.com/",
        )
        secret_fields = [field for field in template["fields"] if field["type"] == "CONCEALED"]
        self.assertEqual([field["label"] for field in secret_fields], ["access token", "app secret"])
        self.assertEqual(template["category"], "API_CREDENTIAL")

    def test_config_must_be_private_regular_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps({"token": "x" * 30, "vault": "DevFlow Automation"}))
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "mode 0600"):
                MODULE.load_config(path)
            path.chmod(0o600)
            self.assertEqual(MODULE.load_config(path), ("x" * 30, "DevFlow Automation"))

    def test_run_op_passes_secret_template_on_stdin_not_argv(self):
        completed = mock.Mock(returncode=0, stdout='{"id":"item-1"}', stderr="")
        with mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run:
            result = MODULE.run_op(
                Path("/example/op"),
                ["item", "create", "-", "--title", "Meta API"],
                "service-account-token",
                stdin='{"credential":"synthetic-secret"}',
            )
        self.assertEqual(result["id"], "item-1")
        argv = run.call_args.args[0]
        self.assertNotIn("synthetic-secret", " ".join(argv))
        self.assertEqual(run.call_args.kwargs["input"], '{"credential":"synthetic-secret"}')
        self.assertEqual(run.call_args.kwargs["env"]["OP_SERVICE_ACCOUNT_TOKEN"], "service-account-token")

    def test_idempotency_tag_is_stable_and_does_not_contain_key(self):
        first = MODULE.idempotency_tag("whatsapp-create-20260906")
        second = MODULE.idempotency_tag("whatsapp-create-20260906")
        self.assertEqual(first, second)
        self.assertNotIn("whatsapp", first)
        self.assertRegex(first, r"^devflow-onboarding-[0-9a-f]{20}$")


if __name__ == "__main__":
    unittest.main()
