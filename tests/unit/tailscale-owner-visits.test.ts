import { expect, it, vi } from 'vitest';
vi.mock('@/lib/data-paths', () => ({ DataPaths: {} }));
import { judgeSecondDevice, planServe } from '@/lib/wizards/tailscale';
it('distinguishes a signed-in second device from an authentication bypass', () => {
 expect(judgeSecondDevice([{ device: '100.64.1.2', allowed: true, authenticated: true }]).state).toBe('ok');
 expect(judgeSecondDevice([{ device: '100.64.1.2', allowed: true, authenticated: false }]).state).toBe('open');
 expect(judgeSecondDevice([{ device: '100.64.1.2', allowed: false }]).state).toBe('ok');
});
it('requires HTTPS for the isolated node and retains native-container refusal', () => {
 const facts = { inContainer: true, isolatedNode: true, installed: true, version: '1', state: 'Running', dnsName: 'example.ts.net', ips: [], httpsReady: false, operatorOk: true, serve: [] };
 expect(planServe(facts, 3000)).toMatchObject({ ok: false, fix: 'https' });
 expect(planServe({ ...facts, httpsReady: true }, 3000)).toMatchObject({ ok: true, https: true, target: 'http://127.0.0.1:3000' });
 expect(planServe({ ...facts, isolatedNode: false }, 3000)).toMatchObject({ ok: false, fix: 'container' });
});
