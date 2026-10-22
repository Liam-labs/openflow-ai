/**
 * Sprint 5 — Outcome synthesis (spec §8.2).
 *
 * Per-tool refiners pull a useful count out of the result text where it
 * matters (Read lines, Grep matches, Glob files, Write bytes, Bash first
 * stderr line on failure). Everything else gets the safe default
 * (✓ / ✗ <first error line>).
 */

import type { InterpretedAction, InterpretedOutcome, StreamItem } from './types';
import { firstLine } from './utils';

type Refiner = (text: string, ok: boolean) => InterpretedOutcome;

const READ_LINE_RE = /^\s*\d+→/; // Read tool prefixes lines with `   42→`
function readRefiner(text: string, ok: boolean): InterpretedOutcome {
  if (!ok) {
    return { ok, summary: `✗ ${firstLine(text).slice(0, 60)}` };
  }
  const lines = text.split('\n').filter((l) => READ_LINE_RE.test(l)).length;
  if (lines > 0) {
    return { ok, summary: `✓ ${lines} lines`, count: lines, countLabel: 'lines' };
  }
  return { ok, summary: '✓' };
}

function grepRefiner(text: string, ok: boolean): InterpretedOutcome {
  if (!ok) {
    return { ok, summary: `✗ ${firstLine(text).slice(0, 60)}` };
  }
  if (!text.trim()) {
    return { ok, summary: '✓ 0 matches', count: 0, countLabel: 'matches' };
  }
  const lines = text.split('\n').filter((l) => l.trim()).length;
  return { ok, summary: `✓ ${lines} matches`, count: lines, countLabel: 'matches' };
}

function globRefiner(text: string, ok: boolean): InterpretedOutcome {
  if (!ok) {
    return { ok, summary: `✗ ${firstLine(text).slice(0, 60)}` };
  }
  if (!text.trim() || /^No files found/i.test(text.trim())) {
    return { ok, summary: '✓ 0 files', count: 0, countLabel: 'files' };
  }
  const lines = text.split('\n').filter((l) => l.trim()).length;
  return { ok, summary: `✓ ${lines} files`, count: lines, countLabel: 'files' };
}

function writeRefiner(text: string, ok: boolean): InterpretedOutcome {
  if (!ok) {
    return { ok, summary: `✗ ${firstLine(text).slice(0, 60)}` };
  }
  return { ok, summary: '✓ written' };
}

function editRefiner(text: string, ok: boolean): InterpretedOutcome {
  if (!ok) {
    return { ok, summary: `✗ ${firstLine(text).slice(0, 60)}` };
  }
  return { ok, summary: '✓ edited' };
}

function bashRefiner(text: string, ok: boolean): InterpretedOutcome {
  if (!ok) {
    return { ok, summary: `✗ ${firstLine(text).slice(0, 60)}` };
  }
  return { ok, summary: '✓' };
}

const REFINERS: Readonly<Record<string, Refiner>> = {
  Read: readRefiner,
  Grep: grepRefiner,
  Glob: globRefiner,
  Write: writeRefiner,
  Edit: editRefiner,
  Bash: bashRefiner,
};

export function buildOutcome(action: InterpretedAction, result: StreamItem): InterpretedOutcome {
  const text = result.toolResultText ?? '';
  const ok = !result.toolResultIsError;
  const refiner = REFINERS[action.toolName];
  if (refiner) return refiner(text, ok);
  return {
    ok,
    summary: ok ? '✓' : `✗ ${firstLine(text).slice(0, 60)}`,
  };
}
