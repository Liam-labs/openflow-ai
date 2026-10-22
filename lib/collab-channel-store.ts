/**
 * The only code that writes collab-channels.json.
 *
 * Every change goes through `mutateChannels(caller, fn)`: it takes the file lock,
 * reads the file fresh, hands `fn` a private copy, and `fn` persists it with
 * `saveChannels(data)`. A copy read before the lock, or by someone else, can never
 * be written back over a newer change, because nothing outside this module can write.
 * `scripts/check-channel-writes.mjs` fails the build when other code tries.
 *
 * Slow work (tmux checks, crash reports, network calls) belongs outside the lock.
 * A pass that decides on a snapshot commits through `commitMonitorChanges`
 * (lib/collab-roster-merge.ts), which replays only the fields it changed.
 *
 * Every save logs one line per seat (participant or roster entry) whose identity
 * fields changed, with the caller's name, so the next record that goes wrong can
 * be traced to the write that did it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import { getHumanDisplayName } from './account-store';
import { readJsonFile, writeJsonFile, withFileLock } from './data-io';
import { DataPaths } from './data-paths';
import { dedupeAllChannelParticipants } from './collab-participants';
import { applyDisplayNameToHumans } from './human-identity';
import { logEvent } from './log-writer';
import type { CollabChannelsData } from './types';

const LOCK_WAIT_WARNING_MS = 10_000;
const LOCK_HOLD_ERROR_MS = 60_000;

// ---------------------------------------------------------------------------
// Shared state. Next.js can load this module once per bundle, the file lock in
// data-io is already shared on globalThis, and so is this.
// ---------------------------------------------------------------------------

interface LiveTransaction {
  caller: string;
  seats: SeatTable;
  open: boolean;
}

interface StoreState {
  live: WeakMap<object, LiveTransaction>;
  /** The transaction the running async code belongs to, so a nested call can be refused. */
  context: AsyncLocalStorage<LiveTransaction>;
  holder: { caller: string; since: number } | null;
}

const globalScope = globalThis as typeof globalThis & { __devflowChannelStore?: StoreState };
const state: StoreState = (globalScope.__devflowChannelStore ??= {
  live: new WeakMap(),
  context: new AsyncLocalStorage<LiveTransaction>(),
  holder: null,
});

// ---------------------------------------------------------------------------
// Seat identity table: what the delivery checks and presence read about a seat.
// ---------------------------------------------------------------------------

export interface SeatSnapshot {
  kind: 'participant' | 'roster';
  channelId: string;
  channelName: string;
  id: string;
  name: string;
  fields: Record<string, string>;
}

export type SeatTable = Map<string, SeatSnapshot>;

export interface SeatChange {
  change: 'added' | 'removed' | 'updated';
  seat: SeatSnapshot;
  fields: Array<{ field: string; before: string; after: string }>;
}

const NONE = '-';

function text(value: unknown): string {
  return value === undefined || value === null || value === '' ? NONE : String(value);
}

/** Identity fields of every participant and roster entry, keyed by channel, kind and id. */
export function seatTable(data: CollabChannelsData): SeatTable {
  const table: SeatTable = new Map();
  for (const channel of data.channels ?? []) {
    for (const p of channel.participants ?? []) {
      if (!p?.id) continue;
      table.set(`${channel.id}|participant|${p.id}`, {
        kind: 'participant',
        channelId: channel.id,
        channelName: channel.name,
        id: p.id,
        name: p.name,
        fields: {
          type: text(p.type),
          deliveryProtocol: text(p.deliveryProtocol),
          source: text(p.source),
          // Only 'away' is a real persisted state. 'online' and 'offline' are computed from lastSeen
          // and get saved along with other changes, so logging them would be noise.
          status: text(p.status === 'away' ? 'away' : undefined),
          awayInChannelId: text(p.awayInChannelId),
          pid: text(p.pid),
          wrapperPid: text(p.host?.wrapperPid),
        },
      });
    }
    for (const a of channel.roster?.agents ?? []) {
      if (!a?.id) continue;
      table.set(`${channel.id}|roster|${a.id}`, {
        kind: 'roster',
        channelId: channel.id,
        channelName: channel.name,
        id: a.id,
        name: a.name,
        fields: {
          agentType: text(a.agentType),
          deliveryProtocol: text(a.deliveryProtocol),
          status: text(a.status),
          model: text(a.model),
          awayInChannelId: text(a.awayInChannelId),
          pid: text(a.pid),
          participantId: text(a.participantId),
        },
      });
    }
  }
  return table;
}

/** The seats whose identity fields differ between two tables, in the order they appear. */
export function diffSeatTables(before: SeatTable, after: SeatTable): SeatChange[] {
  const changes: SeatChange[] = [];
  for (const [key, was] of before) {
    const now = after.get(key);
    if (!now) {
      changes.push({
        change: 'removed',
        seat: was,
        fields: Object.entries(was.fields).filter(([, v]) => v !== NONE).map(([field, v]) => ({ field, before: v, after: NONE })),
      });
      continue;
    }
    const fields = Object.keys(now.fields)
      .filter(field => was.fields[field] !== now.fields[field])
      .map(field => ({ field, before: was.fields[field] ?? NONE, after: now.fields[field] }));
    if (fields.length > 0) changes.push({ change: 'updated', seat: now, fields });
  }
  for (const [key, now] of after) {
    if (before.has(key)) continue;
    changes.push({
      change: 'added',
      seat: now,
      fields: Object.entries(now.fields).filter(([, v]) => v !== NONE).map(([field, v]) => ({ field, before: NONE, after: v })),
    });
  }
  return changes;
}

/** One log line for one changed seat. */
export function describeSeatChange(caller: string, change: SeatChange): string {
  const { seat } = change;
  const what = change.change === 'added' ? 'added' : change.change === 'removed' ? 'removed' : 'changed';
  const fields = change.fields.map(f => `${f.field} ${f.before} -> ${f.after}`).join('; ');
  return `[Channels] ${caller} ${what} ${seat.kind} ${seat.name} in ${seat.channelName}: ${fields}`;
}

function reportSeatChanges(caller: string, before: SeatTable, after: SeatTable): void {
  for (const change of diffSeatTables(before, after)) {
    console.info(describeSeatChange(caller, change));
    logEvent('agent', 'info', `Seat record ${change.change}: ${change.seat.name} (${change.seat.channelName})`, {
      event: 'seat-record-change',
      caller,
      change: change.change,
      seatKind: change.seat.kind,
      seatId: change.seat.id,
      seatName: change.seat.name,
      channelId: change.seat.channelId,
      channelName: change.seat.channelName,
      fields: change.fields,
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

function emptyChannels(): CollabChannelsData {
  return { channels: [], lastUpdated: new Date().toISOString() };
}

/**
 * Run `fn` on a fresh copy of the channels file while holding its lock.
 *
 * `fn` must work only on the `data` it is given and call `saveChannels(data)` where it
 * wants a change kept; changes it does not save are discarded. Keep slow work outside it.
 * `caller` names who is writing, as "module:operation", for the seat log.
 *
 * The lock is not re-entrant: a `mutateChannels` call made from inside `fn` (directly or
 * through any helper it awaits) would wait for the lock its own caller holds and stall
 * every channel write in the server. Such a call is refused at once with an error that
 * names both callers, and the outer transaction carries on untouched.
 */
export async function mutateChannels<T>(
  caller: string,
  fn: (data: CollabChannelsData) => T | Promise<T>,
): Promise<T> {
  const name = typeof caller === 'string' ? caller.trim() : '';
  if (!name) throw new Error('mutateChannels needs the name of its caller, e.g. "collab-api:heartbeat"');

  const outer = state.context.getStore();
  if (outer?.open) {
    throw new Error(
      `mutateChannels("${name}") was called inside mutateChannels("${outer.caller}"). ` +
      'It would wait for the channels lock its own caller holds and stall every channel write. ' +
      'Do the work in one callback, or call it after the outer callback has finished.',
    );
  }

  const waiting = setTimeout(() => {
    const holder = state.holder;
    console.warn(
      `[Channels] ${name} has waited ${LOCK_WAIT_WARNING_MS / 1000}s for the channels lock` +
      (holder ? `, held by ${holder.caller} for ${Math.round((Date.now() - holder.since) / 1000)}s` : ''),
    );
  }, LOCK_WAIT_WARNING_MS);

  try {
    return await withFileLock(DataPaths.collabChannels, async () => {
      clearTimeout(waiting);
      state.holder = { caller: name, since: Date.now() };
      const holding = setTimeout(() => {
        console.error(`[Channels] ${name} has held the channels lock for ${LOCK_HOLD_ERROR_MS / 1000}s; every channel write is waiting on it`);
      }, LOCK_HOLD_ERROR_MS);
      let transaction: LiveTransaction | undefined;
      let data: CollabChannelsData | undefined;
      try {
        const stored = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, emptyChannels());
        data = structuredClone(stored);
        dedupeAllChannelParticipants(data);
        transaction = { caller: name, seats: seatTable(data), open: true };
        state.live.set(data, transaction);
        const live = transaction;
        const copy = data;
        return await state.context.run(live, () => fn(copy));
      } finally {
        clearTimeout(holding);
        if (transaction) transaction.open = false;
        if (data) state.live.delete(data);
        state.holder = null;
      }
    });
  } finally {
    clearTimeout(waiting);
  }
}

/**
 * Persist the data `mutateChannels` handed to the running callback. Inline messages are
 * stripped (messages live in per-channel files), duplicate participants are merged, the
 * account owner's display name is stamped on their participant records and the seat changes
 * are logged. Throws for any other object, so a stale copy cannot be saved.
 */
export async function saveChannels(data: CollabChannelsData): Promise<void> {
  const transaction = state.live.get(data);
  if (!transaction || !transaction.open) {
    throw new Error('saveChannels needs the data mutateChannels handed to the callback that is still running');
  }
  dedupeAllChannelParticipants(data);
  // Every human record carries the current display name, whichever code added the record.
  const ownerName = await getHumanDisplayName();
  if (ownerName) applyDisplayNameToHumans(data, ownerName);
  data.lastUpdated = new Date().toISOString();
  for (const channel of data.channels) channel.messages = [];
  const after = seatTable(data);
  await writeJsonFile(DataPaths.collabChannels, data);
  reportSeatChanges(transaction.caller, transaction.seats, after);
  transaction.seats = after;
}

/**
 * Copy the channels file, as it is on disk, next to itself before a data migration, and return the
 * copy's path (null when there is no file yet). Only valid inside a transaction, so nothing writes
 * while the copy is taken. The name follows the older backups: collab-channels.json.bak-<label>-<UTC stamp>.
 */
export async function backupChannelsFile(data: CollabChannelsData, label: string): Promise<string | null> {
  const transaction = state.live.get(data);
  if (!transaction || !transaction.open) {
    throw new Error('backupChannelsFile needs the data mutateChannels handed to the callback that is still running');
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const target = `${DataPaths.collabChannels}.bak-${label.replace(/[^a-z0-9-]/gi, '-')}-${stamp}`;
  try {
    await fs.copyFile(DataPaths.collabChannels, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return target;
}
