import {
  runCodexDesktopTurn,
  inspectCodexDesktopDelivery,
  CodexDesktopTurnError,
  createAgentChatPrompt,
  extractAgentChatReply,
} from '@/lib/codex-desktop-turn';
import { forwardCodexNativeReply } from '@/lib/codex-native-forward';
import { codexNativeStore } from '@/lib/codex-native-store';
import type {
  CodexNativeBinding,
  CodexNativeClaimInput,
  CodexNativeDelivery,
  CodexNativeInFlightDelivery,
  CodexNativeDeliveryStatus,
  CodexNativeListPendingInput,
  CodexNativePendingMessage,
} from '@/lib/codex-native-store';
import type { CodexNativeForwardInput, CodexNativeForwardResult } from '@/lib/codex-native-forward';
import type { CodexDesktopTurnInput, CodexDesktopTurnResult } from '@/lib/codex-desktop-turn';
import { resolveCodexNativeLocalAttachments } from '@/lib/codex-native-attachments';
import { PRODUCT_NAME } from '@/lib/brand';

interface AutoDeliveryDependencies {
  listActiveBindings(): Promise<CodexNativeBinding[]>;
  getInFlight(input: CodexNativeBinding): Promise<CodexNativeInFlightDelivery | null>;
  listPending(input: CodexNativeListPendingInput): Promise<CodexNativePendingMessage[]>;
  claim(input: CodexNativeClaimInput): Promise<CodexNativeDelivery>;
  releaseClaim(input: CodexNativeClaimInput): Promise<CodexNativeDeliveryStatus>;
  runTurn(input: CodexDesktopTurnInput): Promise<CodexDesktopTurnResult>;
  inspectDelivery(
    threadId: string,
    outboundCorrelationId: string,
    claimedAt: string,
  ): ReturnType<typeof inspectCodexDesktopDelivery>;
  forward(input: CodexNativeForwardInput): Promise<Partial<CodexNativeForwardResult>>;
  log(level: 'info' | 'warn' | 'error', message: string, metadata?: Record<string, unknown>): void;
}

export interface CodexNativeAutoDeliveryRunResult {
  bindings: number;
  forwarded: number;
  failed: number;
  skipped?: boolean;
}

const defaults: AutoDeliveryDependencies = {
  listActiveBindings: () => codexNativeStore.listActiveBindings(),
  getInFlight: (input) => codexNativeStore.getInFlight(input),
  listPending: (input) => codexNativeStore.listPending(input),
  claim: (input) => codexNativeStore.claim(input),
  releaseClaim: (input) => codexNativeStore.releaseClaim(input),
  runTurn: runCodexDesktopTurn,
  inspectDelivery: inspectCodexDesktopDelivery,
  forward: forwardCodexNativeReply,
  log(level, message, metadata) {
    const details = metadata ? ` ${JSON.stringify(metadata)}` : '';
    if (level === 'error') console.error(`[codex-native-auto] ${message}${details}`);
    else if (level === 'warn') console.warn(`[codex-native-auto] ${message}${details}`);
    else console.log(`[codex-native-auto] ${message}${details}`);
  },
};

function terminalFailureMessage(status: 'interrupted' | 'failed'): string {
  const ending = status === 'interrupted'
    ? 'was interrupted before it returned a verified reply'
    : 'ended as failed before it returned a verified reply';
  return [
    `This Codex Native turn ${ending}.`,
    `${PRODUCT_NAME} did not retry it automatically because an external action may already have started.`,
    'Please inspect the target state before asking for a retry.',
  ].join(' ');
}

function unverifiedCompletionMessage(): string {
  return [
    'This Codex Native turn ended without a verified, correlated reply.',
    `${PRODUCT_NAME} did not retry it automatically because an external action may already have started.`,
    'Please inspect the target state before asking for a retry.',
  ].join(' ');
}

export function createCodexNativeAutoDeliveryWorker(
  overrides: Partial<AutoDeliveryDependencies> = {},
) {
  const dependencies: AutoDeliveryDependencies = { ...defaults, ...overrides };
  let running = false;
  const incompatibleBindings = new Set<string>();

  async function reconcileInFlight(
    binding: CodexNativeBinding,
    delivery: CodexNativeInFlightDelivery,
  ): Promise<'forwarded' | 'idle' | 'failed'> {
    if (delivery.state === 'acked') return 'idle';
    const correlation = delivery.outboundCorrelationId;
    if (!correlation) {
      dependencies.log('error', 'in-flight delivery has no reply correlation', {
        channelId: binding.channelId,
        participantId: binding.participantId,
        originMessageId: delivery.originMessageId,
      });
      return 'failed';
    }

    let inspection: Awaited<ReturnType<typeof inspectCodexDesktopDelivery>>;
    try {
      inspection = await dependencies.inspectDelivery(
        binding.nativeThreadId,
        correlation,
        delivery.claimedAt ?? '',
      );
    } catch (error) {
      // Inspection failure is not proof that the native turn ended. Keep the
      // durable claim so a transient Desktop outage cannot cause a duplicate.
      dependencies.log('warn', 'in-flight delivery inspection unavailable; claim retained', {
        channelId: binding.channelId,
        participantId: binding.participantId,
        originMessageId: delivery.originMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }

    if (inspection.state === 'unknown' || inspection.state === 'in-progress') return 'idle';
    if (inspection.state === 'not-started') {
      // The bound legacy thread is idle and its complete turn history contains
      // no prompt carrying this delivery's opaque correlation. This proves
      // turn/start never committed, so replay is safe.
      await dependencies.releaseClaim({ ...binding, originMessageId: delivery.originMessageId });
      dependencies.log('warn', 'orphan claim released after Desktop proved the turn never started', {
        channelId: binding.channelId,
        participantId: binding.participantId,
        originMessageId: delivery.originMessageId,
      });
      return 'failed';
    }

    let content: string;
    if (inspection.state === 'completed') {
      const reply = extractAgentChatReply(inspection.content);
      content = reply && reply.outboundCorrelationId === correlation
        ? reply.content
        : unverifiedCompletionMessage();
    } else {
      content = terminalFailureMessage(inspection.state);
    }
    await dependencies.forward({
      nativeSessionId: binding.nativeSessionId,
      turnId: inspection.turnId,
      outboundCorrelationId: correlation,
      content,
    });
    dependencies.log(
      inspection.state === 'completed' ? 'info' : 'warn',
      'reconciled stranded native delivery from persisted Desktop history',
      {
        channelId: binding.channelId,
        participantId: binding.participantId,
        originMessageId: delivery.originMessageId,
        turnId: inspection.turnId,
        status: inspection.state,
      },
    );
    return 'forwarded';
  }

  async function processBinding(binding: CodexNativeBinding): Promise<'forwarded' | 'idle' | 'failed'> {
    if (incompatibleBindings.has(binding.bindingId)) return 'idle';
    const inFlight = await dependencies.getInFlight(binding);
    if (inFlight) return reconcileInFlight(binding, inFlight);
    // Historical messages remain inspectable through the pending API, but the
    // automatic worker must never execute work that predates this binding.
    // Such work may be hours old and its external side effects may already
    // have been completed by another route while no native chat was attached.
    const pending = await dependencies.listPending({
      ...binding,
      limit: 1,
      currentBindingOnly: true,
    });
    const next = pending[0];
    if (!next) return 'idle';

    let claimed: CodexNativeDelivery;
    try {
      claimed = await dependencies.claim({ ...binding, originMessageId: next.originMessageId });
    } catch (error) {
      dependencies.log('warn', 'claim skipped', {
        channelId: binding.channelId,
        participantId: binding.participantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }

    const correlation = claimed.outboundCorrelationId;
    if (!correlation) {
      await dependencies.releaseClaim({ ...binding, originMessageId: next.originMessageId });
      dependencies.log('error', 'claim did not contain a reply correlation', {
        channelId: binding.channelId,
        originMessageId: next.originMessageId,
      });
      return 'failed';
    }

    try {
      const localAttachments = resolveCodexNativeLocalAttachments(next.attachments);
      const turn = await dependencies.runTurn({
        threadId: binding.nativeThreadId,
        permissionMode: binding.permissionMode ?? 'restricted',
        prompt: createAgentChatPrompt(
          next.content,
          correlation,
          localAttachments,
        ),
        ...(localAttachments.length
          ? { attachmentReadPaths: localAttachments.map((attachment) => attachment.path) }
          : {}),
      });
      if (turn.status !== 'completed') {
        // A completed protocol turn with a terminal failure status is no
        // longer in flight. Resolve it through the normal outbound
        // transaction so the origin gets a visible, exactly-once failure and
        // the next queued message can advance. Never retry automatically:
        // the failed/interrupted turn may already have caused side effects.
        await dependencies.forward({
          nativeSessionId: binding.nativeSessionId,
          turnId: turn.turnId,
          outboundCorrelationId: correlation,
          content: terminalFailureMessage(turn.status),
        });
        dependencies.log('warn', 'terminal turn failure forwarded', {
          channelId: binding.channelId,
          participantId: binding.participantId,
          originMessageId: next.originMessageId,
          turnId: turn.turnId,
          status: turn.status,
        });
        return 'forwarded';
      }
      const reply = extractAgentChatReply(turn.content);
      if (!reply || reply.outboundCorrelationId !== correlation) {
        throw new CodexDesktopTurnError(
          'Codex Desktop final answer did not contain the expected routing marker',
          'CODEX_DESKTOP_REPLY_UNCORRELATED',
          true,
        );
      }
      await dependencies.forward({
        nativeSessionId: binding.nativeSessionId,
        turnId: turn.turnId,
        outboundCorrelationId: correlation,
        content: reply.content,
      });
      dependencies.log('info', 'reply forwarded', {
        channelId: binding.channelId,
        participantId: binding.participantId,
        originMessageId: next.originMessageId,
        turnId: turn.turnId,
      });
      return 'forwarded';
    } catch (error) {
      const turnStarted = error instanceof CodexDesktopTurnError && error.turnStarted;
      const incompatible = error instanceof CodexDesktopTurnError
        && error.code === 'CODEX_DESKTOP_THREAD_HISTORY_UNSUPPORTED';
      if (!turnStarted) {
        try {
          await dependencies.releaseClaim({ ...binding, originMessageId: next.originMessageId });
        } catch (releaseError) {
          dependencies.log('error', 'pre-turn claim release failed', {
            channelId: binding.channelId,
            originMessageId: next.originMessageId,
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          });
        }
      }
      dependencies.log(turnStarted ? 'error' : 'warn', turnStarted
        ? 'turn failed after start; claim retained to prevent duplicate work'
        : incompatible
          ? 'binding uses an incompatible Codex history mode; claim released and retries paused'
          : 'turn was not started; claim released for retry', {
        channelId: binding.channelId,
        participantId: binding.participantId,
        originMessageId: next.originMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (incompatible) incompatibleBindings.add(binding.bindingId);
      return 'failed';
    }
  }

  async function runOnce(): Promise<CodexNativeAutoDeliveryRunResult> {
    if (running) return { bindings: 0, forwarded: 0, failed: 0, skipped: true };
    running = true;
    try {
      const bindings = await dependencies.listActiveBindings();
      let forwarded = 0;
      let failed = 0;
      for (const binding of bindings) {
        try {
          const result = await processBinding(binding);
          if (result === 'forwarded') forwarded += 1;
          if (result === 'failed') failed += 1;
        } catch (error) {
          failed += 1;
          dependencies.log('error', 'binding delivery cycle failed', {
            channelId: binding.channelId,
            participantId: binding.participantId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { bindings: bindings.length, forwarded, failed };
    } finally {
      running = false;
    }
  }

  return { runOnce };
}

export const codexNativeAutoDeliveryWorker = createCodexNativeAutoDeliveryWorker();
