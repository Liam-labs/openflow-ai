// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TailscaleWizard } from '@/components/wizards/TailscaleWizard';
const stream = vi.hoisted(() => ({ data: undefined as undefined | { wizard: string }, isConnected: true }));
vi.mock('@/lib/contexts/EventStreamContext', () => ({ useEventStream: () => stream }));
let root: Root; let host: HTMLDivElement;
const request = vi.fn();
const state = (running = false) => ({ success:true,passwordSet:true,facts:{isolatedNode:true,inContainer:true,installed:true,state:running?'Running':'NeedsLogin',dnsName:running?'node.ts.net':null,httpsReady:true,operatorOk:true},plan:{ok:false,reason:'Sign in to continue',fix:'login'},active:null,visits:[],secondDevice:null });
beforeEach(() => { Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true}); stream.data=undefined; request.mockReset(); vi.stubGlobal('fetch',request); host=document.createElement('div'); document.body.append(host); root=createRoot(host); });
afterEach(async () => { await act(async()=>root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const reply = (body:unknown) => ({ json:async()=>body });
async function render() { await act(async()=>root.render(createElement(TailscaleWizard))); }
async function login() { await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Sign in to Tailscale')!.click()); }
it('shows approval without host commands and refreshes after the wizard event',async()=>{
 request.mockResolvedValueOnce(reply(state())).mockResolvedValueOnce(reply({...state(),loginUrl:'https://login.tailscale.com/a/example'})).mockResolvedValueOnce(reply(state(true)));
 await render(); expect(host.textContent).not.toContain('sudo tailscale'); await login();
 expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({action:'login'});
 expect(host.querySelector('a[href="https://login.tailscale.com/a/example"]')).not.toBeNull();
 stream.data={wizard:'tailscale'}; await render();
 expect(host.textContent).toContain('Signed in.'); expect(host.textContent).not.toContain('Approve this installation in Tailscale');
});
it('refuses an unsafe approval address and permits retry',async()=>{
 request.mockResolvedValueOnce(reply(state())).mockResolvedValueOnce(reply({...state(),loginUrl:'javascript:alert(1)'}));
 await render(); await login(); expect(host.querySelector('a')).toBeNull(); expect(host.textContent).toContain('invalid approval address');
 expect(Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Sign in to Tailscale')?.disabled).toBe(false);
});
it('shows failed login and releases the button',async()=>{
 request.mockResolvedValueOnce(reply(state())).mockRejectedValueOnce(new Error('Connection lost. Try again.'));
 await render(); await login(); expect(host.textContent).toContain('Connection lost. Try again.');
 expect(Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Sign in to Tailscale')?.disabled).toBe(false);
});

it('requires HTTPS for the isolated server without promising an HTTP fallback', async () => {
 const current = state(true);
 current.facts.httpsReady = false;
 current.plan = {ok:false,reason:'Enable HTTPS certificates in your Tailscale account before sharing this server. Owner sign-in requires HTTPS.',fix:'https'};
 request.mockResolvedValueOnce(reply(current));
 await render();
 expect(host.textContent).toContain('Owner sign-in requires HTTPS');
 expect(host.textContent).not.toContain('will use plain http');
 expect(host.textContent).not.toContain('sudo tailscale');
 expect(Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Switch on remote access')?.disabled).toBe(true);
});
