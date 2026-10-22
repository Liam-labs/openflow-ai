/**
 * Who "the human" is in a channel, and the name agents address them by.
 *
 * Agents say `@the owner` and `--to the owner`: the participant `name` is the routing name and stays "the owner" for
 * now. What the person chooses to be called (lib/account-store.ts) is `displayName`, stored on their
 * participant records and used for labels. Putting the chosen name into the agent rule files is a
 * later, fleet-wide step.
 *
 * "The human" is a `user` participant carrying the routing name. Not every `user` participant is the
 * account owner: Slack and Teams people join as "<name> (Slack)" / "(Teams)" and the hearing tools add
 * a companion and rehearsal actors, all of type `user`.
 *
 * Pure and import-safe in the browser: no file access.
 */

import type { CollabChannelsData, CollabParticipant } from './types';

/**
 * The name agents address the account owner by. The profile's display name never replaces it.
 *
 * It is configuration: set `DEVFLOW_OWNER_NAME` where DevFlow is built (next.config.ts hands it to the
 * browser bundle as `NEXT_PUBLIC_DEVFLOW_OWNER_NAME`, which Next inlines at build time, so the browser and
 * the server always agree). Unset, the owner is addressed as "You". Changing it needs a rebuild, and the
 * stored participant records of an existing install keep the old name until they are renamed.
 */
export const HUMAN_ROUTING_NAME = process.env.NEXT_PUBLIC_DEVFLOW_OWNER_NAME?.trim() || 'You';

/** True when `content` @mentions the account owner (`@<owner name>`, case-insensitive, whole word). */
export function mentionsHuman(content: string | undefined | null): boolean {
  const text = (content ?? '').toLowerCase();
  const tag = `@${HUMAN_ROUTING_NAME.toLowerCase()}`;
  for (let i = text.indexOf(tag); i !== -1; i = text.indexOf(tag, i + 1)) {
    if (!/\w/.test(text.charAt(i + tag.length))) return true;
  }
  return false;
}

/** True for the account owner's own participant records (their canonical id and any browser id). */
export function isHumanParticipant(participant: Pick<CollabParticipant, 'type' | 'name'>): boolean {
  return participant.type === 'user' && participant.name === HUMAN_ROUTING_NAME;
}

/** The account owner's participant records in a channel. */
export function humanParticipants<T extends Pick<CollabParticipant, 'type' | 'name'>>(
  participants: readonly T[] | undefined,
): T[] {
  return (participants ?? []).filter(isHumanParticipant);
}

/**
 * Give every human participant record the display name. Returns how many records changed.
 * Callers save once afterwards, so a name change is one write.
 */
export function applyDisplayNameToHumans(
  data: Pick<CollabChannelsData, 'channels'>,
  displayName: string,
): number {
  let changed = 0;
  for (const channel of data.channels ?? []) {
    for (const participant of channel.participants ?? []) {
      if (isHumanParticipant(participant) && participant.displayName !== displayName) {
        participant.displayName = displayName;
        changed++;
      }
    }
  }
  return changed;
}
