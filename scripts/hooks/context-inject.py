#!/usr/bin/env python3
"""Deprecated no-op for legacy UserPromptSubmit configurations.

DevFlow now loads durable scaffolding at session start and keeps detailed state in
its journal, task, and sprint systems. Per-message behavioural reminders created
repetition, moving gates, and context noise, so wrappers and canonical settings no
longer invoke this script.

The file remains temporarily as a safe compatibility target for agent sessions
that have not yet reloaded their settings. It deliberately emits no context and
writes no counters or logs.
"""

raise SystemExit(0)
