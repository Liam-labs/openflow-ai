import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import {
  CodexDesktopTurnError,
  createAgentChatPrompt,
  createCodexDesktopDeliveryInspector,
  createCodexDesktopTurnRunner,
  extractAgentChatReply,
  isAuthorizedAttachmentReadApproval,
  type CodexDesktopTurnResult,
} from '@/lib/codex-desktop-turn';
import { createCodexNativeAutoDeliveryWorker } from '@/lib/codex-native-auto-delivery';
import type {
  CodexNativeBinding,
  CodexNativeDelivery,
  CodexNativePendingMessage,
} from '@/lib/codex-native-store';

const binding: CodexNativeBinding = {
  channelId: 'channel-1',
  participantId: 'participant-1',
  bindingId: 'binding-1',
  nativeSessionId: 'session-1',
  nativeThreadId: 'thread-1',
  boundAt: '2026-08-16T08:00:00.000Z',
  lastActiveAt: '2026-08-16T08:00:00.000Z',
};

const pending: CodexNativePendingMessage = {
  ...binding,
  idempotencyKey: 'message-1:thread-1',
  originMessageId: 'message-1',
  originTimestamp: '2026-08-16T08:01:00.000Z',
  state: 'waiting',
  createdAt: '2026-08-16T08:01:01.000Z',
  content: '@Codex check the deployment guard',
  from: {
    id: 'owner',
    name: 'Owner',
    type: 'user',
    source: 'test',
    joinedAt: '2026-08-16T08:00:00.000Z',
    lastSeen: '2026-08-16T08:00:00.000Z',
  },
};

const claimed: CodexNativeDelivery = {
  ...pending,
  state: 'claimed',
  outboundCorrelationId: 'correlation-1',
  claimedAt: '2026-08-16T08:01:02.000Z',
};

function completedTurn(content = 'The guard is working.'): CodexDesktopTurnResult {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    status: 'completed',
    content: `${content}\n\n[[DEVFLOW_AGENTCHAT_REPLY:correlation-1]]`,
    turnStarted: true,
  };
}

function inspectorChild(thread: Record<string, unknown>): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
  let inputBuffer = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    inputBuffer += chunk;
    let newline = inputBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = inputBuffer.slice(0, newline);
      inputBuffer = inputBuffer.slice(newline + 1);
      newline = inputBuffer.indexOf('\n');
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number };
      if (message.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      if (message.id === 2) stdout.write(`${JSON.stringify({
        id: 2,
        result: { thread: { ...thread, turns: [] } },
      })}\n`);
      if (typeof message.id === 'number' && message.id >= 3) stdout.write(`${JSON.stringify({
        id: message.id,
        result: { data: Array.isArray(thread.turns) ? thread.turns : [], nextCursor: null },
      })}\n`);
    }
  });
  return child;
}

function harness(overrides: Record<string, unknown> = {}) {
  const dependencies = {
    listActiveBindings: vi.fn().mockResolvedValue([binding]),
    getInFlight: vi.fn().mockResolvedValue(null),
    listPending: vi.fn().mockResolvedValue([pending]),
    claim: vi.fn().mockResolvedValue(claimed),
    releaseClaim: vi.fn().mockResolvedValue({
      originMessageId: pending.originMessageId,
      state: 'waiting',
      confirmed: false,
    }),
    runTurn: vi.fn().mockResolvedValue(completedTurn()),
    inspectDelivery: vi.fn().mockResolvedValue({ state: 'unknown' }),
    forward: vi.fn().mockResolvedValue({ messageId: 'reply-1' }),
    log: vi.fn(),
    ...overrides,
  };
  return { dependencies, worker: createCodexNativeAutoDeliveryWorker(dependencies) };
}

describe('Codex Native automatic delivery', () => {
  it('claims a targeted message, runs the bound Desktop thread, and forwards its final answer', async () => {
    const { dependencies, worker } = harness();

    await expect(worker.runOnce()).resolves.toMatchObject({ forwarded: 1, failed: 0 });

    expect(dependencies.listPending).toHaveBeenCalledWith({
      ...binding,
      limit: 1,
      currentBindingOnly: true,
    });
    expect(dependencies.runTurn).toHaveBeenCalledWith({
      threadId: binding.nativeThreadId,
      permissionMode: 'restricted',
      prompt: expect.stringContaining(pending.content),
    });
    expect(dependencies.forward).toHaveBeenCalledWith({
      nativeSessionId: binding.nativeSessionId,
      turnId: 'turn-1',
      outboundCorrelationId: 'correlation-1',
      content: 'The guard is working.',
    });
    expect(dependencies.releaseClaim).not.toHaveBeenCalled();
  });

  it('reconciles a completed stranded claim from persisted Desktop history', async () => {
    const { dependencies, worker } = harness({
      getInFlight: vi.fn().mockResolvedValue(claimed),
      inspectDelivery: vi.fn().mockResolvedValue({
        state: 'completed',
        turnId: 'turn-recovered',
        content: 'Recovered result\n[[DEVFLOW_AGENTCHAT_REPLY:correlation-1]]',
      }),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ forwarded: 1, failed: 0 });
    expect(dependencies.listPending).not.toHaveBeenCalled();
    expect(dependencies.runTurn).not.toHaveBeenCalled();
    expect(dependencies.forward).toHaveBeenCalledWith({
      nativeSessionId: binding.nativeSessionId,
      turnId: 'turn-recovered',
      outboundCorrelationId: 'correlation-1',
      content: 'Recovered result',
    });
  });

  it('releases a stranded claim only when complete Desktop history proves no turn started', async () => {
    const { dependencies, worker } = harness({
      getInFlight: vi.fn().mockResolvedValue(claimed),
      inspectDelivery: vi.fn().mockResolvedValue({ state: 'not-started' }),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ forwarded: 0, failed: 1 });
    expect(dependencies.releaseClaim).toHaveBeenCalledWith({
      ...binding,
      originMessageId: claimed.originMessageId,
    });
    expect(dependencies.runTurn).not.toHaveBeenCalled();
    expect(dependencies.forward).not.toHaveBeenCalled();
  });

  it('retains a stranded claim while its exact native turn is still in progress', async () => {
    const { dependencies, worker } = harness({
      getInFlight: vi.fn().mockResolvedValue(claimed),
      inspectDelivery: vi.fn().mockResolvedValue({
        state: 'in-progress',
        turnId: 'turn-active',
      }),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ forwarded: 0, failed: 0 });
    expect(dependencies.releaseClaim).not.toHaveBeenCalled();
    expect(dependencies.forward).not.toHaveBeenCalled();
  });

  it('keeps the claim fail-closed when Desktop history cannot be inspected', async () => {
    const { dependencies, worker } = harness({
      getInFlight: vi.fn().mockResolvedValue(claimed),
      inspectDelivery: vi.fn().mockRejectedValue(new Error('Desktop unavailable')),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ forwarded: 0, failed: 1 });
    expect(dependencies.releaseClaim).not.toHaveBeenCalled();
    expect(dependencies.forward).not.toHaveBeenCalled();
  });

  it('settles a terminal stranded turn visibly without retrying its external work', async () => {
    const { dependencies, worker } = harness({
      getInFlight: vi.fn().mockResolvedValue(claimed),
      inspectDelivery: vi.fn().mockResolvedValue({
        state: 'failed',
        turnId: 'turn-failed',
      }),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ forwarded: 1, failed: 0 });
    expect(dependencies.releaseClaim).not.toHaveBeenCalled();
    expect(dependencies.forward).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'turn-failed',
      content: expect.stringContaining('ended as failed'),
    }));
  });

  it('inspects persisted history by the opaque delivery marker and recovers its final answer', async () => {
    const child = inspectorChild({
      status: { type: 'idle' },
      turns: [{
        id: 'turn-recovered',
        status: 'completed',
        items: [
          {
            type: 'userMessage',
            content: [{ type: 'text', text: 'Task\n[[DEVFLOW_AGENTCHAT_REPLY:correlation-1]]' }],
          },
          {
            type: 'agentMessage',
            phase: 'final_answer',
            text: 'Recovered\n[[DEVFLOW_AGENTCHAT_REPLY:correlation-1]]',
          },
        ],
      }],
    });
    const inspect = createCodexDesktopDeliveryInspector({
      createEnvironment: async () => ({ NODE_ENV: 'test' }),
      spawnAppServer: () => child,
      timeoutMs: 1_000,
    });

    await expect(inspect(
      'thread-1',
      'correlation-1',
      '2026-08-16T08:01:02.000Z',
    )).resolves.toEqual({
      state: 'completed',
      turnId: 'turn-recovered',
      content: 'Recovered\n[[DEVFLOW_AGENTCHAT_REPLY:correlation-1]]',
    });
  });

  it('proves a claimed delivery never started only when the thread is idle and its marker is absent', async () => {
    const idleInspect = createCodexDesktopDeliveryInspector({
      createEnvironment: async () => ({ NODE_ENV: 'test' }),
      spawnAppServer: () => inspectorChild({ status: { type: 'idle' }, turns: [] }),
      timeoutMs: 1_000,
    });
    const activeInspect = createCodexDesktopDeliveryInspector({
      createEnvironment: async () => ({ NODE_ENV: 'test' }),
      spawnAppServer: () => inspectorChild({ status: { type: 'active' }, turns: [] }),
      timeoutMs: 1_000,
    });

    await expect(idleInspect(
      'thread-1',
      'correlation-1',
      '2026-08-16T08:01:02.000Z',
    )).resolves.toEqual({ state: 'not-started' });
    await expect(activeInspect(
      'thread-1',
      'correlation-1',
      '2026-08-16T08:01:02.000Z',
    )).resolves.toEqual({ state: 'unknown' });
  });

  it('includes each persisted attachment local path in the native Desktop prompt', async () => {
    const attachmentPending: CodexNativePendingMessage = {
      ...pending,
      attachments: [{
        name: 'drone-hub-marketplace-notes.md',
        type: 'text/markdown',
        size: 24_973,
        url: '/api/collab/images/message-1-0.md',
      }],
    };
    const { dependencies, worker } = harness({
      listPending: vi.fn().mockResolvedValue([attachmentPending]),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ forwarded: 1, failed: 0 });

    const prompt = dependencies.runTurn.mock.calls[0][0].prompt as string;
    const attachmentPath = path.join(
      process.cwd(),
      '.AppData',
      'collab-images',
      'message-1-0.md',
    );
    expect(prompt).toContain('drone-hub-marketplace-notes.md');
    expect(prompt).toContain(attachmentPath);
    expect(dependencies.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      attachmentReadPaths: [attachmentPath],
    }));
  });

  it('authorizes only a one-file read command for an explicitly supplied attachment', () => {
    const attachmentPath = '/home/user/DevFlow/.AppData/collab-images/message-1-0.md';
    const request = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      additionalPermissions: null,
      networkApprovalContext: null,
      proposedNetworkPolicyAmendments: [],
      proposedExecpolicyAmendment: ['wsl', '--', 'cat', '--', attachmentPath],
      availableDecisions: ['accept', 'cancel'],
      commandActions: [{ type: 'unknown', command: `wsl -- cat -- ${attachmentPath}` }],
    };

    expect(isAuthorizedAttachmentReadApproval(
      request,
      [attachmentPath],
      'thread-1',
      'turn-1',
    )).toBe(true);
    expect(isAuthorizedAttachmentReadApproval(
      {
        ...request,
        proposedExecpolicyAmendment: ['wsl', '--', 'cat', '--', '/home/user/.ssh/id_ed25519'],
        commandActions: [{ type: 'unknown', command: 'wsl -- cat -- /home/user/.ssh/id_ed25519' }],
      },
      [attachmentPath],
      'thread-1',
      'turn-1',
    )).toBe(false);
    expect(isAuthorizedAttachmentReadApproval(
      {
        ...request,
        proposedExecpolicyAmendment: ['wsl', '--', 'sh', '-c', `cat ${attachmentPath}`],
        commandActions: [{ type: 'unknown', command: `wsl -- sh -c 'cat ${attachmentPath}'` }],
      },
      [attachmentPath],
      'thread-1',
      'turn-1',
    )).toBe(false);
  });

  it('releases the claim when app-server proves the native turn never started', async () => {
    const error = new CodexDesktopTurnError(
      'Desktop thread is busy',
      'CODEX_DESKTOP_THREAD_BUSY',
      false,
    );
    const { dependencies, worker } = harness({ runTurn: vi.fn().mockRejectedValue(error) });

    await expect(worker.runOnce()).resolves.toMatchObject({ forwarded: 0, failed: 1 });
    expect(dependencies.releaseClaim).toHaveBeenCalledWith({
      ...binding,
      originMessageId: pending.originMessageId,
    });
  });

  it('pauses an incompatible paginated binding after one failed delivery attempt', async () => {
    const error = new CodexDesktopTurnError(
      'Paginated history is unsupported',
      'CODEX_DESKTOP_THREAD_HISTORY_UNSUPPORTED',
      false,
      409,
    );
    const { dependencies, worker } = harness({ runTurn: vi.fn().mockRejectedValue(error) });

    await expect(worker.runOnce()).resolves.toMatchObject({ failed: 1 });
    await expect(worker.runOnce()).resolves.toMatchObject({ failed: 0 });
    expect(dependencies.runTurn).toHaveBeenCalledOnce();
    expect(dependencies.releaseClaim).toHaveBeenCalledOnce();
    expect(dependencies.log).toHaveBeenCalledTimes(1);
  });

  it('keeps a claim fail-closed after turn/start to prevent duplicate native work', async () => {
    const error = new CodexDesktopTurnError(
      'Desktop turn connection closed',
      'CODEX_DESKTOP_TURN_INTERRUPTED',
      true,
    );
    const { dependencies, worker } = harness({ runTurn: vi.fn().mockRejectedValue(error) });

    await expect(worker.runOnce()).resolves.toMatchObject({ forwarded: 0, failed: 1 });
    expect(dependencies.releaseClaim).not.toHaveBeenCalled();
  });

  it('forwards a visible exactly-once failure when a completed turn is interrupted', async () => {
    const { dependencies, worker } = harness({
      runTurn: vi.fn().mockResolvedValue({
        ...completedTurn(),
        status: 'interrupted',
        content: '',
      }),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ forwarded: 1, failed: 0 });
    expect(dependencies.releaseClaim).not.toHaveBeenCalled();
    expect(dependencies.forward).toHaveBeenCalledWith({
      nativeSessionId: binding.nativeSessionId,
      turnId: 'turn-1',
      outboundCorrelationId: 'correlation-1',
      content: expect.stringContaining('was interrupted before it returned a verified reply'),
    });
    expect(dependencies.forward.mock.calls[0][0].content).toContain(
      'Please inspect the target state before asking for a retry.',
    );
  });

  it('forwards a visible exactly-once failure when a completed turn fails', async () => {
    const { dependencies, worker } = harness({
      runTurn: vi.fn().mockResolvedValue({
        ...completedTurn(),
        status: 'failed',
        content: 'untrusted partial output without a routing marker',
      }),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ forwarded: 1, failed: 0 });
    expect(dependencies.releaseClaim).not.toHaveBeenCalled();
    expect(dependencies.forward).toHaveBeenCalledWith({
      nativeSessionId: binding.nativeSessionId,
      turnId: 'turn-1',
      outboundCorrelationId: 'correlation-1',
      content: expect.stringContaining('ended as failed before it returned a verified reply'),
    });
    expect(dependencies.forward.mock.calls[0][0].content).not.toContain('untrusted partial output');
  });

  it('does not overlap monitor cycles', async () => {
    let finish!: (value: CodexDesktopTurnResult) => void;
    const runTurn = vi.fn().mockReturnValue(new Promise<CodexDesktopTurnResult>((resolve) => {
      finish = resolve;
    }));
    const { worker } = harness({ runTurn });

    const first = worker.runOnce();
    const second = worker.runOnce();
    await expect(second).resolves.toMatchObject({ skipped: true });
    finish(completedTurn());
    await first;
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it('requires the exact opaque marker and strips it from the forwarded content', () => {
    const prompt = createAgentChatPrompt('Do the thing', 'correlation-1');
    expect(prompt).toContain('[[DEVFLOW_AGENTCHAT_REPLY:correlation-1]]');
    expect(extractAgentChatReply('Done\n[[DEVFLOW_AGENTCHAT_REPLY:correlation-1]]'))
      .toEqual({ content: 'Done', outboundCorrelationId: 'correlation-1' });
    expect(extractAgentChatReply('Done without marker')).toBeNull();
  });

  it('uses the stable stdio lifecycle and pins restricted AgentChat turns fail-closed', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcessWithoutNullStreams;
    let inputBuffer = '';
    const requests: Array<Record<string, unknown>> = [];
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      inputBuffer += chunk;
      let newline = inputBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = inputBuffer.slice(0, newline);
        inputBuffer = inputBuffer.slice(newline + 1);
        newline = inputBuffer.indexOf('\n');
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        requests.push(message);
        const id = message.id;
        if (id === 1) stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: 'test' } })}\n`);
        if (id === 2) stdout.write(`${JSON.stringify({
          id: 2,
          result: { thread: { id: 'thread-1', status: { type: 'idle' } } },
        })}\n`);
        if (id === 3) stdout.write(`${JSON.stringify({
          id: 3,
          result: { thread: { id: 'thread-1' } },
        })}\n`);
        if (id === 4) {
          stdout.write(`${JSON.stringify({ id: 4, result: { turn: { id: 'turn-1' } } })}\n`);
          stdout.write(`${JSON.stringify({
            id: 91,
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
          })}\n`);
        }
        if (id === 91) {
          stdout.write(`${JSON.stringify({
            method: 'item/completed',
            params: {
              item: {
                id: 'answer-1',
                type: 'agentMessage',
                phase: 'final_answer',
                text: 'Finished\n[[DEVFLOW_AGENTCHAT_REPLY:correlation-1]]',
              },
            },
          })}\n`);
          stdout.write(`${JSON.stringify({
            method: 'turn/completed',
            params: { turn: { id: 'turn-1', status: 'completed' } },
          })}\n`);
        }
      }
    });
    const runTurn = createCodexDesktopTurnRunner({
      createEnvironment: async () => ({ WSL_INTEROP: '/run/WSL/test', NODE_ENV: 'test' }),
      spawnAppServer: () => child,
      startTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
    });

    await expect(runTurn({ threadId: 'thread-1', prompt: 'test prompt' })).resolves.toMatchObject({
      turnId: 'turn-1',
      status: 'completed',
      content: 'Finished\n[[DEVFLOW_AGENTCHAT_REPLY:correlation-1]]',
    });
    expect(requests).toContainEqual({ id: 91, result: { decision: 'decline' } });
    expect(requests.find((request) => request.id === 3)).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'thread-1', excludeTurns: true },
    });
    expect(requests.find((request) => request.id === 4)).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      },
    });
  });

  it('pins explicitly authorized full-access bindings on the unattended Desktop turn', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcessWithoutNullStreams;
    const requests: Array<Record<string, unknown>> = [];
    let inputBuffer = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      inputBuffer += chunk;
      let newline = inputBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = inputBuffer.slice(0, newline);
        inputBuffer = inputBuffer.slice(newline + 1);
        newline = inputBuffer.indexOf('\n');
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        requests.push(message);
        if (message.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        if (message.id === 2) stdout.write(`${JSON.stringify({
          id: 2,
          result: { thread: { id: 'thread-1', status: { type: 'idle' } } },
        })}\n`);
        if (message.id === 3) stdout.write(`${JSON.stringify({
          id: 3,
          result: { thread: { id: 'thread-1' } },
        })}\n`);
        if (message.id === 4) {
          stdout.write(`${JSON.stringify({ id: 4, result: { turn: { id: 'turn-1' } } })}\n`);
          stdout.write(`${JSON.stringify({
            method: 'item/completed',
            params: {
              item: {
                type: 'agentMessage',
                phase: 'final_answer',
                text: 'Done\n[[DEVFLOW_AGENTCHAT_REPLY:correlation-1]]',
              },
            },
          })}\n`);
          stdout.write(`${JSON.stringify({
            method: 'turn/completed',
            params: { turn: { id: 'turn-1', status: 'completed' } },
          })}\n`);
        }
      }
    });
    const runTurn = createCodexDesktopTurnRunner({
      createEnvironment: async () => ({ WSL_INTEROP: '/run/WSL/test', NODE_ENV: 'test' }),
      spawnAppServer: () => child,
      startTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
    });

    await expect(runTurn({
      threadId: 'thread-1',
      prompt: 'test prompt',
      permissionMode: 'full-access',
    })).resolves.toMatchObject({ status: 'completed' });
    expect(requests.find((request) => request.id === 4)).toMatchObject({
      method: 'turn/start',
      params: {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    });
  });

  it('rejects an already-active Desktop thread before sending a second turn', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcessWithoutNullStreams;
    const methods: string[] = [];
    let inputBuffer = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      inputBuffer += chunk;
      let newline = inputBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = inputBuffer.slice(0, newline);
        inputBuffer = inputBuffer.slice(newline + 1);
        newline = inputBuffer.indexOf('\n');
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number; method?: string };
        if (message.method) methods.push(message.method);
        if (message.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        if (message.id === 2) stdout.write(`${JSON.stringify({
          id: 2,
          result: { thread: { id: 'thread-1', status: { type: 'active' } } },
        })}\n`);
      }
    });
    const runTurn = createCodexDesktopTurnRunner({
      createEnvironment: async () => ({ WSL_INTEROP: '/run/WSL/test', NODE_ENV: 'test' }),
      spawnAppServer: () => child,
      startTimeoutMs: 1_000,
    });

    await expect(runTurn({ threadId: 'thread-1', prompt: 'test prompt' })).rejects.toMatchObject({
      code: 'CODEX_DESKTOP_THREAD_BUSY',
      turnStarted: false,
    });
    expect(methods).not.toContain('turn/start');
  });

  it('rejects paginated history before attempting thread/resume', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcessWithoutNullStreams;
    const methods: string[] = [];
    let inputBuffer = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      inputBuffer += chunk;
      let newline = inputBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = inputBuffer.slice(0, newline);
        inputBuffer = inputBuffer.slice(newline + 1);
        newline = inputBuffer.indexOf('\n');
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number; method?: string };
        if (message.method) methods.push(message.method);
        if (message.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        if (message.id === 2) stdout.write(`${JSON.stringify({
          id: 2,
          result: { thread: { id: 'thread-1', historyMode: 'paginated', status: { type: 'notLoaded' } } },
        })}\n`);
      }
    });
    const runTurn = createCodexDesktopTurnRunner({
      createEnvironment: async () => ({ WSL_INTEROP: '/run/WSL/test', NODE_ENV: 'test' }),
      spawnAppServer: () => child,
      startTimeoutMs: 1_000,
    });

    await expect(runTurn({ threadId: 'thread-1', prompt: 'test prompt' })).rejects.toMatchObject({
      code: 'CODEX_DESKTOP_THREAD_HISTORY_UNSUPPORTED',
      turnStarted: false,
    });
    expect(methods).not.toContain('thread/resume');
  });
});
