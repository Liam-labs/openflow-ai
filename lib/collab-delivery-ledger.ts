/**
 * Durable delivery ledger for runtime adapters that acknowledge transcript ingestion.
 *
 * The channel message remains the canonical user-visible record. This ledger is the
 * delivery authority, keyed by (channelId, participantId, messageId). SSE, polling,
 * and legacy inbox files only wake wrappers; they do not acknowledge delivery.
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { withFileLock } from '@/lib/data-io';
import { formatReplyContext } from '@/lib/reply-context';
import type { AgentRosterEntry, CollabChannel, CollabMessage, CollabParticipant } from '@/lib/types';
import { appRoot } from '@/lib/app-paths';

export const DELIVERY_PROTOCOL = 'ledger-v1' as const;
export const DEFAULT_DELIVERY_LEASE_MS = 30_000;
export const DELIVERY_RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Terminal rows (handled, dead-lettered, cancelled, superseded) are never
 * delivered again: they are tombstones that stop a replayed submit or the 24 h
 * reconciliation scan from creating a second delivery, so they only need the
 * message identity and timestamp (voice-turn records are kept whole).
 * Their full bodies made the ledger ~4 MB, and every mutation re-parses and
 * re-writes the whole file under one lock: on 1 Oct 2026 that saturated the
 * event loop and DevFlow stopped answering.
 */
function slimTombstone(record: DeliveryRecord): DeliveryRecord {
  const { message } = record;
  // Voice-turn records stay whole: voice control replays their exact result.
  if (!message || message.metadata?.voice
    || (message.content === '' && !message.mentions && !message.recipients)) {
    return record;
  }
  return {
    ...record,
    message: {
      id: message.id,
      channelId: message.channelId,
      from: { id: message.from?.id, name: message.from?.name, type: message.from?.type } as CollabMessage['from'],
      content: '',
      timestamp: message.timestamp,
    },
  };
}
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OLDER_TERMINAL_RECORDS = 2_000;

/**
 * Hard ceiling on delivery attempts before the server auto-handles a record to
 * break an infinite replay loop. Observed loops hit 8,024 and 7,937 attempts
 * (2026-08-04) when the wrapper's JSONL verification became permanently
 * unavailable (transcript outside today/yesterday window, Codex not writing
 * to the expected path, etc.). Each attempt = one injected user turn, so 10
 * attempts is already ~5 minutes of retries — generous for transient issues
 * but tight enough to prevent agent-flooding loops.
 */
export const MAX_DELIVERY_ATTEMPTS = 3;

export type DeliveryState =
  | 'pending'
  | 'leased'
  | 'submitted'
  | 'ingested'
  | 'handled'
  | 'dead_letter'
  | 'cancel_requested'
  | 'cancelled'
  | 'superseded'
  // Folded into another record's injected turn; mirrors that record's outcome.
  | 'bundled';

export interface VoiceDeliveryControl {
  cancelId?: string;
  expectedRevision?: number;
  cancelDisposition?: 'pending_cancelled' | 'active_cancel_requested';
  cancelRequestedAt?: string;
  cancelledAt?: string;
  cancelledLeaseId?: string;
  cancelledOwnerId?: string;
  runtimeObservedAt?: string;
  supersededAt?: string;
  supersededByMessageId?: string;
  supersededByRevision?: number;
  responseMessageId?: string;
  responseAcceptedAt?: string;
}

export interface DeliveryLease {
  id: string;
  ownerId: string;
  claimedAt: string;
  expiresAt: string;
}

export interface DeliveryRecord {
  id: string;
  channelId: string;
  participantId: string;
  messageId: string;
  protocol: typeof DELIVERY_PROTOCOL;
  token: string;
  state: DeliveryState;
  message: CollabMessage;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lease?: DeliveryLease;
  submittedAt?: string;
  ingestedAt?: string;
  handledAt?: string;
  deadLetteredAt?: string;
  transcriptPath?: string;
  transcriptByte?: number;
  recoveryReason?: string;
  lastReleasedLeaseId?: string;
  lastReleasedOwnerId?: string;
  voiceControl?: VoiceDeliveryControl;
  /** On a 'bundled' record: the record whose turn carries this message. */
  bundledInto?: string;
  /** On the record that carries a bundle: what to restore if it is replayed. */
  bundle?: { recordIds: string[]; originalMessage: CollabMessage };
}

interface DeliveryLedgerStore {
  version: 1;
  records: DeliveryRecord[];
  lastUpdated: string;
}

export class DeliveryLedgerConflictError extends Error {}

function getLedgerPath(): string {
  const configured = process.env.DEVFLOW_APP_DATA_DIR || process.env.DEVFLOW_DATA_DIR || '.AppData';
  const base = path.resolve(appRoot(), configured);
  return path.join(base, 'collab-delivery-ledger.json');
}

function deliveryRecordId(channelId: string, participantId: string, messageId: string): string {
  return `${channelId}:${participantId}:${messageId}`;
}

export function deliveryToken(messageId: string, participantId?: string): string {
  const identity = participantId ? `${participantId}:${messageId}` : messageId;
  return `[[collab-delivery:${identity}]]`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function readStore(): Promise<DeliveryLedgerStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(getLedgerPath(), 'utf-8')) as DeliveryLedgerStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
      throw new Error('Unsupported or malformed delivery ledger schema');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { version: 1, records: [], lastUpdated: new Date(0).toISOString() };
    }
    console.error('[CollabDeliveryLedger] Failed to read ledger; refusing mutation:', error);
    throw error;
  }
}

interface LedgerSnapshot {
  key: string;
  store: DeliveryLedgerStore;
  serializedRecords: string;
}

// Every ledger wrapper polls `claim` every ~2 s. Re-reading, parsing and
// re-serialising the multi-megabyte ledger for each poll saturated the DevFlow
// event loop, so the parsed store is cached against the file identity. Writes
// replace the file by rename, so any writer (including another process)
// changes the inode/size/mtime key and forces a fresh read.
let snapshotCache: LedgerSnapshot | null = null;

async function ledgerFileKey(ledgerPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(ledgerPath);
    return `${ledgerPath}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Current ledger contents. The returned store is shared: never mutate it. */
async function readSnapshot(): Promise<LedgerSnapshot> {
  const key = await ledgerFileKey(getLedgerPath());
  if (key && snapshotCache?.key === key) return snapshotCache;
  // Stat precedes the read, so the parsed content is never older than `key`.
  const store = await readStore();
  const snapshot = { key: key ?? '', store, serializedRecords: JSON.stringify(store.records) };
  if (key) snapshotCache = snapshot;
  return snapshot;
}

async function writeStore(store: DeliveryLedgerStore): Promise<void> {
  const ledgerPath = getLedgerPath();
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const tmp = `${ledgerPath}.tmp.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
  await fs.copyFile(ledgerPath, `${ledgerPath}.bak`).catch(() => undefined);
  await fs.rename(tmp, ledgerPath);
}

const LEDGER_LOCK_STALE_MS = 30_000;
const LEDGER_LOCK_TIMEOUT_MS = 10_000;

async function acquireLedgerProcessLock(ledgerPath: string): Promise<() => Promise<void>> {
  const lockPath = `${ledgerPath}.lock`;
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.write(`${process.pid}\n${new Date().toISOString()}\n`);
      } finally {
        await handle.close();
      }
      return async () => fs.unlink(lockPath).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LEDGER_LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - startedAt >= LEDGER_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring delivery ledger lock ${lockPath}`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

async function mutateStore<T>(fn: (store: DeliveryLedgerStore, now: Date) => T | Promise<T>): Promise<T> {
  const ledgerPath = getLedgerPath();
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  return withFileLock(ledgerPath, async () => {
    const releaseProcessLock = await acquireLedgerProcessLock(ledgerPath);
    try {
      const snapshot = await readSnapshot();
      // Mutate a private copy so readers of the shared snapshot never observe
      // an uncommitted change.
      const store: DeliveryLedgerStore = {
        ...snapshot.store,
        records: JSON.parse(snapshot.serializedRecords) as DeliveryRecord[],
      };
      const now = new Date();
      const before = snapshot.serializedRecords;
      const result = await fn(store, now);
      settleBundles(store, now);
      const terminalCutoff = now.getTime() - TERMINAL_RETENTION_MS;
      const reconciliationCutoff = now.getTime() - DELIVERY_RECONCILIATION_WINDOW_MS;
      const terminal = store.records.filter(record =>
        record.state === 'handled'
        || record.state === 'dead_letter'
        || record.state === 'cancelled'
        || record.state === 'superseded'
      );
      // Reconciliation scans canonical messages from the last 24 hours. Their
      // terminal rows are replay-suppression tombstones, not disposable
      // history: pruning one lets the monitor recreate it as pending.
      const replayProtected = terminal.filter(record => {
        const messageTime = Date.parse(record.message.timestamp);
        return !Number.isFinite(messageTime) || messageTime >= reconciliationCutoff;
      });
      const replayProtectedIds = new Set(replayProtected.map(record => record.id));
      const olderRecentTerminal = terminal
        .filter(record =>
          !replayProtectedIds.has(record.id)
          && new Date(record.updatedAt).getTime() >= terminalCutoff
        )
        .slice(-MAX_OLDER_TERMINAL_RECORDS);
      const retainedIds = new Set([
        ...replayProtected.map(record => record.id),
        ...olderRecentTerminal.map(record => record.id),
      ]);
      store.records = store.records
        .filter(record =>
          (record.state !== 'handled'
            && record.state !== 'dead_letter'
            && record.state !== 'cancelled'
            && record.state !== 'superseded')
          || retainedIds.has(record.id)
        )
        .map(record => (retainedIds.has(record.id) ? slimTombstone(record) : record));
      const after = JSON.stringify(store.records);
      if (after !== before) {
        store.lastUpdated = now.toISOString();
        snapshotCache = null;
        await writeStore(store);
        const key = await ledgerFileKey(ledgerPath);
        if (key) snapshotCache = { key, store, serializedRecords: after };
      }
      return result;
    } finally {
      await releaseProcessLock();
    }
  });
}

function isAgentSender(senderId: string, channel: CollabChannel): boolean {
  const sender = channel.participants.find(participant => participant.id === senderId);
  if (!sender) return senderId.startsWith('pty-') || senderId.startsWith('roster-');
  return sender.type !== 'user' || sender.id.startsWith('pty-') || sender.id.startsWith('roster-');
}

function participantSupportsLedger(participant: CollabParticipant): boolean {
  return participant.type === 'codex' && participant.deliveryProtocol === DELIVERY_PROTOCOL;
}

function rosterAgentSupportsLedger(agent: AgentRosterEntry): boolean {
  return agent.agentType === 'codex' && agent.deliveryProtocol === DELIVERY_PROTOCOL;
}

/** Resolve opted-in Codex recipients without changing legacy delivery buckets. */
export function resolveDurableRecipientIds(
  senderId: string,
  message: CollabMessage,
  channel: CollabChannel,
): string[] {
  if (isAgentSender(senderId, channel) && !message.recipients) return [];

  const candidates = new Set<string>();
  for (const participant of channel.participants) {
    if (participant.id !== senderId && participantSupportsLedger(participant)) {
      candidates.add(participant.id);
    }
  }
  for (const agent of channel.roster?.agents || []) {
    if (agent.participantId !== senderId && rosterAgentSupportsLedger(agent)) {
      candidates.add(agent.participantId);
    }
  }

  if (!message.recipients) return [...candidates];
  return message.recipients.filter(participantId => candidates.has(participantId));
}

/**
 * Tag the message before canonical append so every wake-up path knows that it
 * must claim the server record instead of injecting the payload independently.
 */
export function prepareDurableDelivery(
  senderId: string,
  message: CollabMessage,
  channel: CollabChannel,
): string[] {
  const recipientIds = resolveDurableRecipientIds(senderId, message, channel);
  if (recipientIds.length > 0) {
    message.metadata = { ...message.metadata, durableDelivery: DELIVERY_PROTOCOL };
  }
  return recipientIds;
}

export async function enqueueDurableDeliveries(
  senderId: string,
  message: CollabMessage,
  channel: CollabChannel,
): Promise<DeliveryRecord[]> {
  const recipientIds = prepareDurableDelivery(senderId, message, channel);
  if (recipientIds.length === 0) return [];

  return mutateStore((store, now) => {
    const created: DeliveryRecord[] = [];
    for (const participantId of recipientIds) {
      const voice = message.metadata?.voice;
      if (voice?.kind === 'riley.voice.turn'
          && voice.source === 'recorded-text'
          && voice.supersedesMessageId) {
        // A canonical N+1 message is appended before the old record is
        // superseded so exact retry can repair either crash boundary. Prevent
        // the background reconciler from making N+1 claimable in that gap.
        const source = store.records.find(record =>
          record.channelId === channel.id
          && record.participantId === participantId
          && record.messageId === voice.supersedesMessageId
        );
        const sourceVoice = source?.message.metadata?.voice;
        const replacementIsFenced = source?.state === 'superseded'
          && source.voiceControl?.supersededByMessageId === message.id
          && source.voiceControl?.supersededByRevision === voice.revision
          && sourceVoice?.kind === 'riley.voice.turn'
          && sourceVoice.conversationSessionId === voice.conversationSessionId
          && sourceVoice.audioTurnId === voice.audioTurnId
          && sourceVoice.revision === voice.revision - 1;
        if (!replacementIsFenced) continue;
      }
      const id = deliveryRecordId(channel.id, participantId, message.id);
      const existing = store.records.find(record => record.id === id);
      if (existing) {
        created.push(cloneJson(existing));
        continue;
      }
      const record: DeliveryRecord = {
        id,
        channelId: channel.id,
        participantId,
        messageId: message.id,
        protocol: DELIVERY_PROTOCOL,
        token: deliveryToken(message.id, participantId),
        state: 'pending',
        message: cloneJson(message),
        attempts: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      store.records.push(record);
      created.push(cloneJson(record));
    }
    return created;
  });
}

function expireReplayableLeases(store: DeliveryLedgerStore, now: Date): void {
  for (const record of store.records) {
    if ((record.state !== 'leased' && record.state !== 'submitted') || !record.lease) continue;
    if (new Date(record.lease.expiresAt).getTime() > now.getTime()) continue;
    record.state = 'pending';
    record.recoveryReason = 'lease_expired';
    record.updatedAt = now.toISOString();
    delete record.lease;
    delete record.submittedAt;
  }
}

/** True when claimDelivery could return a record or expire a lease. */
function claimMayChange(
  store: DeliveryLedgerStore,
  input: { channelId: string; participantId: string; ownerId: string; messageId?: string },
  now: Date,
): boolean {
  return store.records.some(record => {
    if ((record.state === 'leased' || record.state === 'submitted') && record.lease) {
      if (new Date(record.lease.expiresAt).getTime() <= now.getTime()) return true;
      return record.lease.ownerId === input.ownerId
        && record.channelId === input.channelId
        && record.participantId === input.participantId
        && (!input.messageId || record.messageId === input.messageId);
    }
    return record.state === 'pending'
      && record.channelId === input.channelId
      && record.participantId === input.participantId
      && (!input.messageId || record.messageId === input.messageId);
  });
}

/**
 * A durable recipient takes one injected turn per claim and claims only between
 * turns. When several messages queue up during a long turn (2 Oct 2026: 16
 * messages for Iris while she generated images), delivering them one turn at a
 * time is slow and makes the agent answer messages already superseded by later
 * ones. So the claimed record carries every other queued, non-voice message for
 * the same recipient, in order, as one turn. The folded records become
 * 'bundled' and follow the carrier: handled or dead-lettered with it, and back
 * to pending (with the carrier's original message restored) if it is replayed.
 */
const MAX_BUNDLED_MESSAGES = 24;

function isBundleable(record: DeliveryRecord): boolean {
  return !record.message.metadata?.voice && !record.voiceControl;
}

export function bundledMessageText(message: CollabMessage, participantId: string): string {
  const sender = message.from?.name || 'Unknown';
  const reply = formatReplyContext(message.replyTo);
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const addressed = mentions.includes(participantId)
    ? '(@you)'
    : mentions.length ? '(not addressed to you)' : '(broadcast)';
  return `[Channel message from ${sender} in this channel]${reply ? ` ${reply}` : ''}: ${message.content}\n${addressed}`;
}

function bundleQueuedMessages(
  carrier: DeliveryRecord,
  candidates: DeliveryRecord[],
  now: Date,
): void {
  if (!isBundleable(carrier)) return;
  const folded = candidates
    .filter(candidate =>
      candidate !== carrier
      && candidate.state === 'pending'
      && candidate.attempts < MAX_DELIVERY_ATTEMPTS
      && isBundleable(candidate))
    .slice(0, MAX_BUNDLED_MESSAGES - 1);
  if (folded.length === 0) return;
  const original = carrier.bundle?.originalMessage ?? carrier.message;
  const imageUrls = [original, ...folded.map(record => record.message)]
    .flatMap(message => (Array.isArray(message.metadata?.imageUrls) ? message.metadata.imageUrls as string[] : []));
  const latest = folded[folded.length - 1].message.timestamp;
  carrier.bundle = { recordIds: folded.map(record => record.id), originalMessage: cloneJson(original) };
  carrier.message = {
    ...cloneJson(original),
    content: [
      original.content,
      '',
      `---`,
      `(${folded.length} more message${folded.length === 1 ? '' : 's'} arrived while you were busy. `
        + 'Read them all in order and answer once, to what is still current; later messages may correct earlier ones.)',
      '',
      folded.map(record => bundledMessageText(record.message, carrier.participantId)).join('\n\n'),
    ].join('\n'),
    timestamp: latest > original.timestamp ? latest : original.timestamp,
    metadata: { ...(original.metadata || {}), ...(imageUrls.length ? { imageUrls } : {}) },
  };
  for (const record of folded) {
    record.state = 'bundled';
    record.bundledInto = carrier.id;
    record.updatedAt = now.toISOString();
  }
}

/** Keep bundled records in step with the record that carries them. */
function settleBundles(store: DeliveryLedgerStore, now: Date): void {
  const byId = new Map(store.records.map(record => [record.id, record]));
  for (const record of store.records) {
    if (record.state !== 'bundled') continue;
    const carrier = record.bundledInto ? byId.get(record.bundledInto) : undefined;
    const carried = carrier?.bundle?.recordIds.includes(record.id) ?? false;
    if (!carrier || !carried || ['pending', 'superseded', 'cancelled'].includes(carrier.state)) {
      record.state = 'pending';
      delete record.bundledInto;
      record.recoveryReason = 'bundle_carrier_replayed';
    } else if (carrier.state === 'handled') {
      record.state = 'handled';
      record.handledAt = carrier.handledAt ?? now.toISOString();
      if (carrier.transcriptPath) record.transcriptPath = carrier.transcriptPath;
    } else if (carrier.state === 'dead_letter') {
      record.state = 'dead_letter';
      record.deadLetteredAt = now.toISOString();
      record.recoveryReason = `bundled_with:${carrier.recoveryReason || 'dead_letter'}`;
    } else {
      continue;
    }
    record.updatedAt = now.toISOString();
  }
  for (const record of store.records) {
    if (record.bundle && record.state === 'pending') {
      record.message = record.bundle.originalMessage;
      delete record.bundle;
    }
  }
}

export async function claimDelivery(input: {
  channelId: string;
  participantId: string;
  ownerId: string;
  messageId?: string;
  leaseMs?: number;
}): Promise<DeliveryRecord | null> {
  // Nearly every poll finds nothing to do. Answer those from the cached
  // snapshot without taking the ledger lock or re-serialising it.
  if (!claimMayChange((await readSnapshot()).store, input, new Date())) return null;
  return mutateStore((store, now) => {
    expireReplayableLeases(store, now);
    settleBundles(store, now);
    const owned = store.records
      .filter(candidate =>
        candidate.channelId === input.channelId &&
        candidate.participantId === input.participantId &&
        (candidate.state === 'leased' || candidate.state === 'submitted') &&
        candidate.lease?.ownerId === input.ownerId &&
        (!input.messageId || candidate.messageId === input.messageId)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (owned) return cloneJson(owned);
    const candidates = store.records
      .filter(candidate =>
        candidate.channelId === input.channelId &&
        candidate.participantId === input.participantId &&
        candidate.state === 'pending' &&
        (!input.messageId || candidate.messageId === input.messageId)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    let record: DeliveryRecord | undefined;
    for (const candidate of candidates) {
      if (candidate.attempts < MAX_DELIVERY_ATTEMPTS) {
        record = candidate;
        break;
      }
      candidate.state = 'dead_letter';
      candidate.deadLetteredAt = now.toISOString();
      candidate.recoveryReason = `${candidate.recoveryReason || 'attempt_ceiling'}_dead_letter`;
      candidate.updatedAt = now.toISOString();
      console.error(
        `[CollabDeliveryLedger] Quarantined record ${candidate.id} after ` +
        `${candidate.attempts} attempts (reason: ${candidate.recoveryReason})`
      );
    }
    if (!record) return null;

    if (!input.messageId) bundleQueuedMessages(record, candidates, now);

    const leaseMs = Math.max(1, input.leaseMs ?? DEFAULT_DELIVERY_LEASE_MS);
    record.state = 'leased';
    record.attempts += 1;
    record.updatedAt = now.toISOString();
    record.lease = {
      id: randomUUID(),
      ownerId: input.ownerId,
      claimedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    };
    return cloneJson(record);
  });
}

/**
 * Lease an already-ingested, not-yet-handled record for transcript recovery.
 * A new wrapper may take ownership only after the previous lease expires; the
 * same wrapper owner may recover immediately across a child respawn.
 */
export async function recoverIngestedDelivery(input: {
  channelId: string;
  participantId: string;
  ownerId: string;
  leaseMs?: number;
}): Promise<DeliveryRecord | null> {
  return mutateStore((store, now) => {
    const record = store.records
      .filter(candidate => {
        if (candidate.channelId !== input.channelId || candidate.participantId !== input.participantId) return false;
        if (candidate.state !== 'ingested') return false;
        if (!candidate.lease) return true;
        return candidate.lease.ownerId === input.ownerId ||
          new Date(candidate.lease.expiresAt).getTime() <= now.getTime();
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!record) return null;
    const leaseMs = Math.max(1, input.leaseMs ?? DEFAULT_DELIVERY_LEASE_MS);
    record.lease = {
      id: randomUUID(),
      ownerId: input.ownerId,
      claimedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    };
    record.updatedAt = now.toISOString();
    return cloneJson(record);
  });
}

function assertLease(record: DeliveryRecord, leaseId: string, ownerId: string, now: Date): void {
  if (!record.lease || record.lease.id !== leaseId || record.lease.ownerId !== ownerId) {
    throw new DeliveryLedgerConflictError('Delivery lease is missing or owned by another wrapper');
  }
  if (new Date(record.lease.expiresAt).getTime() <= now.getTime()) {
    throw new DeliveryLedgerConflictError('Delivery lease has expired');
  }
}

function assertRecordScope(
  record: DeliveryRecord,
  channelId?: string,
  participantId?: string,
): void {
  if ((channelId && record.channelId !== channelId)
      || (participantId && record.participantId !== participantId)) {
    throw new DeliveryLedgerConflictError('Delivery record does not belong to the requested participant');
  }
}

const TRANSITIONS: Record<'submitted' | 'ingested' | 'handled', DeliveryState[]> = {
  submitted: ['leased'],
  ingested: ['leased', 'submitted'],
  handled: ['ingested'],
};

export async function transitionDelivery(input: {
  channelId?: string;
  participantId?: string;
  recordId: string;
  leaseId: string;
  ownerId: string;
  state: 'submitted' | 'ingested' | 'handled';
  transcriptPath?: string;
  transcriptByte?: number;
}): Promise<DeliveryRecord> {
  return mutateStore((store, now) => {
    const record = store.records.find(candidate => candidate.id === input.recordId);
    if (!record) throw new DeliveryLedgerConflictError('Delivery record not found');
    assertRecordScope(record, input.channelId, input.participantId);
    assertLease(record, input.leaseId, input.ownerId, now);
    if (record.state === input.state) return cloneJson(record);
    if (!TRANSITIONS[input.state].includes(record.state)) {
      throw new DeliveryLedgerConflictError(`Invalid delivery transition ${record.state} -> ${input.state}`);
    }

    record.state = input.state;
    record.updatedAt = now.toISOString();
    if (input.state === 'submitted') {
      record.submittedAt = now.toISOString();
      if (input.transcriptPath) record.transcriptPath = input.transcriptPath;
      if (input.transcriptByte !== undefined) record.transcriptByte = input.transcriptByte;
    }
    if (input.state === 'ingested') {
      record.ingestedAt = now.toISOString();
      if (input.transcriptPath) record.transcriptPath = input.transcriptPath;
      if (input.transcriptByte !== undefined) record.transcriptByte = input.transcriptByte;
    }
    if (input.state === 'handled') record.handledAt = now.toISOString();
    return cloneJson(record);
  });
}

/** Keep one accepted runtime submission exclusively owned while Codex is delayed. */
export async function renewDelivery(input: {
  channelId?: string;
  participantId?: string;
  recordId: string;
  leaseId: string;
  ownerId: string;
  leaseMs?: number;
}): Promise<DeliveryRecord> {
  return mutateStore((store, now) => {
    const record = store.records.find(candidate => candidate.id === input.recordId);
    if (!record) throw new DeliveryLedgerConflictError('Delivery record not found');
    assertRecordScope(record, input.channelId, input.participantId);
    assertLease(record, input.leaseId, input.ownerId, now);
    if (record.state !== 'leased' && record.state !== 'submitted' && record.state !== 'ingested') {
      throw new DeliveryLedgerConflictError(`Cannot renew delivery in ${record.state} state`);
    }
    const leaseMs = Math.max(1, input.leaseMs ?? DEFAULT_DELIVERY_LEASE_MS);
    record.lease!.expiresAt = new Date(now.getTime() + leaseMs).toISOString();
    record.updatedAt = now.toISOString();
    return cloneJson(record);
  });
}

/**
 * Legacy wrappers used a five-second verifier timeout as a NACK even after tmux
 * accepted Enter. The outcome is ambiguous: replay can duplicate a turn, while
 * handled would silently drop it. Quarantine it for explicit operator review.
 */
export async function settleTimedOutDelivery(input: {
  channelId?: string;
  participantId?: string;
  recordId: string;
  leaseId: string;
  ownerId: string;
  reason: string;
}): Promise<DeliveryRecord> {
  return mutateStore((store, now) => {
    const record = store.records.find(candidate => candidate.id === input.recordId);
    if (!record) throw new DeliveryLedgerConflictError('Delivery record not found');
    assertRecordScope(record, input.channelId, input.participantId);
    assertLease(record, input.leaseId, input.ownerId, now);
    if (record.state !== 'leased' && record.state !== 'submitted' && record.state !== 'ingested') {
      throw new DeliveryLedgerConflictError(`Cannot settle delivery in ${record.state} state`);
    }
    record.state = 'dead_letter';
    record.deadLetteredAt = now.toISOString();
    record.recoveryReason = `${input.reason}_dead_letter`;
    record.updatedAt = now.toISOString();
    return cloneJson(record);
  });
}

export async function releaseDelivery(input: {
  channelId?: string;
  participantId?: string;
  recordId: string;
  leaseId: string;
  ownerId: string;
  reason: string;
}): Promise<DeliveryRecord> {
  return mutateStore((store, now) => {
    const record = store.records.find(candidate => candidate.id === input.recordId);
    if (!record) throw new DeliveryLedgerConflictError('Delivery record not found');
    assertRecordScope(record, input.channelId, input.participantId);
    if (record.state === 'pending' && record.lastReleasedLeaseId === input.leaseId
        && record.lastReleasedOwnerId === input.ownerId) {
      return cloneJson(record);
    }
    assertLease(record, input.leaseId, input.ownerId, now);
    if (record.state !== 'leased' && record.state !== 'submitted') {
      throw new DeliveryLedgerConflictError(`Cannot release delivery in ${record.state} state`);
    }
    record.state = 'pending';
    record.recoveryReason = input.reason;
    record.lastReleasedLeaseId = input.leaseId;
    record.lastReleasedOwnerId = input.ownerId;
    record.updatedAt = now.toISOString();
    delete record.lease;
    delete record.submittedAt;
    return cloneJson(record);
  });
}

/** Explicit dup-over-drop recovery when the runtime cannot resume an ingested turn. */
export async function requeueDelivery(input: {
  channelId?: string;
  participantId?: string;
  recordId: string;
  leaseId: string;
  ownerId: string;
  reason: string;
}): Promise<DeliveryRecord> {
  return mutateStore((store, now) => {
    const record = store.records.find(candidate => candidate.id === input.recordId);
    if (!record) throw new DeliveryLedgerConflictError('Delivery record not found');
    assertRecordScope(record, input.channelId, input.participantId);
    if (record.state === 'pending' && record.lastReleasedLeaseId === input.leaseId
        && record.lastReleasedOwnerId === input.ownerId) {
      return cloneJson(record);
    }
    assertLease(record, input.leaseId, input.ownerId, now);
    if (record.state === 'handled') {
      throw new DeliveryLedgerConflictError('Handled delivery cannot be requeued');
    }
    record.state = 'pending';
    record.recoveryReason = input.reason;
    record.lastReleasedLeaseId = input.leaseId;
    record.lastReleasedOwnerId = input.ownerId;
    record.updatedAt = now.toISOString();
    delete record.lease;
    delete record.submittedAt;
    delete record.ingestedAt;
    delete record.transcriptPath;
    delete record.transcriptByte;
    return cloneJson(record);
  });
}

export async function getDeliveryRecords(filter: {
  channelId?: string;
  participantId?: string;
  messageId?: string;
  recordId?: string;
  includeHandled?: boolean;
} = {}): Promise<DeliveryRecord[]> {
  const { store } = await readSnapshot();
  return store.records
    .filter(record =>
      (!filter.recordId || record.id === filter.recordId) &&
      (!filter.channelId || record.channelId === filter.channelId) &&
      (!filter.participantId || record.participantId === filter.participantId) &&
      (!filter.messageId || record.messageId === filter.messageId) &&
      (filter.includeHandled !== false || record.state !== 'handled')
    )
    .map(cloneJson);
}

/** Backstop for a live recipient that still has not claimed its queue. */
export const LIVE_RECIPIENT_PENDING_MAX_AGE_MS = 2 * 60 * 60_000;

/**
 * Move abandoned replayable records into the visible quarantine queue.
 *
 * Wrappers claim only between turns, so a live recipient in a long turn keeps
 * its queue pending. Such records wait for the idle claim, up to the live
 * backstop; the short expiry applies only to recipients that are gone.
 */
export async function quarantineStalePendingDeliveries(
  maxAgeMs = 8 * 60_000,
  options: {
    isRecipientLive?: (record: DeliveryRecord) => boolean;
    liveMaxAgeMs?: number;
  } = {},
): Promise<DeliveryRecord[]> {
  const liveMaxAgeMs = options.liveMaxAgeMs ?? LIVE_RECIPIENT_PENDING_MAX_AGE_MS;
  return mutateStore((store, now) => {
    expireReplayableLeases(store, now);
    const cutoff = now.getTime() - maxAgeMs;
    const liveCutoff = now.getTime() - liveMaxAgeMs;
    const quarantined: DeliveryRecord[] = [];
    for (const record of store.records) {
      if (record.state !== 'pending') continue;
      const createdAt = new Date(record.createdAt).getTime();
      if (createdAt >= cutoff) continue;
      if (createdAt >= liveCutoff && options.isRecipientLive?.(record)) continue;
      record.state = 'dead_letter';
      record.deadLetteredAt = now.toISOString();
      record.updatedAt = now.toISOString();
      record.recoveryReason = 'stale_pending_expired';
      quarantined.push(cloneJson(record));
    }
    return quarantined;
  });
}

/** Operator recovery: quarantine one channel queue after its runtimes are stopped. */
export async function quarantineChannelNonTerminalDeliveries(
  channelId: string,
  reason: string,
): Promise<DeliveryRecord[]> {
  if (!channelId || channelId.length > 500 || !reason || reason.length > 500) {
    throw new TypeError('channelId and reason must be non-empty strings of at most 500 characters');
  }
  return mutateStore((store, now) => {
    const quarantined: DeliveryRecord[] = [];
    for (const record of store.records) {
      if (record.channelId !== channelId) continue;
      if (
        record.state === 'handled'
        || record.state === 'dead_letter'
        || record.state === 'cancelled'
        || record.state === 'superseded'
      ) continue;
      record.state = 'dead_letter';
      record.deadLetteredAt = now.toISOString();
      record.updatedAt = now.toISOString();
      record.recoveryReason = reason;
      delete record.lease;
      quarantined.push(cloneJson(record));
    }
    return quarantined;
  });
}

function getVoiceRevision(record: DeliveryRecord): number | null {
  const voice = record.message.metadata?.voice;
  if (!voice || typeof voice !== 'object') return null;
  const revision = (voice as { revision?: unknown }).revision;
  return Number.isSafeInteger(revision) && Number(revision) >= 0 ? Number(revision) : null;
}

function assertVoiceRecord(
  record: DeliveryRecord,
  input: {
    channelId: string;
    participantId: string;
    expectedMessageId: string;
    expectedRevision: number;
  },
): void {
  assertRecordScope(record, input.channelId, input.participantId);
  if (record.messageId !== input.expectedMessageId) {
    throw new DeliveryLedgerConflictError('Voice cancel does not match the expected delivery message');
  }
  const revision = getVoiceRevision(record);
  if (revision === null || revision !== input.expectedRevision) {
    throw new DeliveryLedgerConflictError('Voice cancel does not match the expected delivery revision');
  }
}

function findScopedVoiceRecord(
  store: DeliveryLedgerStore,
  input: {
    channelId: string;
    participantId: string;
    expectedMessageId: string;
  },
): DeliveryRecord {
  const record = store.records.find(candidate =>
    candidate.channelId === input.channelId
    && candidate.participantId === input.participantId
    && candidate.messageId === input.expectedMessageId
  );
  if (!record) throw new DeliveryLedgerConflictError('Voice delivery record not found');
  return record;
}

export interface VoiceCancelDeliveryResult {
  disposition: 'pending_cancelled' | 'active_cancel_requested';
  requiresRuntimeInterrupt: boolean;
  ownerId?: string;
  record: DeliveryRecord;
}

/** Persist a correlated voice cancel before any runtime interrupt is attempted. */
export async function requestVoiceDeliveryCancel(input: {
  cancelId: string;
  channelId: string;
  participantId: string;
  expectedMessageId: string;
  expectedRevision: number;
}): Promise<VoiceCancelDeliveryResult> {
  return mutateStore((store, now) => {
    const reusedCancel = store.records.find(record => record.voiceControl?.cancelId === input.cancelId);
    if (reusedCancel) {
      assertVoiceRecord(reusedCancel, input);
      const disposition = reusedCancel.voiceControl!.cancelDisposition;
      if (!disposition) throw new DeliveryLedgerConflictError('Voice cancel record is incomplete');
      return {
        disposition,
        requiresRuntimeInterrupt: disposition === 'active_cancel_requested'
          && reusedCancel.state === 'cancel_requested',
        ownerId: reusedCancel.lease?.ownerId,
        record: cloneJson(reusedCancel),
      };
    }

    const record = findScopedVoiceRecord(store, input);
    assertVoiceRecord(record, input);
    if (record.voiceControl?.responseMessageId) {
      throw new DeliveryLedgerConflictError('Voice revision already has a correlated response');
    }
    if (record.state === 'handled' || record.state === 'dead_letter') {
      throw new DeliveryLedgerConflictError(`Voice revision cannot be cancelled from ${record.state}`);
    }
    if (record.state === 'cancelled' || record.state === 'superseded') {
      throw new DeliveryLedgerConflictError(`Voice revision is already ${record.state}`);
    }
    if (record.state === 'cancel_requested') {
      throw new DeliveryLedgerConflictError('Voice revision already has a different cancel request');
    }

    const active = record.state === 'submitted' || record.state === 'ingested';
    const disposition = active ? 'active_cancel_requested' : 'pending_cancelled';
    const cancelledLeaseId = record.state === 'leased' ? record.lease?.id : undefined;
    const cancelledOwnerId = record.state === 'leased' ? record.lease?.ownerId : undefined;
    record.voiceControl = {
      ...record.voiceControl,
      cancelId: input.cancelId,
      expectedRevision: input.expectedRevision,
      cancelDisposition: disposition,
      cancelRequestedAt: now.toISOString(),
      ...(active ? {} : { cancelledAt: now.toISOString() }),
      ...(cancelledLeaseId ? { cancelledLeaseId } : {}),
      ...(cancelledOwnerId ? { cancelledOwnerId } : {}),
    };
    record.state = active ? 'cancel_requested' : 'cancelled';
    record.updatedAt = now.toISOString();
    if (!active) delete record.lease;

    return {
      disposition,
      requiresRuntimeInterrupt: active,
      ownerId: active ? record.lease?.ownerId : undefined,
      record: cloneJson(record),
    };
  });
}

/** Runtime acknowledgement after the exact owning wrapper has sent Codex C-c. */
export async function acknowledgeVoiceDeliveryCancel(input: {
  cancelId: string;
  channelId: string;
  participantId: string;
  expectedMessageId: string;
  expectedRevision: number;
  recordId: string;
  leaseId: string;
  ownerId: string;
}): Promise<DeliveryRecord> {
  return mutateStore((store, now) => {
    const record = store.records.find(candidate => candidate.id === input.recordId);
    if (!record) throw new DeliveryLedgerConflictError('Voice delivery record not found');
    assertVoiceRecord(record, input);
    if (record.voiceControl?.cancelId !== input.cancelId) {
      throw new DeliveryLedgerConflictError('Voice cancel acknowledgement does not match the request');
    }
    if (record.state === 'cancelled') {
      if (record.voiceControl.cancelDisposition !== 'pending_cancelled') return cloneJson(record);
      if (record.voiceControl.cancelledLeaseId || record.voiceControl.cancelledOwnerId) {
        if (
          record.voiceControl.cancelledLeaseId !== input.leaseId
          || record.voiceControl.cancelledOwnerId !== input.ownerId
        ) {
          throw new DeliveryLedgerConflictError('Voice cancel acknowledgement does not match the cancelled lease');
        }
        if (!record.voiceControl.runtimeObservedAt) {
          record.voiceControl.runtimeObservedAt = now.toISOString();
          record.updatedAt = now.toISOString();
        }
      }
      return cloneJson(record);
    }
    if (record.state !== 'cancel_requested') {
      throw new DeliveryLedgerConflictError(`Voice cancel cannot be acknowledged from ${record.state}`);
    }
    assertLease(record, input.leaseId, input.ownerId, now);

    record.state = 'cancelled';
    record.voiceControl = {
      ...record.voiceControl,
      cancelledAt: now.toISOString(),
    };
    record.updatedAt = now.toISOString();
    delete record.lease;
    return cloneJson(record);
  });
}

/** Mark a cancelled voice revision as replaced by one exact monotonic revision. */
export async function supersedeVoiceDelivery(input: {
  channelId: string;
  participantId: string;
  expectedMessageId: string;
  expectedRevision: number;
  replacementMessageId: string;
  replacementRevision: number;
}): Promise<DeliveryRecord> {
  return mutateStore((store, now) => {
    const record = findScopedVoiceRecord(store, input);
    assertVoiceRecord(record, input);
    if (input.replacementRevision !== input.expectedRevision + 1) {
      throw new DeliveryLedgerConflictError('Voice replacement revision must increase by exactly one');
    }
    if (record.state === 'superseded') {
      if (
        record.voiceControl?.supersededByMessageId === input.replacementMessageId
        && record.voiceControl?.supersededByRevision === input.replacementRevision
      ) return cloneJson(record);
      throw new DeliveryLedgerConflictError('Voice revision was superseded by a different replacement');
    }
    if (record.state !== 'cancelled') {
      throw new DeliveryLedgerConflictError(`Voice revision cannot be superseded from ${record.state}`);
    }

    record.state = 'superseded';
    record.voiceControl = {
      ...record.voiceControl,
      supersededAt: now.toISOString(),
      supersededByMessageId: input.replacementMessageId,
      supersededByRevision: input.replacementRevision,
    };
    record.updatedAt = now.toISOString();
    return cloneJson(record);
  });
}

/** Atomically fence cancellation against one accepted Commander response. */
export async function acceptVoiceDeliveryResponse(input: {
  channelId: string;
  participantId: string;
  recordId: string;
  expectedMessageId: string;
  expectedRevision: number;
  responseMessageId: string;
}): Promise<DeliveryRecord> {
  return mutateStore((store, now) => {
    const record = store.records.find(candidate => candidate.id === input.recordId);
    if (!record) throw new DeliveryLedgerConflictError('Voice delivery record not found');
    assertVoiceRecord(record, input);
    if (record.state === 'cancel_requested' || record.state === 'cancelled' || record.state === 'superseded') {
      throw new DeliveryLedgerConflictError(`Voice revision no longer accepts replies (${record.state})`);
    }
    if (record.state !== 'submitted' && record.state !== 'ingested') {
      throw new DeliveryLedgerConflictError(`Voice revision cannot accept a reply from ${record.state}`);
    }
    if (record.voiceControl?.responseMessageId) {
      if (record.voiceControl.responseMessageId === input.responseMessageId) return cloneJson(record);
      throw new DeliveryLedgerConflictError('Voice revision already has a correlated response');
    }
    record.voiceControl = {
      ...record.voiceControl,
      responseMessageId: input.responseMessageId,
      responseAcceptedAt: now.toISOString(),
    };
    record.updatedAt = now.toISOString();
    return cloneJson(record);
  });
}
