/**
 * Logic and wording for the setup wizard step "How will you reach OpenFlow?".
 *
 * The screens in components/setup/AddressStep.tsx only draw this. Every decision lives here
 * so it can be tested without a browser. The install domain is a setting: nothing in this
 * file names it, and every sentence that shows an address receives it as an argument.
 */

// ─── What the screens need from the backend ─────────────────────────────────

/** Why the free addresses cannot be offered. */
export type FreeNamesUnavailable = 'full' | 'unreachable';

/** What an outside check of the person's own domain found. */
export type DomainCheck = 'found' | 'not-found' | 'wrong-address' | 'proxied' | 'certificate-blocked';

export type NameSuggestion =
  | { ok: true; name: string }
  | { ok: false; reason: FreeNamesUnavailable };

export interface ClaimStatus {
  name: string;
  /** The name points at the server. */
  pointed: boolean;
  /** The padlock (HTTPS certificate) is issued. */
  padlock: boolean;
  /** One plain sentence, set when the installer could not finish the padlock. */
  failure?: string;
}

export interface DomainCheckResult {
  result: DomainCheck;
  /** The address the check found, when it found a different one. */
  foundAddress?: string;
}

export interface AddressService {
  /** The install domain, read from the setting. */
  installDomain(): Promise<string>;
  /** The public address of the VPS. */
  vpsAddress(): Promise<string>;
  suggestName(): Promise<NameSuggestion>;
  claimStatus(name: string): Promise<ClaimStatus>;
  checkOwnDomain(host: string, expectedAddress: string): Promise<DomainCheckResult>;
}

// ─── Own-domain helpers ─────────────────────────────────────────────────────

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Turns whatever the person typed into a bare domain, or null when it cannot be one.
 * Accepts "Example.com", "https://example.com/path" and "www.example.com". Rejects IP addresses,
 * single words and anything with a space or a port.
 */
export function normaliseDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split(/[/?#]/)[0] ?? '';
  value = value.replace(/\.$/, '');
  if (value.startsWith('www.')) value = value.slice(4);
  if (!value || value.length > 253) return null;
  const labels = value.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL_RE.test(l))) return null;
  // The last label is the top-level name. It must hold a letter, which also rules out IP addresses.
  if (!/[a-z]/.test(labels[labels.length - 1])) return null;
  return value;
}

/** Whether the part before the dot can be used as a name. */
export function isValidHostLabel(label: string): boolean {
  return LABEL_RE.test(label);
}

/** The address OpenFlow will use on the person's domain. */
export function ownDomainHost(domain: string, label = 'openflow'): string | null {
  const d = normaliseDomain(domain);
  if (!d || !isValidHostLabel(label)) return null;
  return `${label}.${d}`;
}

/** The server's own address on the free sslip.io service, such as 203-0-113-5.sslip.io. IPv4 only. */
export function fallbackAddress(ipv4: string): string | null {
  const parts = ipv4.trim().split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^(0|[1-9]\d{0,2})$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n > 255)) return null;
  return `${nums.join('-')}.sslip.io`;
}

// ─── Screens and state ──────────────────────────────────────────────────────

export type AddressChoice = 'free' | 'own';

export type AddressState =
  | { screen: 'choose'; choice: AddressChoice }
  | { screen: 'free'; name: string | null; pointed: boolean; padlock: boolean }
  | { screen: 'own-domain' }
  | { screen: 'own-record'; host: string; check: DomainCheckResult | null }
  | { screen: 'own-ticks'; host: string; pointed: boolean; padlock: boolean }
  | { screen: 'unavailable'; reason: FreeNamesUnavailable }
  | { screen: 'padlock-failed'; reason: string; name: string; route: AddressChoice }
  | { screen: 'done'; address: string };

export type AddressEvent =
  | { type: 'pick'; choice: AddressChoice }
  | { type: 'continue' }
  | { type: 'suggested'; suggestion: NameSuggestion }
  | { type: 'claim'; status: ClaimStatus }
  | { type: 'choose-another' }
  | { type: 'domain-entered'; domain: string }
  | { type: 'domain-checked'; result: DomainCheckResult }
  | { type: 'use-server-address'; address: string }
  | { type: 'use-own-domain' }
  | { type: 'retry' }
  | { type: 'finish' };

export const INITIAL_ADDRESS_STATE: AddressState = { screen: 'choose', choice: 'free' };

/**
 * One step forward. An event that makes no sense on the current screen changes nothing,
 * so a late answer from the backend cannot drag the person to the wrong screen.
 */
export function nextAddressState(state: AddressState, event: AddressEvent): AddressState {
  switch (event.type) {
    case 'pick':
      return state.screen === 'choose' ? { screen: 'choose', choice: event.choice } : state;

    case 'continue':
      if (state.screen === 'choose') {
        return state.choice === 'free'
          ? { screen: 'free', name: null, pointed: false, padlock: false }
          : { screen: 'own-domain' };
      }
      if (state.screen === 'own-record' && state.check?.result === 'found') {
        return { screen: 'own-ticks', host: state.host, pointed: true, padlock: false };
      }
      return state;

    case 'suggested':
      if (state.screen !== 'free' || state.name !== null) return state;
      return event.suggestion.ok
        ? { ...state, name: event.suggestion.name }
        : { screen: 'unavailable', reason: event.suggestion.reason };

    case 'claim':
      if (state.screen === 'free') {
        if (state.name !== null && event.status.name !== state.name) return state;
        if (event.status.failure) return { screen: 'padlock-failed', reason: event.status.failure, name: event.status.name, route: 'free' };
        return {
          ...state,
          name: event.status.name,
          pointed: event.status.pointed,
          padlock: event.status.padlock,
        };
      }
      if (state.screen === 'own-ticks') {
        if (event.status.name !== state.host) return state;
        if (event.status.failure) return { screen: 'padlock-failed', reason: event.status.failure, name: state.host, route: 'own' };
        return { ...state, pointed: event.status.pointed, padlock: event.status.padlock };
      }
      return state;

    case 'choose-another':
      // Only before the first padlock is issued.
      return state.screen === 'free' && !state.padlock && state.name !== null
        ? { screen: 'free', name: null, pointed: false, padlock: false }
        : state;

    case 'domain-entered': {
      if (state.screen !== 'own-domain') return state;
      const host = ownDomainHost(event.domain);
      return host ? { screen: 'own-record', host, check: null } : state;
    }

    case 'domain-checked':
      return state.screen === 'own-record' ? { ...state, check: event.result } : state;

    case 'use-server-address':
      return state.screen === 'unavailable' ? { screen: 'done', address: event.address } : state;

    case 'use-own-domain':
      return state.screen === 'unavailable' ? { screen: 'own-domain' } : state;

    case 'retry':
      if (state.screen === 'unavailable') {
        return { screen: 'free', name: null, pointed: false, padlock: false };
      }
      if (state.screen === 'padlock-failed') {
        // Same name again: the installer retries the padlock, it does not pick a new name.
        return state.route === 'own'
          ? { screen: 'own-ticks', host: state.name, pointed: true, padlock: false }
          : { screen: 'free', name: state.name, pointed: true, padlock: false };
      }
      return state;

    case 'finish':
      if (state.screen === 'free' && state.padlock && state.name) {
        return { screen: 'done', address: state.name };
      }
      if (state.screen === 'own-ticks' && state.padlock) {
        return { screen: 'done', address: state.host };
      }
      return state;
  }
}

/** Whether the Continue button of the current screen can be pressed. */
export function canContinue(state: AddressState): boolean {
  switch (state.screen) {
    case 'choose':
      return true;
    case 'free':
      return state.padlock && state.name !== null;
    case 'own-record':
      return state.check?.result === 'found';
    case 'own-ticks':
      return state.padlock;
    default:
      return false;
  }
}

// ─── Wording ────────────────────────────────────────────────────────────────
// Plain sentences, one topic each, no semicolons. "Address" is what goes into a browser.
// "Domain" appears only on the own-domain screens. The install domain is never written here.

export const ADDRESS_COPY = {
  chooseTitle: 'How will you reach OpenFlow?',
  freeCardTitle: "Use OpenFlow's free address",
  freeCardBody: (example: string) =>
    `Your install gets its own address, such as ${example}. There is nothing to buy and nothing to set up.`,
  ownCardTitle: 'Use my own domain instead',
  ownCardBody:
    "Choose this if you want your own branding, an address you control, or an address that keeps working if OpenFlow's domain ever changes.",
  freeTitle: 'Getting your address',
  tickChosen: (name: string) => `Address chosen: ${name}`,
  tickPointed: 'Address pointed at your server',
  tickPadlock: 'Padlock issued',
  ready: 'Your address is ready.',
  chooseAnother: 'Choose another',
  ownDomainTitle: 'Your domain',
  ownDomainHelp: 'Type the domain you own, such as example.com.',
  ownDomainUse: (host: string) => `We will use ${host}.`,
  ownDomainInvalid: 'That does not look like a domain. Type it like this: example.com.',
  recordTitle: 'Add this at your domain provider',
  recordCloudflare: 'If your provider is Cloudflare, set the cloud to grey ("DNS only").',
  found: 'Found it.',
  notFound: 'We cannot see it yet. A new record can take a few minutes.',
  wrongAddress: (found: string, expected: string) =>
    `We found ${found}, but it should be ${expected}. Change it, then check again.`,
  proxied: 'Your provider is passing visitors through its own servers. Set the record to DNS only, then check again.',
  certificateBlocked:
    'Your domain has a rule that stops us making the padlock. Add letsencrypt.org to it, then check again.',
  full: "OpenFlow's free addresses are all taken for this week.",
  unreachable: 'We cannot reach the address service right now.',
  unavailableBody: (fallback: string) =>
    `Your server's own address works right now: ${fallback}. It changes if your server's address changes.`,
  padlockFailed: (reason: string) => `We could not make your padlock. ${reason}`,
  showDetails: 'Show details',
  buttons: {
    continue: 'Continue',
    next: 'Next',
    check: 'Check',
    checkAgain: 'Check again',
    tryAgain: 'Try again',
    copy: 'Copy',
    openIt: 'Open it',
    useServerAddress: "Use the server's address",
    useOwnDomain: 'Use my own domain',
  },
} as const;

/** The sentence for an own-domain check result, or null when the check passed. */
export function domainCheckMessage(check: DomainCheckResult, expectedAddress: string): string | null {
  switch (check.result) {
    case 'found':
      return null;
    case 'not-found':
      return ADDRESS_COPY.notFound;
    case 'wrong-address':
      return ADDRESS_COPY.wrongAddress(check.foundAddress ?? 'a different address', expectedAddress);
    case 'proxied':
      return ADDRESS_COPY.proxied;
    case 'certificate-blocked':
      return ADDRESS_COPY.certificateBlocked;
  }
}

/** The opening sentence of the "names are full or the service is down" screen. */
export function unavailableMessage(reason: FreeNamesUnavailable): string {
  return reason === 'full' ? ADDRESS_COPY.full : ADDRESS_COPY.unreachable;
}
