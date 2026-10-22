"""Scaffolding adapter layer — per-model scaffolding strategy classes.

One adapter per model family. Each adapter encodes the answers to:

  - **Which harness am I responsible for?**  (matches conditions such as
    agentType:gemini or agentType:antigravity; provider/model is separate.)
  - **Does the model load `.claude/rules/` natively** (Claude, DeepSeek) or
    via @-imports inside an entry-point file like GEMINI.md / GROK.md /
    AGENTS.md? (entry_template_id + required_imports)
  - **Who manages the agent's hooks** — native settings.json (Claude,
    DeepSeek) or hardcoded wrapper subprocess calls (Antigravity, Codex)
    or no general hooks at all (Gemini, Grok)? (settings_managed_by_wrapper
    + hook_coverage_level)

The audit at docs/scaffolding-audit-matrix.md §6 specified this design.
The headline fix is `ensure_imports()` — sync.py post-processes per-model
entry-point templates so that every required global @-import is present,
even if the master template forgot to declare it. That eliminates the
silent-failure mode where alignment-gemini.md lands on disk but never
loads (§2.1) and the parallel Grok/Codex template-import gaps (§2.2).

The function is idempotent: running sync.py twice in a row produces a
byte-identical entry-point file the second time. The verifier
(sync.py --verify-only) shares the same post-processor, so verify never
reports drift caused by the injection itself.

NOTE: this module is pure — no file I/O. It operates on agent dicts and
manifest entries already loaded by sync.py. Apart from class instantiation
(cheap), the only work is string manipulation. Adapters can be unit-tested
in isolation by passing synthesized agent dicts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

# =============================================================================
# Canonical import lists
# =============================================================================

#: The globals that every non-Claude entry-point template should @-import so
#: the model actually loads them at session start. Order matches the cache-
#: friendly grouping the existing Gemini template uses: identity first,
#: workspace/startup next, then the compact operating agreement and safety
#: boundary. Specialist engineering guidance remains available as skills and
#: tiny routing stubs; it is not repeated in every non-Claude entry point.
STANDARD_GLOBAL_IMPORTS: list[str] = [
    "@./.claude/rules/Personality.md",
    "@./.claude/rules/Directives.md",
    "@./.claude/rules/Workspace.md",
    "@./.claude/rules/startup.md",
    "@./.claude/rules/user-profile.md",
    "@./.claude/rules/base-role-boilerplate.md",
    "@./.claude/rules/channel-communication.md",
    "@./.claude/rules/DEVFLOW.md",
    "@./.claude/rules/rag-memory.md",
    "@./.claude/rules/approval-protocol.md",
    "@./.claude/rules/skill-index.md",
]

#: Marker line existing templates use to demarcate cacheable (above) from
#: dynamic (below) content. We always inject @-imports BEFORE this marker so
#: they sit in the cacheable region. If the marker is absent we append to a
#: new block separated by a comment.
DYNAMIC_BOUNDARY = "<!-- SYSTEM_PROMPT_DYNAMIC_BOUNDARY -->"

#: Comment line we add when we have to inject our own import block (no
#: existing imports in the template). Lets later humans/agents see what
#: happened and where to add manual entries.
AUTO_IMPORTS_HEADER = "<!-- Auto-injected global imports (managed by data/scaffolding/adapters.py) -->"


# =============================================================================
# Helper — the load-bearing post-processor
# =============================================================================

# Matches any line that looks like `@./path/something.md` (single token).
# We use this to find existing imports so we can place new ones near them
# and not duplicate.
_IMPORT_LINE_RE = re.compile(r"^\s*@\S+\s*$")


def ensure_imports(rendered: str, required_imports: Iterable[str]) -> str:
    """Idempotently ensure each required @-import line is present in `rendered`.

    The function:
      1. Skips imports already present (matched by exact line content, after
         stripping surrounding whitespace).
      2. For missing imports, inserts them BEFORE the SYSTEM_PROMPT_DYNAMIC_BOUNDARY
         marker if it exists — that keeps the dynamic boundary semantics
         intact. Imports land in the same cacheable region as existing ones.
      3. If no boundary marker exists, appends a new section near the end
         (after any trailing newlines), preceded by AUTO_IMPORTS_HEADER so
         the addition is human-debuggable.
      4. Returns a byte-identical result on a second pass — no duplicates.
    """
    required = list(required_imports)
    if not required:
        return rendered

    # Build a set of normalized existing import targets for fast membership
    # test. Normalize: strip whitespace, drop trailing slashes — the exact
    # form we want to match is the body after `@`.
    existing_imports: set[str] = set()
    for line in rendered.splitlines():
        stripped = line.strip()
        if _IMPORT_LINE_RE.match(stripped):
            existing_imports.add(stripped)

    missing = [imp for imp in required if imp.strip() not in existing_imports]
    if not missing:
        # Already satisfied — return unchanged (cache-friendly, no churn)
        return rendered

    inject_block = "\n".join(missing)

    if DYNAMIC_BOUNDARY in rendered:
        # Place injected imports immediately before the boundary, separated
        # by a blank line for readability. If the previous line is already
        # blank we don't add another.
        before, _, after = rendered.partition(DYNAMIC_BOUNDARY)
        # Trim trailing whitespace/newlines from `before` so we control spacing
        before_clean = before.rstrip()
        # Compose: existing-cacheable + 1 blank line + missing imports + 1 blank + boundary
        new_text = (
            f"{before_clean}\n\n"
            f"{AUTO_IMPORTS_HEADER}\n"
            f"{inject_block}\n\n"
            f"{DYNAMIC_BOUNDARY}{after}"
        )
        return new_text

    # No boundary marker — append to end. Preserve trailing newline if present.
    trailing_nl = "\n" if rendered.endswith("\n") else ""
    body = rendered.rstrip("\n")
    return (
        f"{body}\n\n"
        f"{AUTO_IMPORTS_HEADER}\n"
        f"{inject_block}\n"
        f"{trailing_nl}"
    )


# =============================================================================
# Adapter classes
# =============================================================================

@dataclass
class ScaffoldingAdapter:
    """One scaffolding strategy class per model family.

    Concrete subclasses set the class-level fields; behaviour is shared via
    instance methods. The class can be used either as a singleton (one per
    family) or instantiated per-agent — there's no mutable state.
    """

    #: Short identifier — 'claude', 'gemini', 'grok', 'codex', 'antigravity',
    #: 'deepseek', 'gpt'. Used for logging + roster reporting.
    family: str = "unknown"

    #: Manifest condition strings this adapter is responsible for.
    #: An agent matches the adapter if ANY of these conditions is true for it.
    matches_conditions: tuple[str, ...] = ()

    #: Manifest entry id of the entry-point file the model loads at boot
    #: (e.g. 'gemini-md' → per-model/gemini/GEMINI.md.tmpl). When the model
    #: loads `.claude/rules/` natively (Claude, DeepSeek) this is None.
    entry_template_id: str | None = None

    #: True iff the model's lifecycle hooks are wired by a wrapper script
    #: rather than .claude/settings.json. Used by the X-Ray panel to flag
    #: hook visibility expectations.
    settings_managed_by_wrapper: bool = False

    #: Hook lifecycle coverage level — 'full' (Claude/DeepSeek native +
    #: Antigravity/Codex wrapper subprocess), 'log-only' (Gemini/Grok
    #: hardcoded session-end flush only), 'none' (GPT or any wrapper that
    #: doesn't invoke any hook scripts).
    hook_coverage_level: str = "none"

    #: Filename of the per-model alignment file expected to live at the
    #: agent root. None if no per-model alignment exists for this family.
    alignment_filename: str | None = None

    def matches(self, agent: dict, agent_matches_condition_fn, known_models: set[str] | None = None) -> bool:
        """True iff this adapter applies to the given agent.

        Caller supplies `agent_matches_condition_fn` (the existing sync.py
        helper) — keeps this module fully decoupled from sync.py imports.

        Adapter conditions are defined in code, not the manifest, so they are
        not validated against models.json (None disables that check).
        `known_models` is accepted for call-site compatibility only.
        """
        for cond in self.matches_conditions:
            if agent_matches_condition_fn(agent, cond, None):
                return True
        return False

    def required_imports(self) -> list[str]:
        """Globals + alignment file the entry-point template must @-import.

        Default = STANDARD_GLOBAL_IMPORTS + the per-model alignment file
        (if any). Override for adapters that need extra/fewer imports.
        """
        base = list(STANDARD_GLOBAL_IMPORTS)
        if self.alignment_filename:
            base.append(f"@./{self.alignment_filename}")
        return base

    def inject_imports(self, rendered: str) -> str:
        """Apply ensure_imports() with this adapter's required_imports."""
        return ensure_imports(rendered, self.required_imports())

    def info(self) -> dict:
        """Diagnostic summary — used by `sync.py --adapters` and the X-Ray."""
        return {
            "family": self.family,
            "matches_conditions": list(self.matches_conditions),
            "entry_template_id": self.entry_template_id,
            "settings_managed_by_wrapper": self.settings_managed_by_wrapper,
            "hook_coverage_level": self.hook_coverage_level,
            "alignment_filename": self.alignment_filename,
            "required_import_count": len(self.required_imports()),
        }


# -----------------------------------------------------------------------------
# Concrete adapters — one per model family
# -----------------------------------------------------------------------------


class ClaudeAdapter(ScaffoldingAdapter):
    """Claude uses session-bound native hooks; no per-message behaviour hooks."""
    def __init__(self) -> None:
        super().__init__(
            family="claude",
            matches_conditions=("agentType:claude",),
            # Claude scans `.claude/rules/` at boot natively — no entry-point file
            # needs to import them. CLAUDE.md is generated by rollout-agent-dirs.py
            # one-shot; not sync-managed.
            entry_template_id=None,
            settings_managed_by_wrapper=False,  # native settings.json
            hook_coverage_level="full",  # full supported session lifecycle by policy
            alignment_filename=None,  # alignment-claude.md is deployed to ~/.claude/rules
        )

    def required_imports(self) -> list[str]:
        # Claude doesn't need @-imports — it reads .claude/rules/ directly.
        return []


class DeepSeekAdapter(ScaffoldingAdapter):
    """8 agents — currently inherits Claude scaffolding by running on the
    Claude CLI. No dedicated alignment file yet (audit §2.3 flagged this
    as a follow-up — alignment-deepseek.md doesn't exist)."""
    def __init__(self) -> None:
        super().__init__(
            family="deepseek",
            matches_conditions=("model:deepseek",),
            entry_template_id=None,
            settings_managed_by_wrapper=False,
            hook_coverage_level="full",
            alignment_filename=None,
        )

    def required_imports(self) -> list[str]:
        return []


class GeminiAdapter(ScaffoldingAdapter):
    """4 agents — GEMINI.md.tmpl is the entry-point template.

    Audit §2.1: previously, alignment-gemini.md landed on disk but the
    template never imported it. This adapter's `required_imports()`
    includes the alignment file so the auto-injector ensures it's
    present. Fixes the silent-failure bug.
    """
    def __init__(self) -> None:
        super().__init__(
            family="gemini",
            matches_conditions=("agentType:gemini",),
            entry_template_id="gemini-md",
            settings_managed_by_wrapper=True,
            hook_coverage_level="full",  # session lifecycle; no per-message hooks by policy
            alignment_filename="alignment-gemini.md",
        )


class GrokAdapter(ScaffoldingAdapter):
    """4 agents — compact shared globals plus Grok-specific alignment."""
    def __init__(self) -> None:
        super().__init__(
            family="grok",
            matches_conditions=("agentType:grok",),
            entry_template_id="grok-md",
            settings_managed_by_wrapper=True,
            hook_coverage_level="full",  # session lifecycle; no per-message hooks by policy
            alignment_filename="alignment-grok.md",
        )


class CodexAdapter(ScaffoldingAdapter):
    """Codex loads durable rules at startup and records session-end state.

    UserPromptSubmit context injection is intentionally disabled: behavioural
    reminders belong in the durable scaffold, not in every channel turn.
    """
    def __init__(self) -> None:
        super().__init__(
            family="codex",
            matches_conditions=("agentType:codex",),
            entry_template_id="agents-md",
            settings_managed_by_wrapper=True,
            hook_coverage_level="full",  # full supported session lifecycle by policy
            alignment_filename="alignment-codex.md",
        )


class AntigravityAdapter(ScaffoldingAdapter):
    """Antigravity uses startup/stop continuity without per-message reminders."""
    def __init__(self) -> None:
        super().__init__(
            family="antigravity",
            matches_conditions=("agentType:antigravity",),
            entry_template_id="antigravity-gemini-md",
            settings_managed_by_wrapper=True,
            hook_coverage_level="full",  # full supported session lifecycle by policy
            alignment_filename="alignment-antigravity.md",
        )


class GptAdapter(ScaffoldingAdapter):
    """Placeholder for any agents declared with `models: ['gpt']` in
    agents.json. No live agent does today — the only fleet GPT model
    (Heimdall on gpt-5.4 at the roster level) is declared with claude/gemini/codex
    in scaffolding, so OpenAI runtime is opaque to the manifest.

    Adapter kept so future GPT-wrappered agents have a strategy slot.
    Match condition narrowed to `model:gpt` (no version suffix) so
    sync.py doesn't warn about unknown `model:gpt-5.4` — versioned IDs
    aren't valid manifest conditions today.
    """
    def __init__(self) -> None:
        super().__init__(
            family="gpt",
            matches_conditions=("model:gpt",),
            entry_template_id=None,
            settings_managed_by_wrapper=True,
            hook_coverage_level="none",
            alignment_filename=None,
        )

    def required_imports(self) -> list[str]:
        return []


# =============================================================================
# Registry — single source of truth for which adapters exist
# =============================================================================

#: Order matters for `select_adapters_for(agent)` — earlier adapters take
#: precedence when an agent has multiple matching conditions (rare but
#: possible: a Gemini agent that's also tagged agentType:antigravity).
ADAPTER_REGISTRY: list[ScaffoldingAdapter] = [
    AntigravityAdapter(),  # agentType beats model — check this first
    GeminiAdapter(),
    GrokAdapter(),
    CodexAdapter(),
    DeepSeekAdapter(),
    ClaudeAdapter(),
    GptAdapter(),
]


def select_adapters_for(agent: dict, agent_matches_condition_fn,
                         known_models: set[str] | None = None) -> list[ScaffoldingAdapter]:
    """Return every adapter that matches the given agent.

    An agent typically matches one adapter per model it supports (e.g. a
    dual-model agent matches both ClaudeAdapter and GeminiAdapter), so the
    return is a list, not a single adapter.
    """
    return [
        a for a in ADAPTER_REGISTRY
        if a.matches(agent, agent_matches_condition_fn, known_models)
    ]


def adapter_for_entry_template(entry_template_id: str) -> ScaffoldingAdapter | None:
    """Find the adapter that owns the given manifest entry-point template id.

    Returns None for entries that aren't entry-point templates (alignment
    files, globals, per-agent files, config files).
    """
    if not entry_template_id:
        return None
    for adapter in ADAPTER_REGISTRY:
        if adapter.entry_template_id == entry_template_id:
            return adapter
    return None
