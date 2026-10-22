/** Durable per-board state with cross-process locking and atomic CAS transitions. */

import { promises as fs } from 'fs';
import path from 'path';
import { readJsonFile, writeJsonFile } from '@/lib/data-io';
import { computeDesignReferenceSelectionFingerprint } from './fingerprint';
import type { DesignReferenceBoard, DesignReferenceSelection } from './types';
import { appPath } from '@/lib/app-paths';

export type DesignReferenceState =
  | 'awaiting-selection'
  | 'refinement-requested'
  | 'selected'
  | 'superseded';

export interface StoredDesignReferenceRevision {
  board: DesignReferenceBoard;
  humanRecipientIds: string[];
  launcherIdentity: DesignReferenceLauncherIdentity;
  state: DesignReferenceState;
  selection: DesignReferenceSelection | null;
  selectionFingerprint: string | null;
  recordedAt: string;
  updatedAt: string;
}

interface DesignReferenceManifest {
  version: 2;
  boardId: string;
  currentRevision: number;
  revisions: StoredDesignReferenceRevision[];
  lastUpdated: string;
}

export interface StoredDesignReferenceBoard extends StoredDesignReferenceRevision {
  history: StoredDesignReferenceRevision[];
}

export type RecordBoardResult =
  | { ok: true; disposition: 'created' | 'idempotent' | 'superseded'; record: StoredDesignReferenceBoard }
  | { ok: false; error: string };

export type RecordSelectionResult =
  | { ok: true; disposition: 'selected' | 'refinement-requested' | 'idempotent'; record: StoredDesignReferenceBoard }
  | { ok: false; error: string };

export interface SelectionCasContext {
  senderId: string;
  senderType: string;
  channelId: string;
  now?: Date;
}

export interface DesignReferenceLauncherIdentity {
  participantId: string;
  launcherSessionId: string;
  workspacePath: string;
}

export type ActiveDesignReferenceGateLookup =
  | { status: 'none' }
  | { status: 'identity-mismatch'; error: string }
  | { status: 'ambiguous'; error: string }
  | {
      status: 'active';
      identity: DesignReferenceLauncherIdentity;
      createdAt: string;
      authorization: DesignReferenceAuthorization;
    };

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 20;
const BOARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LAUNCHER_SESSION_RE = /^(?:pid:[1-9][0-9]{0,11}|session:[A-Za-z0-9][A-Za-z0-9._:-]{0,255})$/;

function getAppDataDir(): string {
  return appPath('.AppData');
}

export function getDesignReferenceRootPath(): string {
  return path.join(getAppDataDir(), 'reference-discovery');
}

export function getDesignReferenceStorePath(boardId: string): string {
  if (!BOARD_ID_RE.test(boardId)) throw new Error('Invalid design reference board id');
  return path.join(getDesignReferenceRootPath(), boardId, 'manifest.json');
}

function toStored(manifest: DesignReferenceManifest): StoredDesignReferenceBoard {
  const current = manifest.revisions.find(item => item.board.revision === manifest.currentRevision);
  if (!current) throw new Error(`Reference board ${manifest.boardId} has no current revision`);
  return { ...current, history: manifest.revisions };
}

// A remote server may not have the agent's workspace on its own filesystem;
// ENOENT then falls back to the normalised absolute path (still exact-match).
async function canonicalWorkspacePath(workspacePath: string): Promise<string> {
  try {
    return await fs.realpath(workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.normalize(workspacePath);
    throw error;
  }
}

async function normalizeLauncherIdentity(
  identity: DesignReferenceLauncherIdentity,
): Promise<DesignReferenceLauncherIdentity> {
  if (!BOARD_ID_RE.test(identity.participantId)) throw new Error('Invalid design reference participant identity');
  if (!LAUNCHER_SESSION_RE.test(identity.launcherSessionId)) throw new Error('Invalid design reference launcher session');
  if (!path.isAbsolute(identity.workspacePath)) throw new Error('Design reference workspace must be absolute');
  const workspacePath = await canonicalWorkspacePath(identity.workspacePath);
  return { ...identity, workspacePath };
}

function isStoredLauncherIdentity(value: unknown): value is DesignReferenceLauncherIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<DesignReferenceLauncherIdentity>;
  return typeof identity.participantId === 'string'
    && BOARD_ID_RE.test(identity.participantId)
    && typeof identity.launcherSessionId === 'string'
    && LAUNCHER_SESSION_RE.test(identity.launcherSessionId)
    && typeof identity.workspacePath === 'string'
    && path.isAbsolute(identity.workspacePath);
}

async function acquireCrossProcessLock(targetPath: string): Promise<() => Promise<void>> {
  const lockPath = `${targetPath}.lock`;
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.write(`${process.pid}\n${new Date().toISOString()}\n`);
      await handle.close();
      return async () => fs.unlink(lockPath).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        // The other writer released the lock between checks.
      }
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out locking design reference board ${targetPath}`);
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

async function withManifestLock<T>(boardId: string, fn: (storePath: string) => Promise<T>): Promise<T> {
  const storePath = getDesignReferenceStorePath(boardId);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const release = await acquireCrossProcessLock(storePath);
  try {
    return await fn(storePath);
  } finally {
    await release();
  }
}

function sameSelectionDecision(a: DesignReferenceSelection, b: DesignReferenceSelection): boolean {
  return a.boardId === b.boardId
    && a.channelId === b.channelId
    && a.boardRevision === b.boardRevision
    && a.boardFingerprint === b.boardFingerprint
    && a.action === b.action
    && a.candidateIds.join('\0') === b.candidateIds.join('\0')
    && (a.note?.trim() ?? '') === (b.note?.trim() ?? '')
    && a.answeredBy === b.answeredBy;
}

export async function recordDesignReferenceBoard(
  board: DesignReferenceBoard,
  humanRecipientIds: readonly string[],
  launcherIdentity: DesignReferenceLauncherIdentity,
): Promise<RecordBoardResult> {
  const audience = Array.from(new Set(humanRecipientIds.filter(Boolean))).sort();
  if (audience.length === 0) return { ok: false, error: 'board requires at least one human recipient' };

  let normalizedIdentity: DesignReferenceLauncherIdentity;
  try {
    normalizedIdentity = await normalizeLauncherIdentity(launcherIdentity);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid launcher identity' };
  }
  if (normalizedIdentity.participantId !== board.createdBy.participantId) {
    return { ok: false, error: 'launcher participant does not match the board creator' };
  }

  return withManifestLock(board.id, async storePath => {
    const existing = await readJsonFile<DesignReferenceManifest | null>(storePath, null);
    const now = new Date().toISOString();
    if (!existing) {
      if (board.revision !== 1) return { ok: false, error: 'a new board must start at revision 1' };
      const revision: StoredDesignReferenceRevision = {
        board,
        humanRecipientIds: audience,
        launcherIdentity: normalizedIdentity,
        state: 'awaiting-selection',
        selection: null,
        selectionFingerprint: null,
        recordedAt: now,
        updatedAt: now,
      };
      const manifest: DesignReferenceManifest = {
        version: 2,
        boardId: board.id,
        currentRevision: 1,
        revisions: [revision],
        lastUpdated: now,
      };
      await writeJsonFile(storePath, manifest);
      return { ok: true, disposition: 'created', record: toStored(manifest) };
    }

    const current = toStored(existing);
    if (board.channelId !== current.board.channelId || board.createdBy.participantId !== current.board.createdBy.participantId) {
      return { ok: false, error: 'board channel and creator are immutable' };
    }
    if (board.revision === current.board.revision && board.fingerprint === current.board.fingerprint) {
      const currentRevision = existing.revisions.find(item => item.board.revision === existing.currentRevision)!;
      currentRevision.launcherIdentity = normalizedIdentity;
      currentRevision.updatedAt = now;
      existing.lastUpdated = now;
      await writeJsonFile(storePath, existing);
      return { ok: true, disposition: 'idempotent', record: toStored(existing) };
    }
    if (current.state === 'selected') return { ok: false, error: 'a selected board cannot be revised' };
    if (board.revision !== current.board.revision + 1) {
      return { ok: false, error: `board revision conflict; expected ${current.board.revision + 1}` };
    }

    const previous = existing.revisions.find(item => item.board.revision === current.board.revision)!;
    previous.state = 'superseded';
    previous.updatedAt = now;
    existing.revisions.push({
      board,
      humanRecipientIds: audience,
      launcherIdentity: normalizedIdentity,
      state: 'awaiting-selection',
      selection: null,
      selectionFingerprint: null,
      recordedAt: now,
      updatedAt: now,
    });
    existing.currentRevision = board.revision;
    existing.lastUpdated = now;
    await writeJsonFile(storePath, existing);
    return { ok: true, disposition: 'superseded', record: toStored(existing) };
  });
}

function authorizationForRecord(record: StoredDesignReferenceBoard, now: Date): DesignReferenceAuthorization {
  const unexpired = now.getTime() < Date.parse(record.board.expiresAt);
  const unlocked = unexpired
    && record.state === 'selected'
    && Boolean(record.selectionFingerprint);
  return {
    boardId: record.board.id,
    channelId: record.board.channelId,
    revision: record.board.revision,
    boardFingerprint: record.board.fingerprint,
    createdByParticipantId: record.board.createdBy.participantId,
    expiresAt: record.board.expiresAt,
    state: record.state,
    implementationUnlocked: unlocked,
    selectionFingerprint: unlocked ? record.selectionFingerprint : null,
  };
}

export async function findActiveDesignReferenceGate(
  workspacePath: string,
  launcherSessionIds: readonly string[],
  now: Date = new Date(),
): Promise<ActiveDesignReferenceGateLookup> {
  let canonicalWorkspace: string;
  try {
    if (!path.isAbsolute(workspacePath)) throw new Error('workspace must be absolute');
    canonicalWorkspace = await canonicalWorkspacePath(workspacePath);
  } catch {
    return { status: 'identity-mismatch', error: 'canonical workspace identity is unavailable' };
  }
  const sessions = new Set(launcherSessionIds.filter(value => LAUNCHER_SESSION_RE.test(value)));
  if (sessions.size === 0) {
    return { status: 'identity-mismatch', error: 'launcher session identity is unavailable' };
  }

  let entries: Array<import('fs').Dirent>;
  try {
    entries = await fs.readdir(getDesignReferenceRootPath(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'none' };
    return { status: 'ambiguous', error: 'active gate store is unavailable' };
  }

  const workspaceRecords: StoredDesignReferenceBoard[] = [];
  let unreadableManifest = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !BOARD_ID_RE.test(entry.name)) continue;
    const manifestPath = getDesignReferenceStorePath(entry.name);
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as DesignReferenceManifest;
      const record = toStored(manifest);
      // A legacy/malformed record cannot safely prove that this workspace has
      // no active gate. Treat it as global ambiguity until it is migrated by a
      // server-correlated board write rather than silently returning `none`.
      if (!isStoredLauncherIdentity(record.launcherIdentity)) {
        unreadableManifest = true;
        continue;
      }
      if (record.launcherIdentity.workspacePath === canonicalWorkspace) workspaceRecords.push(record);
    } catch {
      unreadableManifest = true;
    }
  }
  if (unreadableManifest) {
    return { status: 'ambiguous', error: 'one or more active gate manifests are unreadable' };
  }
  if (workspaceRecords.length === 0) return { status: 'none' };

  const matching = workspaceRecords.filter(record => sessions.has(record.launcherIdentity.launcherSessionId));
  if (matching.length === 0) {
    return { status: 'identity-mismatch', error: 'workspace has a gate bound to another launcher session' };
  }
  matching.sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt));
  if (matching.length > 1 && matching[0].recordedAt === matching[1].recordedAt) {
    return { status: 'ambiguous', error: 'multiple active gates have the same server ordering time' };
  }
  const record = matching[0];
  return {
    status: 'active',
    identity: record.launcherIdentity,
    createdAt: record.board.createdAt,
    authorization: authorizationForRecord(record, now),
  };
}

export async function getDesignReferenceBoard(boardId: string): Promise<StoredDesignReferenceBoard | null> {
  const manifest = await readJsonFile<DesignReferenceManifest | null>(getDesignReferenceStorePath(boardId), null);
  return manifest ? toStored(manifest) : null;
}

export async function recordDesignReferenceSelection(
  selection: DesignReferenceSelection,
  context: SelectionCasContext,
): Promise<RecordSelectionResult> {
  return withManifestLock(selection.boardId, async storePath => {
    const manifest = await readJsonFile<DesignReferenceManifest | null>(storePath, null);
    if (!manifest) return { ok: false, error: 'board was not found' };
    const record = toStored(manifest);
    const now = context.now ?? new Date();

    if (context.senderType !== 'user') return { ok: false, error: 'selection sender must be a human participant' };
    if (selection.answeredBy !== context.senderId) return { ok: false, error: 'selection.answeredBy does not match the sender' };
    if (!record.humanRecipientIds.includes(context.senderId)) {
      return { ok: false, error: 'selection sender was not an authorized board recipient' };
    }
    if (context.channelId !== record.board.channelId || selection.channelId !== record.board.channelId) {
      return { ok: false, error: 'selection channel does not match the active board' };
    }
    if (selection.boardRevision !== record.board.revision || selection.boardFingerprint !== record.board.fingerprint) {
      return { ok: false, error: 'selection targets a stale board revision or fingerprint' };
    }
    if (now.getTime() > Date.parse(record.board.expiresAt)) {
      return { ok: false, error: 'selection targets an expired board' };
    }
    const knownIds = new Set(record.board.candidates.map(candidate => candidate.id));
    if (selection.candidateIds.some(id => !knownIds.has(id))) {
      return { ok: false, error: 'selection contains a candidate that is not on the board' };
    }
    if (record.selection) {
      if (!sameSelectionDecision(record.selection, selection)) {
        return { ok: false, error: 'board has already been answered' };
      }
      return { ok: true, disposition: 'idempotent', record };
    }
    if (record.state !== 'awaiting-selection') {
      return { ok: false, error: `board is ${record.state}` };
    }

    const selectionFingerprint = selection.action === 'refine'
      ? null
      : computeDesignReferenceSelectionFingerprint(record.board, selection);
    const storedSelection = selectionFingerprint ? { ...selection, selectionFingerprint } : selection;
    const current = manifest.revisions.find(item => item.board.revision === manifest.currentRevision)!;
    current.selection = storedSelection;
    current.selectionFingerprint = selectionFingerprint;
    current.state = selection.action === 'refine' ? 'refinement-requested' : 'selected';
    current.updatedAt = now.toISOString();
    manifest.lastUpdated = current.updatedAt;
    await writeJsonFile(storePath, manifest);
    return {
      ok: true,
      disposition: selection.action === 'refine' ? 'refinement-requested' : 'selected',
      record: toStored(manifest),
    };
  });
}

export interface DesignReferenceAuthorization {
  boardId: string;
  channelId: string;
  revision: number;
  boardFingerprint: string;
  createdByParticipantId: string;
  expiresAt: string;
  state: DesignReferenceState;
  implementationUnlocked: boolean;
  selectionFingerprint: string | null;
}

export async function getDesignReferenceAuthorization(
  boardId: string,
  expected: { channelId: string; revision: number; boardFingerprint: string },
  now: Date = new Date(),
): Promise<DesignReferenceAuthorization | null> {
  const record = await getDesignReferenceBoard(boardId);
  if (!record) return null;
  const correlated = expected.channelId === record.board.channelId
    && expected.revision === record.board.revision
    && expected.boardFingerprint === record.board.fingerprint;
  const authorization = authorizationForRecord(record, now);
  if (!correlated) {
    authorization.implementationUnlocked = false;
    authorization.selectionFingerprint = null;
  }
  return authorization;
}
