// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ConnectionsSection } from '@/components/systems/ConnectionsSection';
vi.mock('@/components/connectors/ConnectorsPanel',()=>({ConnectorsPanel:()=>createElement('div',null,'Connector catalogue')}));
vi.mock('@/components/wizards/SignInWizard',()=>({SignInWizard:()=>null}));
vi.mock('@/components/wizards/TailscaleWizard',()=>({TailscaleWizard:()=>null}));
vi.mock('@/components/wizards/CloudflareWizard',()=>({CloudflareWizard:()=>null}));
vi.mock('@/components/wizards/BrowserWizard',()=>({BrowserWizard:()=>null}));
vi.mock('@/components/wizards/MemoryWizard',()=>({MemoryWizard:()=>null}));
it('keeps exported catalogue and wizard entry points visible after a status failure',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:false})));
 const host=document.createElement('div');const root=createRoot(host);
 try {
  await act(async()=>root.render(createElement(ConnectionsSection)));
  expect(host.textContent).toContain('Connector catalogue');
  expect(host.textContent).toContain('Open it on your phone with Tailscale');
  expect(host.textContent).toContain('Shared memory for your team');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('status is unavailable');
 } finally {await act(async()=>root.unmount());vi.unstubAllGlobals();}
});
