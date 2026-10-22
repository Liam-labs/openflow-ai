import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { getProjectById as defaultGetProjectById } from '@/lib/config';
import { DataPaths } from '@/lib/data-paths';
import {
  parseDeliveryEvidenceReceipt,
  parseVerificationProfile,
} from '@/lib/delivery-evidence/schema';
import type {
  DeliveryEvidenceReceipt,
  VerificationProfile,
} from '@/lib/delivery-evidence/types';

const STORAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const PROFILE_RELATIVE_PATH = path.join('.devflow', 'delivery-evidence.yaml');

export const DELIVERY_EVIDENCE_POLICY_FLOOR = Object.freeze({
  version: 'delivery-evidence-floor/v1',
  registeredExecutorsOnly: true,
  loopbackPreviewOnly: true,
  immutableReceipts: true,
  secretReferencesOnly: true,
  policyMode: 'advisory',
});

export type DeliveryEvidenceStoreErrorCode =
  | 'DELIVERY_EVIDENCE_INVALID_RECEIPT'
  | 'DELIVERY_EVIDENCE_RECEIPT_EXISTS'
  | 'DELIVERY_EVIDENCE_RECEIPT_NOT_FOUND'
  | 'DELIVERY_EVIDENCE_PROJECT_NOT_FOUND'
  | 'DELIVERY_EVIDENCE_INVALID_CONFIG'
  | 'DELIVERY_EVIDENCE_INVALID_STORAGE_ID'
  | 'DELIVERY_EVIDENCE_ARTIFACT_EXISTS'
  | 'DELIVERY_EVIDENCE_ARTIFACT_NOT_FOUND'
  | 'DELIVERY_EVIDENCE_STORAGE_FAILED';

export class DeliveryEvidenceStoreError extends Error {
  constructor(
    message: string,
    public readonly code: DeliveryEvidenceStoreErrorCode,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'DeliveryEvidenceStoreError';
  }
}

export interface ResolvedVerificationProfile {
  profile: VerificationProfile;
  fingerprint: string;
  projectPath: string;
  profilePath: string;
  policyFloorVersion: string;
}

export interface StoredEvidenceArtifact {
  path: string;
  uri: string;
  sha256: string;
  byteSize: number;
}

interface RegisteredProject {
  id: string;
  path: string;
}

export interface DeliveryEvidenceStoreOptions {
  rootDir?: string;
  getProjectById?: (id: string) => Promise<RegisteredProject | undefined>;
  policyFloorVersion?: string;
  resolveSecretReference?: (reference: string) => string | undefined;
  knownSecretValues?: () => string[];
}

export interface LoadVerificationProfileInput {
  projectId: string;
  projectPath: string;
  expectedVersion?: string;
}

export interface WriteArtifactInput {
  projectId: string;
  receiptId: string;
  artifactId: string;
  extension: 'png' | 'json' | 'txt';
  data: Buffer | string;
}

export interface ReadArtifactInput {
  projectId: string;
  receiptId: string;
  fileName: string;
}

export interface StoredArtifactData {
  data: Buffer;
  sha256: string;
  byteSize: number;
}

function assertStorageId(value: string, label: string): void {
  if (!STORAGE_ID_PATTERN.test(value)) {
    throw new DeliveryEvidenceStoreError(
      `${label} is not safe for Delivery Evidence storage`,
      'DELIVERY_EVIDENCE_INVALID_STORAGE_ID',
      400,
    );
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

async function writeExclusive(filePath: string, data: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
      handle = undefined;
      await fs.unlink(filePath).catch(() => undefined);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function createDeliveryEvidenceStore(options: DeliveryEvidenceStoreOptions = {}) {
  const rootDir = options.rootDir ?? DataPaths.deliveryEvidence;
  const getProjectById = options.getProjectById ?? defaultGetProjectById;
  const policyFloorVersion = options.policyFloorVersion ?? DELIVERY_EVIDENCE_POLICY_FLOOR.version;
  const resolveSecretReference = options.resolveSecretReference
    ?? ((reference: string) => process.env[reference]);
  const knownSecretValues = options.knownSecretValues ?? (() =>
    Object.entries(process.env)
      .filter(([name, value]) =>
        Boolean(value)
        && /(?:^|_)(?:secret|token|password|api_key|private_key|access_key|client_secret)(?:$|_)/i
          .test(name)
      )
      .map(([, value]) => value as string)
  );

  function receiptPath(projectId: string, receiptId: string): string {
    assertStorageId(projectId, 'projectId');
    assertStorageId(receiptId, 'receiptId');
    return path.join(rootDir, projectId, 'receipts', `${receiptId}.json`);
  }

  async function writeReceipt(input: unknown): Promise<DeliveryEvidenceReceipt> {
    let receipt: DeliveryEvidenceReceipt;
    try {
      receipt = parseDeliveryEvidenceReceipt(input);
    } catch {
      throw new DeliveryEvidenceStoreError(
        'Receipt does not satisfy the Delivery Evidence contract',
        'DELIVERY_EVIDENCE_INVALID_RECEIPT',
        400,
      );
    }

    const serializedReceipt = JSON.stringify(receipt);
    const rawSecretValues = new Set(knownSecretValues());
    for (const reference of receipt.environment.secretRefs) {
      const rawValue = resolveSecretReference(reference);
      if (rawValue) rawSecretValues.add(rawValue);
    }
    for (const rawValue of rawSecretValues) {
      if (rawValue && rawValue.length >= 8 && serializedReceipt.includes(rawValue)) {
        throw new DeliveryEvidenceStoreError(
          'Receipt contains a raw value for a declared secret reference',
          'DELIVERY_EVIDENCE_INVALID_RECEIPT',
          400,
        );
      }
    }

    const target = receiptPath(receipt.projectId, receipt.id);
    try {
      await writeExclusive(target, `${JSON.stringify(receipt, null, 2)}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new DeliveryEvidenceStoreError(
          'Receipt already exists and is immutable',
          'DELIVERY_EVIDENCE_RECEIPT_EXISTS',
          409,
        );
      }
      if (error instanceof DeliveryEvidenceStoreError) throw error;
      throw new DeliveryEvidenceStoreError(
        'Unable to persist Delivery Evidence receipt',
        'DELIVERY_EVIDENCE_STORAGE_FAILED',
        500,
      );
    }
    return receipt;
  }

  async function readReceipt(projectId: string, receiptId: string): Promise<DeliveryEvidenceReceipt> {
    const target = receiptPath(projectId, receiptId);
    try {
      const raw = await fs.readFile(target, 'utf8');
      return parseDeliveryEvidenceReceipt(JSON.parse(raw));
    } catch (error) {
      if (error instanceof DeliveryEvidenceStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DeliveryEvidenceStoreError(
          'Receipt not found',
          'DELIVERY_EVIDENCE_RECEIPT_NOT_FOUND',
          404,
        );
      }
      throw new DeliveryEvidenceStoreError(
        'Stored receipt is unreadable',
        'DELIVERY_EVIDENCE_STORAGE_FAILED',
        500,
      );
    }
  }

  async function findReceiptById(receiptId: string): Promise<DeliveryEvidenceReceipt> {
    assertStorageId(receiptId, 'receiptId');
    let projects: string[];
    try {
      projects = await fs.readdir(rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DeliveryEvidenceStoreError(
          'Receipt not found',
          'DELIVERY_EVIDENCE_RECEIPT_NOT_FOUND',
          404,
        );
      }
      throw error;
    }

    for (const projectId of projects) {
      if (!STORAGE_ID_PATTERN.test(projectId)) continue;
      try {
        return await readReceipt(projectId, receiptId);
      } catch (error) {
        if (
          error instanceof DeliveryEvidenceStoreError
          && error.code === 'DELIVERY_EVIDENCE_RECEIPT_NOT_FOUND'
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new DeliveryEvidenceStoreError(
      'Receipt not found',
      'DELIVERY_EVIDENCE_RECEIPT_NOT_FOUND',
      404,
    );
  }

  async function loadVerificationProfile(
    input: LoadVerificationProfileInput,
  ): Promise<ResolvedVerificationProfile> {
    const registered = await getProjectById(input.projectId);
    if (!registered?.path) {
      throw new DeliveryEvidenceStoreError(
        'Registered project not found',
        'DELIVERY_EVIDENCE_PROJECT_NOT_FOUND',
        404,
      );
    }

    let registeredPath: string;
    let requestedPath: string;
    try {
      [registeredPath, requestedPath] = await Promise.all([
        fs.realpath(registered.path),
        fs.realpath(input.projectPath),
      ]);
    } catch {
      throw new DeliveryEvidenceStoreError(
        'Registered project path not found',
        'DELIVERY_EVIDENCE_PROJECT_NOT_FOUND',
        404,
      );
    }
    if (registered.id !== input.projectId || registeredPath !== requestedPath) {
      throw new DeliveryEvidenceStoreError(
        'Project ID and path do not match the registered project',
        'DELIVERY_EVIDENCE_PROJECT_NOT_FOUND',
        404,
      );
    }

    const profilePath = path.join(registeredPath, PROFILE_RELATIVE_PATH);
    let profile: VerificationProfile;
    try {
      const raw = await fs.readFile(profilePath, 'utf8');
      profile = parseVerificationProfile(parseYaml(raw));
    } catch {
      throw new DeliveryEvidenceStoreError(
        'Project verification profile is missing or invalid',
        'DELIVERY_EVIDENCE_INVALID_CONFIG',
        400,
      );
    }

    if (
      profile.project.id !== input.projectId
      || (input.expectedVersion && profile.profile.version !== input.expectedVersion)
    ) {
      throw new DeliveryEvidenceStoreError(
        'Project verification profile identity does not match the request',
        'DELIVERY_EVIDENCE_INVALID_CONFIG',
        400,
      );
    }

    const fingerprint = sha256(canonicalJson({
      policyFloor: {
        ...DELIVERY_EVIDENCE_POLICY_FLOOR,
        version: policyFloorVersion,
      },
      profile,
    }));

    return {
      profile,
      fingerprint,
      projectPath: registeredPath,
      profilePath,
      policyFloorVersion,
    };
  }

  async function writeArtifact(input: WriteArtifactInput): Promise<StoredEvidenceArtifact> {
    assertStorageId(input.projectId, 'projectId');
    assertStorageId(input.receiptId, 'receiptId');
    assertStorageId(input.artifactId, 'artifactId');
    const fileName = `${input.artifactId}.${input.extension}`;
    const target = path.join(
      rootDir,
      input.projectId,
      'artifacts',
      input.receiptId,
      fileName,
    );
    const data = typeof input.data === 'string' ? Buffer.from(input.data, 'utf8') : input.data;
    try {
      await writeExclusive(target, data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new DeliveryEvidenceStoreError(
          'Artifact already exists and is immutable',
          'DELIVERY_EVIDENCE_ARTIFACT_EXISTS',
          409,
        );
      }
      throw new DeliveryEvidenceStoreError(
        'Unable to persist Delivery Evidence artifact',
        'DELIVERY_EVIDENCE_STORAGE_FAILED',
        500,
      );
    }
    return {
      path: target,
      uri: `delivery-evidence://${input.projectId}/${input.receiptId}/${fileName}`,
      sha256: sha256(data),
      byteSize: data.byteLength,
    };
  }

  async function readArtifact(input: ReadArtifactInput): Promise<StoredArtifactData> {
    assertStorageId(input.projectId, 'projectId');
    assertStorageId(input.receiptId, 'receiptId');
    assertStorageId(input.fileName, 'fileName');
    const target = path.join(rootDir, input.projectId, 'artifacts', input.receiptId, input.fileName);
    try {
      const data = await fs.readFile(target);
      return { data, sha256: sha256(data), byteSize: data.byteLength };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DeliveryEvidenceStoreError(
          'Artifact not found',
          'DELIVERY_EVIDENCE_ARTIFACT_NOT_FOUND',
          404,
        );
      }
      throw new DeliveryEvidenceStoreError(
        'Stored artifact is unreadable',
        'DELIVERY_EVIDENCE_STORAGE_FAILED',
        500,
      );
    }
  }

  return {
    rootDir,
    receiptPath,
    writeReceipt,
    readReceipt,
    findReceiptById,
    loadVerificationProfile,
    writeArtifact,
    readArtifact,
  };
}

export const deliveryEvidenceStore = createDeliveryEvidenceStore();
