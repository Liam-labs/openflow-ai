/** Structured visual-reference board carried over Collab metadata.client. */

export const DESIGN_REFERENCE_BOARD_KIND = 'design-reference.board' as const;
export const DESIGN_REFERENCE_SELECTION_KIND = 'design-reference.selection' as const;

export const MIN_DESIGN_REFERENCE_CANDIDATES = 5;
export const MAX_DESIGN_REFERENCE_CANDIDATES = 15;
export const MAX_COMBINED_REFERENCES = 3;
export const MAX_DESIGN_REFERENCE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

export type DesignReferenceUseMode =
  | 'inspiration-only'
  | 'purchase-and-adapt'
  | 'open-source-base';

export type DesignReferenceLicenceStatus =
  | 'clear'
  | 'purchase-required'
  | 'unclear';

export interface DesignReferenceCandidate {
  id: string;
  title: string;
  source: string;
  creator?: string;
  itemUrl: string;
  previewUrl: string;
  imageUrl: string;
  capturedAt: string;
  price?: { amount: number; currency: string };
  popularity?: {
    label: string;
    value: string;
    confidence: 'high' | 'medium' | 'low';
  };
  platform: string;
  stack: string[];
  licence: {
    status: DesignReferenceLicenceStatus;
    summary: string;
    url?: string;
  };
  useMode: DesignReferenceUseMode;
  fitScore: number;
  fitReasons: string[];
  tradeoff: string;
}

export interface DesignReferenceBoardCreator {
  participantId: string;
  name: string;
}

export interface DesignReferenceBoard {
  id: string;
  channelId: string;
  revision: number;
  fingerprint: string;
  projectId?: string;
  brief: string;
  shortlistSize: number;
  candidates: DesignReferenceCandidate[];
  createdBy: DesignReferenceBoardCreator;
  createdAt: string;
  expiresAt: string;
}

export type DesignReferenceSelectionAction = 'use-one' | 'combine' | 'refine';

export interface DesignReferenceSelection {
  boardId: string;
  channelId: string;
  boardRevision: number;
  boardFingerprint: string;
  action: DesignReferenceSelectionAction;
  candidateIds: string[];
  note?: string;
  answeredBy: string;
  answeredAt: string;
  /** Server-issued implementation resume token. Clients must not submit it. */
  selectionFingerprint?: string;
}

export interface DesignReferenceBoardEnvelope {
  kind: typeof DESIGN_REFERENCE_BOARD_KIND;
  payload: DesignReferenceBoard;
}

export interface DesignReferenceSelectionEnvelope {
  kind: typeof DESIGN_REFERENCE_SELECTION_KIND;
  payload: DesignReferenceSelection;
}

export type DesignReferenceClientMetadata =
  | DesignReferenceBoardEnvelope
  | DesignReferenceSelectionEnvelope;

export type DesignReferenceParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const USE_MODES = new Set<DesignReferenceUseMode>([
  'inspiration-only',
  'purchase-and-adapt',
  'open-source-base',
]);
const LICENCE_STATUSES = new Set<DesignReferenceLicenceStatus>([
  'clear',
  'purchase-required',
  'unclear',
]);
const POPULARITY_CONFIDENCE = new Set(['high', 'medium', 'low']);
const SELECTION_ACTIONS = new Set<DesignReferenceSelectionAction>([
  'use-one',
  'combine',
  'refine',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isHttpsUrl(value: unknown): value is string {
  if (!isHttpUrl(value)) return false;
  return new URL(value).protocol === 'https:';
}

function validateCandidate(value: unknown, index: number): string | null {
  const prefix = `candidates[${index}]`;
  if (!isRecord(value)) return `${prefix} must be an object`;
  if (!isId(value.id)) return `${prefix}.id is invalid`;
  if (!isBoundedString(value.title, 1, 160)) return `${prefix}.title is invalid`;
  if (!isBoundedString(value.source, 1, 80)) return `${prefix}.source is invalid`;
  if (value.creator !== undefined && !isBoundedString(value.creator, 1, 120)) {
    return `${prefix}.creator is invalid`;
  }
  for (const field of ['itemUrl', 'previewUrl'] as const) {
    if (!isHttpUrl(value[field])) return `${prefix}.${field} must be an HTTP(S) URL`;
  }
  if (!isHttpsUrl(value.imageUrl)) return `${prefix}.imageUrl must be an HTTPS URL`;
  if (!isIsoDate(value.capturedAt)) return `${prefix}.capturedAt is invalid`;
  if (!isBoundedString(value.platform, 1, 80)) return `${prefix}.platform is invalid`;
  if (!Array.isArray(value.stack) || value.stack.length > 12 || value.stack.some(s => !isBoundedString(s, 1, 60))) {
    return `${prefix}.stack is invalid`;
  }
  if (typeof value.fitScore !== 'number' || !Number.isFinite(value.fitScore) || value.fitScore < 0 || value.fitScore > 100) {
    return `${prefix}.fitScore must be between 0 and 100`;
  }
  if (!Array.isArray(value.fitReasons) || value.fitReasons.length < 1 || value.fitReasons.length > 5 || value.fitReasons.some(r => !isBoundedString(r, 1, 240))) {
    return `${prefix}.fitReasons must contain 1-5 concise reasons`;
  }
  if (!isBoundedString(value.tradeoff, 1, 320)) return `${prefix}.tradeoff is invalid`;
  if (!USE_MODES.has(value.useMode as DesignReferenceUseMode)) return `${prefix}.useMode is invalid`;

  if (!isRecord(value.licence)) return `${prefix}.licence must be an object`;
  const licenceStatus = value.licence.status as DesignReferenceLicenceStatus;
  if (!LICENCE_STATUSES.has(licenceStatus)) return `${prefix}.licence.status is invalid`;
  if (!isBoundedString(value.licence.summary, 1, 320)) return `${prefix}.licence.summary is invalid`;
  if (value.licence.url !== undefined && !isHttpUrl(value.licence.url)) {
    return `${prefix}.licence.url must be an HTTP(S) URL`;
  }
  if (licenceStatus === 'unclear' && value.useMode !== 'inspiration-only') {
    return `${prefix} has an unclear licence and must be inspiration-only`;
  }
  if (value.useMode === 'open-source-base' && licenceStatus !== 'clear') {
    return `${prefix} must have a clear licence to be an open-source base`;
  }

  if (value.price !== undefined) {
    if (!isRecord(value.price)) return `${prefix}.price must be an object`;
    if (typeof value.price.amount !== 'number' || !Number.isFinite(value.price.amount) || value.price.amount < 0 || value.price.amount > 1_000_000) {
      return `${prefix}.price.amount is invalid`;
    }
    if (typeof value.price.currency !== 'string' || !CURRENCY_RE.test(value.price.currency)) {
      return `${prefix}.price.currency must be a three-letter uppercase code`;
    }
  }

  if (value.popularity !== undefined) {
    if (!isRecord(value.popularity)) return `${prefix}.popularity must be an object`;
    if (!isBoundedString(value.popularity.label, 1, 80)) return `${prefix}.popularity.label is invalid`;
    if (!isBoundedString(value.popularity.value, 1, 80)) return `${prefix}.popularity.value is invalid`;
    if (!POPULARITY_CONFIDENCE.has(value.popularity.confidence as string)) {
      return `${prefix}.popularity.confidence is invalid`;
    }
  }

  return null;
}

export function parseDesignReferenceBoard(value: unknown): DesignReferenceParseResult<DesignReferenceBoard> {
  if (!isRecord(value)) return { ok: false, error: 'board payload must be an object' };
  if (!isId(value.id)) return { ok: false, error: 'board.id is invalid' };
  if (!isId(value.channelId)) return { ok: false, error: 'board.channelId is invalid' };
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    return { ok: false, error: 'board.revision must be a positive integer' };
  }
  if (typeof value.fingerprint !== 'string' || !SHA256_RE.test(value.fingerprint)) {
    return { ok: false, error: 'board.fingerprint must be a lowercase SHA-256 hash' };
  }
  if (value.projectId !== undefined && !isBoundedString(value.projectId, 1, 200)) {
    return { ok: false, error: 'board.projectId is invalid' };
  }
  if (!isBoundedString(value.brief, 1, 1_500)) return { ok: false, error: 'board.brief is invalid' };
  if (!Array.isArray(value.candidates)) return { ok: false, error: 'board.candidates must be an array' };
  if (value.candidates.length < MIN_DESIGN_REFERENCE_CANDIDATES || value.candidates.length > MAX_DESIGN_REFERENCE_CANDIDATES) {
    return { ok: false, error: `board.candidates must contain ${MIN_DESIGN_REFERENCE_CANDIDATES}-${MAX_DESIGN_REFERENCE_CANDIDATES} items` };
  }
  if (value.shortlistSize !== value.candidates.length) {
    return { ok: false, error: 'board.shortlistSize must equal candidates.length' };
  }
  const ids = new Set<string>();
  for (let i = 0; i < value.candidates.length; i += 1) {
    const error = validateCandidate(value.candidates[i], i);
    if (error) return { ok: false, error };
    const id = (value.candidates[i] as { id: string }).id;
    if (ids.has(id)) return { ok: false, error: `candidate id ${id} is duplicated` };
    ids.add(id);
  }
  if (!isRecord(value.createdBy) || !isId(value.createdBy.participantId) || !isBoundedString(value.createdBy.name, 1, 80)) {
    return { ok: false, error: 'board.createdBy is invalid' };
  }
  if (!isIsoDate(value.createdAt)) return { ok: false, error: 'board.createdAt is invalid' };
  if (!isIsoDate(value.expiresAt)) return { ok: false, error: 'board.expiresAt is invalid' };
  const createdAt = Date.parse(value.createdAt as string);
  const expiresAt = Date.parse(value.expiresAt as string);
  if (expiresAt <= createdAt || expiresAt - createdAt > MAX_DESIGN_REFERENCE_LIFETIME_MS) {
    return { ok: false, error: 'board.expiresAt must be after creation and within the maximum lifetime' };
  }
  if (JSON.stringify(value).length > 100_000) return { ok: false, error: 'board payload is too large' };
  return { ok: true, value: value as unknown as DesignReferenceBoard };
}

export function parseDesignReferenceSelection(value: unknown): DesignReferenceParseResult<DesignReferenceSelection> {
  if (!isRecord(value)) return { ok: false, error: 'selection payload must be an object' };
  if (!isId(value.boardId)) return { ok: false, error: 'selection.boardId is invalid' };
  if (!isId(value.channelId)) return { ok: false, error: 'selection.channelId is invalid' };
  if (!Number.isSafeInteger(value.boardRevision) || (value.boardRevision as number) < 1) {
    return { ok: false, error: 'selection.boardRevision must be a positive integer' };
  }
  if (typeof value.boardFingerprint !== 'string' || !SHA256_RE.test(value.boardFingerprint)) {
    return { ok: false, error: 'selection.boardFingerprint must be a lowercase SHA-256 hash' };
  }
  if (!SELECTION_ACTIONS.has(value.action as DesignReferenceSelectionAction)) {
    return { ok: false, error: 'selection.action is invalid' };
  }
  if (!Array.isArray(value.candidateIds) || value.candidateIds.some(id => !isId(id))) {
    return { ok: false, error: 'selection.candidateIds is invalid' };
  }
  if (new Set(value.candidateIds).size !== value.candidateIds.length) {
    return { ok: false, error: 'selection.candidateIds must be unique' };
  }
  if (value.action === 'use-one' && value.candidateIds.length !== 1) {
    return { ok: false, error: 'use-one requires exactly one candidate' };
  }
  if (value.action === 'combine' && (value.candidateIds.length < 2 || value.candidateIds.length > MAX_COMBINED_REFERENCES)) {
    return { ok: false, error: `combine requires 2-${MAX_COMBINED_REFERENCES} candidates` };
  }
  if (value.action === 'refine' && value.candidateIds.length !== 0) {
    return { ok: false, error: 'refine does not accept candidate ids' };
  }
  if (value.note !== undefined && !isBoundedString(value.note, 1, 1_000)) {
    return { ok: false, error: 'selection.note is invalid' };
  }
  if (!isId(value.answeredBy)) return { ok: false, error: 'selection.answeredBy is invalid' };
  if (!isIsoDate(value.answeredAt)) return { ok: false, error: 'selection.answeredAt is invalid' };
  if (value.selectionFingerprint !== undefined
    && (typeof value.selectionFingerprint !== 'string' || !SHA256_RE.test(value.selectionFingerprint))) {
    return { ok: false, error: 'selection.selectionFingerprint must be a lowercase SHA-256 hash' };
  }
  return { ok: true, value: value as unknown as DesignReferenceSelection };
}

export function isDesignReferenceBoardEnvelope(value: unknown): value is DesignReferenceBoardEnvelope {
  return isRecord(value)
    && value.kind === DESIGN_REFERENCE_BOARD_KIND
    && parseDesignReferenceBoard(value.payload).ok;
}

export function isDesignReferenceSelectionEnvelope(value: unknown): value is DesignReferenceSelectionEnvelope {
  return isRecord(value)
    && value.kind === DESIGN_REFERENCE_SELECTION_KIND
    && parseDesignReferenceSelection(value.payload).ok;
}

export function isDesignReferenceMetadataKind(value: unknown): boolean {
  return isRecord(value)
    && (value.kind === DESIGN_REFERENCE_BOARD_KIND || value.kind === DESIGN_REFERENCE_SELECTION_KIND);
}
