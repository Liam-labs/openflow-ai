/**
 * Logic and wording for the setup wizard step "How will you reach OpenFlow?".
 *
 * The screens in components/setup/AddressStep.tsx only draw this. Every decision lives here
 * so it can be tested without a browser. The install domain is a setting: nothing in this
 * file names it, and every sentence that shows an address receives it as an argument.
 */

// ─── What the screens need from the backend ─────────────────────────────────

/**
 * Why the free addresses cannot be offered.
 * - full: the weekly cap of new names is reached.
 * - limit: too many names were requested from this network today.
 * - unreachable: the names service could not be reached.
 */
export type FreeNamesUnavailable = 'full' | 'limit' | 'unreachable';

/** Where a claim stands in the names service. The service knows nothing about the padlock. */
export type ClaimState = 'pending' | 'active' | 'suspended' | 'expired';

/** What an outside check of the person's own domain found. */
export type DomainCheck =
  | 'found'
  | 'not-found'
  | 'wrong-address'
  | 'proxied'
  | 'certificate-blocked'
  /** The service answered HTTP 429, code rate_limited. The screen never retries by itself. */
  | 'rate-limited';

/**
 * Asking for a name is a claim, not a read-only suggestion. The service holds the name as pending
 * for about ten minutes until the server confirms it.
 */
export type NameSuggestion =
  | { ok: true; name: string; rerollsLeft: number }
  | { ok: false; reason: FreeNamesUnavailable };

export type RerollResult =
  | { ok: true; name: string; rerollsLeft: number }
  | { ok: false; reason: 'no-more' | 'unreachable' };

export interface ClaimStatus {
  name: string;
  state: ClaimState;
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
  /** Claims a new random name. */
  suggestName(): Promise<NameSuggestion>;
  /** Swaps a pending claim for another random name. The service allows a few of these for each claim. */
  chooseAnother(name: string): Promise<RerollResult>;
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
  | { screen: 'free'; name: string | null; rerollsLeft: number; pointed: boolean; padlock: boolean }
  | { screen: 'own-domain' }
  | { screen: 'own-record'; host: string; check: DomainCheckResult | null }
  | { screen: 'own-ticks'; host: string; pointed: boolean; padlock: boolean }
  | { screen: 'unavailable'; reason: FreeNamesUnavailable }
  | { screen: 'padlock-failed'; reason: string; name: string; route: AddressChoice }
  | { screen: 'expired'; why: 'expired' | 'suspended' }
  | { screen: 'done'; address: string };

export type AddressEvent =
  | { type: 'pick'; choice: AddressChoice }
  | { type: 'continue' }
  | { type: 'suggested'; suggestion: NameSuggestion }
  | { type: 'claim'; status: ClaimStatus }
  | { type: 'rerolled'; result: RerollResult }
  | { type: 'domain-entered'; domain: string }
  | { type: 'domain-checked'; result: DomainCheckResult }
  | { type: 'use-server-address'; address: string }
  | { type: 'use-own-domain' }
  | { type: 'retry' }
  | { type: 'finish' };

const freshFree = (): AddressState => ({ screen: 'free', name: null, rerollsLeft: 0, pointed: false, padlock: false });

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
          ? freshFree()
          : { screen: 'own-domain' };
      }
      if (state.screen === 'own-record' && state.check?.result === 'found') {
        return { screen: 'own-ticks', host: state.host, pointed: true, padlock: false };
      }
      return state;

    case 'suggested':
      if (state.screen !== 'free' || state.name !== null) return state;
      return event.suggestion.ok
        ? { ...state, name: event.suggestion.name, rerollsLeft: event.suggestion.rerollsLeft }
        : { screen: 'unavailable', reason: event.suggestion.reason };

    case 'claim':
      if (state.screen === 'free') {
        if (state.name !== null && event.status.name !== state.name) return state;
        // A claim that ran out of time or was suspended cannot be saved. The person starts again with a new name.
        if (event.status.state === 'expired' || event.status.state === 'suspended') {
          return { screen: 'expired', why: event.status.state };
        }
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

    case 'rerolled':
      // Only before the first padlock is issued.
      if (state.screen !== 'free' || state.padlock || state.name === null) return state;
      if (event.result.ok) {
        return { screen: 'free', name: event.result.name, rerollsLeft: event.result.rerollsLeft, pointed: false, padlock: false };
      }
      return event.result.reason === 'no-more'
        ? { ...state, rerollsLeft: 0 }
        : { screen: 'unavailable', reason: 'unreachable' };

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
      if (state.screen === 'unavailable' || state.screen === 'expired') {
        return freshFree();
      }
      if (state.screen === 'padlock-failed') {
        // Same name again: the installer retries the padlock, it does not pick a new name.
        return state.route === 'own'
          ? { screen: 'own-ticks', host: state.name, pointed: true, padlock: false }
          : { screen: 'free', name: state.name, rerollsLeft: 0, pointed: true, padlock: false };
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

/** Whether the person can swap the pending name for another one. */
export function canChooseAnother(state: AddressState): boolean {
  return state.screen === 'free' && !state.padlock && state.name !== null && state.rerollsLeft > 0;
}

/** How long a claim may stay pending before the screen says port 80 may be closed. */
export const PENDING_HINT_MS = 60_000;

/**
 * The server confirms a claim by letting the names service fetch a token from its port 80.
 * A claim that stays pending usually means that port is not reachable.
 */
export function showPortHint(claimState: ClaimState, pendingForMs: number, afterMs = PENDING_HINT_MS): boolean {
  return claimState === 'pending' && pendingForMs >= afterMs;
}

// ─── The names service's own spellings, mapped in one place ─────────────────

export interface NamesServiceDomainCheck {
  result: string;
  domain?: string;
  found?: string[];
}

const DOMAIN_RESULTS: Record<string, DomainCheck> = {
  found: 'found',
  not_found: 'not-found',
  wrong_address: 'wrong-address',
  proxied: 'proxied',
  certificate_blocked: 'certificate-blocked',
  rate_limited: 'rate-limited',
};

/** Turns the answer of the names service into the screen's own shape. An answer it does not know counts as not found. */
export function fromNamesServiceDomainCheck(raw: NamesServiceDomainCheck, expectedAddress: string): DomainCheckResult {
  const result = DOMAIN_RESULTS[raw.result] ?? 'not-found';
  if (result !== 'wrong-address') return { result };
  // "found" is a list. Show the first address that is not the right one.
  const foundAddress = raw.found?.find((a) => a !== expectedAddress) ?? raw.found?.[0];
  return foundAddress ? { result, foundAddress } : { result };
}

export interface NamesServiceClaim {
  name: string;
  state: string;
  claimed?: boolean;
  pointed?: boolean;
}

const CLAIM_STATES: ClaimState[] = ['pending', 'active', 'suspended', 'expired'];

/**
 * Joins the answer of the names service with what the installer knows about the padlock.
 * An unknown state counts as pending, so the screen keeps waiting and never claims success.
 */
export function fromNamesServiceClaim(raw: NamesServiceClaim, padlock: boolean, failure?: string): ClaimStatus {
  const state = CLAIM_STATES.find((s) => s === raw.state) ?? 'pending';
  return { name: raw.name, state, pointed: raw.pointed === true, padlock, ...(failure ? { failure } : {}) };
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
  rateLimited: 'Too many checks. Wait a few minutes and try again.',
  certificateBlocked:
    'Your domain has a rule that stops us making the padlock. Add letsencrypt.org to it, then check again.',
  full: "OpenFlow's free addresses are all taken for this week.",
  limit: 'Too many addresses were asked for from your internet connection today.',
  unreachable: 'We cannot reach the address service right now.',
  unavailableBody: (fallback: string) =>
    `Your server's own address works right now: ${fallback}. It changes if your server's address changes.`,
  padlockFailed: (reason: string) => `We could not make your padlock. ${reason}`,
  portNotReachable: 'Port 80 on your server is not reachable.',
  expired: 'Your address was not confirmed in time. Try again to get a new one.',
  suspended: 'This address has been stopped. Try again to get a new one.',
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
    case 'rate-limited':
      return ADDRESS_COPY.rateLimited;
  }
}

/** The opening sentence of the "names are full or the service is down" screen. */
export function unavailableMessage(reason: FreeNamesUnavailable): string {
  return reason === 'full' ? ADDRESS_COPY.full : reason === 'limit' ? ADDRESS_COPY.limit : ADDRESS_COPY.unreachable;
}
