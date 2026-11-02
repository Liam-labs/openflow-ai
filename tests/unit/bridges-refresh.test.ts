// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BridgesSection } from '@/components/systems/BridgesSection';
it('loads all three bridges and refreshes on focus without interval polling', async () => {
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 vi.useFakeTimers();
 const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({configured:false})}));
 vi.stubGlobal('fetch',fetchMock);
 const host=document.createElement('div'); const root=createRoot(host);
 try {
  await act(async()=>root.render(createElement(BridgesSection)));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(host.textContent).toContain('WhatsApp'); expect(host.textContent).toContain('Microsoft Teams'); expect(host.textContent).toContain('Slack');
  await act(async()=>{vi.advanceTimersByTime(60000);}); expect(fetchMock).toHaveBeenCalledTimes(3);
  await act(async()=>{window.dispatchEvent(new Event('focus'));}); expect(fetchMock).toHaveBeenCalledTimes(6);
  await act(async()=>root.unmount());
  window.dispatchEvent(new Event('focus')); expect(fetchMock).toHaveBeenCalledTimes(6);
 } finally {vi.unstubAllGlobals();vi.useRealTimers();}
});
