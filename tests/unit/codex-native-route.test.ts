import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuthOrLocal: vi.fn(),
  getBinding: vi.fn(),
  listPending: vi.fn(),
  bind: vi.fn(),
  bindSelected: vi.fn(),
  setPermissionMode: vi.fn(),
  unbind: vi.fn(),
  claim: vi.fn(),
  releaseClaim: vi.fn(),
  getDeliveryStatus: vi.fn(),
  getPairing: vi.fn(),
  createPairing: vi.fn(),
  redeemPairing: vi.fn(),
  cancelPairing: vi.fn(),
  disconnect: vi.fn(),
  getParticipant: vi.fn(),
  ensureParticipant: vi.fn(),
  listDesktopThreads: vi.fn(),
  findDesktopThread: vi.fn(),
  ensureBridgeThread: vi.fn(),
  forwardOutbound: vi.fn(),
  onboard: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  requireAuthOrLocal: mocks.requireAuthOrLocal,
}));

vi.mock('@/lib/api-tracking', () => ({
  tracked: (
    _path: string,
    handler: (request: NextRequest) => Promise<NextResponse>,
  ) => handler,
}));

vi.mock('@/lib/codex-native-store', () => ({
  CodexNativeStoreError: class CodexNativeStoreError extends Error {},
  codexNativeStore: {
    getBinding: mocks.getBinding,
    listPending: mocks.listPending,
    bind: mocks.bind,
    bindSelected: mocks.bindSelected,
    setPermissionMode: mocks.setPermissionMode,
    unbind: mocks.unbind,
    claim: mocks.claim,
    releaseClaim: mocks.releaseClaim,
    getDeliveryStatus: mocks.getDeliveryStatus,
    getPairing: mocks.getPairing,
    createPairing: mocks.createPairing,
    redeemPairing: mocks.redeemPairing,
    cancelPairing: mocks.cancelPairing,
    disconnect: mocks.disconnect,
  },
}));

vi.mock('@/lib/codex-native-participant', () => ({
  codexNativeParticipantRegistry: {
    get: mocks.getParticipant,
    ensure: mocks.ensureParticipant,
  },
}));

vi.mock('@/lib/codex-native-forward', () => ({
  forwardCodexNativeReply: mocks.forwardOutbound,
}));

vi.mock('@/lib/codex-desktop-threads', () => ({
  listCodexDesktopThreads: mocks.listDesktopThreads,
  findCodexDesktopThread: mocks.findDesktopThread,
  ensureCodexDesktopBridgeThread: mocks.ensureBridgeThread,
}));

vi.mock('@/lib/codex-native-onboarding', () => ({
  onboardCodexNativeBinding: mocks.onboard,
}));

import { GET, POST } from '@/app/api/codex-native/route';

function post(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/codex-native', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/codex-native', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthOrLocal.mockResolvedValue(null);
    mocks.onboard.mockResolvedValue({ primerCreated: true, introductionRequestCreated: true });
    mocks.ensureBridgeThread.mockImplementation(async (thread) => thread);
  });

  it('authenticates pending reads with read scope', async () => {
    mocks.listPending.mockResolvedValue([{ originMessageId: 'm1' }]);
    const request = new NextRequest(
      'http://localhost:3000/api/codex-native?mode=pending&channelId=c1&participantId=p1&bindingId=b1&nativeSessionId=s1&nativeThreadId=t1&limit=7',
    );

    const response = await GET(request);

    expect(mocks.requireAuthOrLocal).toHaveBeenCalledWith(request, 'read');
    expect(mocks.listPending).toHaveBeenCalledWith({
      channelId: 'c1',
      participantId: 'p1',
      bindingId: 'b1',
      nativeSessionId: 's1',
      nativeThreadId: 't1',
      limit: 7,
    });
    expect(await response.json()).toEqual({ pending: [{ originMessageId: 'm1' }] });
  });

  it('returns bounded public delivery confirmation state with read scope', async () => {
    mocks.getDeliveryStatus.mockResolvedValue({
      originMessageId: 'm1', state: 'claimed', confirmed: false,
    });
    const request = new NextRequest(
      'http://localhost:3000/api/codex-native?mode=status&channelId=c1&participantId=p1&bindingId=b1&nativeSessionId=s1&nativeThreadId=t1&originMessageId=m1',
    );

    const response = await GET(request);

    expect(mocks.requireAuthOrLocal).toHaveBeenCalledWith(request, 'read');
    expect(mocks.getDeliveryStatus).toHaveBeenCalledWith({
      channelId: 'c1', participantId: 'p1', bindingId: 'b1',
      nativeSessionId: 's1', nativeThreadId: 't1', originMessageId: 'm1',
    });
    expect(await response.json()).toEqual({
      delivery: { originMessageId: 'm1', state: 'claimed', confirmed: false },
    });
  });

  it('returns channel-level connection status for the roster pane', async () => {
    mocks.getParticipant.mockResolvedValue({ id: 'p1', name: 'Codex Native' });
    mocks.getBinding.mockResolvedValue({
      channelId: 'c1', participantId: 'p1', bindingId: 'b1',
      nativeSessionId: 's1', nativeThreadId: 't1',
      boundAt: '2026-08-09T00:00:00.000Z', lastActiveAt: '2026-08-09T00:00:00.000Z',
    });
    const request = new NextRequest(
      'http://localhost:3000/api/codex-native?mode=connection&channelId=c1',
    );

    const response = await GET(request);

    expect(mocks.getParticipant).toHaveBeenCalledWith('c1');
    expect(await response.json()).toMatchObject({
      connection: {
        status: 'connected',
        participant: { id: 'p1', name: 'Codex Native' },
        exactChatUrl: 'codex://threads/t1',
      },
    });
  });

  it('lists existing native Codex Desktop chats for the roster picker', async () => {
    mocks.listDesktopThreads.mockResolvedValue([{
      id: 'thread-1', sessionId: 'session-1', title: 'Build the portal',
      project: 'portal', updatedAt: '2026-08-12T10:00:00.000Z',
      cwd: 'C:\\Users\\winuser\\Documents\\Codex\\portal', historyMode: 'legacy',
    }]);
    const request = new NextRequest('http://localhost:3000/api/codex-native?mode=threads');

    const response = await GET(request);

    expect(mocks.requireAuthOrLocal).toHaveBeenCalledWith(request, 'read');
    expect(await response.json()).toEqual({
      threads: [{
        id: 'thread-1', title: 'Build the portal', project: 'portal',
        updatedAt: '2026-08-12T10:00:00.000Z',
      }],
    });
  });

  it('connects only a native chat resolved from the Windows Codex thread list', async () => {
    mocks.ensureParticipant.mockResolvedValue({ id: 'p1', name: 'Codex Native' });
    mocks.findDesktopThread.mockResolvedValue({
      id: 'thread-1', sessionId: 'session-1', title: 'Build the portal',
      project: 'portal', updatedAt: '2026-08-12T10:00:00.000Z',
      cwd: 'C:\\Users\\winuser\\Documents\\Codex\\portal', historyMode: 'legacy',
    });
    mocks.bindSelected.mockResolvedValue({
      channelId: 'c1', participantId: 'p1', bindingId: 'binding-generated',
      nativeSessionId: 'session-1', nativeThreadId: 'thread-1',
    });

    const response = await POST(post({
      action: 'connect-thread', channelId: 'c1', nativeThreadId: 'thread-1',
      permissionMode: 'full-access',
    }));

    expect(mocks.findDesktopThread).toHaveBeenCalledWith('thread-1');
    expect(mocks.ensureBridgeThread).toHaveBeenCalledWith(expect.objectContaining({ id: 'thread-1' }));
    expect(mocks.bindSelected).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'c1', participantId: 'p1',
      nativeSessionId: 'session-1', nativeThreadId: 'thread-1',
      permissionMode: 'full-access',
    }));
    expect(mocks.onboard).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'c1', participantId: 'p1', nativeThreadId: 'thread-1',
    }));
    expect(await response.json()).toMatchObject({
      connection: { status: 'connected', participant: { id: 'p1' } },
    });
  });

  it('binds an automatic legacy replacement for a paginated Desktop chat', async () => {
    mocks.ensureParticipant.mockResolvedValue({ id: 'p1', name: 'Codex Native' });
    mocks.findDesktopThread.mockResolvedValue({
      id: 'paginated-1', sessionId: 'paginated-1', title: 'Life Admin', project: 'you-x20',
      updatedAt: '2026-08-29T12:18:41.000Z', cwd: 'C:\\Codex\\you-x20', historyMode: 'paginated',
    });
    mocks.ensureBridgeThread.mockResolvedValue({
      id: 'legacy-1', sessionId: 'legacy-1', title: 'Life Admin · AgentChat', project: 'you-x20',
      updatedAt: '2026-08-29T12:20:00.000Z', cwd: 'C:\\Codex\\you-x20', historyMode: 'legacy',
    });
    mocks.bindSelected.mockResolvedValue({
      channelId: 'c1', participantId: 'p1', bindingId: 'binding-generated',
      nativeSessionId: 'legacy-1', nativeThreadId: 'legacy-1',
    });

    const response = await POST(post({
      action: 'connect-thread', channelId: 'c1', nativeThreadId: 'paginated-1',
    }));

    expect(mocks.bindSelected).toHaveBeenCalledWith(expect.objectContaining({
      nativeSessionId: 'legacy-1', nativeThreadId: 'legacy-1',
    }));
    expect(await response.json()).toMatchObject({
      connection: { status: 'connected', replacedIncompatibleThread: true },
    });
  });

  it('creates a roster-pane pairing ticket and returns one copyable command', async () => {
    mocks.ensureParticipant.mockResolvedValue({ id: 'p1', name: 'Codex Native' });
    mocks.createPairing.mockResolvedValue({
      pairingId: 'pair-1', pairingCode: 'PAIR-CODE-1', channelId: 'c1',
      participantId: 'p1', expiresAt: '2026-08-09T00:10:00.000Z',
    });

    const response = await POST(post({ action: 'create-pairing', channelId: 'c1' }));
    const payload = await response.json();

    expect(mocks.ensureParticipant).toHaveBeenCalledWith('c1');
    expect(mocks.createPairing).toHaveBeenCalledWith('c1', 'p1', 'restricted');
    expect(payload.connection).toMatchObject({
      status: 'pairing', pairingId: 'pair-1', participant: { id: 'p1' },
    });
    expect(payload.pairingCommand).toContain('PAIR-CODE-1');
  });

  it('redeems a one-time pairing code without trusting channel identity from the client', async () => {
    mocks.redeemPairing.mockResolvedValue({
      channelId: 'c1', participantId: 'p1', bindingId: 'b1',
      nativeSessionId: 's1', nativeThreadId: 't1',
    });

    const response = await POST(post({
      action: 'redeem-pairing',
      pairingCode: 'PAIR-CODE-1',
      nativeSessionId: 's1',
      nativeThreadId: 't1',
      channelId: 'attacker-supplied',
      participantId: 'attacker-supplied',
    }));

    expect(mocks.redeemPairing).toHaveBeenCalledWith({
      pairingCode: 'PAIR-CODE-1', nativeSessionId: 's1', nativeThreadId: 't1',
    });
    expect(mocks.onboard).toHaveBeenCalledWith(expect.objectContaining({ bindingId: 'b1' }));
    expect(await response.json()).toEqual({
      binding: {
        channelId: 'c1', participantId: 'p1', bindingId: 'b1',
        nativeSessionId: 's1', nativeThreadId: 't1',
      },
    });
  });

  it('disconnects by server-resolved liaison identity', async () => {
    mocks.getParticipant.mockResolvedValue({ id: 'p1', name: 'Codex Native' });
    mocks.disconnect.mockResolvedValue({ bindingId: 'b1', unboundAt: 'now' });
    mocks.cancelPairing.mockResolvedValue(undefined);
    mocks.getBinding.mockResolvedValue(null);
    mocks.getPairing.mockResolvedValue(null);

    const response = await POST(post({
      action: 'disconnect', channelId: 'c1', participantId: 'attacker-supplied',
    }));

    expect(mocks.disconnect).toHaveBeenCalledWith('c1', 'p1');
    expect(mocks.cancelPairing).toHaveBeenCalledWith('c1', 'p1');
    expect((await response.json()).connection.status).toBe('disconnected');
  });

  it('authenticates every mutation with write scope', async () => {
    mocks.bind.mockResolvedValue({ bindingId: 'b1' });
    const request = post({
      action: 'bind',
      channelId: 'c1',
      participantId: 'p1',
      bindingId: 'b1',
      nativeSessionId: 's1',
      nativeThreadId: 't1',
      permissionMode: 'restricted',
    });

    const response = await POST(request);

    expect(mocks.requireAuthOrLocal).toHaveBeenCalledWith(request, 'write');
    expect(mocks.bind).toHaveBeenCalledWith({
      channelId: 'c1',
      participantId: 'p1',
      bindingId: 'b1',
      nativeSessionId: 's1',
      nativeThreadId: 't1',
      permissionMode: 'restricted',
    });
    expect(mocks.onboard).toHaveBeenCalledWith(expect.objectContaining({ bindingId: 'b1' }));
    expect(response.status).toBe(200);
  });

  it('changes the active binding permission mode through the server-resolved participant', async () => {
    mocks.getParticipant.mockResolvedValue({ id: 'p1', name: 'Codex Native' });
    mocks.setPermissionMode.mockResolvedValue({
      channelId: 'c1', participantId: 'p1', bindingId: 'b1',
      nativeSessionId: 's1', nativeThreadId: 't1', permissionMode: 'full-access',
    });

    const response = await POST(post({
      action: 'set-permission-mode',
      channelId: 'c1',
      participantId: 'attacker-supplied',
      permissionMode: 'full-access',
    }));

    expect(mocks.setPermissionMode).toHaveBeenCalledWith('c1', 'p1', 'full-access');
    expect(await response.json()).toMatchObject({
      connection: {
        status: 'connected',
        permissionMode: 'full-access',
        exactChatUrl: 'codex://threads/t1',
      },
    });
  });

  it('rejects an unknown native permission mode before binding', async () => {
    mocks.ensureParticipant.mockResolvedValue({ id: 'p1', name: 'Codex Native' });
    mocks.findDesktopThread.mockResolvedValue({
      id: 'thread-1', sessionId: 'session-1', title: 'Build the portal',
      project: 'portal', updatedAt: '2026-08-12T10:00:00.000Z',
      cwd: 'C:\\Users\\winuser\\Documents\\Codex\\portal', historyMode: 'legacy',
    });

    const response = await POST(post({
      action: 'connect-thread', channelId: 'c1', nativeThreadId: 'thread-1',
      permissionMode: 'trust-me',
    }));

    expect(response.status).toBe(400);
    expect(mocks.findDesktopThread).not.toHaveBeenCalled();
    expect(mocks.ensureParticipant).not.toHaveBeenCalled();
    expect(mocks.bindSelected).not.toHaveBeenCalled();
  });

  it('returns an auth denial before touching the store', async () => {
    const denied = NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    mocks.requireAuthOrLocal.mockResolvedValue(denied);

    const response = await POST(post({ action: 'unbind' }));

    expect(response).toBe(denied);
    expect(mocks.unbind).not.toHaveBeenCalled();
  });

  it('maps typed store failures to their declared HTTP status', async () => {
    mocks.claim.mockRejectedValue(Object.assign(new Error('Already in flight'), {
      name: 'CodexNativeStoreError',
      code: 'CODEX_NATIVE_CLAIM_CONFLICT',
      statusCode: 409,
    }));

    const response = await POST(post({
      action: 'claim',
      channelId: 'c1',
      participantId: 'p1',
      bindingId: 'b1',
      nativeSessionId: 's1',
      nativeThreadId: 't1',
      originMessageId: 'm1',
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Already in flight',
      code: 'CODEX_NATIVE_CLAIM_CONFLICT',
    });
  });

  it('requires write auth for explicit cancelled-send release', async () => {
    mocks.releaseClaim.mockResolvedValue({
      originMessageId: 'm1', state: 'waiting', confirmed: false,
    });
    const request = post({
      action: 'release-claim',
      channelId: 'c1',
      participantId: 'p1',
      bindingId: 'b1',
      nativeSessionId: 's1',
      nativeThreadId: 't1',
      originMessageId: 'm1',
    });

    const response = await POST(request);

    expect(mocks.requireAuthOrLocal).toHaveBeenCalledWith(request, 'write');
    expect(mocks.releaseClaim).toHaveBeenCalledWith({
      channelId: 'c1', participantId: 'p1', bindingId: 'b1',
      nativeSessionId: 's1', nativeThreadId: 't1', originMessageId: 'm1',
    });
    expect(await response.json()).toEqual({
      delivery: { originMessageId: 'm1', state: 'waiting', confirmed: false },
    });
  });

  it('rejects unknown write actions', async () => {
    const response = await POST(post({ action: 'launch-daemon' }));
    expect(response.status).toBe(400);
  });

  it('forwards a bounded Stop answer through the authenticated route', async () => {
    mocks.forwardOutbound.mockResolvedValue({
      messageId: 'reply-1',
      replyToMessageId: 'origin-1',
      outboundIdempotencyKey: 'session-1:turn-1',
      deduplicated: false,
    });
    const request = post({
      action: 'forward-outbound',
      nativeSessionId: 'session-1',
      turnId: 'turn-1',
      outboundCorrelationId: 'correlation-1',
      content: 'Final answer',
    });

    const response = await POST(request);

    expect(mocks.requireAuthOrLocal).toHaveBeenCalledWith(request, 'write');
    expect(mocks.forwardOutbound).toHaveBeenCalledWith({
      nativeSessionId: 'session-1',
      turnId: 'turn-1',
      outboundCorrelationId: 'correlation-1',
      content: 'Final answer',
    });
    expect(await response.json()).toEqual({
      forwarded: {
        messageId: 'reply-1',
        replyToMessageId: 'origin-1',
        outboundIdempotencyKey: 'session-1:turn-1',
        deduplicated: false,
      },
    });
  });

  it('rejects an oversized declared body before JSON parsing', async () => {
    const request = new NextRequest('http://localhost:3000/api/codex-native', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(2_000_033),
      },
      body: '{}',
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(mocks.forwardOutbound).not.toHaveBeenCalled();
  });

  it('rejects an oversized chunked body while streaming', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"action":"forward-outbound","content":"'));
        controller.enqueue(new Uint8Array(130 * 1024).fill(120));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const request = new NextRequest('http://localhost:3000/api/codex-native', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    } as never);

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(mocks.forwardOutbound).not.toHaveBeenCalled();
  });
});
