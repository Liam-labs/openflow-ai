/**
 * SystemOwnership — per-agent declaration of the systems an agent owns, plus
 * pointers (KBs, guides, skills, key directories) for each. Lives at
 * `<workingDirectory>/SystemOwnership.json`, read at agent session start and
 * served to the AgentChat config cog via roster_system_ownership_read.
 *
 * The reader is graceful-empty by contract: a missing or malformed file
 * resolves to `{ systems: [] }` and NEVER throws — a broken/absent file must
 * not break the cog panel or an agent's startup.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { withFileLock, writeJsonFile } from '@/lib/data-io';

export interface OwnedSystem {
  name: string;                 // Required — the system's name (e.g. "Scaffolding")
  description: string;          // Short summary of what the system does / why it's owned
  kbs: string[];                // Knowledge-base file paths
  guides: string[];            // Guide/doc paths
  skills: string[];            // Skill names (e.g. "scaffolding-sync")
  keyDirectories: string[];     // Important directories for the system
}

export interface SystemOwnership {
  agent?: string;               // Display name — sanity field; the reader already knows whose file it is from the path
  systems: OwnedSystem[];
}

export const SYSTEM_OWNERSHIP_FILENAME = 'SystemOwnership.json';

/** Coerce an unknown value into a string[], dropping non-string entries. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Normalize arbitrary parsed JSON into the canonical SystemOwnership shape.
 * Pure (no I/O). Drops systems with no valid `name` (the only required field);
 * fills `[]`/'' defaults for everything else.
 */
export function normalizeSystemOwnership(raw: unknown): SystemOwnership {
  if (!raw || typeof raw !== 'object') return { systems: [] };
  const obj = raw as Record<string, unknown>;

  const rawSystems = Array.isArray(obj.systems) ? obj.systems : [];
  const systems: OwnedSystem[] = [];
  for (const entry of rawSystems) {
    if (!entry || typeof entry !== 'object') continue;
    const sys = entry as Record<string, unknown>;
    if (typeof sys.name !== 'string' || sys.name.trim() === '') continue; // name is required
    systems.push({
      name: sys.name,
      description: typeof sys.description === 'string' ? sys.description : '',
      kbs: toStringArray(sys.kbs),
      guides: toStringArray(sys.guides),
      skills: toStringArray(sys.skills),
      keyDirectories: toStringArray(sys.keyDirectories),
    });
  }

  const result: SystemOwnership = { systems };
  if (typeof obj.agent === 'string') result.agent = obj.agent;
  return result;
}

/**
 * Read and normalize `<workingDirectory>/SystemOwnership.json`.
 * Graceful-empty: missing file or malformed JSON resolves to `{ systems: [] }`.
 */
export async function readSystemOwnership(workingDirectory: string): Promise<SystemOwnership> {
  const filePath = path.join(workingDirectory, SYSTEM_OWNERSHIP_FILENAME);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return normalizeSystemOwnership(JSON.parse(raw));
  } catch {
    return { systems: [] };
  }
}

/**
 * Normalize and atomically write `<workingDirectory>/SystemOwnership.json`.
 *
 * Full-replace semantics: `raw` (the client-supplied payload) becomes the whole
 * file. `raw` is run through `normalizeSystemOwnership` first, so nameless
 * systems are dropped and pointer arrays are coerced before anything hits disk —
 * the file is always canonical regardless of what the client sent.
 *
 * The write is serialized per-path (`withFileLock`) and atomic (`writeJsonFile`
 * does temp-write + rename), so a concurrent `readSystemOwnership` sees either
 * the old file or the new one, never a torn write.
 *
 * Returns the normalized ownership that was written, so callers can echo it back
 * in the same shape `readSystemOwnership` returns.
 */
export async function writeSystemOwnership(
  workingDirectory: string,
  raw: unknown
): Promise<SystemOwnership> {
  // Guard a null/empty workDir up front: path.join('', file) is RELATIVE, so an empty
  // workingDirectory would silently write SystemOwnership.json into the process CWD.
  // Reject so the caller (bulk-backfill handler) surfaces a clean per-agent error.
  if (typeof workingDirectory !== 'string' || workingDirectory.trim() === '') {
    throw new Error('writeSystemOwnership: workingDirectory must be a non-empty string');
  }
  const normalized = normalizeSystemOwnership(raw);
  const filePath = path.join(workingDirectory, SYSTEM_OWNERSHIP_FILENAME);
  await withFileLock(filePath, () => writeJsonFile(filePath, normalized));
  return normalized;
}
