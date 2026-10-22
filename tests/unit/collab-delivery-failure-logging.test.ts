/**
 * T4: Verify writeToParticipantInbox() routes failures to the log system
 * with severity=high and required metadata fields.
 *
 * RED: logEvent is NOT called in the catch block before this change.
 * GREEN: after change, logEvent is called with severity=high and correct metadata.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@/lib/log-writer', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  makeLogEntry: vi.fn(),
  writeLogEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/event-bus', () => ({
  emitCollabError: vi.fn(),
  eventBus: {
    emitEvent: vi.fn(),
  },
}));

// Mock data-io so withFileLock executes the callback by default,
// but individual tests can override to throw.
vi.mock('@/lib/data-io', () => ({
  withFileLock: vi.fn().mockImplementation(
    (_path: string, fn: () => Promise<unknown>) => fn()
  ),
}));

// Mock fs/promises to control inbox read/write behaviour
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    promises: {
      ...real.promises,
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// ─── Import after mocks ───────────────────────────────────────────────────────

import { writeToParticipantInbox } from '@/lib/collab-delivery';
import { logEvent } from '@/lib/log-writer';
import { withFileLock } from '@/lib/data-io';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HOME = '/home/user';

function makeParticipant(overrides: object = {}) {
  return {
    id: 'participant-abc',
    name: 'TestAgent',
    type: 'claude-terminal' as const,
    projectPath: `${HOME}/some-project`,
    joinedAt: '2025-01-01T00:00:00Z',
    lastSeen: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeMessage(overrides: object = {}) {
  return {
    id: 'msg-xyz-123',
    channelId: 'channel-001',
    from: { id: 'sender-1', name: 'Jack', type: 'user', joinedAt: '', lastSeen: '' },
    content: 'Hello agent',
    timestamp: '2025-06-01T10:00:00Z',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('writeToParticipantInbox — failure logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOME = HOME;
  });

  it('calls logEvent with severity=high when the inbox write fails', async () => {
    // Force the withFileLock callback to throw
    vi.mocked(withFileLock).mockRejectedValueOnce(new Error('disk full'));

    await writeToParticipantInbox(makeParticipant() as never, makeMessage() as never, 'test-channel');

    expect(logEvent).toHaveBeenCalledOnce();
    const [source, severity] = (logEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(source).toBe('error');
    expect(severity).toBe('high');
  });

  it('includes participantName in log metadata', async () => {
    vi.mocked(withFileLock).mockRejectedValueOnce(new Error('permission denied'));

    await writeToParticipantInbox(makeParticipant({ name: 'Worf' }) as never, makeMessage() as never, 'sg1');

    const callArgs = (logEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    const metadata = callArgs[3]; // 4th arg is metadata
    expect(metadata).toMatchObject({ participantName: 'Worf' });
  });

  it('includes channelId in log metadata', async () => {
    vi.mocked(withFileLock).mockRejectedValueOnce(new Error('ENOSPC'));

    await writeToParticipantInbox(makeParticipant() as never, makeMessage({ channelId: 'channel-999' }) as never, 'sg1');

    const callArgs = (logEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    const metadata = callArgs[3];
    expect(metadata).toMatchObject({ channelId: 'channel-999' });
  });

  it('includes messageId in log metadata', async () => {
    vi.mocked(withFileLock).mockRejectedValueOnce(new Error('ENOSPC'));

    await writeToParticipantInbox(makeParticipant() as never, makeMessage({ id: 'msg-abc-999' }) as never, 'sg1');

    const callArgs = (logEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    const metadata = callArgs[3];
    expect(metadata).toMatchObject({ messageId: 'msg-abc-999' });
  });

  it('includes errorType in log metadata', async () => {
    vi.mocked(withFileLock).mockRejectedValueOnce(
      Object.assign(new Error('not found'), { code: 'ENOENT' })
    );

    await writeToParticipantInbox(makeParticipant() as never, makeMessage() as never, 'sg1');

    const callArgs = (logEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    const metadata = callArgs[3];
    expect(metadata.errorType).toBeDefined();
  });

  it('does NOT call logEvent when inbox write succeeds', async () => {
    // withFileLock succeeds (default mock) — no error path
    await writeToParticipantInbox(makeParticipant() as never, makeMessage() as never, 'test-channel');

    expect(logEvent).not.toHaveBeenCalled();
  });

  it('does NOT call logEvent for non-terminal participants (early return)', async () => {
    const gemini = makeParticipant({ type: 'gemini' });
    await writeToParticipantInbox(gemini as never, makeMessage() as never, 'test-channel');

    expect(logEvent).not.toHaveBeenCalled();
  });
});
