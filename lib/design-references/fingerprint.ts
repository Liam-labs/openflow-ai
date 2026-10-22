/** Canonical server-side hashes for reference boards and implementation resumes. */

import { createHash } from 'crypto';
import type { DesignReferenceBoard, DesignReferenceSelection } from './types';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function computeDesignReferenceBoardFingerprint(
  board: Omit<DesignReferenceBoard, 'fingerprint'> | DesignReferenceBoard,
): string {
  const payload = { ...board } as Partial<DesignReferenceBoard>;
  delete payload.fingerprint;
  return sha256(payload);
}

export function computeDesignReferenceSelectionFingerprint(
  board: DesignReferenceBoard,
  selection: DesignReferenceSelection,
): string {
  return sha256({
    boardId: board.id,
    channelId: board.channelId,
    boardRevision: board.revision,
    boardFingerprint: board.fingerprint,
    action: selection.action,
    candidateIds: selection.candidateIds,
    note: selection.note?.trim() ?? '',
    answeredBy: selection.answeredBy,
  });
}
