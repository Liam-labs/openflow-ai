/** Server routing for design-reference.board and design-reference.selection. */

import type { CollabMessage } from '@/lib/types';
import {
  DESIGN_REFERENCE_BOARD_KIND,
  DESIGN_REFERENCE_SELECTION_KIND,
  isDesignReferenceMetadataKind,
  parseDesignReferenceBoard,
  parseDesignReferenceSelection,
  type DesignReferenceBoard,
  type DesignReferenceSelection,
} from './types';
import {
  recordDesignReferenceBoard,
  recordDesignReferenceSelection,
} from './store';
import { computeDesignReferenceBoardFingerprint } from './fingerprint';

export type DesignReferenceRouteResult =
  | { kind: 'none' }
  | { kind: 'invalid'; error: string }
  | { kind: 'board'; boardId: string; revision: number; fingerprint: string }
  | { kind: 'selection'; boardId: string; routedTo: string; selectionFingerprint: string | null; deduplicated: boolean };

export interface DesignReferenceRouteContext {
  humanRecipientIds?: readonly string[];
  now?: Date;
}

function launcherIdentityForMessage(message: CollabMessage) {
  const participant = message.from;
  const launcherSessionId = participant.sessionId
    ? `session:${participant.sessionId}`
    : Number.isSafeInteger(participant.pid) && (participant.pid ?? 0) > 0
      ? `pid:${participant.pid}`
      : '';
  return {
    participantId: participant.id,
    launcherSessionId,
    workspacePath: participant.projectPath ?? '',
  };
}

function selectionSummary(board: DesignReferenceBoard, selection: DesignReferenceSelection): string {
  if (selection.action === 'refine') {
    return `Refine the reference search${selection.note ? ` — ${selection.note}` : ''}`;
  }
  const titles = selection.candidateIds.map(id => (
    board.candidates.find(candidate => candidate.id === id)?.title ?? id
  ));
  if (selection.action === 'use-one') return `Use ${titles[0]}`;
  return `Combine ${titles.join(' + ')}${selection.note ? ` — ${selection.note}` : ''}`;
}

export function formatDesignReferenceSelectionForAgent(
  board: DesignReferenceBoard,
  selection: DesignReferenceSelection,
  actorName: string,
): string {
  const targetName = board.createdBy.name.trim().replace(/^@+/, '');
  const humanName = actorName.trim().replace(/^@+/, '') || 'A human participant';
  return `@${targetName} [Design references] ${humanName} decided: ${selectionSummary(board, selection)}`;
}

export async function handleDesignReferenceMessage(
  message: CollabMessage,
  context: DesignReferenceRouteContext = {},
): Promise<DesignReferenceRouteResult> {
  const client = message.metadata?.client;
  if (!isDesignReferenceMetadataKind(client)) return { kind: 'none' };

  const kind = (client as { kind: string }).kind;
  const payload = (client as { payload?: unknown }).payload;

  if (kind === DESIGN_REFERENCE_BOARD_KIND) {
    const parsed = parseDesignReferenceBoard(payload);
    if (!parsed.ok) return { kind: 'invalid', error: parsed.error };
    const board = parsed.value;
    if (board.channelId !== message.channelId) {
      return { kind: 'invalid', error: 'board.channelId does not match the message channel' };
    }
    if (board.createdBy.participantId !== message.from.id) {
      return { kind: 'invalid', error: 'board.createdBy does not match the sender' };
    }
    const now = context.now ?? new Date();
    if (Date.parse(board.createdAt) > now.getTime() + 5 * 60 * 1_000) {
      return { kind: 'invalid', error: 'board.createdAt is too far in the future' };
    }
    if (Date.parse(board.expiresAt) <= now.getTime()) {
      return { kind: 'invalid', error: 'board is already expired' };
    }
    if (computeDesignReferenceBoardFingerprint(board) !== board.fingerprint) {
      return { kind: 'invalid', error: 'board fingerprint does not match its contents' };
    }
    const humanRecipientIds = Array.from(new Set(
      (context.humanRecipientIds ?? []).filter(id => typeof id === 'string' && id.length > 0),
    ));
    if (humanRecipientIds.length === 0) {
      return { kind: 'invalid', error: 'board requires at least one human channel recipient' };
    }
    const recorded = await recordDesignReferenceBoard(
      board,
      humanRecipientIds,
      launcherIdentityForMessage(message),
    );
    if (!recorded.ok) return { kind: 'invalid', error: recorded.error };
    message.recipients = recorded.record.humanRecipientIds;
    message.metadata = { ...message.metadata, deliveryMode: 'targeted' };
    return { kind: 'board', boardId: board.id, revision: board.revision, fingerprint: board.fingerprint };
  }

  if (kind === DESIGN_REFERENCE_SELECTION_KIND) {
    const parsed = parseDesignReferenceSelection(payload);
    if (!parsed.ok) return { kind: 'invalid', error: parsed.error };
    const selection = parsed.value;
    if (selection.selectionFingerprint) {
      return { kind: 'invalid', error: 'selection fingerprint is server-issued and cannot be submitted' };
    }
    const selected = await recordDesignReferenceSelection(selection, {
      senderId: message.from.id,
      senderType: message.from.type,
      channelId: message.channelId,
      now: context.now,
    });
    if (!selected.ok) return { kind: 'invalid', error: selected.error };
    const record = selected.record;
    const target = record.board.createdBy.participantId;
    message.recipients = [target];
    message.mentions = [target];
    message.content = formatDesignReferenceSelectionForAgent(record.board, record.selection!, message.from.name);
    message.metadata = {
      ...message.metadata,
      isHidden: true,
      deliveryMode: 'targeted',
      client: {
        kind: DESIGN_REFERENCE_SELECTION_KIND,
        payload: record.selection,
      },
    };
    return {
      kind: 'selection',
      boardId: selection.boardId,
      routedTo: target,
      selectionFingerprint: record.selectionFingerprint,
      deduplicated: selected.disposition === 'idempotent',
    };
  }

  return { kind: 'none' };
}
