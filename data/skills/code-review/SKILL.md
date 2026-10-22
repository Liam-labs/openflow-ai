---
name: code-review
description: >
  Perform a collaborative, risk-based review against the requested outcome and
  changed surface. Use for medium- or high-risk changes, requested reviews, or
  a focused release check. Low-risk work normally uses owner self-review.
---

# Collaborative Code Review

## Start With the Current State

Review the newest active candidate, not each message as a separate ticket. Read
queued handoffs together and silently discard anything the owner superseded.
Before requesting review, the owner confirms that the candidate contains the
accepted base and the complete intended change.

Keep exact commit, tree, test, and artifact identity in the task or review
record. Include only the identity needed to disambiguate the active candidate in
conversation; the channel is not an append-only CI ledger.

## Decide the Depth

- **Low risk:** internal, reversible work; owner self-review.
- **Medium risk:** a functional change with realistic edge or regression risk;
  one peer review of the affected surface.
- **High risk:** destructive or hard-to-reverse work, or anything that publishes,
  sends, charges, deletes, migrates, or routes on a public, client, or production
  surface; use one focused review of material failure modes and recovery.

Review the actual diff and the agreed user journey, including interaction and
approval counts. Do not expand the contract during review. Temporary commissioning
controls must have an endpoint and must not become everyday user obligations.

## Apply a Complexity Budget

Cover realistic supported edge cases and likely regressions. Do not treat a
merely imaginable state as a blocker. Outside a missed requirement or reproduced
regression, require all three before blocking:

1. the failure path is reachable in supported operation;
2. its impact is material; and
3. an existing product requirement or threat model makes that boundary relevant.

If any is missing, record optional hardening as a follow-up and let the current
work proceed.

Fix the invariant at the narrowest layer that owns it. Prefer a direct field
comparison, validation, or focused regression over a new gate, receipt,
attestation, watcher, approval, or state machine. Do not make mutable current
state revalidate historical evidence unless the contract explicitly says that
state change invalidates the evidence. A safety control that breaks or routinely
blocks the normal feature path is itself a regression.

## Blocking Standard

Block only for:

1. a missed acceptance requirement;
2. a reproduced user-visible regression;
3. a credible, reachable failure with material destructive, public, client, or
   production impact; or
4. an unsafe destructive or public/client-live action without adequate recovery
   or authority.

Style preferences, speculative edge cases, unrelated defects, optional
refactors, and extra hardening are follow-ups. They do not hold the task.

## Work as Collaborators

Explain the observed problem and impact in ordinary language, with a reproduction
or concrete code-path evidence; do not require a live harmful action to prove it.
Ask a direct question when discussion can resolve uncertainty faster than a formal verdict.
`ship` and `fix` may be useful task states, but they are not a required speaking
style.

Return consolidated findings in the task or review record. The owner works through
valid corrections and relevant verification until complete; there is no fixed
correction-round quota or new design gate. Follow `channel-communication.md` for
hard blockers and completed findings that affect the next phase.

For the owner, translate the result into what was wrong, what changed, and whether it
now works. Put detailed evidence in the record unless they ask for it.
