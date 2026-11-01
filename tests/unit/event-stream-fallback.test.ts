// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useEventStream } from '@/lib/contexts/EventStreamContext';

function Subscriber({prefix}: {prefix:string}) {
 const {data}=useEventStream<string>('pm2:status',{
  fallbackUrl:'/api/pm2',fallbackInterval:15000,
  fallbackTransform:()=>prefix+' result',
 });
 return createElement('p',null,data);
}
it('keeps fallback cadence through rerenders and uses the latest transform',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.useFakeTimers();
 const fetchMock=vi.fn(async()=>({json:async()=>({processes:[]})}));vi.stubGlobal('fetch',fetchMock);
 const host=document.createElement('div');const root=createRoot(host);
 try {
  await act(async()=>root.render(createElement(Subscriber,{prefix:'first'})));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(host.textContent).toBe('first result');
  await act(async()=>root.render(createElement(Subscriber,{prefix:'second'})));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async()=>vi.advanceTimersByTimeAsync(15000));
  expect(fetchMock).toHaveBeenCalledTimes(2);expect(host.textContent).toBe('second result');
 } finally {await act(async()=>root.unmount());vi.useRealTimers();vi.unstubAllGlobals();}
});
