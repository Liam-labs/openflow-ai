/**
 * What the credential broker may do in version 1: one action, `test-key`, which checks a saved provider key against the provider's own
 * address (the wizard's Test button, behind the broker). `start-agent` follows as its own card.
 */
import type { BrokerAction } from '@/lib/credential-broker';
import { loadCatalog, KEY_TESTS, type Connector, type KeyTestId } from '@/lib/connectors/catalog';
import { testKey } from '@/lib/connectors/test-key';

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

export const BROKER_ACTIONS = { 'test-key': testKeyAction } as const;
