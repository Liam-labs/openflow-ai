/**
 * Outlook Watch CRUD Actions
 *
 * Actions exposed on /api/agent for managing mailbox routing filters consumed
 * by the push-based outlook-graph-webhook service. The legacy action and store
 * names remain for API compatibility. `intervalMs` is retained as inert legacy
 * data; it must not be interpreted as permission to poll a mailbox.
 *
 * Spec: services/outlook-watcher/PROJECT.md § 5
 */

import crypto from 'crypto';

import { readJsonFile } from '@/lib/data-io';
import type { CollabChannelsData } from '@/lib/types';
import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';
import {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  coerceFilter,
  isFilterMeaningful,
  withWatchStoreLock,
  readWatchStore,
} from '@/lib/outlook-watches-store';
import type { Watch } from '@/lib/outlook-watches-store';
import type { NotifyTemplate } from '@/lib/outlook-events';

// `lib/collab-pty.ts` exports `DataPaths.collabChannels`. Avoid pulling in the
// whole pty module by reading the channels file via the DataPaths constant.
import { DataPaths } from '@/lib/data-paths';

const CHANNELS_PATH = DataPaths.collabChannels;
const DEFAULT_CHANNELS_DATA: CollabChannelsData = { channels: [], lastUpdated: '' };

interface CreateInput {
  ownerParticipantId: string;
  channelId: string;
  filter: unknown;
  folderId?: string;
  userId?: string;
  intervalMs?: number;
  enabled?: boolean;
  deliveryMode?: 'poll' | 'push';
  notifyTemplate?: NotifyTemplate;
}

// --------------- create ---------------

export async function create(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ watch: Watch }> {
  const input = parseCreateInput(body);

  await assertChannelAndOwner(input.channelId, input.ownerParticipantId);

  const filter = coerceFilter(input.filter);
  if (!isFilterMeaningful(filter)) {
    throw new ValidationError('invalid_filter', 'filter must constrain at least one field');
  }

  const intervalMs = clampInterval(input.intervalMs ?? 60_000);

  const now = new Date().toISOString();
  const watch: Watch = {
    id: crypto.randomUUID(),
    ownerParticipantId: input.ownerParticipantId,
    channelId: input.channelId,
    filter,
    folderId: input.folderId,
    userId: input.userId,
    intervalMs,
    enabled: input.enabled !== false,
    deliveryMode: input.deliveryMode ?? 'poll',
    notifyTemplate: input.notifyTemplate,
    lastChecked: now,
    dedupRing: [],
    createdAt: now,
    updatedAt: now,
    failureCount: 0,
  };

  return withWatchStoreLock(async (store) => {
    const next = { ...store, watches: [...store.watches, watch] };
    return { store: next, result: { watch } };
  });
}

// --------------- list ---------------

export async function list(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ watches: Watch[]; count: number }> {
  const ownerParticipantId =
    typeof body.ownerParticipantId === 'string' ? body.ownerParticipantId : undefined;
  const channelId = typeof body.channelId === 'string' ? body.channelId : undefined;
  const includeDisabled = body.includeDisabled === true;

  const store = await readWatchStore();
  let watches = store.watches;
  if (ownerParticipantId) watches = watches.filter((w) => w.ownerParticipantId === ownerParticipantId);
  if (channelId) watches = watches.filter((w) => w.channelId === channelId);
  if (!includeDisabled) watches = watches.filter((w) => w.enabled);

  return { watches, count: watches.length };
}

// --------------- update ---------------

interface UpdatePatch {
  filter?: unknown;
  folderId?: string;
  userId?: string;
  intervalMs?: number;
  enabled?: boolean;
  deliveryMode?: 'poll' | 'push';
  notifyTemplate?: NotifyTemplate;
}

export async function update(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ watch: Watch }> {
  const watchId = mustString(body.watchId, 'watchId');
  const ownerParticipantId = mustString(body.ownerParticipantId, 'ownerParticipantId');
  const patch = (body.patch && typeof body.patch === 'object' ? body.patch : {}) as UpdatePatch;

  return withWatchStoreLock(async (store) => {
    const idx = store.watches.findIndex((w) => w.id === watchId);
    if (idx < 0) throw new ValidationError('not_found', `Watch not found: ${watchId}`, 404);
    const existing = store.watches[idx];
    if (existing.ownerParticipantId !== ownerParticipantId) {
      throw new ValidationError('forbidden', 'Owner mismatch', 403);
    }

    const updated: Watch = { ...existing };
    let touched = false;

    if (patch.filter !== undefined) {
      const next = coerceFilter(patch.filter);
      if (!isFilterMeaningful(next)) {
        throw new ValidationError('invalid_filter', 'filter must constrain at least one field');
      }
      updated.filter = next;
      touched = true;
    }
    if (typeof patch.folderId === 'string') {
      updated.folderId = patch.folderId;
      touched = true;
    }
    if (typeof patch.userId === 'string') {
      updated.userId = patch.userId;
      touched = true;
    }
    if (typeof patch.intervalMs === 'number') {
      updated.intervalMs = clampInterval(patch.intervalMs);
      touched = true;
    }
    if (typeof patch.enabled === 'boolean') {
      // Re-enabling clears prior failure state — fresh start.
      if (patch.enabled && !updated.enabled) {
        updated.failureCount = 0;
        updated.lastError = undefined;
      }
      updated.enabled = patch.enabled;
      touched = true;
    }
    if (patch.deliveryMode === 'poll' || patch.deliveryMode === 'push') {
      updated.deliveryMode = patch.deliveryMode;
      touched = true;
    }
    if (patch.notifyTemplate !== undefined) {
      updated.notifyTemplate =
        typeof patch.notifyTemplate === 'string' || typeof patch.notifyTemplate === 'function'
          ? patch.notifyTemplate
          : undefined;
      touched = true;
    }

    if (!touched) {
      throw new ValidationError('empty_patch', 'patch had no recognised fields');
    }

    updated.updatedAt = new Date().toISOString();
    const watches = [...store.watches];
    watches[idx] = updated;
    return { store: { ...store, watches }, result: { watch: updated } };
  });
}

// --------------- delete (registered as outlook.watch.delete) ---------------

export async function remove(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ deletedId: string }> {
  const watchId = mustString(body.watchId, 'watchId');
  const ownerParticipantId = mustString(body.ownerParticipantId, 'ownerParticipantId');

  return withWatchStoreLock(async (store) => {
    const target = store.watches.find((w) => w.id === watchId);
    if (!target) throw new ValidationError('not_found', `Watch not found: ${watchId}`, 404);
    if (target.ownerParticipantId !== ownerParticipantId) {
      throw new ValidationError('forbidden', 'Owner mismatch', 403);
    }
    const watches = store.watches.filter((w) => w.id !== watchId);
    return { store: { ...store, watches }, result: { deletedId: watchId } };
  });
}

// --------------- helpers ---------------

class ValidationError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export { ValidationError };

function parseCreateInput(body: AgentApiRequest): CreateInput {
  const ownerParticipantId = mustString(body.ownerParticipantId, 'ownerParticipantId');
  const channelId = mustString(body.channelId, 'channelId');
  const filter = body.filter;
  if (filter === undefined) {
    throw new ValidationError('invalid_filter', 'filter is required');
  }
  const folderId = typeof body.folderId === 'string' ? body.folderId : undefined;
  const userId = typeof body.userId === 'string' ? body.userId : undefined;
  const intervalMs = typeof body.intervalMs === 'number' ? body.intervalMs : undefined;
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
  const deliveryMode = body.deliveryMode === 'push' ? 'push' : body.deliveryMode === 'poll' ? 'poll' : undefined;
  const notifyTemplate =
    typeof body.notifyTemplate === 'string' || typeof body.notifyTemplate === 'function'
      ? (body.notifyTemplate as NotifyTemplate)
      : undefined;

  return { ownerParticipantId, channelId, filter, folderId, userId, intervalMs, enabled, deliveryMode, notifyTemplate };
}

function mustString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ValidationError('invalid_request', `${name} is required`);
  }
  return v;
}

function clampInterval(n: number): number {
  if (!Number.isFinite(n)) {
    throw new ValidationError(
      'invalid_interval',
      `intervalMs must be a finite number between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`
    );
  }
  if (n < MIN_INTERVAL_MS || n > MAX_INTERVAL_MS) {
    throw new ValidationError(
      'invalid_interval',
      `intervalMs ${n} out of bounds (${MIN_INTERVAL_MS}-${MAX_INTERVAL_MS})`
    );
  }
  return n;
}

async function assertChannelAndOwner(channelId: string, ownerParticipantId: string): Promise<void> {
  const data = await readJsonFile<CollabChannelsData>(CHANNELS_PATH, DEFAULT_CHANNELS_DATA);
  const channel = data.channels.find((c) => c.id === channelId);
  if (!channel) {
    throw new ValidationError('invalid_channel', `Channel not found: ${channelId}`);
  }
  const owner = channel.participants.find((p) => p.id === ownerParticipantId);
  if (!owner) {
    throw new ValidationError(
      'invalid_owner',
      `ownerParticipantId not found in channel ${channelId}`
    );
  }
}
