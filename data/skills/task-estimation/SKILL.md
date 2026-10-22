---
name: task-estimation
description: >
  Estimate and time coding work done by AI agents so project quotes are based on
  measured agent speed, not human-developer habits. Use when asked to estimate or
  quote effort for a build, when starting a task you want a timing record for, or
  when comparing estimate against actual after finishing. Provides est.py, an
  append-only phase log with estimate-vs-actual reports.
---

# Task estimation for AI agents

Origin: Flooring Platform, Oct 2026. The owner observed that agents estimate like human
developers ("1-2 hours") and then finish in minutes. Four real tasks were timed to
get a first measured ratio. Background and the data set:
`~/DevFlow/data/central-knowledge-base/tools/task-estimation.md`.

## Use

```bash
EST=~/DevFlow/data/skills/task-estimation/est.py      # or the project's estimation/est.py
$EST estimate T1-name 25 50 8 12 --excludes "live deploy, client sign-off" "note: already knew the code"
$EST phase T1-name read          # starts a phase; ends whichever phase was open
$EST phase T1-name implement
$EST phase T1-name test
$EST phase T1-name review        # keep review its own phase (see below)
$EST phase T1-name fix
$EST done  T1-name
$EST report [task]               # phases, wall-clock span, % of estimate
$EST summary                     # all finished tasks, overall ratio
$EST check                       # open phases, tasks with no estimate
```

The log is `$EST_LOG`, else `./estimation/log.jsonl`, else beside the script. Set
`AGENT_NAME` to record who logged. Check that `report` shows your task before
relying on it: a wrong working directory silently logs somewhere else.

## Rules that make the data worth having

1. **Estimate before reading the code in depth**, as agent-minutes (low-high) and as
   what a human developer working without AI would need. If you already know the
   code, say so in the note; the read phase will be understated.
2. **Log each phase change when it happens.** A phase logged afterwards is a guess.
   Two of the first four tasks had wrong phase splits for exactly this reason. The
   report also prints the wall-clock span so total time is still trustworthy.
3. **Say what the estimate does not cover** with `--excludes`: live deploy, checks
   against real systems (Supabase, Stripe, email), client acceptance, waiting on
   other people. The first data set only covers local build, lint, tests and
   throwaway-database checks.
4. **Keep review as its own phase, done by someone other than the author.** In the
   first set, independent review found real defects the author missed (a payment
   rounding case that blocked job completion; an unreachable-today lost charge).
   Do not fold review into test.
5. Work at one effort setting across a project so the numbers are comparable (the
   first set used High).

## Using the numbers for a quote

- Quote the measured agent time for the coding, build and local-verification part.
- Add separate, clearly labelled allowances for what the estimate excludes:
  deployment and real-system checks, client acceptance and rework, access and
  waiting time. These are not covered by the ratios and were not measured.
- Do not apply the first ratios blindly. Four small, well-specified tasks with
  prior context is a thin sample; large unfamiliar or ambiguous work will cost more
  per unit. Add tasks to the log and re-read `summary` as data accrues.
