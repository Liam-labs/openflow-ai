// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CreateLogin } from '@/components/setup/CreateLogin';

let host: HTMLDivElement;
let root: Root;
const createLogin = vi.fn();
const onCreated = vi.fn();
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createLogin.mockReset();
  onCreated.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(CreateLogin, { createLogin, onCreated })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function input(id: string, value: string) {
  await act(async () => {
    const element = host.querySelector<HTMLInputElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function fill(confirmation = 'several ordinary words') {
  await input('setup-code', ' one-time-code ');
  await input('setup-password', 'several ordinary words');
  await input('setup-password-confirm', confirmation);
}
async function submit() {
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
it('does not send mismatched passwords or advance', async () => {
  await fill('different ordinary words');
  await submit();
  expect(createLogin).not.toHaveBeenCalled();
  expect(onCreated).not.toHaveBeenCalled();
  expect(host.textContent).toContain('passwords do not match');
});
it('keeps a rejected code on the screen and supports retry', async () => {
  createLogin.mockResolvedValueOnce({ ok: false, error: 'This code has expired.' }).mockResolvedValueOnce({ ok: true });
  await fill();
  await submit();
  expect(onCreated).not.toHaveBeenCalled();
  expect(host.textContent).toContain('This code has expired.');
  await input('setup-code', 'replacement-code');
  await submit();
  expect(createLogin).toHaveBeenLastCalledWith('replacement-code', 'several ordinary words');
  expect(onCreated).toHaveBeenCalledTimes(1);
  for (const field of host.querySelectorAll('input')) expect(field.value).toBe('');
});
it('prevents duplicate requests while saving and advances only on success', async () => {
  let resolve!: (value: { ok: boolean }) => void;
  createLogin.mockImplementation(() => new Promise((done) => { resolve = done; }));
  await fill();
  await submit();
  await submit();
  expect(createLogin).toHaveBeenCalledTimes(1);
  expect(createLogin).toHaveBeenCalledWith('one-time-code', 'several ordinary words');
  expect(onCreated).not.toHaveBeenCalled();
  expect(host.querySelector('button')!.disabled).toBe(true);
  await act(async () => resolve({ ok: true }));
  expect(onCreated).toHaveBeenCalledTimes(1);
});
it('keeps network failure retryable without advancing', async () => {
  createLogin.mockRejectedValue(new Error('offline'));
  await fill();
  await submit();
  expect(host.textContent).toContain('Check your connection');
  expect(onCreated).not.toHaveBeenCalled();
  expect(host.querySelector('button')!.disabled).toBe(false);
});
