---
name: methodology
description: >
  Choose proportionate testing, verification, and debugging for engineering work.
  Use when deciding how to prove a change, fixing a bug, investigating a failure,
  or preparing to report completion. Focused work gets focused checks; broader or
  high-risk work gets stronger evidence.
---

# Proportionate Engineering Method

Methodology exists to help the team ship correct work. It is a toolbox, not a
fixed ceremony.

## Test Strategy

Choose the cheapest proof that establishes the requested behaviour:

- test-first for reproducible bugs, stable business logic, and contracts where a
  failing example clarifies the target;
- tests alongside implementation for ordinary feature work;
- focused manual checks for copy, docs, simple config, prototypes, or observable
  behaviour that is not worth automating;
- broader suites for shared surfaces, releases, and credible high-impact risk.

Do not manufacture edge cases. Test acceptance behaviour plus the failure modes
justified by security, privacy, money, data loss, migrations, concurrency, or
production routing. Record other ideas as non-blocking hardening work.

## Verification

Before reporting completion:

1. confirm the acceptance behaviour;
2. run the most relevant command, test, request, or direct observation;
3. inspect the changed diff or artefact;
4. report the actual result and any material limitation.

Run a full suite or build when scope and risk justify it, normally once at the
release or sprint boundary. Do not repeat broad checks after every small edit.

## Debugging

Read the failure, reproduce it when practical, compare a working case, and test
the smallest useful hypothesis. After repeated attempts without new evidence,
change strategy: inspect another layer, consult current documentation, simplify
the solution, or ask a specialist.

This is not a mandatory stop count. Continue useful work while it is available.
A temporary safe workaround or rollback is valid when restoring service matters.

Keep reusable causes and fixes in DevFlow memory. Raw logs, attempt histories,
hashes, and sidecars stay out of channel and permanent records unless forensic or
byte-identity evidence is genuinely part of the task.
