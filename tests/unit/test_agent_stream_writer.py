import json
from pathlib import Path

from scripts.agent_stream_writer import append_stream_message


def test_append_stream_message_writes_drawer_compatible_jsonl(tmp_path: Path):
    output = append_stream_message(
        str(tmp_path),
        ".hermes-stream.jsonl",
        "assistant",
        "Implemented.\n\n- 12 tests passed",
        event_id="turn-1-response",
    )

    assert output == tmp_path / ".hermes-stream.jsonl"
    record = json.loads(output.read_text().strip())
    assert record["type"] == "assistant"
    assert record["uuid"] == "turn-1-response"
    assert record["message"] == {
        "role": "assistant",
        "content": [{"type": "text", "text": "Implemented.\n\n- 12 tests passed"}],
    }
    assert record["timestamp"].endswith("Z")


def test_append_stream_message_ignores_empty_content(tmp_path: Path):
    output = append_stream_message(
        str(tmp_path), ".grok-stream.jsonl", "user", "   "
    )

    assert output is None
    assert not (tmp_path / ".grok-stream.jsonl").exists()


def test_append_stream_message_preserves_existing_turns(tmp_path: Path):
    append_stream_message(str(tmp_path), ".grok-stream.jsonl", "user", "First")
    append_stream_message(
        str(tmp_path), ".grok-stream.jsonl", "assistant", "Second"
    )

    lines = (tmp_path / ".grok-stream.jsonl").read_text().splitlines()
    assert [json.loads(line)["type"] for line in lines] == ["user", "assistant"]
