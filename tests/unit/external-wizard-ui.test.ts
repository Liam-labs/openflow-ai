// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudflareWizard } from '@/components/wizards/CloudflareWizard';
import { TailscaleWizard } from '@/components/wizards/TailscaleWizard';
let host: HTMLDivElement; let root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host=document.createElement('div');root=createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals();vi.useRealTimers(); });
it.each([CloudflareWizard, TailscaleWizard])('offers a retry after a failed initial connection read', async Wizard => {
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')));
 await act(async () => root.render(createElement(Wizard)));
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not reach OpenFlow');
 const retry=[...host.querySelectorAll('button')].find(b=>b.textContent==='Try again')!;
 await act(async () => retry.click());
 expect(fetch).toHaveBeenCalledTimes(2);
});
it('does not poll Tailscale when remote access is active', async () => {
 vi.useFakeTimers();
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({success:true,passwordSet:true,facts:{installed:true,state:'Running'},plan:{ok:true},active:{url:'https://device.example.test'},visits:[],secondDevice:{state:'waiting',detail:'Waiting for another device'}})}));
 await act(async()=>root.render(createElement(TailscaleWizard)));
 await act(async()=>vi.advanceTimersByTimeAsync(60000));
 expect(fetch).toHaveBeenCalledTimes(1);
 expect(host.textContent).toContain('Waiting for another device');
});
