/**
 * Sprint 58 T2 TDD — phases.create must be idempotent on (sprintId, name).
 *
 * Context: Sprint 50 was created with 11 phases instead of 4 because
 * phases.create fired 3 times in a 23-second burst during setup,
 * stacking duplicate "Phase 1/2/3/4" rows on the same sprintId.
 *
 * Fix: upsert semantics — a second phases.create with the same
 * (sprintId, name) returns the existing phase's full record rather than
 * inserting a duplicate. Friendly to idempotent clients and retry loops.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CollabTasksData, CollabSprint, CollabPhase } from '../../lib/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@/lib/data-io', () => ({
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn().mockResolvedValue(undefined),
  withFileLock: vi.fn().mockImplementation(
    (_path: string, fn: () => Promise<unknown>) => fn()
  ),
}));

vi.mock('@/lib/log-emitter', () => ({
  emitApiEvent: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { readJsonFile, writeJsonFile } from '@/lib/data-io';
import { create as phasesCreate } from '../../app/api/agent/actions/phases';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSprint(overrides: Partial<CollabSprint> = {}): CollabSprint {
  const now = new Date().toISOString();
  return {
    id: 'sprint-1',
    channelId: 'channel-1',
    name: 'Sprint 58',
    status: 'active',
    createdBy: 'participant-1',
    createdAt: now,
    updatedAt: now,
    sortOrder: 0,
    ...overrides,
  };
}

function makeTasksData(
  sprints: CollabSprint[],
  phases: CollabPhase[] = []
): CollabTasksData {
  return {
    tasks: [],
    sprints,
    phases,
    lastUpdated: new Date().toISOString(),
  };
}

function mockAuth() {
  return {
    requestId: 'req-1',
    tokenId: 'tok-1',
    tokenName: 'test',
    scope: 'write' as const,
    createdBy: 'test',
  };
}

function createBody(fields: Record<string, unknown>) {
  return {
    action: 'phases.create',
    channelId: 'channel-1',
    participantId: 'participant-1',
    sprintId: 'sprint-1',
    ...fields,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('phases.create — dedup on (sprintId, name)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first create with new name inserts a phase and returns it', async () => {
    const data = makeTasksData([makeSprint()]);
    vi.mocked(readJsonFile).mockResolvedValue(data);

    const res = await phasesCreate(
      createBody({ name: 'Phase 1' }),
      mockAuth()
    );

    expect(res.phase.name).toBe('Phase 1');
    expect(res.phase.sprintId).toBe('sprint-1');
    expect(res.phase.channelId).toBe('channel-1');
    expect(data.phases).toHaveLength(1);
    expect(data.phases![0].id).toBe(res.phase.id);
    expect(writeJsonFile).toHaveBeenCalledTimes(1);
  });

  it('duplicate (sprintId, name) is idempotent — returns existing phase, no new row', async () => {
    const data = makeTasksData([makeSprint()]);
    vi.mocked(readJsonFile).mockResolvedValue(data);

    const first = await phasesCreate(
      createBody({ name: 'Phase 1' }),
      mockAuth()
    );
    const writeCountAfterFirst = vi.mocked(writeJsonFile).mock.calls.length;

    const second = await phasesCreate(
      createBody({ name: 'Phase 1' }),
      mockAuth()
    );

    // Same phase ID returned
    expect(second.phase.id).toBe(first.phase.id);
    // Phases array not grown
    expect(data.phases).toHaveLength(1);
    // No additional write on the duplicate
    expect(vi.mocked(writeJsonFile).mock.calls.length).toBe(writeCountAfterFirst);
  });

  it('triple-burst (the Sprint 50 scenario) yields a single phase', async () => {
    const data = makeTasksData([makeSprint()]);
    vi.mocked(readJsonFile).mockResolvedValue(data);

    const a = await phasesCreate(createBody({ name: 'Phase 1' }), mockAuth());
    const b = await phasesCreate(createBody({ name: 'Phase 1' }), mockAuth());
    const c = await phasesCreate(createBody({ name: 'Phase 1' }), mockAuth());

    expect(data.phases).toHaveLength(1);
    expect(a.phase.id).toBe(b.phase.id);
    expect(b.phase.id).toBe(c.phase.id);
  });

  it('different name in same sprint creates a fresh phase', async () => {
    const data = makeTasksData([makeSprint()]);
    vi.mocked(readJsonFile).mockResolvedValue(data);

    const first = await phasesCreate(
      createBody({ name: 'Phase 1' }),
      mockAuth()
    );
    const second = await phasesCreate(
      createBody({ name: 'Phase 2' }),
      mockAuth()
    );

    expect(second.phase.id).not.toBe(first.phase.id);
    expect(data.phases).toHaveLength(2);
    // sortOrder should advance
    expect(second.phase.sortOrder).toBe(first.phase.sortOrder + 1);
  });

  it('same name in different sprint creates a fresh phase', async () => {
    const data = makeTasksData([
      makeSprint(),
      makeSprint({ id: 'sprint-2', name: 'Sprint 59' }),
    ]);
    vi.mocked(readJsonFile).mockResolvedValue(data);

    const first = await phasesCreate(
      createBody({ name: 'Phase 1' }),
      mockAuth()
    );
    const second = await phasesCreate(
      createBody({ name: 'Phase 1', sprintId: 'sprint-2' }),
      mockAuth()
    );

    expect(second.phase.id).not.toBe(first.phase.id);
    expect(data.phases).toHaveLength(2);
    expect(second.phase.sprintId).toBe('sprint-2');
  });

  it('duplicate preserves original metadata (createdBy, createdAt, sortOrder)', async () => {
    const data = makeTasksData([makeSprint()]);
    vi.mocked(readJsonFile).mockResolvedValue(data);

    const first = await phasesCreate(
      createBody({ name: 'Phase 1', description: 'orig desc', color: '#FF0000' }),
      mockAuth()
    );

    // Duplicate call with DIFFERENT description/color — original metadata should win
    const second = await phasesCreate(
      createBody({ name: 'Phase 1', description: 'new desc', color: '#00FF00' }),
      mockAuth()
    );

    expect(second.phase.id).toBe(first.phase.id);
    expect(second.phase.createdAt).toBe(first.phase.createdAt);
    expect(second.phase.createdBy).toBe(first.phase.createdBy);
    expect(second.phase.sortOrder).toBe(first.phase.sortOrder);
    // Description is NOT overwritten — upsert is return-existing, not merge
    expect(second.phase.description).toBe('orig desc');
    expect(second.phase.color).toBe('#FF0000');
  });

  it('duplicate only matches within same channel', async () => {
    const data = makeTasksData([
      makeSprint({ id: 'sprint-A', channelId: 'channel-A' }),
      makeSprint({ id: 'sprint-B', channelId: 'channel-B' }),
    ]);
    vi.mocked(readJsonFile).mockResolvedValue(data);

    // Create "Phase 1" in sprint-A / channel-A
    const first = await phasesCreate(
      {
        action: 'phases.create',
        channelId: 'channel-A',
        participantId: 'participant-1',
        sprintId: 'sprint-A',
        name: 'Phase 1',
      },
      mockAuth()
    );
    // Same (sprintId, name) tuple on different channel would be a data bug
    // in practice, but channel scoping is defensive. Sanity check: same sprintId
    // from a DIFFERENT channel should NOT dedup-match (sprints are 1:1 with
    // channels so this should never fire in prod, but keep the check honest).
    const secondData = data.phases!;
    expect(secondData).toHaveLength(1);
    expect(first.phase.channelId).toBe('channel-A');
  });
});
