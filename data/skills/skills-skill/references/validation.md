# Skill Validation and Evaluation

## Working checklist

Copy the relevant checks into the task record or requested user-facing checklist.
For a small edit, validate the affected behavior without rerunning an unrelated suite.

- [ ] Scope and output match the user's task; existing authorization is preserved.
- [ ] Name/folder/frontmatter are valid; description states what and when in third person.
- [ ] SKILL.md stays below 500 lines; files over 100 lines have a contents list.
- [ ] Every needed reference is linked directly from SKILL.md; no missing local links.
- [ ] Instructions add useful domain knowledge without duplicate policy or basic definitions.
- [ ] Freedom matches the risk; templates distinguish fixed fields from options.
- [ ] Multi-step workflow has observable checks, branches and explicit return paths.
- [ ] Review loop repairs failures and has a bounded stopping condition.
- [ ] Required tools, versions, setup and authentication routes are documented.
- [ ] Applicable hard rules are enforced and tested at the actual operation boundary.
- [ ] Relevant, paraphrased and nearby negative requests have recorded results.
- [ ] Actual output and failure behavior are tested on intended model/harness combinations.
- [ ] Untested combinations and known limits are stated, not reported as passed.
- [ ] Scoped diff reviewed; deployed skill and every bundled resource verified.

## Behavioral tests

For a new workflow, start with a few representative cases before tuning wording:

| Case | Observe |
|---|---|
| Direct request and paraphrase | Correct selection and the requested artifact |
| Nearby unrelated request | No unwanted activation or scope expansion |
| Missing prerequisite | Useful setup/diagnosis without an invented tool or secret |
| Invalid input | Return to the named repair step; no invalid final write |
| Normal and edge outputs | Correct result, format and appropriate judgment |
| Consequential action, when applicable | Allow/deny checks on the real enforcement path using fixtures |

Use the same inputs with and without the skill when investigating whether it
helps. Judge artifacts and tool effects against objective criteria. A stronger
model may need fewer examples; a smaller one may need clearer branches. Repair
the observed cause instead of adding universal restrictions for one failure.

A review by the author is not independent behavioral evaluation. Use available,
authorized evaluation facilities; do not assume permission to spawn agents,
spend paid API credits, publish artifacts or touch live client data. Use temporary
fixtures and record what was actually executed. No fixed number of model runs
makes every kind of skill reliable.

## Evidence record

```text
Skill revision and scope:
Model identifier/version, harness and tool versions:
Fixture/request:
Expected observable result:
Actual result and artifact path:
Pass / fail / untested:
Correction and affected retest:
Known limits:
```

## Deploying in DevFlow

Run from the DevFlow repository after reviewing and committing owned skill files:

```bash
python3 data/scaffolding/sync.py --skills-only --skill skills-skill --dry-run
python3 data/scaffolding/sync.py --skills-only --skill skills-skill
```

Replace `skills-skill` with the skill being deployed. Inspect a catalogue-dirty
refusal rather than committing other people's work. Check target scope before
any explicit dirty override. Sync summary counts alone are insufficient: compare
the main file and all linked resources at the installed agent and host paths.
Use the configured deployment environment; do not install Python packages into
the system environment merely to bypass a missing repository dependency.
