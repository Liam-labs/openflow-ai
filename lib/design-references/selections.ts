/** Pure message selectors for correlating board-selection envelopes in the UI. */

import {
  isDesignReferenceSelectionEnvelope,
  type DesignReferenceSelection,
} from './types';

interface ClientMetaMessage {
  metadata?: { client?: unknown } | null;
}

export function designReferenceSelectionKey(
  value: Pick<DesignReferenceSelection, 'boardId' | 'boardRevision' | 'boardFingerprint'>,
): string {
  return `${value.boardId}:${value.boardRevision}:${value.boardFingerprint}`;
}

export function collectDesignReferenceSelections(
  messages: ClientMetaMessage[],
): Map<string, DesignReferenceSelection> {
  const selections = new Map<string, DesignReferenceSelection>();
  for (const message of messages) {
    const client = message.metadata?.client;
    if (isDesignReferenceSelectionEnvelope(client)) {
      selections.set(designReferenceSelectionKey(client.payload), client.payload);
    }
  }
  return selections;
}
