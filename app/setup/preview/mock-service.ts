import type { AddressService, DomainCheck } from '@/lib/setup/address-step';

/** Pretend backend for the preview page. Real installs use the installer and names service instead. */
export type Scenario =
  | 'free'
  | 'full'
  | 'down'
  | 'own'
  | 'own-wrong-address'
  | 'own-proxied'
  | 'own-blocked'
  | 'padlock-fail';

export const SCENARIOS: Scenario[] = [
  'free', 'full', 'down', 'own', 'own-wrong-address', 'own-proxied', 'own-blocked', 'padlock-fail',
];

const SERVER = '203.0.113.5';

export function makeMockService(scenario: Scenario, stepMs = 1200): AddressService {
  const started = new Map<string, number>();
  let checks = 0;
  const failing: DomainCheck | null =
    scenario === 'own-wrong-address' ? 'wrong-address' : scenario === 'own-proxied' ? 'proxied' : scenario === 'own-blocked' ? 'certificate-blocked' : null;

  return {
    installDomain: async () => 'my.example.test',
    vpsAddress: async () => SERVER,
    suggestName: async () => {
      if (scenario === 'full') return { ok: false, reason: 'full' };
      if (scenario === 'down') return { ok: false, reason: 'unreachable' };
      return { ok: true, name: 'calm-otter-4821.my.example.test' };
    },
    claimStatus: async (name) => {
      if (!started.has(name)) started.set(name, Date.now());
      const age = Date.now() - (started.get(name) ?? Date.now());
      if (scenario === 'padlock-fail' && age > stepMs * 2) {
        return { name, pointed: true, padlock: false, failure: 'The certificate service did not answer in time.' };
      }
      return { name, pointed: age > stepMs, padlock: scenario !== 'padlock-fail' && age > stepMs * 2 };
    },
    checkOwnDomain: async () => {
      checks += 1;
      if (failing) return { result: failing, foundAddress: failing === 'wrong-address' ? '198.51.100.7' : undefined };
      return { result: checks === 1 ? 'not-found' : 'found' };
    },
  };
}
