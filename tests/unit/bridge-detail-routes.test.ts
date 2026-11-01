// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BridgeDetail } from '@/components/systems/BridgeDetail';
let host:HTMLDivElement; let root:Root;
const fetchMock=vi.fn();
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.stubGlobal('fetch',fetchMock);fetchMock.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it.each(['slack','teams'])('loads %s from its real status and configuration routes',async bridgeId=>{
 fetchMock.mockImplementation(async(url:string)=>({ok:true,json:async()=>url.endsWith('/configure')?{config:{syncEnabled:true,workspaceId:'test'}}:{connected:true}}));
 await act(async()=>root.render(createElement(BridgeDetail,{bridgeId})));
 expect(fetchMock.mock.calls.map(c=>c[0]).sort()).toEqual([`/api/bridges/${bridgeId}/configure`,`/api/bridges/${bridgeId}/status`]);
 expect(host.textContent).toContain('Connected');
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Config')!.click());
 expect(host.textContent).not.toContain('No configuration found');
});
it('shows a retryable error instead of pretending a failed request has no configuration',async()=>{
 fetchMock.mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:false});
 await act(async()=>root.render(createElement(BridgeDetail,{bridgeId:'slack'})));
 expect(host.textContent).toContain('could not load');
 fetchMock.mockImplementation(async(url:string)=>({ok:true,json:async()=>url.endsWith('/configure')?{config:{syncEnabled:false}}:{connected:false}}));
 await act(async()=>host.querySelector('button')!.click());
 expect(host.textContent).toContain('Not Configured');
});
