import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { codexNativeStore } from '@/lib/codex-native-store';
import { forwardCodexNativeReply } from '@/lib/codex-native-forward';
import { codexNativeParticipantRegistry } from '@/lib/codex-native-participant';
import {
  ensureCodexDesktopBridgeThread,
  findCodexDesktopThread,
  listCodexDesktopThreads,
} from '@/lib/codex-desktop-threads';
import { onboardCodexNativeBinding } from '@/lib/codex-native-onboarding';
import type { CodexNativePermissionMode } from '@/lib/codex-native-store';

const MAX_POST_BODY_BYTES = 128 * 1024;

async function boundedJsonBody(
  request: NextRequest,
): Promise<{ body?: Record<string, unknown>; response?: NextResponse }> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_POST_BODY_BYTES) {
    return { response: NextResponse.json({ error: 'Request body is too large' }, { status: 413 }) };
  }
  if (!request.body) {
    return { response: NextResponse.json({ error: 'Valid JSON body required' }, { status: 400 }) };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_POST_BODY_BYTES) {
        await reader.cancel();
        return { response: NextResponse.json({ error: 'Request body is too large' }, { status: 413 }) };
      }
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { response: NextResponse.json({ error: 'JSON object body required' }, { status: 400 }) };
    }
    return { body: parsed as Record<string, unknown> };
  } catch {
    return { response: NextResponse.json({ error: 'Valid JSON body required' }, { status: 400 }) };
  } finally {
    reader.releaseLock();
  }
}

function field(source: URLSearchParams | Record<string, unknown>, key: string): string {
  if (source instanceof URLSearchParams) return source.get(key) ?? '';
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function permissionMode(
  source: Record<string, unknown>,
  defaultMode: CodexNativePermissionMode = 'restricted',
): CodexNativePermissionMode {
  const value = source.permissionMode;
  if (value === undefined || value === '') return defaultMode;
  if (value === 'restricted' || value === 'full-access') return value;
  throw Object.assign(new Error('permissionMode must be restricted or full-access'), {
    code: 'CODEX_NATIVE_INVALID_INPUT',
    statusCode: 400,
  });
}

function storeError(error: unknown): NextResponse {
  if (
    error
    && typeof error === 'object'
    && 'statusCode' in error
    && typeof error.statusCode === 'number'
    && 'code' in error
    && typeof error.code === 'string'
  ) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Codex Native request failed',
        code: error.code,
      },
      { status: error.statusCode },
    );
  }
  return NextResponse.json({ error: 'Codex Native request failed' }, { status: 500 });
}

async function onboardBestEffort(binding: Awaited<ReturnType<typeof codexNativeStore.bind>>): Promise<void> {
  try {
    await onboardCodexNativeBinding(binding);
  } catch (error) {
    console.error('[codex-native] Connected, but automatic channel onboarding failed:', error);
  }
}

async function channelConnection(channelId: string) {
  const participant = await codexNativeParticipantRegistry.get(channelId);
  if (!participant) return { status: 'disconnected' as const };
  const binding = await codexNativeStore.getBinding(channelId, participant.id);
  if (binding) {
    return {
      status: 'connected' as const,
      participant: { id: participant.id, name: participant.name },
      binding,
      permissionMode: binding.permissionMode ?? 'restricted',
      exactChatUrl: `codex://threads/${encodeURIComponent(binding.nativeThreadId)}`,
    };
  }
  const pairing = await codexNativeStore.getPairing(channelId, participant.id);
  if (pairing) {
    return {
      status: 'pairing' as const,
      participant: { id: participant.id, name: participant.name },
      pairingId: pairing.pairingId,
      permissionMode: pairing.permissionMode ?? 'restricted',
      expiresAt: pairing.expiresAt,
    };
  }
  return {
    status: 'disconnected' as const,
    participant: { id: participant.id, name: participant.name },
  };
}

export const GET = tracked('/api/codex-native', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const params = request.nextUrl.searchParams;
    const mode = field(params, 'mode');
    const channelId = field(params, 'channelId');
    const participantId = field(params, 'participantId');

    if (mode === 'binding') {
      const binding = await codexNativeStore.getBinding(channelId, participantId);
      return NextResponse.json({ binding });
    }
    if (mode === 'connection') {
      return NextResponse.json({ connection: await channelConnection(channelId) });
    }
    if (mode === 'threads') {
      const threads = (await listCodexDesktopThreads()).map(({ id, title, project, updatedAt }) => ({
        id,
        title,
        project,
        updatedAt,
      }));
      return NextResponse.json({ threads });
    }
    if (mode === 'pending') {
      const rawLimit = Number.parseInt(field(params, 'limit'), 10);
      const pending = await codexNativeStore.listPending({
        channelId,
        participantId,
        bindingId: field(params, 'bindingId'),
        nativeSessionId: field(params, 'nativeSessionId'),
        nativeThreadId: field(params, 'nativeThreadId'),
        limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
      });
      return NextResponse.json({ pending });
    }
    if (mode === 'status') {
      const delivery = await codexNativeStore.getDeliveryStatus({
        channelId,
        participantId,
        bindingId: field(params, 'bindingId'),
        nativeSessionId: field(params, 'nativeSessionId'),
        nativeThreadId: field(params, 'nativeThreadId'),
        originMessageId: field(params, 'originMessageId'),
      });
      return NextResponse.json({ delivery });
    }
    return NextResponse.json(
      { error: 'mode must be binding, connection, threads, pending, or status' },
      { status: 400 },
    );
  } catch (error) {
    return storeError(error);
  }
});

export const POST = tracked('/api/codex-native', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const parsed = await boundedJsonBody(request);
    if (parsed.response) return parsed.response;
    const body = parsed.body!;

    const action = field(body, 'action');
    const binding = {
      channelId: field(body, 'channelId'),
      participantId: field(body, 'participantId'),
      bindingId: field(body, 'bindingId'),
      nativeSessionId: field(body, 'nativeSessionId'),
      nativeThreadId: field(body, 'nativeThreadId'),
    };

    switch (action) {
      case 'create-pairing': {
        const channelId = field(body, 'channelId');
        const selectedPermissionMode = permissionMode(body);
        const participant = await codexNativeParticipantRegistry.ensure(channelId);
        const ticket = await codexNativeStore.createPairing(
          channelId,
          participant.id,
          selectedPermissionMode,
        );
        return NextResponse.json({
          connection: {
            status: 'pairing',
            participant: { id: participant.id, name: participant.name },
            pairingId: ticket.pairingId,
            permissionMode: ticket.permissionMode ?? selectedPermissionMode,
            expiresAt: ticket.expiresAt,
          },
          pairingCommand:
            `Open the Codex AgentChat bridge and connect this native chat using pairing code ${ticket.pairingCode}.`,
        });
      }
      case 'redeem-pairing': {
        const redeemed = await codexNativeStore.redeemPairing({
            pairingCode: field(body, 'pairingCode'),
            nativeSessionId: field(body, 'nativeSessionId'),
            nativeThreadId: field(body, 'nativeThreadId'),
        });
        await onboardBestEffort(redeemed);
        return NextResponse.json({ binding: redeemed });
      }
      case 'connect-thread': {
        const channelId = field(body, 'channelId');
        const selectedPermissionMode = permissionMode(body);
        const selected = await findCodexDesktopThread(field(body, 'nativeThreadId'));
        const compatible = await ensureCodexDesktopBridgeThread(selected);
        const participant = await codexNativeParticipantRegistry.ensure(channelId);
        const connected = await codexNativeStore.bindSelected({
          channelId,
          participantId: participant.id,
          bindingId: randomUUID(),
          nativeSessionId: compatible.sessionId,
          nativeThreadId: compatible.id,
          permissionMode: selectedPermissionMode,
        });
        await onboardBestEffort(connected);
        return NextResponse.json({
          connection: {
            status: 'connected',
            participant: { id: participant.id, name: participant.name },
            binding: connected,
            permissionMode: connected.permissionMode ?? selectedPermissionMode,
            exactChatUrl: `codex://threads/${encodeURIComponent(connected.nativeThreadId)}`,
            replacedIncompatibleThread: compatible.id !== selected.id,
          },
        });
      }
      case 'disconnect': {
        const channelId = field(body, 'channelId');
        const participant = await codexNativeParticipantRegistry.get(channelId);
        if (participant) {
          await codexNativeStore.disconnect(channelId, participant.id);
          await codexNativeStore.cancelPairing(channelId, participant.id);
        }
        return NextResponse.json({ connection: await channelConnection(channelId) });
      }
      case 'set-permission-mode': {
        const channelId = field(body, 'channelId');
        const participant = await codexNativeParticipantRegistry.get(channelId);
        if (!participant) {
          return NextResponse.json({ error: 'Codex Native participant not found' }, { status: 404 });
        }
        const updated = await codexNativeStore.setPermissionMode(
          channelId,
          participant.id,
          permissionMode(body),
        );
        return NextResponse.json({
          connection: {
            status: 'connected',
            participant: { id: participant.id, name: participant.name },
            binding: updated,
            permissionMode: updated.permissionMode ?? 'restricted',
            exactChatUrl: `codex://threads/${encodeURIComponent(updated.nativeThreadId)}`,
          },
        });
      }
      case 'bind': {
        const connected = await codexNativeStore.bind({
          ...binding,
          permissionMode: permissionMode(body),
        });
        await onboardBestEffort(connected);
        return NextResponse.json({ binding: connected });
      }
      case 'unbind':
        return NextResponse.json({ binding: await codexNativeStore.unbind(binding) });
      case 'claim':
        return NextResponse.json({
          delivery: await codexNativeStore.claim({
            ...binding,
            originMessageId: field(body, 'originMessageId'),
          }),
        });
      case 'release-claim':
        return NextResponse.json({
          delivery: await codexNativeStore.releaseClaim({
            ...binding,
            originMessageId: field(body, 'originMessageId'),
          }),
        });
      case 'forward-outbound':
        return NextResponse.json({
          forwarded: await forwardCodexNativeReply({
            nativeSessionId: field(body, 'nativeSessionId'),
            turnId: field(body, 'turnId'),
            outboundCorrelationId: field(body, 'outboundCorrelationId'),
            content: field(body, 'content'),
          }),
        });
      default:
        return NextResponse.json({ error: 'Unknown Codex Native action' }, { status: 400 });
    }
  } catch (error) {
    return storeError(error);
  }
});
