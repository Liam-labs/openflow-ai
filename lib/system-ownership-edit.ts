/**
 * Pure, client-safe edit helpers for the cog "Systems Owned" editor (T4.2).
 *
 * Type-only import of OwnedSystem keeps `lib/system-ownership.ts`'s fs/path
 * deps OUT of the client bundle — these functions are React-free, immutable,
 * and unit-tested in isolation. The RosterConfigModal wires its edit handlers
 * to these so the component keeps thin setState callbacks.
 */
import type { OwnedSystem } from './system-ownership';

/** The four string-array pointer fields on an OwnedSystem. */
export type PointerKey = 'kbs' | 'guides' | 'skills' | 'keyDirectories';
export const POINTER_KEYS: PointerKey[] = ['kbs', 'guides', 'skills', 'keyDirectories'];

/** A blank system row for the "Add system" action. */
export function emptySystem(): OwnedSystem {
  return { name: '', description: '', kbs: [], guides: [], skills: [], keyDirectories: [] };
}

export function addSystem(systems: OwnedSystem[]): OwnedSystem[] {
  return [...systems, emptySystem()];
}

export function removeSystem(systems: OwnedSystem[], index: number): OwnedSystem[] {
  return systems.filter((_, i) => i !== index);
}

/** Update a scalar field (name/description) on one system, immutably. */
export function updateSystemField(
  systems: OwnedSystem[],
  index: number,
  field: 'name' | 'description',
  value: string,
): OwnedSystem[] {
  return systems.map((s, i) => (i === index ? { ...s, [field]: value } : s));
}

export function addPointer(systems: OwnedSystem[], index: number, key: PointerKey): OwnedSystem[] {
  return systems.map((s, i) => (i === index ? { ...s, [key]: [...s[key], ''] } : s));
}

export function updatePointer(
  systems: OwnedSystem[],
  index: number,
  key: PointerKey,
  ptrIndex: number,
  value: string,
): OwnedSystem[] {
  return systems.map((s, i) =>
    i === index ? { ...s, [key]: s[key].map((p, j) => (j === ptrIndex ? value : p)) } : s,
  );
}

export function removePointer(
  systems: OwnedSystem[],
  index: number,
  key: PointerKey,
  ptrIndex: number,
): OwnedSystem[] {
  return systems.map((s, i) =>
    i === index ? { ...s, [key]: s[key].filter((_, j) => j !== ptrIndex) } : s,
  );
}

/**
 * Clean the array for sending to roster_system_ownership_write: trim every
 * string, drop empty pointer entries, drop whole systems with no name (the
 * server applies the same nameless-drop normalize per the T4.1 contract — this
 * keeps the client payload honest so the optimistic UI matches the read-back).
 */
export function sanitizeSystems(systems: OwnedSystem[]): OwnedSystem[] {
  const cleanList = (arr: string[]) => arr.map((s) => s.trim()).filter(Boolean);
  return systems
    .map((s) => ({
      name: s.name.trim(),
      description: s.description.trim(),
      kbs: cleanList(s.kbs),
      guides: cleanList(s.guides),
      skills: cleanList(s.skills),
      keyDirectories: cleanList(s.keyDirectories),
    }))
    .filter((s) => s.name.length > 0);
}
