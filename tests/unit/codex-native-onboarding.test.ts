import { describe, expect, it, vi } from 'vitest';

import { getDevflowHome } from '@/lib/home-dir';
import { createCodexNativeOnboarder } from '@/lib/codex-native-onboarding';

const binding = {
  channelId: 'channel-1',
  participantId: 'native-1',
  bindingId: 'binding-1',
  nativeSessionId: 'session-1',
  nativeThreadId: 'thread-1',
  boundAt: '2026-08-28T00:00:00.000Z',
  lastActiveAt: '2026-08-28T00:00:00.000Z',
};

describe('Codex Native channel onboarding', () => {
  it('primes the native chat with generated handles and asks existing agents to introduce themselves once', async () => {
    const channel = {
      id: 'channel-1',
      name: 'Drone Hub',
      participants: [
        { id: 'native-1', name: 'Codex', type: 'codex' },
        { id: 'pete', name: 'Pete', type: 'user' },
        { id: 'dave', name: 'Dave', type: 'codex' },
        { id: 'sam', name: 'Margaret', type: 'claude' },
      ],
    };
    const messages: Array<Record<string, unknown>> = [];
    const appendIfAbsent = vi.fn(async (_channelId, message) => {
      messages.push(message as unknown as Record<string, unknown>);
      return { message, appended: true };
    });
    const enqueueDelivery = vi.fn(async () => []);
    const deliverMessage = vi.fn();
    const onboard = createCodexNativeOnboarder({
      getChannel: vi.fn(async () => channel as never),
      hasMessage: vi.fn(async () => false),
      appendIfAbsent,
      prepareDelivery: vi.fn(),
      enqueueDelivery,
      emitMessage: vi.fn(),
      deliverMessage,
      now: () => new Date('2026-08-28T00:01:00.000Z'),
    });

    await expect(onboard(binding)).resolves.toEqual({
      primerCreated: true,
      introductionRequestCreated: true,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      recipients: ['native-1'],
      mentions: ['native-1'],
      system: true,
      metadata: {
        isHidden: true,
        client: { kind: 'codex-native.onboarding.primer', bindingId: 'binding-1' },
      },
    });
    expect(messages[0].content).toContain('Pete (user): @Pete');
    expect(messages[0].content).toContain('Dave (agent): @Dave');
    expect(messages[0].content).toContain('Margaret (agent): @Margaret');
    expect(messages[0].content).toContain('Model-neutral DevFlow MCP Gateway');
    expect(messages[0].content).toContain(`${getDevflowHome()}/data/skills/account-access/SKILL.md`);
    expect(messages[0].content).toContain(`${getDevflowHome()}/data/skills/onepassword/SKILL.md`);
    expect(messages[0].content).toContain(`wsl -- ${getDevflowHome()}/scripts/devflow-gateway --help`);
    expect(messages[0].content).toContain('Never call the 1Password CLI directly');
    expect(messages[1]).toMatchObject({
      recipients: ['dave', 'sam'],
      mentions: ['dave', 'sam'],
      metadata: {
        client: { kind: 'codex-native.onboarding.introduction-request', participantId: 'native-1' },
      },
    });
    expect(messages[1].content).toContain('@Dave @Margaret');
    expect(messages[1].content).toContain('Address your reply to @Codex');
    expect(enqueueDelivery).toHaveBeenCalledTimes(2);
    expect(deliverMessage).toHaveBeenCalledTimes(2);
  });

  it('does not repeat the primer when the same native thread reconnects', async () => {
    const channel = {
      id: 'channel-1', name: 'Drone Hub',
      participants: [
        { id: 'native-1', name: 'Codex', type: 'codex' },
        { id: 'dave', name: 'Dave', type: 'codex' },
      ],
    };
    const stored = new Map<string, unknown>();
    const appendIfAbsent = vi.fn(async (_channelId, message) => {
      const appended = !stored.has(message.id);
      if (appended) stored.set(message.id, message);
      return { message, appended };
    });
    const onboard = createCodexNativeOnboarder({
      getChannel: vi.fn(async () => channel as never),
      hasMessage: vi.fn(async () => true),
      appendIfAbsent,
      prepareDelivery: vi.fn(), enqueueDelivery: vi.fn(),
      emitMessage: vi.fn(), deliverMessage: vi.fn(),
      now: () => new Date('2026-08-28T00:01:00.000Z'),
    });

    await expect(onboard(binding)).resolves.toEqual({
      primerCreated: true,
      introductionRequestCreated: false,
    });
    await expect(onboard({ ...binding, bindingId: 'binding-2' })).resolves.toEqual({
      primerCreated: false,
      introductionRequestCreated: false,
    });
    expect(appendIfAbsent).toHaveBeenCalledTimes(2);
    expect(appendIfAbsent.mock.calls[1][1]).toMatchObject({
      metadata: { client: { kind: 'codex-native.onboarding.primer', bindingId: 'binding-2' } },
    });
    expect(appendIfAbsent.mock.calls[0][1].id).toBe(appendIfAbsent.mock.calls[1][1].id);
  });
});
