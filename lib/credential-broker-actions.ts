/**
 * What the credential broker may do in version 1: `test-key` checks a saved provider key against the provider's own
 * address (the wizard's Test button, behind the broker). `start-agent` starts a roster agent and hands its key to the launch shell
 * through a one-shot file (lib/agent-key-handoff.ts), so the key is in no argument, log or answer.
 */
import type { BrokerAction } from '@/lib/credential-broker';
import { loadCatalog, KEY_TESTS, type Connector, type KeyTestId } from '@/lib/connectors/catalog';
import { testKey } from '@/lib/connectors/test-key';
import { isDeepSeekModel } from '@/lib/deepseek-env';

function keyOf(c: Connector): { env: string; test: KeyTestId } | null {
  const k = c.setup?.key;
  return k && k.env && k.test && (KEY_TESTS as readonly string[]).includes(k.test) ? { env: k.env, test: k.test as KeyTestId } : null;
}

export const testKeyAction: BrokerAction<{ connectorId: string }> = {
  id: 'test-key',
  async validateArgs(args) {
    const id = args && typeof args === 'object' ? (args as { connectorId?: unknown }).connectorId : undefined;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(id)) return 'Say which connector to check, for example { "connectorId": "deepseek" }.';
    const c = (await loadCatalog()).connectors.find((x) => x.id === id);
    if (!c || !keyOf(c)) return 'That connector has no key check.';
    return { connectorId: id };
  },
  async names(args) {
    const c = (await loadCatalog()).connectors.find((x) => x.id === args.connectorId);
    const k = c && keyOf(c);
    return k ? [k.env] : [];
  },
  async run(args, secrets) {
    const c = (await loadCatalog()).connectors.find((x) => x.id === args.connectorId);
    const k = c && keyOf(c);
    if (!k) return { ok: false, message: 'That connector has no key check.' };
    const r = await testKey(k.test, secrets[k.env]);
    return { ok: r.ok, message: r.message };
  },
};

// ---- start-agent ----------------------------------------------------------------------------------------------------------

interface StartAgentArgs { channelId: string; agentId: string }
const ID = /^[A-Za-z0-9._:-]{1,80}$/;

/** The provider key an agent's model needs, or none. Today only DeepSeek agents get one. */
export function keyNamesForModel(model: string | undefined, flags: readonly string[] = []): string[] {
  const flagged = flags.indexOf('--model') >= 0 ? flags[flags.indexOf('--model') + 1] : undefined;
  return isDeepSeekModel(flagged ?? model) ? ['DEEPSEEK_API_KEY'] : [];
}

async function findAgent(a: StartAgentArgs) {
  const { readChannelsData } = await import('@/app/api/collab/pty/_pty-shared');
  const channel = (await readChannelsData()).channels.find((c) => c.id === a.channelId);
  return channel?.roster?.agents.find((x) => x.id === a.agentId);
}

export const startAgentAction: BrokerAction<StartAgentArgs> = {
  id: 'start-agent',
  validateArgs(args) {
    const o = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
    if (typeof o.channelId !== 'string' || !ID.test(o.channelId) || typeof o.agentId !== 'string' || !ID.test(o.agentId)) return 'Say which agent to start, for example { "channelId": "...", "agentId": "..." }.';
    return { channelId: o.channelId, agentId: o.agentId };
  },
  async names(args) {
    const agent = await findAgent(args);
    return agent ? keyNamesForModel(agent.model, agent.claudeFlags) : [];
  },
  async run(args, secrets) {
    const { handleRosterSpawn } = await import('@/app/api/collab/pty/_handlers/message-inject');
    const res = await handleRosterSpawn(args.channelId, args.agentId, new Date().toISOString(), true, undefined, undefined, false, secrets);
    if (res.status >= 400) return { ok: false, message: 'The agent did not start.' };
    return { ok: true, message: 'The agent was started with its key.' };
  },
};

export const BROKER_ACTIONS = { 'test-key': testKeyAction, 'start-agent': startAgentAction } as const;
