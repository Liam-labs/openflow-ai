import { describe, it, expect, beforeEach } from 'vitest';
import { allowLocalTrust, listensOnLoopbackOnly, originCheckMode, resetReportedForTests, splitHost, verdictFor } from '@/lib/local-trust';

const facts = (over: Partial<{ host: string | null; origin: string | null; secFetchSite: string | null; path: string | null }> = {}) => ({
  host: 'localhost:3000', origin: null, secFetchSite: null, ...over,
});

describe('splitHost', () => {
  it.each([
    ['localhost:3000', 'localhost', '3000'],
    ['LocalHost', 'localhost', ''],
    ['[::1]:3000', '::1', '3000'],
    ['127.0.0.1:3000', '127.0.0.1', '3000'],
    ['Example.COM:8080', 'example.com', '8080'],
  ])('%s', (input, name, port) => expect(splitHost(input)).toEqual({ name, port }));

  it.each(['', null, undefined, 'a b', 'evil.com/x', 'user@example.com', 'a\\b'])('refuses %j', (input) => expect(splitHost(input as string)).toBeNull());
});

describe('who counts as a local user', () => {
  it('a command-line tool (no Origin, no Sec-Fetch-Site) on localhost does', () => {
    expect(verdictFor(facts())).toEqual({ ok: true });
  });

  it.each(['localhost:3000', '127.0.0.1:3000', '[::1]:3000', '192.168.1.20:3000', '100.64.1.2:3000', 'app.localhost:3000'])('Host %s is fine', (host) => {
    expect(verdictFor(facts({ host })).ok).toBe(true);
  });

  it('refuses a request sent to a name that is not this machine (DNS rebinding)', () => {
    const verdict = verdictFor(facts({ host: 'attacker.example:3000' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/does not recognise/);
  });

  it('accepts this machine\'s own host name and name.local', () => {
    expect(verdictFor(facts({ host: 'mybox:3000' }), {}, 'MyBox').ok).toBe(true);
    expect(verdictFor(facts({ host: 'mybox.local:3000' }), {}, 'mybox').ok).toBe(true);
    expect(verdictFor(facts({ host: 'otherbox:3000' }), {}, 'mybox').ok).toBe(false);
  });

  it('accepts names listed in DEVFLOW_ALLOWED_HOSTS, exactly or by *.suffix', () => {
    const env = { DEVFLOW_ALLOWED_HOSTS: 'trusted-host-a, *.tailnet.example' };
    expect(verdictFor(facts({ host: 'trusted-host-a:3000' }), env).ok).toBe(true);
    expect(verdictFor(facts({ host: 'box.tailnet.example' }), env).ok).toBe(true);
    expect(verdictFor(facts({ host: 'tailnet.example.evil.com' }), env).ok).toBe(false);
    expect(verdictFor(facts({ host: 'eviltailnet.example' }), env).ok).toBe(false);     // the dot is part of the suffix
    expect(verdictFor(facts({ host: 'evil-trusted-host-a' }), env).ok).toBe(false);
  });

  it('refuses a request from a page on another origin', () => {
    const verdict = verdictFor(facts({ origin: 'https://evil.example' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/different origin/);
  });

  it('refuses another local app on a different port (same site, different origin)', () => {
    expect(verdictFor(facts({ origin: 'http://localhost:7860' })).ok).toBe(false);
  });

  it('accepts the dashboard itself (Origin equals Host)', () => {
    expect(verdictFor(facts({ origin: 'http://localhost:3000' })).ok).toBe(true);
    expect(verdictFor(facts({ host: '192.168.1.20:3000', origin: 'http://192.168.1.20:3000' })).ok).toBe(true);
  });

  it('accepts an origin listed in DEVFLOW_ALLOWED_ORIGINS', () => {
    const env = { DEVFLOW_ALLOWED_ORIGINS: 'http://localhost:7860' };
    expect(verdictFor(facts({ origin: 'http://localhost:7860' }), env).ok).toBe(true);
    expect(verdictFor(facts({ origin: 'http://localhost:7861' }), env).ok).toBe(false);
  });

  it.each(['null', 'not a url'])('refuses Origin %j', (origin) => expect(verdictFor(facts({ origin })).ok).toBe(false));

  it('says why for a sandboxed page (Origin: null)', () => {
    expect(verdictFor(facts({ origin: 'null' })).reason).toMatch(/no origin/);
    expect(verdictFor(facts({ origin: 'NULL' })).reason).toMatch(/no origin/);
  });

  it('refuses what the browser marks cross-site, accepts same-origin and none', () => {
    expect(verdictFor(facts({ secFetchSite: 'cross-site' })).ok).toBe(false);
    expect(verdictFor(facts({ secFetchSite: 'same-origin' })).ok).toBe(true);
    expect(verdictFor(facts({ secFetchSite: 'none' })).ok).toBe(true);
  });

  it('refuses a request with no usable Host', () => {
    expect(verdictFor(facts({ host: null })).ok).toBe(false);
  });
});

describe('modes', () => {
  beforeEach(() => resetReportedForTests());

  it('defaults to enforce and understands report and off', () => {
    expect(originCheckMode({})).toBe('enforce');
    expect(originCheckMode({ DEVFLOW_ORIGIN_CHECK: 'Report' })).toBe('report');
    expect(originCheckMode({ DEVFLOW_ORIGIN_CHECK: 'off' })).toBe('off');
    expect(originCheckMode({ DEVFLOW_ORIGIN_CHECK: 'nonsense' })).toBe('enforce');
  });

  it('enforce refuses, report allows but logs the first of each kind, off allows silently', () => {
    const bad = facts({ origin: 'https://evil.example' });
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    expect(allowLocalTrust(bad, {}, '', log)).toBe(false);
    expect(allowLocalTrust(bad, { DEVFLOW_ORIGIN_CHECK: 'report' }, '', log)).toBe(true);
    expect(allowLocalTrust(bad, { DEVFLOW_ORIGIN_CHECK: 'report' }, '', log)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/would refuse local trust/);
    expect(allowLocalTrust(bad, { DEVFLOW_ORIGIN_CHECK: 'off' }, '', log)).toBe(true);
    expect(lines).toHaveLength(1);
  });

  it('report mode counts repeats (1st, 10th, 100th) and tells kinds and routes apart', () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    const env = { DEVFLOW_ORIGIN_CHECK: 'report' };
    for (let i = 0; i < 100; i++) allowLocalTrust(facts({ origin: 'https://evil.example', path: '/api/a' }), env, '', log);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/x10 /);
    expect(lines[2]).toMatch(/x100 /);
    expect(lines[0]).toMatch(/origin=evil\.example/);
    expect(lines[0]).toMatch(/path=\/api\/a/);
    allowLocalTrust(facts({ origin: 'https://evil.example', path: '/api/b' }), env, '', log);
    allowLocalTrust(facts({ origin: 'https://other.example', path: '/api/a' }), env, '', log);
    expect(lines).toHaveLength(5);
  });

  it('report mode cleans header text and keeps counting kinds past the limit in one shared counter', () => {
    const lines: string[] = [];
    const env = { DEVFLOW_ORIGIN_CHECK: 'report' };
    allowLocalTrust(facts({ host: 'evil\u0085\u2028.example', path: '/api/' + 'p'.repeat(500) }), env, '', (l) => lines.push(l));
    expect(lines[0]).not.toMatch(/[^\x20-\x7e]/);
    expect(lines[0].length).toBeLessThan(400);
    for (let i = 0; i < 250; i++) allowLocalTrust(facts({ origin: 'https://h' + i + '.example' }), env, '', (l) => lines.push(l));
    expect(lines.filter((l) => /more kinds/.test(l)).length).toBeGreaterThanOrEqual(1);
  });

  it('refuses a no-Origin request a browser marks same-site (a page on another port), but accepts same-origin, none and no header', () => {
    expect(verdictFor(facts({ secFetchSite: 'same-site' })).ok).toBe(false);
    expect(verdictFor(facts({ secFetchSite: 'same-site', origin: 'http://localhost:3000', host: 'localhost:3000' })).ok).toBe(true);
    expect(verdictFor(facts({ secFetchSite: 'same-origin' })).ok).toBe(true);
    expect(verdictFor(facts({ secFetchSite: 'none' })).ok).toBe(true);
    expect(verdictFor(facts({ secFetchSite: null })).ok).toBe(true);
  });

  it('report mode stops tracking new kinds at a limit but still allows the request', () => {
    const lines: string[] = [];
    const env = { DEVFLOW_ORIGIN_CHECK: 'report' };
    for (let i = 0; i < 250; i++) expect(allowLocalTrust(facts({ origin: 'https://h' + i + '.example' }), env, '', (l) => lines.push(l))).toBe(true);
    expect(lines.length).toBeGreaterThanOrEqual(200);
  });

  it('good requests are never logged', () => {
    const lines: string[] = [];
    expect(allowLocalTrust(facts(), { DEVFLOW_ORIGIN_CHECK: 'report' }, '', (l) => lines.push(l))).toBe(true);
    expect(lines).toEqual([]);
  });
});

describe('listensOnLoopbackOnly', () => {
  it.each([['', true], [undefined, true], ['127.0.0.1', true], ['127.1.2.3', true], ['localhost', true], ['LOCALHOST', true], ['::1', true], ['[::1]', true],
    ['0.0.0.0', false], ['::', false], ['192.168.1.20', false], ['100.64.1.2', false], ['example.com', false], ['127.0.0.1.evil.com', false], ['1270.0.0.1', false]])('%s -> %s', (host, expected) => {
    expect(listensOnLoopbackOnly({ DEVFLOW_BIND_HOST: host })).toBe(expected);
  });
});
