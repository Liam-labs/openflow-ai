---
name: skills-skill
description: >
  Creates, updates, reviews and tests DevFlow agent skills. Covers skill structure,
  discovery descriptions, progressive disclosure, workflow design and deployment.
  Applies when an agent authors a skill, improves an existing SKILL.md, captures a
  reusable workflow or diagnoses skill triggering. Does not apply merely because
  an agent is using another skill to complete ordinary work.
---

# Building DevFlow Skills

## Contents

- [Scope and instruction freedom](#1-scope-and-instruction-freedom)
- [Files and discovery](#2-files-and-discovery)
- [Workflows and feedback](#3-workflows-and-feedback)
- [Dependencies and enforceable rules](#4-dependencies-and-enforceable-rules)
- [Validation and deployment](#5-validation-and-deployment)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [References](#references)

## 1. Scope and instruction freedom

Edit the existing canonical skill when it already owns the workflow. Create a
new skill only for a distinct reusable capability. Source lives at
`~/DevFlow/data/skills/<skill-name>/SKILL.md`; deployed copies are not masters.

Identify representative requests, the useful output, required tools and the
company-specific knowledge the agent lacks. Use the user's supplied examples;
ask only when a missing fact materially changes the result. A small correction
does not require a new planning exercise or approval ceremony.

Match the instructions to consequences:

| Freedom | Use | Write |
|---|---|---|
| High | Brainstorming, creative choices | Outcomes, constraints and decision criteria |
| Medium | Reports with a consistent shape | Templates with explicit configurable fields |
| Low | Fragile calculations or consequential writes | Tested scripts, validated inputs and precise conditions |

Apply rigidity to the risky operation, not every surrounding sentence. Preserve
existing authorization and task scope. Do not turn an example threshold into a
company policy. Explain local terms, approved formats and operational constraints;
omit textbook definitions, repeated role rules and exhortations to try harder.

## 2. Files and discovery

Use the exact filename `SKILL.md`. The folder and frontmatter `name` must match:
lowercase letters, digits and hyphens, at most 64 characters. For Anthropic
compatibility, avoid reserved names containing `anthropic` or `claude`.

Frontmatter needs a nonempty `description` under 1,024 characters, without XML
tags. Write it in third person: what the skill does, when it applies, and natural
request terms. For example: "Creates weekly operations reports from approved
metrics. Applies to weekly reporting and report-template updates." Avoid "I can"
or "You should". Put execution detail in the body, not the discovery description.

The loading layers are metadata for selection, the entrypoint when selected,
and supporting resources as needed. Keep the main file under 500 lines; that is
a ceiling, not a target. Keep each reference directly linked from SKILL.md with
its purpose and when to read it. Avoid chains through other reference files.
Add a short contents list near the top of instructional files over 100 lines,
including the entrypoint when needed; keep frontmatter first.

Use `references/` for conditional detail, `scripts/` for tested deterministic
operations, and `assets/` for output templates. Do not make empty directories or
copy entire manuals. A short self-contained skill needs no extra structure.

Keep shared instructions model-neutral. Runtime-specific commands, connectors
and hook configuration belong in a clearly labelled reference for that harness.
When native discovery is unavailable, agents can read the canonical skill path.
Do not assume one provider's slash commands or tool names work in every harness.

## 3. Workflows and feedback

For multi-step work, supply a concise checklist the agent can copy into its
response or maintained task record and check off as work completes. Follow
DevFlow's channel communication rules: updating a checklist is not a reason to
post progress messages. Single-step edits do not need ceremonial checklists.

Give consequential steps a condition, action and observable result. Include
specific return paths: "If line totals differ from the approved total, return to
input reconciliation; do not issue the document." Use explicit branches when
conditions change the workflow, instead of making every task run every branch.

Choose a useful pattern:
- **Template:** identify fixed fields and allowed variations.
- **Input/output example:** show the expected level of detail and a real edge case.
- **Conditional workflow:** name the condition and the corresponding next step.

Build a review loop: draft → check the stated criteria → repair failures →
recheck affected criteria. For calculations or structured files, prefer a
validator over a model's assertion. Stop when criteria pass; if the same failure
persists after two repairs, record the blocker and continue independent work.
Do not retry external writes without evidence about whether the prior attempt
succeeded. A narrow documentation edit needs proportionate validation.

## 4. Dependencies and enforceable rules

List required tools, packages, supported runtimes and authentication routes in
the skill. Provide version checks and installation/setup instructions, either
inline or directly linked. State which are required, optional or already managed
by DevFlow. Check availability before use; never assume a teammate has a local
plugin. Do not embed secrets or install dependencies unrelated to the task.
This authoring skill needs file editing; DevFlow deployment uses Python 3 and Git
plus the repository's configured sync environment. No new plugin is required.

When a rule truly must block an action, specify deterministic enforcement at the
operation boundary: a supported pre-action hook, wrapper or service-side check.
Plain instructions and after-the-fact review cannot guarantee prevention. Load
DevFlow's `hook-mgmt` skill before changing hooks. Preserve existing approval
policy; do not create a new sign-off threshold from an illustrative example.

Test allowed, blocked and bypass paths in isolation. Verify the rule runs in
all intended harnesses and routes; a Claude-only hook does not protect another
wrapper. A hook configuration alone is not proof of enforcement. Document the
covered boundary and any missing coverage. Do not silently deploy a fleet hook
as a side effect of writing a skill.

## 5. Validation and deployment

Use [the validation and evaluation reference](references/validation.md) when
reviewing, testing or releasing a skill. Copy its compact checklist into the work
record. Test discovery with relevant requests, paraphrases and nearby negatives;
test actual outputs and failure handling, not whether a model can quote the skill.

Record the exact models and harnesses tested. For each intended model, check
whether it needs more guidance or is constrained by needless detail. Reuse the
same realistic cases across Haiku, Sonnet, Opus or other models actually targeted;
those names are examples, not a required universal test matrix. Retest after a
material model or workflow change. Mark unavailable combinations untested and
limit compatibility claims accordingly. Structural validation is not a model eval.

Review the scoped diff, commit only owned changes, then use `scaffolding-sync`
for a targeted preview and deployment. Verify installed contents and sibling
resources, including host copies. Do not restart working agents for a prose
update. Keep generated catalogue changes separate from unrelated authored edits.

## Examples

- **Creative briefs:** allow several concepts within the supplied brand constraints;
  use one output example instead of an exact script for every creative decision.
- **Weekly reporting:** provide a template with configurable dates and metrics;
  validate missing data, then review tone and length before publishing if authorized.
- **Invoices:** use tested arithmetic and the existing approval boundary. An amount
  requiring approval must be blocked at the issuing operation, not just mentioned
  in a checklist. Tests use fixtures, not real client invoices.

## Troubleshooting

| Failure | Next action |
|---|---|
| Misses relevant requests | Revise discovery terms; rerun positive and paraphrased cases |
| Activates for unrelated work | Narrow the description; test nearby negative requests |
| Ignores important detail | Remove redundancy; link detail directly; test a realistic task |
| Tool is missing | Follow declared setup or record the dependency blocker |
| Works on one model only | Compare the same cases; adjust guidance and state coverage |
| Reference missing after sync | Verify the deployed sibling files, not only SKILL.md |
| Output violates a hard rule | Check enforcement at the actual operation and rerun blocked-path tests |

## References

- [Validation and evaluation](references/validation.md): release checklist,
  behavioral cases and a small evidence record.
- [Trajectory drafts](references/trajectory.md): when starting from a session
  capture or `--from-trajectory`; review generated drafts before reuse.
- [Official sources](references/sources.md): provenance and distinctions between
  Anthropic recommendations and DevFlow's application of them.
