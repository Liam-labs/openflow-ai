# Starting from a Trajectory Draft

DevFlow's trajectory capture support is in `lib/trajectory-capture.ts`.
Where the runtime exposes it, `--from-trajectory` starts from recent session
activity; `--name` supplies a name and `--max-tools` selects the capture window
(default 10). Treat these as runner options, not portable model commands. Check
that the invoking runtime actually supports them before promising execution.

The synthesis flow may leave `.session-scratch/synthesis-pending.md` after a
session; its next startup suggestion is an invitation to evaluate reuse, not
proof that every tool sequence deserves a skill.

A generated draft may contain a derived name/description, grouped tool steps
and visible prerequisites. Before saving it:

1. Identify the durable outcome; rename tool-based titles to describe the task.
2. Remove secrets, client data, incidental paths and failed exploratory steps.
3. Replace mechanical tool chronology with decisions, expected results and
   meaningful failure branches. Preserve only dependencies that are required.
4. Complete examples and troubleshooting; delete all unfinished placeholders.
5. Match instruction freedom to risk and validate the draft using the main skill.

For an explicitly requested scaffolding-to-skill migration, retain essential
invariants and a precise load pointer in the canonical startup rule. Move
conditional procedure into the skill. Do not add broad startup mandates simply
to increase a skill's activation rate, or rewrite deployed identity files.
