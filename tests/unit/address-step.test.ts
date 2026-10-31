import { describe, it, expect } from 'vitest';
import {
  ADDRESS_COPY,
  INITIAL_ADDRESS_STATE,
  canContinue,
  domainCheckMessage,
  fallbackAddress,
  nextAddressState,
  normaliseDomain,
  ownDomainHost,
  unavailableMessage,
  type AddressEvent,
  type AddressState,
} from '@/lib/setup/address-step';

const run = (events: AddressEvent[], from: AddressState = INITIAL_ADDRESS_STATE) =>
  events.reduce(nextAddressState, from);

describe('normaliseDomain', () => {
  it.each([
    ['example.com', 'example.com'],
    ['  Example.COM ', 'example.com'],
    ['https://example.com/path?x=1', 'example.com'],
    ['www.example.com', 'example.com'],
    ['example.co.uk.', 'example.co.uk'],
    ['my-site.example.com', 'my-site.example.com'],
  ])('accepts %s', (input, expected) => {
    expect(normaliseDomain(input)).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    ['localhost'],
    ['example'],
    ['203.0.113.5'],
    ['exa mple.com'],
    ['example.com:8080'],
    ['-bad.example.com'],
    ['bad-.example.com'],
    ['a..b.com'],
    ['under_score.com'],
  ])('rejects %j', (input) => {
    expect(normaliseDomain(input)).toBeNull();
  });
});

describe('ownDomainHost', () => {
  it('puts the default label before the domain', () => {
    expect(ownDomainHost('example.com')).toBe('openflow.example.com');
  });
  it('uses a label the person chose', () => {
    expect(ownDomainHost('example.com', 'flow')).toBe('flow.example.com');
  });
  it('refuses a label that is not valid', () => {
    expect(ownDomainHost('example.com', 'bad label')).toBeNull();
    expect(ownDomainHost('example.com', '')).toBeNull();
  });
  it('refuses a domain that is not valid', () => {
    expect(ownDomainHost('nonsense')).toBeNull();
  });
});

describe('fallbackAddress', () => {
  it('writes the server address with dashes on sslip.io', () => {
    expect(fallbackAddress('203.0.113.5')).toBe('203-0-113-5.sslip.io');
  });
  it.each([['203.0.113'], ['203.0.113.256'], ['203.0.113.5.1'], ['a.b.c.d'], ['203.0.113.05'], ['::1'], ['']])(
    'refuses %j',
    (input) => {
      expect(fallbackAddress(input)).toBeNull();
    },
  );
});

describe('free address route', () => {
  const claimed = (padlock: boolean, pointed = true) => ({
    type: 'claim' as const,
    status: { name: 'calm-otter-4821.example.test', pointed, padlock },
  });

  it('reaches the end with two Continue clicks and no typing', () => {
    let s = INITIAL_ADDRESS_STATE;
    expect(canContinue(s)).toBe(true);
    s = nextAddressState(s, { type: 'continue' }); // click 1
    s = nextAddressState(s, { type: 'suggested', suggestion: { ok: true, name: 'calm-otter-4821.example.test' } });
    expect(canContinue(s)).toBe(false);
    s = nextAddressState(s, claimed(false));
    expect(canContinue(s)).toBe(false);
    s = nextAddressState(s, claimed(true));
    expect(canContinue(s)).toBe(true);
    s = nextAddressState(s, { type: 'finish' }); // click 2
    expect(s).toEqual({ screen: 'done', address: 'calm-otter-4821.example.test' });
  });

  it('does not finish before the padlock is issued', () => {
    const s = run([
      { type: 'continue' },
      { type: 'suggested', suggestion: { ok: true, name: 'calm-otter-4821.example.test' } },
      claimed(false),
      { type: 'finish' },
    ]);
    expect(s.screen).toBe('free');
  });

  it('ignores a second suggestion once a name is chosen', () => {
    const s = run([
      { type: 'continue' },
      { type: 'suggested', suggestion: { ok: true, name: 'calm-otter-4821.example.test' } },
      { type: 'suggested', suggestion: { ok: true, name: 'other-name-1111.example.test' } },
    ]);
    expect(s).toMatchObject({ screen: 'free', name: 'calm-otter-4821.example.test' });
  });

  it('ignores a status answer for a different name', () => {
    const s = run([
      { type: 'continue' },
      { type: 'suggested', suggestion: { ok: true, name: 'calm-otter-4821.example.test' } },
      { type: 'claim', status: { name: 'old-name-0000.example.test', pointed: true, padlock: true } },
    ]);
    expect(s).toMatchObject({ screen: 'free', padlock: false });
  });

  it('lets the person choose another name only before the padlock', () => {
    const withName = run([
      { type: 'continue' },
      { type: 'suggested', suggestion: { ok: true, name: 'calm-otter-4821.example.test' } },
    ]);
    expect(nextAddressState(withName, { type: 'choose-another' })).toMatchObject({ screen: 'free', name: null });
    const locked = nextAddressState(withName, claimed(true));
    expect(nextAddressState(locked, { type: 'choose-another' })).toBe(locked);
  });

  it('shows the full screen when the weekly cap is reached', () => {
    const s = run([{ type: 'continue' }, { type: 'suggested', suggestion: { ok: false, reason: 'full' } }]);
    expect(s).toEqual({ screen: 'unavailable', reason: 'full' });
  });

  it('shows the unreachable screen when the service is down', () => {
    const s = run([{ type: 'continue' }, { type: 'suggested', suggestion: { ok: false, reason: 'unreachable' } }]);
    expect(s).toEqual({ screen: 'unavailable', reason: 'unreachable' });
  });

  it('keeps the same name when the person retries after a padlock failure', () => {
    const failed = run([
      { type: 'continue' },
      { type: 'suggested', suggestion: { ok: true, name: 'calm-otter-4821.example.test' } },
      { type: 'claim', status: { name: 'calm-otter-4821.example.test', pointed: true, padlock: false, failure: 'The server did not answer.' } },
    ]);
    expect(failed).toEqual({
      screen: 'padlock-failed',
      reason: 'The server did not answer.',
      name: 'calm-otter-4821.example.test',
      route: 'free',
    });
    expect(nextAddressState(failed, { type: 'retry' })).toEqual({
      screen: 'free',
      name: 'calm-otter-4821.example.test',
      pointed: true,
      padlock: false,
    });
  });
});

describe('unavailable screen', () => {
  const unavailable: AddressState = { screen: 'unavailable', reason: 'full' };

  it('offers the server address', () => {
    expect(nextAddressState(unavailable, { type: 'use-server-address', address: '203-0-113-5.sslip.io' })).toEqual({
      screen: 'done',
      address: '203-0-113-5.sslip.io',
    });
  });
  it('offers the own-domain route', () => {
    expect(nextAddressState(unavailable, { type: 'use-own-domain' })).toEqual({ screen: 'own-domain' });
  });
  it('tries the free route again', () => {
    expect(nextAddressState(unavailable, { type: 'retry' })).toEqual({
      screen: 'free',
      name: null,
      pointed: false,
      padlock: false,
    });
  });
  it('does not offer these actions on other screens', () => {
    expect(nextAddressState(INITIAL_ADDRESS_STATE, { type: 'use-own-domain' })).toBe(INITIAL_ADDRESS_STATE);
    expect(nextAddressState(INITIAL_ADDRESS_STATE, { type: 'use-server-address', address: 'x' })).toBe(
      INITIAL_ADDRESS_STATE,
    );
  });
});

describe('own domain route', () => {
  const toRecord = () =>
    run([{ type: 'pick', choice: 'own' }, { type: 'continue' }, { type: 'domain-entered', domain: 'Example.com' }]);

  it('moves from the choice to the record screen', () => {
    expect(toRecord()).toEqual({ screen: 'own-record', host: 'openflow.example.com', check: null });
  });

  it('stays on the domain screen when the domain is not valid', () => {
    const s = run([{ type: 'pick', choice: 'own' }, { type: 'continue' }, { type: 'domain-entered', domain: 'nope' }]);
    expect(s).toEqual({ screen: 'own-domain' });
  });

  it.each(['not-found', 'wrong-address', 'proxied', 'certificate-blocked'] as const)(
    'cannot continue after the check result %s',
    (result) => {
      const s = nextAddressState(toRecord(), { type: 'domain-checked', result: { result } });
      expect(canContinue(s)).toBe(false);
      expect(nextAddressState(s, { type: 'continue' })).toBe(s);
    },
  );

  it('continues to the ticks after the check passes, then finishes at the padlock', () => {
    let s = nextAddressState(toRecord(), { type: 'domain-checked', result: { result: 'found' } });
    expect(canContinue(s)).toBe(true);
    s = nextAddressState(s, { type: 'continue' });
    expect(s).toEqual({ screen: 'own-ticks', host: 'openflow.example.com', pointed: true, padlock: false });
    expect(canContinue(s)).toBe(false);
    s = nextAddressState(s, { type: 'claim', status: { name: 'openflow.example.com', pointed: true, padlock: true } });
    expect(canContinue(s)).toBe(true);
    expect(nextAddressState(s, { type: 'finish' })).toEqual({ screen: 'done', address: 'openflow.example.com' });
  });

  it('ignores a status answer for a different host and does not finish before the padlock', () => {
    let s = nextAddressState(toRecord(), { type: 'domain-checked', result: { result: 'found' } });
    s = nextAddressState(s, { type: 'continue' });
    const stale = nextAddressState(s, { type: 'claim', status: { name: 'other.example.com', pointed: true, padlock: true } });
    expect(stale).toBe(s);
    expect(nextAddressState(s, { type: 'finish' })).toBe(s);
  });

  it('retries the padlock for the same host', () => {
    let s = nextAddressState(toRecord(), { type: 'domain-checked', result: { result: 'found' } });
    s = nextAddressState(s, { type: 'continue' });
    s = nextAddressState(s, {
      type: 'claim',
      status: { name: 'openflow.example.com', pointed: true, padlock: false, failure: 'The certificate service refused.' },
    });
    expect(s).toMatchObject({ screen: 'padlock-failed', route: 'own', name: 'openflow.example.com' });
    expect(nextAddressState(s, { type: 'retry' })).toEqual({
      screen: 'own-ticks',
      host: 'openflow.example.com',
      pointed: true,
      padlock: false,
    });
  });
});

describe('events on the wrong screen change nothing', () => {
  it.each<AddressEvent>([
    { type: 'domain-checked', result: { result: 'found' } },
    { type: 'claim', status: { name: 'x', pointed: true, padlock: true } },
    { type: 'finish' },
    { type: 'retry' },
    { type: 'choose-another' },
  ])('$type on the choose screen', (event) => {
    expect(nextAddressState(INITIAL_ADDRESS_STATE, event)).toBe(INITIAL_ADDRESS_STATE);
  });
});

describe('wording', () => {
  const sentences = (): string[] => {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') out.push(v);
      else if (typeof v === 'function') out.push((v as (...a: string[]) => string)('a', 'b'));
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(ADDRESS_COPY);
    return out;
  };

  it('never writes the install domain', () => {
    for (const text of sentences()) expect(text).not.toMatch(/openflow-ai\.com|\.my\./i);
  });

  it('uses no semicolons', () => {
    for (const text of sentences()) expect(text).not.toContain(';');
  });

  it('keeps technical record words out of the screen titles', () => {
    const titles = [
      ADDRESS_COPY.chooseTitle,
      ADDRESS_COPY.freeCardTitle,
      ADDRESS_COPY.ownCardTitle,
      ADDRESS_COPY.freeTitle,
      ADDRESS_COPY.ownDomainTitle,
      ADDRESS_COPY.recordTitle,
    ];
    for (const t of titles) expect(t).not.toMatch(/\bDNS\b|A record|\bTXT\b/);
  });

  it('gives each check result one sentence, and none for a pass', () => {
    expect(domainCheckMessage({ result: 'found' }, '203.0.113.5')).toBeNull();
    expect(domainCheckMessage({ result: 'not-found' }, '203.0.113.5')).toBe(ADDRESS_COPY.notFound);
    expect(domainCheckMessage({ result: 'proxied' }, '203.0.113.5')).toBe(ADDRESS_COPY.proxied);
    expect(domainCheckMessage({ result: 'certificate-blocked' }, '203.0.113.5')).toBe(ADDRESS_COPY.certificateBlocked);
  });

  it('names both addresses when the wrong one is found', () => {
    const text = domainCheckMessage({ result: 'wrong-address', foundAddress: '198.51.100.7' }, '203.0.113.5');
    expect(text).toContain('198.51.100.7');
    expect(text).toContain('203.0.113.5');
  });

  it('opens the unavailable screen with the right sentence', () => {
    expect(unavailableMessage('full')).toBe(ADDRESS_COPY.full);
    expect(unavailableMessage('unreachable')).toBe(ADDRESS_COPY.unreachable);
  });
});
