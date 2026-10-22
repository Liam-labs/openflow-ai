import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import type { CollabMessage } from '@/lib/types';
import {
  DESIGN_REFERENCE_BOARD_KIND,
  DESIGN_REFERENCE_SELECTION_KIND,
  parseDesignReferenceBoard,
  parseDesignReferenceSelection,
  type DesignReferenceBoard,
  type DesignReferenceCandidate,
  type DesignReferenceSelection,
} from '@/lib/design-references/types';
import { computeDesignReferenceBoardFingerprint } from '@/lib/design-references/fingerprint';
import { handleDesignReferenceMessage } from '@/lib/design-references/route';
import {
  findActiveDesignReferenceGate,
  getDesignReferenceAuthorization,
  getDesignReferenceBoard,
  getDesignReferenceStorePath,
} from '@/lib/design-references/store';

let tmpDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-refs-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});

afterEach(async () => {
  cwdSpy.mockRestore();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function candidate(index: number, over: Partial<DesignReferenceCandidate> = {}): DesignReferenceCandidate {
  return {
    id: `candidate-${index}`,
    title: `Reference ${index}`,
    source: index % 2 ? 'Webflow' : 'ThemeForest',
    creator: 'Studio Test',
    itemUrl: `https://example.com/items/${index}`,
    previewUrl: `https://example.com/previews/${index}`,
    imageUrl: `https://images.example.com/${index}.jpg`,
    capturedAt: '2026-08-30T16:00:00.000Z',
    price: { amount: index % 2 ? 49 : 0, currency: 'USD' },
    popularity: { label: 'Sales', value: `${index * 100} sales`, confidence: 'high' },
    platform: 'Next.js',
    stack: ['Next.js', 'Tailwind CSS'],
    licence: { status: 'clear', summary: 'Reusable under the linked licence.', url: 'https://example.com/licence' },
    useMode: 'open-source-base',
    fitScore: 90 - index,
    fitReasons: ['Strong product hierarchy', 'Fits the intended audience'],
    tradeoff: 'Requires a custom checkout flow.',
    ...over,
  };
}

function board(over: Partial<DesignReferenceBoard> = {}): DesignReferenceBoard {
  const candidates = Array.from({ length: 5 }, (_, index) => candidate(index + 1));
  const payload = {
    id: 'board-1',
    channelId: 'channel-1',
    revision: 1,
    projectId: 'project-1',
    brief: 'A warm editorial marketplace for independent coffee roasters.',
    shortlistSize: candidates.length,
    candidates,
    createdBy: { participantId: 'roster-architect', name: 'Architect' },
    createdAt: '2026-08-30T16:00:00.000Z',
    expiresAt: '2026-09-06T16:00:00.000Z',
    ...over,
  } as Omit<DesignReferenceBoard, 'fingerprint'>;
  return { ...payload, fingerprint: computeDesignReferenceBoardFingerprint(payload) };
}

function selection(over: Partial<DesignReferenceSelection> = {}): DesignReferenceSelection {
  const activeBoard = board();
  return {
    boardId: activeBoard.id,
    channelId: activeBoard.channelId,
    boardRevision: activeBoard.revision,
    boardFingerprint: activeBoard.fingerprint,
    action: 'use-one',
    candidateIds: ['candidate-1'],
    answeredBy: 'browser-owner',
    answeredAt: '2026-08-30T16:05:00.000Z',
    ...over,
  };
}

function message(
  client: Record<string, unknown>,
  senderId = 'roster-architect',
  channelId = 'channel-1',
  senderType: CollabMessage['from']['type'] = senderId === 'browser-owner' ? 'user' : 'claude',
): CollabMessage {
  return {
    id: randomUUID(),
    channelId,
    from: {
      id: senderId,
      name: senderId === 'browser-owner' ? 'Owner' : 'Architect',
      type: senderType,
      source: 'test',
      pid: 4242,
      projectPath: tmpDir,
      joinedAt: '',
      lastSeen: '',
    },
    content: 'fallback',
    timestamp: '2026-08-30T16:00:00.000Z',
    metadata: { client },
  };
}

const routeNow = new Date('2026-08-30T16:10:00.000Z');
const audience = { humanRecipientIds: ['browser-owner'], now: routeNow };

describe('design reference payload validation', () => {
  it('accepts a complete fingerprinted 5-item board', () => {
    expect(parseDesignReferenceBoard(board()).ok).toBe(true);
  });

  it('uses inspiration-only as the sole canonical wire value', () => {
    expect(parseDesignReferenceBoard(board({
      candidates: [
        candidate(1, { useMode: 'inspiration-only', licence: { status: 'unclear', summary: 'Visual study only.' } }),
        ...Array.from({ length: 4 }, (_, index) => candidate(index + 2)),
      ],
    })).ok).toBe(true);
    const legacy = board() as unknown as { candidates: Array<{ useMode: string }> };
    legacy.candidates[0].useMode = 'inspiration';
    expect(parseDesignReferenceBoard(legacy)).toMatchObject({ ok: false });
  });

  it('enforces correlated selection fields and cardinality', () => {
    expect(parseDesignReferenceSelection(selection()).ok).toBe(true);
    expect(parseDesignReferenceSelection(selection({ action: 'combine', candidateIds: ['candidate-1'] }))).toMatchObject({ ok: false });
    expect(parseDesignReferenceSelection(selection({ action: 'combine', candidateIds: ['candidate-1', 'candidate-2'] })).ok).toBe(true);
    expect(parseDesignReferenceSelection(selection({ action: 'refine', candidateIds: [] })).ok).toBe(true);
  });
});

describe('design reference routing and atomic persistence', () => {
  it('records a verified board with its human audience', async () => {
    const payload = board();
    const msg = message({ kind: DESIGN_REFERENCE_BOARD_KIND, payload });
    const result = await handleDesignReferenceMessage(msg, audience);

    expect(result).toMatchObject({ kind: 'board', boardId: 'board-1', revision: 1 });
    expect(msg.recipients).toEqual(['browser-owner']);
    expect((await getDesignReferenceBoard('board-1'))?.humanRecipientIds).toEqual(['browser-owner']);
  });

  it('discovers the server-owned active gate only for its launcher and canonical workspace', async () => {
    const activeBoard = board();
    await handleDesignReferenceMessage(
      message({ kind: DESIGN_REFERENCE_BOARD_KIND, payload: activeBoard }),
      audience,
    );

    expect(await findActiveDesignReferenceGate(tmpDir, ['pid:4242'], routeNow)).toMatchObject({
      status: 'active',
      identity: {
        participantId: 'roster-architect',
        launcherSessionId: 'pid:4242',
        workspacePath: tmpDir,
      },
      authorization: {
        boardId: 'board-1',
        state: 'awaiting-selection',
        implementationUnlocked: false,
      },
    });
    expect(await findActiveDesignReferenceGate(tmpDir, ['pid:9999'], routeNow)).toMatchObject({
      status: 'identity-mismatch',
    });

    const unrelatedWorkspace = path.join(tmpDir, 'unrelated-workspace');
    await fs.mkdir(unrelatedWorkspace);
    expect(await findActiveDesignReferenceGate(unrelatedWorkspace, ['pid:4242'], routeNow)).toEqual({
      status: 'none',
    });

    await handleDesignReferenceMessage(message({
      kind: DESIGN_REFERENCE_SELECTION_KIND,
      payload: selection({ boardFingerprint: activeBoard.fingerprint }),
    }, 'browser-owner'), { now: routeNow });
    expect(await findActiveDesignReferenceGate(tmpDir, ['pid:4242'], routeNow)).toMatchObject({
      status: 'active',
      authorization: {
        state: 'selected',
        implementationUnlocked: true,
        selectionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it('fails closed instead of returning none when a legacy manifest lacks launcher identity', async () => {
    const activeBoard = board();
    await handleDesignReferenceMessage(
      message({ kind: DESIGN_REFERENCE_BOARD_KIND, payload: activeBoard }),
      audience,
    );
    const manifestPath = getDesignReferenceStorePath(activeBoard.id);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      revisions: Array<{ launcherIdentity?: unknown }>;
    };
    delete manifest.revisions[0].launcherIdentity;
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    expect(await findActiveDesignReferenceGate(tmpDir, ['pid:4242'], routeNow)).toMatchObject({
      status: 'ambiguous',
    });
  });

  it('rejects a forged board fingerprint', async () => {
    const payload = board();
    payload.brief = 'Changed after hashing';
    expect(await handleDesignReferenceMessage(
      message({ kind: DESIGN_REFERENCE_BOARD_KIND, payload }),
      audience,
    )).toMatchObject({ kind: 'invalid', error: expect.stringContaining('fingerprint') });
  });

  it('routes an authorized human decision and issues the only resume token', async () => {
    const activeBoard = board();
    await handleDesignReferenceMessage(message({ kind: DESIGN_REFERENCE_BOARD_KIND, payload: activeBoard }), audience);
    const picked = selection({
      boardFingerprint: activeBoard.fingerprint,
      action: 'combine',
      candidateIds: ['candidate-1', 'candidate-2'],
      note: 'Use the first layout with the second card treatment.',
    });
    const msg = message({ kind: DESIGN_REFERENCE_SELECTION_KIND, payload: picked }, 'browser-owner');
    const result = await handleDesignReferenceMessage(msg, { now: routeNow });

    expect(result).toMatchObject({
      kind: 'selection',
      boardId: 'board-1',
      routedTo: 'roster-architect',
      selectionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(msg.content).toContain('@Architect [Design references] Owner decided: Combine Reference 1 + Reference 2');
    expect((msg.metadata?.client as { payload: DesignReferenceSelection }).payload.selectionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await getDesignReferenceBoard('board-1'))?.state).toBe('selected');

    const duplicate = await handleDesignReferenceMessage(
      message({ kind: DESIGN_REFERENCE_SELECTION_KIND, payload: picked }, 'browser-owner'),
      { now: routeNow },
    );
    expect(duplicate).toMatchObject({ kind: 'selection', deduplicated: true });
  });

  it.each([
    ['agent sender', 'roster-architect', 'channel-1', 'claude'],
    ['unauthorized human', 'browser-other', 'channel-1', 'user'],
    ['cross-channel human', 'browser-owner', 'channel-2', 'user'],
  ] as const)('rejects %s without recording a decision', async (_case, senderId, channelId, senderType) => {
    const activeBoard = board();
    await handleDesignReferenceMessage(message({ kind: DESIGN_REFERENCE_BOARD_KIND, payload: activeBoard }), audience);
    const msg = message({
      kind: DESIGN_REFERENCE_SELECTION_KIND,
      payload: selection({
        boardFingerprint: activeBoard.fingerprint,
        answeredBy: senderId,
        channelId,
      }),
    }, senderId, channelId, senderType);

    expect(await handleDesignReferenceMessage(msg, { now: routeNow })).toMatchObject({ kind: 'invalid' });
    expect((await getDesignReferenceBoard('board-1'))?.selection).toBeNull();
  });

  it('atomically rejects stale revision and fingerprint after a board update', async () => {
    const first = board();
    await handleDesignReferenceMessage(message({ kind: DESIGN_REFERENCE_BOARD_KIND, payload: first }), audience);
    const second = board({ revision: 2, brief: 'A sharper editorial marketplace direction.' });
    await handleDesignReferenceMessage(message({ kind: DESIGN_REFERENCE_BOARD_KIND, payload: second }), audience);

    const stale = selection({ boardRevision: 1, boardFingerprint: first.fingerprint });
    expect(await handleDesignReferenceMessage(
      message({ kind: DESIGN_REFERENCE_SELECTION_KIND, payload: stale }, 'browser-owner'),
      { now: routeNow },
    )).toMatchObject({ kind: 'invalid', error: expect.stringContaining('stale') });
    expect((await getDesignReferenceBoard('board-1'))?.board.revision).toBe(2);
  });

  it('rejects expired boards and resolves concurrent conflicting selections once', async () => {
    const activeBoard = board({ expiresAt: '2026-08-30T16:20:00.000Z' });
    await handleDesignReferenceMessage(message({ kind: DESIGN_REFERENCE_BOARD_KIND, payload: activeBoard }), audience);
    const left = selection({ boardFingerprint: activeBoard.fingerprint, candidateIds: ['candidate-1'] });
    const right = selection({ boardFingerprint: activeBoard.fingerprint, candidateIds: ['candidate-2'] });
    const results = await Promise.all([left, right].map(payload => handleDesignReferenceMessage(
      message({ kind: DESIGN_REFERENCE_SELECTION_KIND, payload }, 'browser-owner'),
      { now: routeNow },
    )));
    expect(results.filter(result => result.kind === 'selection')).toHaveLength(1);
    expect(results.filter(result => result.kind === 'invalid')).toHaveLength(1);

    const lateBoard = board({ id: 'late-board', expiresAt: '2026-08-30T16:15:00.000Z' });
    await handleDesignReferenceMessage(message({ kind: DESIGN_REFERENCE_BOARD_KIND, payload: lateBoard }), audience);
    const late = selection({ boardId: 'late-board', boardFingerprint: lateBoard.fingerprint });
    expect(await handleDesignReferenceMessage(
      message({ kind: DESIGN_REFERENCE_SELECTION_KIND, payload: late }, 'browser-owner'),
      { now: new Date('2026-08-30T16:16:00.000Z') },
    )).toMatchObject({ kind: 'invalid', error: expect.stringContaining('expired') });
  });

  it('unlocks only for the exact selected creator/channel/revision/fingerprints before expiry', async () => {
    const activeBoard = board();
    await handleDesignReferenceMessage(message({ kind: DESIGN_REFERENCE_BOARD_KIND, payload: activeBoard }), audience);
    await handleDesignReferenceMessage(message({
      kind: DESIGN_REFERENCE_SELECTION_KIND,
      payload: selection({ boardFingerprint: activeBoard.fingerprint }),
    }, 'browser-owner'), { now: routeNow });

    const exact = await getDesignReferenceAuthorization('board-1', {
      channelId: 'channel-1', revision: 1, boardFingerprint: activeBoard.fingerprint,
    });
    const stale = await getDesignReferenceAuthorization('board-1', {
      channelId: 'channel-1', revision: 2, boardFingerprint: activeBoard.fingerprint,
    });
    const expired = await getDesignReferenceAuthorization('board-1', {
      channelId: 'channel-1', revision: 1, boardFingerprint: activeBoard.fingerprint,
    }, new Date('2026-09-07T00:00:00.000Z'));
    expect(exact).toMatchObject({
      createdByParticipantId: 'roster-architect',
      expiresAt: activeBoard.expiresAt,
      implementationUnlocked: true,
      selectionFingerprint: expect.any(String),
    });
    expect(stale).toMatchObject({ implementationUnlocked: false, selectionFingerprint: null });
    expect(expired).toMatchObject({ implementationUnlocked: false, selectionFingerprint: null });
  });
});
