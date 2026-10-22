import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import path from 'path';

import { readChannelMessages, loadArchivedMessages } from '@/lib/collab-message-io';
import { withFileLock } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import type { ChannelMessagesData, CollabMessage } from '@/lib/types';

const STORE_VERSION = 1;
const ROUTING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DEFAULT_MAX_BINDINGS = 64;
const DEFAULT_MAX_DELIVERIES = 512;
const DEFAULT_MAX_PAIRINGS = 64;
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
const ALL_ARCHIVES_CURSOR = '9999-12-31T23:59:59.999Z';

export type CodexNativeStoreErrorCode =
  | 'CODEX_NATIVE_INVALID_INPUT'
  | 'CODEX_NATIVE_BINDING_NOT_FOUND'
  | 'CODEX_NATIVE_BINDING_CONFLICT'
  | 'CODEX_NATIVE_PAIRING_INVALID'
  | 'CODEX_NATIVE_PAIRING_EXPIRED'
  | 'CODEX_NATIVE_MESSAGE_NOT_FOUND'
  | 'CODEX_NATIVE_CLAIM_CONFLICT'
  | 'CODEX_NATIVE_OUTBOUND_NOT_FOUND'
  | 'CODEX_NATIVE_QUEUE_FULL'
  | 'CODEX_NATIVE_STORAGE_FAILED';

export class CodexNativeStoreError extends Error {
  constructor(
    message: string,
    public readonly code: CodexNativeStoreErrorCode,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'CodexNativeStoreError';
  }
}

export interface CodexNativeBinding {
  channelId: string;
  participantId: string;
  bindingId: string;
  nativeSessionId: string;
  nativeThreadId: string;
  permissionMode?: CodexNativePermissionMode;
  boundAt: string;
  lastActiveAt: string;
  unboundAt?: string;
}

export interface CodexNativeBindingInput {
  channelId: string;
  participantId: string;
  bindingId: string;
  nativeSessionId: string;
  nativeThreadId: string;
  permissionMode?: CodexNativePermissionMode;
}

export type CodexNativePermissionMode = 'restricted' | 'full-access';

export type CodexNativeBindingIdentity = CodexNativeBindingInput;

export type CodexNativeUnbindInput = CodexNativeBindingIdentity;

export interface CodexNativePairingTicket {
  pairingId: string;
  pairingCode: string;
  channelId: string;
  participantId: string;
  permissionMode?: CodexNativePermissionMode;
  expiresAt: string;
}

export interface CodexNativePairing {
  pairingId: string;
  channelId: string;
  participantId: string;
  permissionMode?: CodexNativePermissionMode;
  pairingCodeHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface CodexNativeRedeemPairingInput {
  pairingCode: string;
  nativeSessionId: string;
  nativeThreadId: string;
}

export type CodexNativeDeliveryState = 'waiting' | 'claimed' | 'acked';

export interface CodexNativeDelivery {
  idempotencyKey: string;
  channelId: string;
  participantId: string;
  bindingId: string;
  nativeSessionId: string;
  nativeThreadId: string;
  originMessageId: string;
  originTimestamp: string;
  state: CodexNativeDeliveryState;
  createdAt: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  ackedAt?: string;
  outboundCorrelationId?: string;
  observedStopIdempotencyKey?: string;
  stopObservedAt?: string;
  outboundIdempotencyKey?: string;
  outboundResolvedAt?: string;
}

export interface CodexNativePendingMessage extends CodexNativeDelivery {
  content: string;
  from: CollabMessage['from'];
  replyTo?: CollabMessage['replyTo'];
  attachments?: CodexNativePendingAttachment[];
}

export interface CodexNativePendingAttachment {
  name: string;
  type: string;
  url?: string;
  size?: number;
}

export interface CodexNativeListPendingInput extends CodexNativeBindingIdentity {
  limit?: number;
  currentBindingOnly?: boolean;
}

export interface CodexNativeClaimInput extends CodexNativeBindingIdentity {
  originMessageId: string;
}

export type CodexNativeInFlightDelivery = CodexNativeDelivery;

export interface CodexNativeResolveOutboundInput {
  nativeSessionId: string;
  turnId: string;
  outboundCorrelationId: string;
}

export interface CodexNativeOutboundResolution {
  channelId: string;
  participantId: string;
  bindingId: string;
  nativeThreadId: string;
  originMessageId: string;
  replyToMessageId: string;
  outboundIdempotencyKey: string;
}

export interface CodexNativeDeliveryStatus {
  originMessageId: string;
  state: CodexNativeDeliveryState;
  confirmed: boolean;
}

interface CodexNativeState {
  version: 1;
  bindings: CodexNativeBinding[];
  deliveries: CodexNativeDelivery[];
  pairings: CodexNativePairing[];
  lastUpdated: string;
}

export interface CodexNativeStoreOptions {
  filePath?: string;
  maxBindings?: number;
  maxDeliveries?: number;
  maxPairings?: number;
  pairingTtlMs?: number;
  now?: () => Date;
  randomId?: () => string;
  readMessages?: (channelId: string) => Promise<ChannelMessagesData>;
}

function invalidInput(label: string): never {
  throw new CodexNativeStoreError(
    `${label} must be a bounded routing identifier`,
    'CODEX_NATIVE_INVALID_INPUT',
    400,
  );
}

function assertRoutingId(value: string, label: string): void {
  if (typeof value !== 'string' || !ROUTING_ID_PATTERN.test(value)) invalidInput(label);
}

function assertBindingInput(input: CodexNativeBindingInput): void {
  assertRoutingId(input.channelId, 'channelId');
  assertRoutingId(input.participantId, 'participantId');
  assertRoutingId(input.bindingId, 'bindingId');
  assertRoutingId(input.nativeSessionId, 'nativeSessionId');
  assertRoutingId(input.nativeThreadId, 'nativeThreadId');
  if (
    input.permissionMode !== undefined
    && input.permissionMode !== 'restricted'
    && input.permissionMode !== 'full-access'
  ) {
    throw new CodexNativeStoreError(
      'permissionMode must be restricted or full-access',
      'CODEX_NATIVE_INVALID_INPUT',
      400,
    );
  }
}

function normalizedPermissionMode(value: unknown): CodexNativePermissionMode {
  return value === 'full-access' ? 'full-access' : 'restricted';
}

function assertPairingCode(value: string): void {
  if (typeof value !== 'string' || value.length < 8 || !ROUTING_ID_PATTERN.test(value)) {
    invalidInput('pairingCode');
  }
}

function pairingCodeHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function equalHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isPermissionMode(value: unknown): value is CodexNativePermissionMode {
  return value === 'restricted' || value === 'full-access';
}

function isBinding(value: unknown): value is CodexNativeBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return [
    item.channelId,
    item.participantId,
    item.bindingId,
    item.nativeSessionId,
    item.nativeThreadId,
    item.boundAt,
    item.lastActiveAt,
  ].every(isString)
    && (item.permissionMode === undefined || isPermissionMode(item.permissionMode))
    && (item.unboundAt === undefined || isString(item.unboundAt));
}

function isDelivery(value: unknown): value is CodexNativeDelivery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const required = [
    item.idempotencyKey,
    item.channelId,
    item.participantId,
    item.bindingId,
    item.nativeSessionId,
    item.nativeThreadId,
    item.originMessageId,
    item.originTimestamp,
    item.createdAt,
  ];
  const optional = [
    item.claimedAt,
    item.claimExpiresAt,
    item.ackedAt,
    item.outboundCorrelationId,
    item.observedStopIdempotencyKey,
    item.stopObservedAt,
    item.outboundIdempotencyKey,
    item.outboundResolvedAt,
  ];
  return required.every(isString)
    && (item.state === 'waiting' || item.state === 'claimed' || item.state === 'acked')
    && optional.every((field) => field === undefined || isString(field))
    && (isString(item.observedStopIdempotencyKey) === isString(item.stopObservedAt));
}

function isPairing(value: unknown): value is CodexNativePairing {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return [
    item.pairingId,
    item.channelId,
    item.participantId,
    item.pairingCodeHash,
    item.createdAt,
    item.expiresAt,
  ].every(isString)
    && (item.permissionMode === undefined || isPermissionMode(item.permissionMode))
    && /^[a-f0-9]{64}$/.test(String(item.pairingCodeHash));
}

function parseState(value: unknown): CodexNativeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('state is not an object');
  }
  const state = value as Record<string, unknown>;
  if (state.pairings === undefined) state.pairings = [];
  if (
    state.version !== STORE_VERSION
    || !Array.isArray(state.bindings)
    || !state.bindings.every(isBinding)
    || !Array.isArray(state.deliveries)
    || !state.deliveries.every(isDelivery)
    || !Array.isArray(state.pairings)
    || !state.pairings.every(isPairing)
    || !isString(state.lastUpdated)
  ) {
    throw new Error('state does not satisfy version 1 schema');
  }
  return state as unknown as CodexNativeState;
}

function emptyState(now: string): CodexNativeState {
  return { version: STORE_VERSION, bindings: [], deliveries: [], pairings: [], lastUpdated: now };
}

async function readAllChannelMessages(channelId: string): Promise<ChannelMessagesData> {
  const [active, archived] = await Promise.all([
    readChannelMessages(channelId),
    loadArchivedMessages(channelId, ALL_ARCHIVES_CURSOR),
  ]);
  const byId = new Map<string, CollabMessage>();
  for (const item of [...archived, ...active.messages]) byId.set(item.id, item);
  const messages = [...byId.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp)
  );
  return { channelId, messages, lastUpdated: active.lastUpdated };
}

function deliveryKey(originMessageId: string, nativeThreadId: string): string {
  return `${originMessageId}:${nativeThreadId}`;
}

function participantOriginKey(
  channelId: string,
  participantId: string,
  originMessageId: string,
): string {
  return JSON.stringify([channelId, participantId, originMessageId]);
}

function isOwned(info: { uid: number }): boolean {
  return typeof process.getuid !== 'function' || info.uid === process.getuid();
}

async function openOwnedRegularFile(filePath: string) {
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || !isOwned(info)) throw new Error('unsafe state file');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function writePrivateJsonFile(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let published = false;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
    published = true;

    const directoryHandle = await fs.open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!published) await fs.unlink(tempPath).catch(() => undefined);
  }
}

export function createCodexNativeStore(options: CodexNativeStoreOptions = {}) {
  const filePath = options.filePath ?? path.join(DataPaths.base, 'codex-native-bridge.json');
  const maxBindings = Math.max(1, options.maxBindings ?? DEFAULT_MAX_BINDINGS);
  const maxDeliveries = Math.max(1, options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES);
  const maxPairings = Math.max(1, options.maxPairings ?? DEFAULT_MAX_PAIRINGS);
  const pairingTtlMs = Math.min(
    Math.max(options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS, 60_000),
    60 * 60 * 1000,
  );
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const readMessages = options.readMessages ?? readAllChannelMessages;

  function timestamp(): string {
    return now().toISOString();
  }

  async function load(): Promise<CodexNativeState> {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const directoryInfo = await fs.lstat(path.dirname(filePath));
      if (
        directoryInfo.isSymbolicLink()
        || !directoryInfo.isDirectory()
        || (typeof process.getuid === 'function' && directoryInfo.uid !== process.getuid())
      ) {
        throw new Error('unsafe state directory');
      }
      await fs.chmod(path.dirname(filePath), 0o700);
      const handle = await openOwnedRegularFile(filePath);
      try {
        await handle.chmod(0o600);
        return parseState(JSON.parse(await handle.readFile('utf8')));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(timestamp());
      throw new CodexNativeStoreError(
        'Codex Native routing state is unreadable',
        'CODEX_NATIVE_STORAGE_FAILED',
        500,
      );
    }
  }

  async function save(state: CodexNativeState): Promise<void> {
    state.lastUpdated = timestamp();
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const directoryInfo = await fs.lstat(path.dirname(filePath));
    if (
      directoryInfo.isSymbolicLink()
      || !directoryInfo.isDirectory()
      || (typeof process.getuid === 'function' && directoryInfo.uid !== process.getuid())
    ) {
      throw new CodexNativeStoreError(
        'Codex Native routing state directory is unsafe',
        'CODEX_NATIVE_STORAGE_FAILED',
        500,
      );
    }
    await fs.chmod(path.dirname(filePath), 0o700);
    try {
      const existing = await openOwnedRegularFile(filePath);
      try {
        await existing.chmod(0o600);
      } finally {
        await existing.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new CodexNativeStoreError(
          'Codex Native routing state file is unsafe',
          'CODEX_NATIVE_STORAGE_FAILED',
          500,
        );
      }
    }
    await writePrivateJsonFile(filePath, state);
  }

  function activeBinding(
    state: CodexNativeState,
    channelId: string,
    participantId: string,
  ): CodexNativeBinding | undefined {
    return state.bindings.find((binding) =>
      !binding.unboundAt
      && binding.channelId === channelId
      && binding.participantId === participantId
    );
  }

  function requireBinding(
    state: CodexNativeState,
    input: CodexNativeBindingIdentity,
  ): CodexNativeBinding {
    assertBindingInput(input);
    const binding = activeBinding(state, input.channelId, input.participantId);
    if (!binding) {
      throw new CodexNativeStoreError(
        'Codex Native binding not found',
        'CODEX_NATIVE_BINDING_NOT_FOUND',
        404,
      );
    }
    if (
      binding.bindingId !== input.bindingId
      || binding.nativeSessionId !== input.nativeSessionId
      || binding.nativeThreadId !== input.nativeThreadId
    ) {
      throw new CodexNativeStoreError(
        'Request does not match the active Codex Native binding',
        'CODEX_NATIVE_BINDING_CONFLICT',
        409,
      );
    }
    return binding;
  }

  function ensureDeliveryCapacity(
    state: CodexNativeState,
    additional: number,
    binding: CodexNativeBinding,
    messages: CollabMessage[],
  ): void {
    const overflow = state.deliveries.length + additional - maxDeliveries;
    if (overflow <= 0) return;
    const canonicalOriginIds = new Set(messages.map((item) => item.id));
    const removable = state.deliveries
      .filter((delivery) =>
        Boolean(delivery.outboundIdempotencyKey)
        && delivery.channelId === binding.channelId
        && !canonicalOriginIds.has(delivery.originMessageId)
      )
      .sort((left, right) =>
        (left.outboundResolvedAt ?? '').localeCompare(right.outboundResolvedAt ?? '')
      )
      .slice(0, overflow);
    const removableKeys = new Set(removable.map((delivery) => delivery.idempotencyKey));
    state.deliveries = state.deliveries.filter(
      (delivery) => !removableKeys.has(delivery.idempotencyKey),
    );
    if (state.deliveries.length + additional > maxDeliveries) {
      throw new CodexNativeStoreError(
        'Codex Native inbox is full; no unresolved or replay-suppression records were dropped',
        'CODEX_NATIVE_QUEUE_FULL',
        409,
      );
    }
  }

  function targetedMessages(
    messages: CollabMessage[],
    binding: CodexNativeBinding,
  ): CollabMessage[] {
    return messages.filter((item) =>
      item.from.id !== binding.participantId
      && Array.isArray(item.recipients)
      && item.recipients.includes(binding.participantId)
    );
  }

  function synchronize(
    state: CodexNativeState,
    binding: CodexNativeBinding,
    messages: CollabMessage[],
    at: string,
  ): boolean {
    let changed = false;
    for (const delivery of state.deliveries) {
      if (delivery.bindingId === binding.bindingId && delivery.claimExpiresAt) {
        // Legacy leases are intentionally retired. Elapsed time cannot prove
        // that Desktop's native confirmation was cancelled.
        delete delivery.claimExpiresAt;
        changed = true;
      }
    }

    // A deleted AgentChat message cannot be delivered, so do not let its
    // unresolved queue row occupy the one-item automatic-delivery window.
    // Preserve claimed and acknowledged rows because they fence in-flight
    // work and suppress replay after a native reply has been committed.
    const canonicalOriginIds = new Set(messages.map((item) => item.id));
    const deliveryCount = state.deliveries.length;
    state.deliveries = state.deliveries.filter((delivery) =>
      delivery.bindingId !== binding.bindingId
      || delivery.state !== 'waiting'
      || canonicalOriginIds.has(delivery.originMessageId)
    );
    if (state.deliveries.length !== deliveryCount) changed = true;

    const existing = new Set(state.deliveries.map((delivery) => delivery.idempotencyKey));
    const resolvedOrigins = new Set(
      state.deliveries
        .filter((delivery) => Boolean(delivery.outboundIdempotencyKey))
        .map((delivery) => participantOriginKey(
          delivery.channelId,
          delivery.participantId,
          delivery.originMessageId,
        )),
    );
    const unresolvedOrigins = new Map<string, CodexNativeDelivery>();
    for (const delivery of state.deliveries) {
      if (delivery.outboundIdempotencyKey) continue;
      unresolvedOrigins.set(
        participantOriginKey(
          delivery.channelId,
          delivery.participantId,
          delivery.originMessageId,
        ),
        delivery,
      );
    }

    const missing: CollabMessage[] = [];
    for (const item of targetedMessages(messages, binding)) {
      const originKey = participantOriginKey(binding.channelId, binding.participantId, item.id);
      if (resolvedOrigins.has(originKey)) continue;

      const nextDeliveryKey = deliveryKey(item.id, binding.nativeThreadId);
      if (existing.has(nextDeliveryKey)) continue;

      const unresolved = unresolvedOrigins.get(originKey);
      if (unresolved) {
        existing.delete(unresolved.idempotencyKey);
        unresolved.idempotencyKey = nextDeliveryKey;
        unresolved.bindingId = binding.bindingId;
        unresolved.nativeSessionId = binding.nativeSessionId;
        unresolved.nativeThreadId = binding.nativeThreadId;
        unresolved.state = 'waiting';
        delete (unresolved as CodexNativeDelivery & { claimToken?: string }).claimToken;
        delete unresolved.claimedAt;
        delete unresolved.claimExpiresAt;
        delete unresolved.ackedAt;
        delete unresolved.outboundCorrelationId;
        delete unresolved.observedStopIdempotencyKey;
        delete unresolved.stopObservedAt;
        existing.add(nextDeliveryKey);
        changed = true;
        continue;
      }
      missing.push(item);
    }
    ensureDeliveryCapacity(state, missing.length, binding, messages);
    for (const item of missing) {
      state.deliveries.push({
        idempotencyKey: deliveryKey(item.id, binding.nativeThreadId),
        channelId: binding.channelId,
        participantId: binding.participantId,
        bindingId: binding.bindingId,
        nativeSessionId: binding.nativeSessionId,
        nativeThreadId: binding.nativeThreadId,
        originMessageId: item.id,
        originTimestamp: item.timestamp,
        state: 'waiting',
        createdAt: at,
      });
      changed = true;
    }
    return changed;
  }

  async function getBinding(channelId: string, participantId: string): Promise<CodexNativeBinding | null> {
    assertRoutingId(channelId, 'channelId');
    assertRoutingId(participantId, 'participantId');
    const state = await load();
    return activeBinding(state, channelId, participantId) ?? null;
  }

  async function listActiveBindings(): Promise<CodexNativeBinding[]> {
    const state = await load();
    return state.bindings.filter((binding) => !binding.unboundAt);
  }

  function bindIntoState(
    state: CodexNativeState,
    input: CodexNativeBindingInput,
    at: string,
  ): CodexNativeBinding {
    const current = activeBinding(state, input.channelId, input.participantId);
    if (current) {
      if (
        current.bindingId !== input.bindingId
        || current.nativeSessionId !== input.nativeSessionId
        || current.nativeThreadId !== input.nativeThreadId
      ) {
        throw new CodexNativeStoreError(
          'Explicitly unbind the current native chat before binding another',
          'CODEX_NATIVE_BINDING_CONFLICT',
          409,
        );
      }
      current.lastActiveAt = at;
      return current;
    }
    if (state.bindings.some((binding) =>
      !binding.unboundAt
      && (
        binding.bindingId === input.bindingId
        || binding.nativeSessionId === input.nativeSessionId
        || binding.nativeThreadId === input.nativeThreadId
      )
    )) {
      throw new CodexNativeStoreError(
        'Native chat is already bound to another AgentChat liaison',
        'CODEX_NATIVE_BINDING_CONFLICT',
        409,
      );
    }

    if (state.bindings.length >= maxBindings) {
      const unbound = state.bindings
        .filter((binding) => binding.unboundAt)
        .sort((left, right) => (left.unboundAt ?? '').localeCompare(right.unboundAt ?? ''));
      const removeCount = state.bindings.length - maxBindings + 1;
      const remove = new Set(unbound.slice(0, removeCount).map((binding) => binding.bindingId));
      state.bindings = state.bindings.filter((binding) => !remove.has(binding.bindingId));
    }
    if (state.bindings.length >= maxBindings) {
      throw new CodexNativeStoreError(
        'Codex Native binding store is full',
        'CODEX_NATIVE_QUEUE_FULL',
        409,
      );
    }

    const binding: CodexNativeBinding = {
      ...input,
      permissionMode: normalizedPermissionMode(input.permissionMode),
      boundAt: at,
      lastActiveAt: at,
    };
    state.bindings.push(binding);
    return binding;
  }

  async function bind(input: CodexNativeBindingInput): Promise<CodexNativeBinding> {
    assertBindingInput(input);
    return withFileLock(filePath, async () => {
      const state = await load();
      const at = timestamp();
      const binding = bindIntoState(state, input, at);
      await save(state);
      return binding;
    });
  }

  async function bindSelected(input: CodexNativeBindingInput): Promise<CodexNativeBinding> {
    assertBindingInput(input);
    return withFileLock(filePath, async () => {
      const state = await load();
      const at = timestamp();
      const obsoleteSameChannel = state.bindings.filter((binding) =>
        !binding.unboundAt
        && binding.channelId === input.channelId
        && binding.participantId !== input.participantId
      );
      if (obsoleteSameChannel.some((binding) => state.deliveries.some((delivery) =>
        delivery.bindingId === binding.bindingId && delivery.state === 'claimed'
      ))) {
        throw new CodexNativeStoreError(
          'Wait for the native Codex turn to finish before replacing this liaison',
          'CODEX_NATIVE_CLAIM_CONFLICT',
          409,
        );
      }
      for (const obsolete of obsoleteSameChannel) {
        obsolete.unboundAt = at;
        obsolete.lastActiveAt = at;
      }
      const binding = bindIntoState(state, input, at);
      state.pairings = state.pairings.filter((item) =>
        item.channelId !== input.channelId || item.participantId !== input.participantId
      );
      await save(state);
      return binding;
    });
  }

  async function setPermissionMode(
    channelId: string,
    participantId: string,
    permissionMode: CodexNativePermissionMode,
  ): Promise<CodexNativeBinding> {
    assertRoutingId(channelId, 'channelId');
    assertRoutingId(participantId, 'participantId');
    if (!isPermissionMode(permissionMode)) {
      throw new CodexNativeStoreError(
        'permissionMode must be restricted or full-access',
        'CODEX_NATIVE_INVALID_INPUT',
        400,
      );
    }
    return withFileLock(filePath, async () => {
      const state = await load();
      const binding = activeBinding(state, channelId, participantId);
      if (!binding) {
        throw new CodexNativeStoreError(
          'Codex Native binding not found',
          'CODEX_NATIVE_BINDING_NOT_FOUND',
          404,
        );
      }
      binding.permissionMode = permissionMode;
      binding.lastActiveAt = timestamp();
      await save(state);
      return binding;
    });
  }

  async function getPairing(
    channelId: string,
    participantId: string,
  ): Promise<Omit<CodexNativePairing, 'pairingCodeHash'> | null> {
    assertRoutingId(channelId, 'channelId');
    assertRoutingId(participantId, 'participantId');
    const state = await load();
    const at = timestamp();
    const pairing = state.pairings.find((item) =>
      item.channelId === channelId
      && item.participantId === participantId
      && item.expiresAt > at
    );
    if (!pairing) return null;
    return {
      pairingId: pairing.pairingId,
      channelId: pairing.channelId,
      participantId: pairing.participantId,
      createdAt: pairing.createdAt,
      expiresAt: pairing.expiresAt,
    };
  }

  async function createPairing(
    channelId: string,
    participantId: string,
    permissionMode: CodexNativePermissionMode = 'restricted',
  ): Promise<CodexNativePairingTicket> {
    assertRoutingId(channelId, 'channelId');
    assertRoutingId(participantId, 'participantId');
    if (permissionMode !== 'restricted' && permissionMode !== 'full-access') {
      throw new CodexNativeStoreError(
        'permissionMode must be restricted or full-access',
        'CODEX_NATIVE_INVALID_INPUT',
        400,
      );
    }
    return withFileLock(filePath, async () => {
      const state = await load();
      if (activeBinding(state, channelId, participantId)) {
        throw new CodexNativeStoreError(
          'This AgentChat liaison is already connected to a native chat',
          'CODEX_NATIVE_BINDING_CONFLICT',
          409,
        );
      }
      const createdAt = timestamp();
      state.pairings = state.pairings.filter((item) =>
        item.expiresAt > createdAt
        && !(item.channelId === channelId && item.participantId === participantId)
      );
      if (state.pairings.length >= maxPairings) {
        throw new CodexNativeStoreError(
          'Codex Native pairing store is full',
          'CODEX_NATIVE_QUEUE_FULL',
          409,
        );
      }
      const pairingId = randomId();
      const pairingCode = randomId();
      assertRoutingId(pairingId, 'pairingId');
      assertPairingCode(pairingCode);
      const expiresAt = new Date(new Date(createdAt).getTime() + pairingTtlMs).toISOString();
      state.pairings.push({
        pairingId,
        channelId,
        participantId,
        permissionMode,
        pairingCodeHash: pairingCodeHash(pairingCode),
        createdAt,
        expiresAt,
      });
      await save(state);
      return { pairingId, pairingCode, channelId, participantId, permissionMode, expiresAt };
    });
  }

  async function redeemPairing(
    input: CodexNativeRedeemPairingInput,
  ): Promise<CodexNativeBinding> {
    assertPairingCode(input.pairingCode);
    assertRoutingId(input.nativeSessionId, 'nativeSessionId');
    assertRoutingId(input.nativeThreadId, 'nativeThreadId');
    return withFileLock(filePath, async () => {
      const state = await load();
      const candidateHash = pairingCodeHash(input.pairingCode);
      const pairingIndex = state.pairings.findIndex((item) =>
        equalHash(item.pairingCodeHash, candidateHash)
      );
      if (pairingIndex < 0) {
        throw new CodexNativeStoreError(
          'Pairing code is invalid or has already been used',
          'CODEX_NATIVE_PAIRING_INVALID',
          404,
        );
      }
      const pairing = state.pairings[pairingIndex];
      const at = timestamp();
      if (pairing.expiresAt <= at) {
        state.pairings.splice(pairingIndex, 1);
        await save(state);
        throw new CodexNativeStoreError(
          'Pairing code has expired',
          'CODEX_NATIVE_PAIRING_EXPIRED',
          410,
        );
      }
      const binding = bindIntoState(state, {
        channelId: pairing.channelId,
        participantId: pairing.participantId,
        bindingId: randomId(),
        nativeSessionId: input.nativeSessionId,
        nativeThreadId: input.nativeThreadId,
        permissionMode: normalizedPermissionMode(pairing.permissionMode),
      }, at);
      state.pairings.splice(pairingIndex, 1);
      await save(state);
      return binding;
    });
  }

  async function cancelPairing(channelId: string, participantId: string): Promise<void> {
    assertRoutingId(channelId, 'channelId');
    assertRoutingId(participantId, 'participantId');
    await withFileLock(filePath, async () => {
      const state = await load();
      const remaining = state.pairings.filter((item) =>
        item.channelId !== channelId || item.participantId !== participantId
      );
      if (remaining.length === state.pairings.length) return;
      state.pairings = remaining;
      await save(state);
    });
  }

  async function unbind(input: CodexNativeUnbindInput): Promise<CodexNativeBinding> {
    assertBindingInput(input);
    return withFileLock(filePath, async () => {
      const state = await load();
      const current = activeBinding(state, input.channelId, input.participantId);
      if (!current) {
        const alreadyUnbound = state.bindings.find((binding) =>
          binding.bindingId === input.bindingId
          && binding.nativeSessionId === input.nativeSessionId
          && binding.nativeThreadId === input.nativeThreadId
          && Boolean(binding.unboundAt)
        );
        if (alreadyUnbound) return alreadyUnbound;
        throw new CodexNativeStoreError(
          'Codex Native binding not found',
          'CODEX_NATIVE_BINDING_NOT_FOUND',
          404,
        );
      }
      requireBinding(state, input);
      current.unboundAt = timestamp();
      current.lastActiveAt = current.unboundAt;
      await save(state);
      return current;
    });
  }

  async function disconnect(
    channelId: string,
    participantId: string,
  ): Promise<CodexNativeBinding | null> {
    assertRoutingId(channelId, 'channelId');
    assertRoutingId(participantId, 'participantId');
    return withFileLock(filePath, async () => {
      const state = await load();
      const current = activeBinding(state, channelId, participantId);
      if (!current) return null;
      const claimed = state.deliveries.filter((delivery) =>
        delivery.bindingId === current.bindingId && delivery.state === 'claimed'
      );
      if (claimed.some((delivery) =>
        Boolean(delivery.observedStopIdempotencyKey || delivery.stopObservedAt)
      )) {
        throw new CodexNativeStoreError(
          'Wait for the native Codex reply to finish committing before disconnecting',
          'CODEX_NATIVE_CLAIM_CONFLICT',
          409,
        );
      }
      // Disconnect is an explicit user cancellation boundary. A turn that
      // started but never produced a native Stop must not hold the liaison
      // forever: return its origin to the waiting state and invalidate the old
      // correlation so a late Desktop result cannot be forwarded after unbind.
      for (const delivery of claimed) {
        delivery.state = 'waiting';
        delete (delivery as CodexNativeDelivery & { claimToken?: string }).claimToken;
        delete delivery.claimedAt;
        delete delivery.claimExpiresAt;
        delete delivery.outboundCorrelationId;
      }
      current.unboundAt = timestamp();
      current.lastActiveAt = current.unboundAt;
      await save(state);
      return current;
    });
  }

  async function listPending(input: CodexNativeListPendingInput): Promise<CodexNativePendingMessage[]> {
    assertBindingInput(input);
    const messages = await readMessages(input.channelId);
    return withFileLock(filePath, async () => {
      const state = await load();
      const binding = requireBinding(state, input);
      const at = timestamp();
      const changed = synchronize(state, binding, messages.messages, at);
      if (changed) await save(state);
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
      const byId = new Map(messages.messages.map((item) => [item.id, item]));
      return state.deliveries
        .filter((delivery) =>
          delivery.bindingId === binding.bindingId
          && delivery.state === 'waiting'
          && (!input.currentBindingOnly || delivery.originTimestamp >= binding.boundAt)
        )
        .sort((left, right) => {
          // A freshly connected native chat must see its onboarding and
          // current requests before historical work accumulated while no
          // chat was attached. Preserve the backlog, but never let it run in
          // front of work created for this binding.
          const leftIsCurrent = left.originTimestamp >= binding.boundAt;
          const rightIsCurrent = right.originTimestamp >= binding.boundAt;
          if (leftIsCurrent !== rightIsCurrent) return leftIsCurrent ? -1 : 1;
          return left.originTimestamp.localeCompare(right.originTimestamp);
        })
        .slice(0, limit)
        .flatMap((delivery) => {
          const origin = byId.get(delivery.originMessageId);
          if (!origin) return [];
          const attachments: CodexNativePendingAttachment[] = (origin.images ?? []).map((attachment) => ({
            name: attachment.name,
            type: attachment.type,
            ...(attachment.url ? { url: attachment.url } : {}),
            ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
          }));
          if (origin.image) {
            attachments.push({
              name: origin.image.name,
              type: origin.image.type,
              ...(origin.image.url ? { url: origin.image.url } : {}),
            });
          }
          return [{
            ...delivery,
            content: origin.content,
            from: origin.from,
            replyTo: origin.replyTo,
            ...(attachments.length ? { attachments } : {}),
          }];
        });
    });
  }

  async function getInFlight(
    input: CodexNativeBindingIdentity,
  ): Promise<CodexNativeInFlightDelivery | null> {
    assertBindingInput(input);
    return withFileLock(filePath, async () => {
      const state = await load();
      const binding = requireBinding(state, input);
      return state.deliveries.find((delivery) =>
        delivery.bindingId === binding.bindingId
        && (
          delivery.state === 'claimed'
          || (delivery.state === 'acked' && !delivery.outboundIdempotencyKey)
        )
      ) ?? null;
    });
  }

  async function claim(input: CodexNativeClaimInput): Promise<CodexNativeDelivery> {
    assertBindingInput(input);
    assertRoutingId(input.originMessageId, 'originMessageId');
    const messages = await readMessages(input.channelId);
    return withFileLock(filePath, async () => {
      const state = await load();
      const binding = requireBinding(state, input);
      const at = timestamp();
      synchronize(state, binding, messages.messages, at);
      const key = deliveryKey(input.originMessageId, binding.nativeThreadId);
      const delivery = state.deliveries.find((item) => item.idempotencyKey === key);
      if (!delivery) {
        throw new CodexNativeStoreError(
          'Targeted AgentChat message not found',
          'CODEX_NATIVE_MESSAGE_NOT_FOUND',
          404,
        );
      }
      if (delivery.state === 'claimed') {
        await save(state);
        return delivery;
      }
      if (delivery.state === 'acked') return delivery;

      const inFlight = state.deliveries.find((item) =>
        item.bindingId === binding.bindingId
        && item.idempotencyKey !== delivery.idempotencyKey
        && (
          item.state === 'claimed'
          || (item.state === 'acked' && !item.outboundIdempotencyKey)
        )
      );
      if (inFlight) {
        throw new CodexNativeStoreError(
          'Another Codex Native delivery is awaiting acknowledgement or reply',
          'CODEX_NATIVE_CLAIM_CONFLICT',
          409,
        );
      }

      delivery.state = 'claimed';
      delivery.outboundCorrelationId = randomId();
      delivery.claimedAt = at;
      delete delivery.claimExpiresAt;
      delete delivery.observedStopIdempotencyKey;
      delete delivery.stopObservedAt;
      await save(state);
      return delivery;
    });
  }

  async function getDeliveryStatus(
    input: CodexNativeClaimInput,
  ): Promise<CodexNativeDeliveryStatus> {
    assertBindingInput(input);
    assertRoutingId(input.originMessageId, 'originMessageId');
    const messages = await readMessages(input.channelId);
    return withFileLock(filePath, async () => {
      const state = await load();
      const binding = requireBinding(state, input);
      const changed = synchronize(state, binding, messages.messages, timestamp());
      const delivery = state.deliveries.find(
        (item) => item.idempotencyKey === deliveryKey(input.originMessageId, binding.nativeThreadId),
      );
      if (!delivery) {
        throw new CodexNativeStoreError(
          'AgentChat delivery status was not found',
          'CODEX_NATIVE_MESSAGE_NOT_FOUND',
          404,
        );
      }
      if (changed) await save(state);
      return {
        originMessageId: delivery.originMessageId,
        state: delivery.state,
        confirmed: Boolean(delivery.outboundIdempotencyKey),
      };
    });
  }

  async function releaseClaim(
    input: CodexNativeClaimInput,
  ): Promise<CodexNativeDeliveryStatus> {
    assertBindingInput(input);
    assertRoutingId(input.originMessageId, 'originMessageId');
    return withFileLock(filePath, async () => {
      const state = await load();
      const binding = requireBinding(state, input);
      const delivery = state.deliveries.find(
        (item) => item.idempotencyKey === deliveryKey(input.originMessageId, binding.nativeThreadId),
      );
      if (!delivery) {
        throw new CodexNativeStoreError(
          'AgentChat delivery claim was not found',
          'CODEX_NATIVE_MESSAGE_NOT_FOUND',
          404,
        );
      }
      if (
        delivery.state === 'acked'
        || delivery.outboundIdempotencyKey
        || delivery.observedStopIdempotencyKey
      ) {
        throw new CodexNativeStoreError(
          'A native Stop already confirmed this delivery and it cannot be released',
          'CODEX_NATIVE_CLAIM_CONFLICT',
          409,
        );
      }
      if (delivery.state === 'claimed') {
        delivery.state = 'waiting';
        delete (delivery as CodexNativeDelivery & { claimToken?: string }).claimToken;
        delete delivery.claimedAt;
        delete delivery.claimExpiresAt;
        delete delivery.outboundCorrelationId;
        await save(state);
      }
      return {
        originMessageId: delivery.originMessageId,
        state: delivery.state,
        confirmed: false,
      };
    });
  }

  async function transactOutbound<T>(
    input: CodexNativeResolveOutboundInput,
    operation: (resolution: CodexNativeOutboundResolution) => Promise<T>,
  ): Promise<{ resolution: CodexNativeOutboundResolution; result: T }> {
    assertRoutingId(input.nativeSessionId, 'nativeSessionId');
    assertRoutingId(input.turnId, 'turnId');
    assertRoutingId(input.outboundCorrelationId, 'outboundCorrelationId');
    const outboundIdempotencyKey = `${input.nativeSessionId}:${input.turnId}`;
    return withFileLock(filePath, async () => {
      const state = await load();
      const existing = state.deliveries.find(
        (delivery) => delivery.outboundIdempotencyKey === outboundIdempotencyKey,
      );
      const observed = state.deliveries.find(
        (delivery) => delivery.observedStopIdempotencyKey === outboundIdempotencyKey,
      );
      if (
        (existing && existing.outboundCorrelationId !== input.outboundCorrelationId)
        || (observed && observed.outboundCorrelationId !== input.outboundCorrelationId)
      ) {
        throw new CodexNativeStoreError(
          'Codex Native outbound key does not match this AgentChat delivery',
          'CODEX_NATIVE_OUTBOUND_NOT_FOUND',
          404,
        );
      }
      const delivery = existing ?? observed ?? state.deliveries.find((item) =>
        item.nativeSessionId === input.nativeSessionId
        && item.outboundCorrelationId === input.outboundCorrelationId
      );
      if (!delivery) {
        throw new CodexNativeStoreError(
          'No claimed AgentChat message awaits this Codex reply',
          'CODEX_NATIVE_OUTBOUND_NOT_FOUND',
          404,
        );
      }
      if (delivery.state !== 'claimed' && delivery.state !== 'acked') {
        throw new CodexNativeStoreError(
          'The correlated AgentChat delivery is not awaiting native confirmation',
          'CODEX_NATIVE_OUTBOUND_NOT_FOUND',
          404,
        );
      }
      if (
        delivery.outboundIdempotencyKey
        && delivery.outboundIdempotencyKey !== outboundIdempotencyKey
      ) {
        throw new CodexNativeStoreError(
          'AgentChat delivery is already correlated to another Codex turn',
          'CODEX_NATIVE_OUTBOUND_NOT_FOUND',
          404,
        );
      }
      if (
        delivery.observedStopIdempotencyKey
        && delivery.observedStopIdempotencyKey !== outboundIdempotencyKey
      ) {
        throw new CodexNativeStoreError(
          'AgentChat delivery already observed a different Codex turn',
          'CODEX_NATIVE_OUTBOUND_NOT_FOUND',
          404,
        );
      }
      const resolution: CodexNativeOutboundResolution = {
        channelId: delivery.channelId,
        participantId: delivery.participantId,
        bindingId: delivery.bindingId,
        nativeThreadId: delivery.nativeThreadId,
        originMessageId: delivery.originMessageId,
        replyToMessageId: delivery.originMessageId,
        outboundIdempotencyKey,
      };
      if (!delivery.outboundIdempotencyKey && !delivery.observedStopIdempotencyKey) {
        delivery.observedStopIdempotencyKey = outboundIdempotencyKey;
        delivery.stopObservedAt = timestamp();
        await save(state);
      }
      const result = await operation(resolution);
      let changed = false;
      if (delivery.state !== 'acked') {
        delivery.state = 'acked';
        delivery.ackedAt = timestamp();
        delete delivery.claimExpiresAt;
        delete (delivery as CodexNativeDelivery & { claimToken?: string }).claimToken;
        changed = true;
      }
      if (!existing) {
        delivery.outboundIdempotencyKey = outboundIdempotencyKey;
        delivery.outboundResolvedAt = timestamp();
        changed = true;
      }
      if (delivery.observedStopIdempotencyKey || delivery.stopObservedAt) {
        delete delivery.observedStopIdempotencyKey;
        delete delivery.stopObservedAt;
        changed = true;
      }
      if (changed) await save(state);
      return { resolution, result };
    });
  }

  return {
    getBinding,
    listActiveBindings,
    getPairing,
    createPairing,
    redeemPairing,
    cancelPairing,
    bind,
    bindSelected,
    setPermissionMode,
    unbind,
    disconnect,
    getInFlight,
    listPending,
    claim,
    getDeliveryStatus,
    releaseClaim,
    transactOutbound,
  };
}

export const codexNativeStore = createCodexNativeStore();
