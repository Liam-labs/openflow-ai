import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
vi.mock('os',async importOriginal=>({...await importOriginal<typeof import('os')>(),release:()=> '6.17.0-generic'}));
vi.mock('@/lib/api-auth',()=>({requireAuthOrLocal:vi.fn(async()=>null)}));
vi.mock('@/lib/api-tracking',()=>({tracked:(_name:string,handler:unknown)=>handler}));
vi.mock('@/lib/computer-use-settings',()=>({readSettings:vi.fn(async()=>({computerUse:{backend:'api'}}))}));
vi.mock('@/lib/computer-use-bridge',()=>({checkBridgeHealth:vi.fn(),getBridgeUrl:vi.fn(),startBridge:vi.fn()}));
import { GET, POST } from '@/app/api/computer-use/wizard/route';
import { checkBridgeHealth, startBridge } from '@/lib/computer-use-bridge';
import { requireAuthOrLocal } from '@/lib/api-auth';
beforeEach(()=>{vi.clearAllMocks();vi.mocked(requireAuthOrLocal).mockResolvedValue(null);});
it('does not offer Windows fixes or claim a pass on a native Linux server',async()=>{
 const result=await GET(new NextRequest('http://localhost/api/computer-use/wizard'));
 const data=await result.json();expect(data.supported).toBe(false);expect(data.allPassed).toBe(false);expect(data.groups).toEqual([]);
 expect(data.unsupportedReason).toContain('cannot install desktop control on this server');
 expect(checkBridgeHealth).not.toHaveBeenCalled();
});
it('refuses desktop setup actions before starting a bridge on Linux',async()=>{
 const result=await POST(new NextRequest('http://localhost/api/computer-use/wizard',{method:'POST',body:JSON.stringify({action:'start_bridge'})}));
 expect(result.status).toBe(409);expect((await result.json()).code).toBe('UNSUPPORTED_PLATFORM');expect(startBridge).not.toHaveBeenCalled();
});
it('retains the authentication requirement',async()=>{
 vi.mocked(requireAuthOrLocal).mockResolvedValue(NextResponse.json({error:'Unauthorized'},{status:401}));
 expect((await GET(new NextRequest('http://localhost/api/computer-use/wizard'))).status).toBe(401);
});
