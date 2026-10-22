import { describe, it, expect } from 'vitest';
import type { OwnedSystem } from '@/lib/system-ownership';
import {
  emptySystem,
  addSystem,
  removeSystem,
  updateSystemField,
  addPointer,
  updatePointer,
  removePointer,
  sanitizeSystems,
  POINTER_KEYS,
} from '@/lib/system-ownership-edit';

const sample = (): OwnedSystem[] => [
  { name: 'Scaffolding', description: 'sync pipeline', kbs: ['kb/a.md'], guides: [], skills: ['scaffolding-sync'], keyDirectories: ['data/scaffolding'] },
  { name: 'Hooks', description: 'agent hooks', kbs: [], guides: ['g/hooks.md'], skills: [], keyDirectories: [] },
];

describe('system-ownership-edit pure helpers', () => {
  it('emptySystem returns a fully-blank system', () => {
    expect(emptySystem()).toEqual({ name: '', description: '', kbs: [], guides: [], skills: [], keyDirectories: [] });
  });

  it('addSystem appends a blank row without mutating the input', () => {
    const before = sample();
    const after = addSystem(before);
    expect(after).toHaveLength(3);
    expect(after[2]).toEqual(emptySystem());
    expect(before).toHaveLength(2); // immutability
  });

  it('removeSystem drops the row at index', () => {
    const after = removeSystem(sample(), 0);
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('Hooks');
  });

  it('updateSystemField updates only the targeted scalar field', () => {
    const before = sample();
    const after = updateSystemField(before, 1, 'name', 'Harnesses');
    expect(after[1].name).toBe('Harnesses');
    expect(after[0].name).toBe('Scaffolding');
    expect(before[1].name).toBe('Hooks'); // immutability
  });

  it('addPointer appends an empty string to the chosen array', () => {
    const after = addPointer(sample(), 0, 'kbs');
    expect(after[0].kbs).toEqual(['kb/a.md', '']);
  });

  it('updatePointer edits a single pointer entry', () => {
    const before = sample();
    const after = updatePointer(before, 0, 'skills', 0, 'scaffolding-deploy');
    expect(after[0].skills).toEqual(['scaffolding-deploy']);
    expect(before[0].skills).toEqual(['scaffolding-sync']); // immutability
  });

  it('removePointer drops a single pointer entry', () => {
    const after = removePointer(sample(), 0, 'keyDirectories', 0);
    expect(after[0].keyDirectories).toEqual([]);
  });

  it('POINTER_KEYS covers exactly the four array fields', () => {
    expect(POINTER_KEYS).toEqual(['kbs', 'guides', 'skills', 'keyDirectories']);
  });

  describe('sanitizeSystems', () => {
    it('trims strings, drops empty pointers, and drops nameless systems', () => {
      const dirty: OwnedSystem[] = [
        { name: '  Scaffolding  ', description: ' x ', kbs: ['  kb/a.md ', '  ', ''], guides: [], skills: [' s1 '], keyDirectories: [] },
        { name: '   ', description: 'no name → dropped', kbs: ['kb/b.md'], guides: [], skills: [], keyDirectories: [] },
      ];
      const clean = sanitizeSystems(dirty);
      expect(clean).toHaveLength(1);
      expect(clean[0]).toEqual({ name: 'Scaffolding', description: 'x', kbs: ['kb/a.md'], guides: [], skills: ['s1'], keyDirectories: [] });
    });

    it('returns [] when every system is nameless (graceful-empty)', () => {
      expect(sanitizeSystems([emptySystem()])).toEqual([]);
    });
  });
});
