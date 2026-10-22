#!/usr/bin/env python3
"""
ask_owner.py — T1.2: cross-model helper to post a structured question to the owner.

Any agent (any model family) can shell out to this to ask the owner a question that
renders as clickable answer buttons + an "Other" free-text option in AgentChat,
instead of forcing a typed reply. The "Other" path is ALWAYS injected
(allowOther=true) — that is the helper's guarantee.

The question rides on the existing channel message flow as metadata.client:
    { kind: "ask-owner.question", payload: <StructuredQuestion> }
matching lib/ask-owner/types.ts (the locked T1.1 contract). The server records it
(T1.3) so the owner's answer routes back to THIS agent's inbox.

Usage:
    python3 ask_owner.py --question "Which DB should we use?" \
        --option "PostgreSQL|Relational, strong consistency" \
        --option "Redis|In-memory, fast" \
        [--header "Database"] [--multiselect] [--channel <id>]

Channel + participant are resolved from the collab session file exactly as
collab_helper.py does — just run it from inside an agent session. On success it
prints the questionId (for correlation) and exits 0.
"""

import argparse
import os
import re
import sys
import uuid
from datetime import datetime, timezone

from collab_helper import CollabSession

# Who the owner is is configuration, not code (unset: neutral wording).
OWNER_PROSE = os.environ.get("DEVFLOW_OWNER_NAME", "").strip() or "the owner"

# Mirrors lib/ask-owner/types.ts — keep in sync with the locked contract.
ASK_OWNER_QUESTION_KIND = "ask-owner.question"
MAX_OPTIONS = 4
HEADER_MAX = 12  # chip cap (<=12 chars), matches StructuredQuestion.header


def slugify_option_id(label: str) -> str:
    """label → url-ish slug. Mirrors capture.ts slugifyOptionId so ids match the
    Claude AskUserQuestion capture path."""
    s = re.sub(r"[^a-z0-9]+", "-", label.lower())
    return re.sub(r"^-+|-+$", "", s)


def build_options(raw_options):
    """Parse 'Label' or 'Label|Description' entries into AskOwnerOption[] with
    unique slug ids. Caps at MAX_OPTIONS. Skips blank labels. Never emits an
    "Other" entry — Other is driven separately by allowOther."""
    used = set()
    out = []
    for raw in raw_options[:MAX_OPTIONS]:
        parts = raw.split("|", 1)
        label = parts[0].strip()
        if not label:
            continue
        desc = parts[1].strip() if len(parts) > 1 else ""
        base = slugify_option_id(label) or "option"
        oid = base
        n = 1
        while oid in used:
            n += 1
            oid = f"{base}-{n}"
        used.add(oid)
        opt = {"id": oid, "label": label}
        if desc:
            opt["description"] = desc
        out.append(opt)
    return out


def build_structured_question(question_text, options, asked_by, channel_id,
                              header=None, multi_select=False,
                              now=None, qid=None):
    """Construct a StructuredQuestion (lib/ask-owner/types.ts). allowOther is
    ALWAYS True. `now`/`qid` are injectable for deterministic tests."""
    q = {
        "id": qid or str(uuid.uuid4()),
        "questionText": question_text,
        "options": build_options(options),
        "allowOther": True,                 # the helper's guarantee
        "multiSelect": bool(multi_select),
        "askedBy": asked_by,
        "channelId": channel_id,
        "status": "pending",
        "answer": None,
        "createdAt": now or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    header = (header or "").strip()
    if header:
        q["header"] = header[:HEADER_MAX]
    return q


def render_fallback_content(q):
    """Plain-text fallback so non-card contexts (logs, terminal-only agents) still
    convey the question. The card UI renders from metadata.client.payload, not this."""
    lines = [f'Question for {OWNER_PROSE}: {q["questionText"]}']
    for i, opt in enumerate(q["options"], 1):
        line = f'  {i}. {opt["label"]}'
        if opt.get("description"):
            line += f' — {opt["description"]}'
        lines.append(line)
    lines.append('  …or choose "Other" to type a custom answer.')
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="ask_owner.py",
        description="Post a structured question to the owner (Ask-Owner). Always injects an Other option.",
    )
    parser.add_argument("--question", required=True, help="The question text.")
    parser.add_argument("--option", action="append", default=[], dest="options",
                        help='Answer choice: "Label" or "Label|Description". Repeatable (1-4).')
    parser.add_argument("--header", default=None, help="Short chip/header (<=12 chars).")
    parser.add_argument("--multiselect", action="store_true", help="Allow multiple selections.")
    parser.add_argument("--channel", default=None, help="Override channelId (default: from session).")
    args = parser.parse_args(argv)

    if not args.options:
        print("error: at least one --option is required (Other is added automatically)", file=sys.stderr)
        return 2

    session = CollabSession.load()
    if not session:
        print("error: no collab session found — run from inside an agent session", file=sys.stderr)
        return 1

    channel_id = args.channel or session.channel_id
    asked_by = {"participantId": session.participant_id, "name": session.display_name}

    question = build_structured_question(
        args.question, args.options, asked_by, channel_id,
        header=args.header, multi_select=args.multiselect,
    )

    metadata = {"client": {"kind": ASK_OWNER_QUESTION_KIND, "payload": question}}
    ok, result = session.post(
        render_fallback_content(question),
        save_on_rejoin=(args.channel is None),
        metadata=metadata,
    )
    if ok:
        print(question["id"])   # questionId for the agent to correlate the answer
        return 0
    print(f"error: failed to post question: {result}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
