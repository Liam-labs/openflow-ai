# Skill Discovery

The skill set changes over time, so this startup file does not duplicate a
static inventory. The scaffolding sync generates the current catalog at
`~/DevFlow/data/skills/matrix.json` from directories containing `SKILL.md`.

Use native skill discovery when the active harness provides it. Otherwise read
the generated catalog, choose the narrowest matching skill, then read
`~/DevFlow/data/skills/<name>/SKILL.md` completely before acting. If the catalog
is missing or stale, enumerate `~/DevFlow/data/skills/*/SKILL.md` directly; the
files themselves are authoritative.

Some skills belong to a **pack** (toolkit) for particular projects, such as the
games pack. In `matrix.json` they carry `"pack"`, and the `packs` map lists each
pack's opted-in project folders. Use a pack skill only when your working
directory is inside one of those projects. A pack's entry skill (for example
`game-toolkit`) maps tasks to its skills, tools and lessons.

**Confirm a skill exists before you claim it.** You may hold skills from more
than one source: this DevFlow catalog, a shared cross-runtime directory such as
`~/.agents/skills/`, and whatever your own harness provides natively. The
combined set differs by runtime, so check rather than recall — naming a skill you
do not have does not make it run, and reports work as done when it was not.

Use `/skill <name>` only on runtimes that support that command. Adding or
removing a skill must be followed by scaffolding sync so `matrix.json` is
regenerated rather than hand-editing an inventory here.

Browser work always starts with `/browser`. If browser status, targeting,
screenshots, authentication, or recovery fails, search
`~/DevFlow/data/central-knowledge-base/platform/browser-use.md` using the literal
error; do not select an old alias or inter-agent chat as a browser fallback.

For 3D asset work in any role, read
`~/DevFlow/data/skills/asset3d-workflow/SKILL.md` before starting a new asset or
materially changing its creation route. It selects between Tripo image-to-3D,
Spline desktop MCP, procedural/manual Blender and specialist routes. Read the
project's decision guide and current setup evidence for account, credit and export
limits; a listed tool is not necessarily connected or funded. Shared selection
context lives in `~/DevFlow/data/central-knowledge-base/tools/3d-asset-selection.md`.
Ordinary inspection/export does not require repeating the asset-route decision.
Tripo generations use the `tripo-studio` MCP server (CLI `~/DevFlow/scripts/tripo-studio`),
which spends {{OWNER_NAME}}'s Tripo Studio Premium credits through the signed-in DevFlow browser.
The Tripo API has no credits. Guide: `~/DevFlow/services/tripo-studio-mcp/README.md`.

For any request to make a video, explainer, promo, motion graphic or captioned clip in
any role, read `~/DevFlow/data/skills/video-toolkit/SKILL.md` first. It chooses between
HyperFrames and Remotion (or a mix) and sends you to that tool's skill and workflow.
Editing or grading {{OWNER_NAME}}'s own footage is the `davinci-resolve` skill instead.

**Jev is the decision model, not a writer.** When your work, a feature you are
building, or an n8n workflow has to make a judgement that is too fuzzy for a
rule but has a fixed set of answers (which owner or route, critical or low,
needs a reply or not, does this passage support the claim, is this safe to
pass), ask TypeSafe Jev instead of prompting a general LLM and parsing its
text. It returns a typed answer plus a confidence you can branch on, in well
under a second and for a tiny fraction of an LLM call. Use it as a smart
If/Switch: act on high confidence, send low confidence to a person or an LLM.
DevFlow's gateway holds the key, so no account or setup is needed: MCP
`typesafe_system_one`, CLI `~/DevFlow/scripts/devflow-gateway typesafe-ask
<caller>`, or HTTP `POST http://127.0.0.1:7007/api/call` (local n8n can call
this with an HTTP Request node). Load the `typesafe-ai` skill to design the
questions. Keep maths, dates, counting and exact lookups in code, and use an
LLM when you need words out.
