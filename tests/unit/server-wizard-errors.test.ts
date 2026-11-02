// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserWizard } from '@/components/wizards/BrowserWizard';
import { MemoryWizard } from '@/components/wizards/MemoryWizard';
let root:Root; let host:HTMLDivElement; const request=vi.fn();
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});request.mockReset();vi.stubGlobal('fetch',request);host=document.createElement('div');root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());vi.unstubAllGlobals();});
it('explains headless browser limits and releases Start after a network failure',async()=>{
 request.mockResolvedValueOnce({json:async()=>({success:true,record:{enabled:false,headless:true,mcp:false,port:null,profileDir:null},running:false,browser:{kind:'chromium'},windowPossible:false})}).mockRejectedValueOnce(new Error('offline'));
 await act(async()=>root.render(createElement(BrowserWizard)));
 expect(host.textContent).toContain('cannot open an interactive website sign-in');
 const start=()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Start the browser')!;
 await act(async()=>start().click());
 expect(host.textContent).toContain('Could not reach the server');expect(start().disabled).toBe(false);
});
it('reports memory read failure without an unhandled rejection and permits retry',async()=>{
 request.mockRejectedValue(new Error('offline'));
 await act(async()=>root.render(createElement(MemoryWizard)));
 expect(host.textContent).toContain('Could not reach the server');
 const retry=Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Check again')!;
 await act(async()=>retry.click());expect(request).toHaveBeenCalledTimes(2);
});
