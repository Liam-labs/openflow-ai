// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import VaultPage from '@/app/vault/page';
const state = vi.hoisted(() => ({ status: 'setup-required' }));
vi.mock('@/components/vault/VaultProvider', () => ({
  VaultProvider: ({children}: {children: ReactNode}) => children,
  useVault: () => ({ status: state.status, setupVault: async () => {state.status='unlocked'; return {backupCodes:['test-recovery-code']};} }),
}));
vi.mock('@/components/vault/PasswordSetup', () => ({PasswordSetup: ({onComplete}: {onComplete:(password:string)=>void}) => createElement('button',{onClick:()=>onComplete('test-password')},'Create password')}));
vi.mock('@/components/vault/PasskeySetup', () => ({PasskeySetup: ({onSkip}: {onSkip:()=>void}) => createElement('button',{onClick:onSkip},'Skip passkey')}));
vi.mock('@/components/vault/BackupCodesDisplay', () => ({BackupCodesDisplay: ({codes,onComplete}: {codes:string[];onComplete:()=>void}) => createElement('button',{onClick:onComplete},`Save ${codes.length} recovery codes`)}));
vi.mock('@/components/vault/VaultSecretsViewer', () => ({VaultSecretsViewer:()=>createElement('p',null,'Secret list')}));
it('retains recovery setup when password creation unlocks the vault', async () => {
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement('div');const root=createRoot(host);
 try {
  await act(async()=>root.render(createElement(VaultPage)));
  await act(async()=>host.querySelector('button')!.click());
  expect(state.status).toBe('unlocked');
  expect(host.textContent).toContain('Skip passkey');
  await act(async()=>host.querySelector('button')!.click());
  expect(host.textContent).toContain('Save 1 recovery codes');
  await act(async()=>host.querySelector('button')!.click());
  expect(host.textContent).toContain('Vault Created!');
  await act(async()=>host.querySelector('button')!.click());
  expect(host.textContent).toContain('Secret list');
 } finally {await act(async()=>root.unmount());}
});
