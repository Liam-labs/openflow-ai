#!/usr/bin/env python3
"""Small, dependency-free writer for wrapper-owned Agent Live View streams."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import uuid


def append_stream_message(
    agent_dir: str,
    stream_name: str,
    role: str,
    content: str,
    *,
    event_id: str | None = None,
) -> Path | None:
    """Append one normalized user/assistant message; never emit blank records."""
    if role not in {"user", "assistant", "system"}:
        raise ValueError(f"unsupported Agent Live View role: {role}")
    text = content.strip()
    if not text:
        return None

    output = Path(agent_dir) / stream_name
    output.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "type": role,
        "uuid": event_id or str(uuid.uuid4()),
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "message": {
            "role": role,
            "content": [{"type": "text", "text": text}],
        },
    }
    encoded = (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8")
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, encoded)
    finally:
        os.close(fd)
    return output


def safe_append_stream_message(*args, **kwargs) -> Path | None:
    """Best-effort wrapper: observability must never break message delivery."""
    try:
        return append_stream_message(*args, **kwargs)
    except Exception:
        return None
