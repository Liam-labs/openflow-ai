import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('collaborative review scaffolding', () => {
  const reviewSkill = read('data/skills/code-review/SKILL.md');
  const teamLeadRole = read('data/roles/team-lead.md');
  const channelRules = read(
    'data/scaffolding/masters/global/channel-communication.md',
  );
  const codexAlignment = read(
    'data/scaffolding/masters/per-model/codex/alignment-codex.md',
  );

  it('collapses superseded review requests into one current candidate', () => {
    expect(reviewSkill).toContain('newest active candidate');
    expect(reviewSkill).toContain('silently discard anything the owner superseded');
    expect(reviewSkill).toContain('one consolidated review');
    expect(reviewSkill).toContain('do not announce every intermediate revision');
  });

  it('keeps package ceremony out of channel conversation', () => {
    expect(reviewSkill).toContain('channel is not an append-only CI ledger');
    expect(reviewSkill).toMatch(/not a required speaking\s+style/);
    expect(teamLeadRole).toContain('Do not turn the channel into a CI');
    expect(channelRules).toContain('not like an automated release system');
    expect(channelRules).toContain('Exact package identity belongs');
  });

  it('keeps Owner-facing review summaries in plain English', () => {
    expect(reviewSkill).toMatch(
      /what was wrong, what changed, and whether it\s+now works/,
    );
    expect(teamLeadRole).toContain('one plain-English summary');
  });

  it('treats human broadcasts as actionable without forcing acknowledgement noise', () => {
    expect(channelRules).toContain('A human broadcast is addressed to every participant');
    expect(channelRules).toContain('do not wait\nfor a separate @mention');
    expect(channelRules).toContain('Silence is still correct');
  });

  it('keeps GPT review safety proportional to demonstrated risk', () => {
    expect(reviewSkill).toContain('Apply a Complexity Budget');
    expect(reviewSkill).toContain('merely imaginable state');
    expect(reviewSkill).toContain('reachable in supported operation');
    expect(reviewSkill).toContain('narrowest layer that owns it');
    expect(reviewSkill).toContain(
      'A safety control that breaks or routinely\nblocks the normal feature path is itself a regression',
    );

    expect(codexAlignment).toContain('Proportional Engineering');
    expect(codexAlignment).toContain('internal, reversible work');
    expect(codexAlignment).toContain('A merely possible\n  state is not a blocker');
    expect(codexAlignment).toContain('public, client, external-live');
    expect(codexAlignment).toContain(
      'attestation, receipt, approval, watcher, or state machine',
    );
  });
});
