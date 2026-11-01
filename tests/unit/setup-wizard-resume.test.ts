// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SetupWizard } from '@/components/SetupWizard';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('framer-motion', () => ({ AnimatePresence: ({children}: {children: React.ReactNode})=>children, motion:{div:({children}: {children: React.ReactNode})=>createElement('div',null,children)} }));
vi.mock('@/components/setup/StepProfile', () => ({ StepProfile: ({data}: {data:{name:string}}) => createElement('p', null, `Profile: ${data.name}`) }));
vi.mock('@/components/setup/StepCredentials', () => ({ StepCredentials: () => createElement('p', null, 'AI credentials step') }));
vi.mock('@/components/setup/StepMeetTeam', () => ({ StepMeetTeam: () => createElement('p', null, 'Team step') }));
let host:HTMLDivElement; let root:Root;
const fetchMock=vi.fn();
beforeEach(()=>{ Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.stubGlobal('fetch',fetchMock);fetchMock.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host); });
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
async function render(){await act(async()=>root.render(createElement(SetupWizard)));}
it('restores the saved name and resumes at AI access after profile save',async()=>{
 fetchMock.mockResolvedValue({ok:true,json:async()=>({steps:{1:{complete:true,data:{name:'Saved owner',role:'Team Lead'}},2:{complete:false}},nextStep:5})});
 await render();expect(host.textContent).toContain('AI credentials step');
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent?.includes('Back'))!.click());
 expect(host.textContent).toContain('Profile: Saved owner');
});
it('maps saved credentials to the current team step, not the legacy nextStep',async()=>{
 fetchMock.mockResolvedValue({ok:true,json:async()=>({steps:{1:{complete:true,data:{name:'Saved owner'}},2:{complete:true}},nextStep:4})});
 await render();expect(host.textContent).toContain('Team step');
});
it('does not present an empty editable form when restoration fails',async()=>{
 fetchMock.mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:true,json:async()=>({steps:{1:{complete:false}}})});
 await render();expect(host.textContent).toContain('could not load');expect(host.textContent).not.toContain('Profile:');
 await act(async()=>host.querySelector('button')!.click());expect(host.textContent).toContain('Profile:');
});
