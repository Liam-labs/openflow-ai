/**
 * Moves the sidebar tabs into groups, once.
 *
 * `ensureChannelGroups()` is called when the channel list is read. If the channels file has no
 * `channelGroups` yet it takes a copy of the file (collab-channels.json.bak-before-groups-<stamp>),
 * stores the seed (Work, Life, Fun, then the stored tabs, same ids) and saves, all in one
 * transaction. Run again it finds the groups and does nothing, so it is safe to call on every read.
 *
 * Must not be called from inside a `mutateChannels` callback (the lock is not re-entrant); the group
 * actions in app/api/collab/_handlers/groups.ts migrate inside their own transaction instead.
 */

import { backupChannelsFile, mutateChannels, saveChannels } from './collab-channel-store';
import { hasChannelGroups, migrateChannelGroups } from './collab-groups';
import { readJsonFile } from './data-io';
import { DataPaths } from './data-paths';
import type { CollabChannelsData } from './types';

let migrated = false;
let inFlight: Promise<void> | null = null;

async function migrate(): Promise<void> {
  const current = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, { channels: [], lastUpdated: '' });
  if (hasChannelGroups(current)) return;
  await mutateChannels('groups:migrate', async data => {
    if (!migrateChannelGroups(data)) return;
    const copy = await backupChannelsFile(data, 'before-groups');
    await saveChannels(data);
    console.info(`[Groups] tabs migrated to ${data.channelGroups?.length ?? 0} groups; copy of the channels file: ${copy ?? 'none, there was no file'}`);
  });
}

/** Make sure the channels file has its groups. Cheap once done; concurrent callers share one run. */
export async function ensureChannelGroups(): Promise<void> {
  if (migrated) return;
  inFlight ??= migrate()
    .then(() => { migrated = true; })
    .finally(() => { inFlight = null; });
  await inFlight;
}

/** For tests: forget that the migration has run. */
export function resetChannelGroupsMigrationForTests(): void {
  migrated = false;
  inFlight = null;
}
