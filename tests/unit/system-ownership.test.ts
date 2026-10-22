import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { normalizeSystemOwnership, readSystemOwnership, writeSystemOwnership } from '@/lib/system-ownership';

describe('normalizeSystemOwnership', () => {
  it('passes a fully-valid object through intact', () => {
    const raw = {
      agent: 'Architect',
      systems: [
        {
          name: 'Scaffolding',
          description: 'Master to deployed sync pipeline',
          kbs: ['~/DevFlow/data/.../scaffolding.md'],
          guides: ['guide-a'],
          skills: ['scaffolding-sync'],
          keyDirectories: ['~/DevFlow/data/scaffolding/masters/'],
        },
      ],
    };
    const out = normalizeSystemOwnership(raw);
    expect(out.agent).toBe('Architect');
    expect(out.systems).toHaveLength(1);
    expect(out.systems[0]).toEqual(raw.systems[0]);
  });

  it('fills [] defaults for missing pointer arrays', () => {
    const out = normalizeSystemOwnership({ systems: [{ name: 'Hooks' }] });
    expect(out.systems[0]).toEqual({
      name: 'Hooks',
      description: '',
      kbs: [],
      guides: [],
      skills: [],
      keyDirectories: [],
    });
  });

  it('drops a system with no valid name (name is the only required field)', () => {
    const out = normalizeSystemOwnership({
      systems: [{ description: 'no name here' }, { name: '', kbs: [] }, { name: 'Valid' }],
    });
    expect(out.systems).toHaveLength(1);
    expect(out.systems[0].name).toBe('Valid');
  });

  it('strips non-string entries out of pointer arrays', () => {
    const out = normalizeSystemOwnership({
      systems: [{ name: 'X', kbs: ['ok', 42, null, 'fine'] }],
    });
    expect(out.systems[0].kbs).toEqual(['ok', 'fine']);
  });

  it('returns empty systems when systems is not an array', () => {
    expect(normalizeSystemOwnership({ systems: 'nope' })).toEqual({ systems: [] });
    expect(normalizeSystemOwnership({ agent: 'X' })).toEqual({ systems: [], agent: 'X' });
  });

  it('returns empty systems for null / non-object input', () => {
    expect(normalizeSystemOwnership(null)).toEqual({ systems: [] });
    expect(normalizeSystemOwnership(undefined)).toEqual({ systems: [] });
    expect(normalizeSystemOwnership('string')).toEqual({ systems: [] });
    expect(normalizeSystemOwnership(123)).toEqual({ systems: [] });
  });

  it('omits agent when it is not a string', () => {
    const out = normalizeSystemOwnership({ agent: 99, systems: [] });
    expect(out.agent).toBeUndefined();
  });
});

describe('readSystemOwnership (graceful-empty I/O)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sysown-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns empty systems when the file is missing (never throws)', async () => {
    await expect(readSystemOwnership(dir)).resolves.toEqual({ systems: [] });
  });

  it('returns empty systems when the JSON is malformed (never throws)', async () => {
    await fs.writeFile(path.join(dir, 'SystemOwnership.json'), '{ this is not: json,', 'utf-8');
    await expect(readSystemOwnership(dir)).resolves.toEqual({ systems: [] });
  });

  it('reads and normalizes a valid file', async () => {
    const payload = {
      agent: 'Builder',
      systems: [{ name: 'Ask-Owner', description: 'question routing' }],
    };
    await fs.writeFile(path.join(dir, 'SystemOwnership.json'), JSON.stringify(payload), 'utf-8');
    const out = await readSystemOwnership(dir);
    expect(out.agent).toBe('Builder');
    expect(out.systems).toHaveLength(1);
    expect(out.systems[0]).toEqual({
      name: 'Ask-Owner',
      description: 'question routing',
      kbs: [],
      guides: [],
      skills: [],
      keyDirectories: [],
    });
  });
});

describe('writeSystemOwnership (flock atomic write, full-replace)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sysown-w-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes a normalized file that readSystemOwnership reads back', async () => {
    const written = await writeSystemOwnership(dir, {
      agent: 'Builder',
      systems: [{ name: 'Ask-Owner', description: 'question routing', skills: ['comms-expert'] }],
    });
    expect(written.agent).toBe('Builder');
    expect(written.systems).toHaveLength(1);

    const readBack = await readSystemOwnership(dir);
    expect(readBack.agent).toBe('Builder');
    expect(readBack.systems[0]).toEqual({
      name: 'Ask-Owner',
      description: 'question routing',
      kbs: [],
      guides: [],
      skills: ['comms-expert'],
      keyDirectories: [],
    });
  });

  it('drops nameless entries on write (server normalizes the client payload)', async () => {
    const written = await writeSystemOwnership(dir, {
      systems: [{ description: 'no name here' }, { name: '' }, { name: 'Valid' }],
    });
    expect(written.systems).toHaveLength(1);
    expect(written.systems[0].name).toBe('Valid');

    const readBack = await readSystemOwnership(dir);
    expect(readBack.systems).toHaveLength(1);
    expect(readBack.systems[0].name).toBe('Valid');
  });

  it('full-replace: a second write overwrites the file entirely (not a merge)', async () => {
    await writeSystemOwnership(dir, { agent: 'X', systems: [{ name: 'Old1' }, { name: 'Old2' }] });
    await writeSystemOwnership(dir, { agent: 'X', systems: [{ name: 'New' }] });

    const readBack = await readSystemOwnership(dir);
    expect(readBack.systems.map((s) => s.name)).toEqual(['New']);
  });

  it('coerces arbitrary/garbage input via normalize (boundary robustness)', async () => {
    const written = await writeSystemOwnership(dir, { systems: 'not-an-array' });
    expect(written.systems).toEqual([]);

    const readBack = await readSystemOwnership(dir);
    expect(readBack.systems).toEqual([]);
  });

  it('serializes concurrent writes without corrupting the file (flock)', async () => {
    await Promise.all([
      writeSystemOwnership(dir, { agent: 'A', systems: [{ name: 'S1' }] }),
      writeSystemOwnership(dir, { agent: 'A', systems: [{ name: 'S2' }] }),
    ]);

    // File must remain valid JSON (atomic rename, no torn write) — one writer wins.
    const readBack = await readSystemOwnership(dir);
    expect(readBack.systems).toHaveLength(1);
    expect(['S1', 'S2']).toContain(readBack.systems[0].name);
  });
});

describe('writeSystemOwnership — empty workingDirectory guard (T4.3 bulk-safety)', () => {
  // A null/'' workDir on a roster entry must NOT silently write SystemOwnership.json
  // into the process CWD (path.join('', file) is RELATIVE). Guard rejects up front so
  // the bulk-backfill handler can surface a clean per-agent error instead of a bad write.
  it('rejects an empty-string workingDirectory (prevents a silent write to CWD)', async () => {
    await expect(writeSystemOwnership('', { systems: [{ name: 'X' }] })).rejects.toThrow(
      /workingDirectory/,
    );
  });

  it('rejects a whitespace-only workingDirectory', async () => {
    await expect(writeSystemOwnership('   ', { systems: [{ name: 'X' }] })).rejects.toThrow(
      /workingDirectory/,
    );
  });

  it('rejects a non-string workingDirectory with our guard message (not a raw path TypeError)', async () => {
    // @ts-expect-error — deliberately passing a bad runtime type to prove the guard
    await expect(writeSystemOwnership(undefined, { systems: [{ name: 'X' }] })).rejects.toThrow(
      /workingDirectory/,
    );
  });
});
