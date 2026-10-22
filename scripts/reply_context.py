"""The reply line an agent is shown when a message answers an earlier one, in every runtime.

    (replying to Ada, message 1538c43d-d16e-4f24-9b27-57e40dd3b8cf: "first 80 characters...")

The full message id is what lets an agent quote the right message back: two messages can start with the same words, a name and
80 characters cannot tell them apart (seen in a live channel, 18 Oct 2026). The server side uses the identical rules in
lib/reply-context.ts; tests/fixtures/reply-context-vectors.json pins both to the same output.

Wrappers import this next to themselves and keep a short fallback with the old wording if a copy of a wrapper ever runs without it,
so a missing file can never stop an agent.
"""
import re

REPLY_PREVIEW_CHARS = 80
# Message ids are UUIDs or short tokens; anything else is not quoted rather than risking a broken line.
_SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")


def format_reply_context(reply_to):
    """'(replying to NAME, message ID: "start of the original...")', or '' when there is nothing to quote."""
    if not isinstance(reply_to, dict):
        return ""
    sender = reply_to.get("from")
    name = (sender.get("name") if isinstance(sender, dict) else sender) or "Unknown"
    preview = " ".join(str(reply_to.get("content") or "").split())[:REPLY_PREVIEW_CHARS]
    message_id = reply_to.get("id")
    message_id = message_id.strip() if isinstance(message_id, str) else ""
    who = f"{name}, message {message_id}" if _SAFE_ID.match(message_id) else str(name)
    return f'(replying to {who}: "{preview}...")'
