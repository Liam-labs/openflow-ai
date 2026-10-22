import importlib.util
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "collab_agent_submit_test",
    ROOT / "scripts" / "collab-agent.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class FakeChild:
    def __init__(self):
        self.sent = []

    def isalive(self):
        return True

    def send(self, value):
        self.sent.append(value)


def wrapper(agent_type: str, output_buffer: str):
    instance = object.__new__(MODULE.CollabAgentWrapper)
    instance.child = FakeChild()
    instance.agent_type = agent_type
    instance.output_buffer = output_buffer
    instance.last_injection_time = 0
    instance.is_busy = False
    return instance


def test_gemini_multiline_prompt_is_submitted_once():
    instance = wrapper("gemini", "")
    with patch.object(MODULE.time, "sleep"):
        assert instance.inject_message_immediate("Builder", "large\ncanary") is True
    assert instance.child.sent == [
        "[Channel message from Builder]: large\ncanary",
        "\r",
    ]


def test_gemini_without_paste_confirmation_and_other_runtimes_submit_once():
    for agent_type in ("gemini", "claude"):
        instance = wrapper(agent_type, "> ")
        with patch.object(MODULE.time, "sleep"):
            assert instance.inject_message_immediate("Builder", "short canary") is True
        assert instance.child.sent == [
            "[Channel message from Builder]: short canary",
            "\r",
        ]


def test_startup_join_begins_before_the_blocking_interact_loop():
    source = (ROOT / "scripts" / "collab-agent.py").read_text(encoding="utf-8")
    run_section = source[source.index("# Start the initial channel join in parallel"):]
    assert run_section.index("startup_join_thread.start()") < run_section.index('debug("Starting interact()")')
    assert "start_channel_join(self.channel_id, self.channel_name)" in run_section
