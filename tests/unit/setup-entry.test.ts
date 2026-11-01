// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SetupEntry } from '@/components/setup/SetupEntry';
vi.mock('@/components/SetupWizard', () => ({ SetupWizard: () => createElement('h1', null, 'Protected wizard') }));
let host: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(createElement(SetupEntry))); }
async function input(id: string, value: string) {
  await act(async () => {
    const element = host.querySelector<HTMLInputElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await input('setup-code', 'sample-code');
  await input('setup-password', 'several ordinary words');
  await input('setup-password-confirm', 'several ordinary words');
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
it('loads the ordinary wizard for local installs', async () => {
  fetchMock.mockResolvedValue(reply({ serverMode: false, needsSetup: true }));
  await render(); expect(host.textContent).toContain('Protected wizard');
});
it('requires the first login before mounting a server wizard', async () => {
  fetchMock.mockResolvedValue(reply({ serverMode: true, needsSetup: true }));
  await render(); expect(host.textContent).toContain('Create your login'); expect(host.textContent).not.toContain('Protected wizard');
});
it('directs a configured server to sign in, and allows an existing session', async () => {
  fetchMock.mockResolvedValueOnce(reply({ serverMode: true, needsSetup: false })).mockResolvedValueOnce(reply({ signedIn: false }));
  await render(); expect(host.querySelector('a')?.getAttribute('href')).toBe('/login?next=%2Fsetup');
});
it('resumes a server wizard with an existing session', async () => {
  fetchMock.mockResolvedValueOnce(reply({ serverMode: true, needsSetup: false })).mockResolvedValueOnce(reply({ signedIn: true }));
  await render(); expect(host.textContent).toContain('Protected wizard');
});
it('does not bypass a failed status check and lets the person retry', async () => {
  fetchMock.mockResolvedValueOnce(reply({}, false)).mockResolvedValueOnce(reply({ serverMode: false, needsSetup: true }));
  await render(); expect(host.textContent).not.toContain('Protected wizard');
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).toContain('Protected wizard');
});
it('posts the agreed contract and opens the wizard only with a verified session', async () => {
  fetchMock.mockResolvedValueOnce(reply({ serverMode: true, needsSetup: true })).mockResolvedValueOnce(reply({ ok: true })).mockResolvedValueOnce(reply({ signedIn: true }));
  await render(); await submit();
  expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/setup');
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ code: 'sample-code', newPassword: 'several ordinary words' });
  expect(host.textContent).toContain('Protected wizard');
});
it('does not advance when the browser did not retain its session cookie', async () => {
  fetchMock.mockResolvedValueOnce(reply({ serverMode: true, needsSetup: true })).mockResolvedValueOnce(reply({ ok: true })).mockResolvedValueOnce(reply({ signedIn: false }));
  await render(); await submit();
  expect(host.textContent).not.toContain('Protected wizard'); expect(host.textContent).toContain('could not start a session');
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/login?next=%2Fsetup');
});
it.each([
  ['invalid_code', 'invalid or expired'],
  ['already_configured', 'A login already exists'],
  ['throttled', 'Wait 90 seconds'],
  ['bad_password', 'Use a longer password.'],
])('keeps %s refusal on the login screen', async (code, expected) => {
  fetchMock.mockResolvedValueOnce(reply({ serverMode: true, needsSetup: true })).mockResolvedValueOnce(reply({ code, error: 'Use a longer password.', retryAfterSeconds: 90 }, false));
  await render(); await submit(); expect(host.textContent).toContain(expected); expect(host.textContent).not.toContain('Protected wizard');
});
